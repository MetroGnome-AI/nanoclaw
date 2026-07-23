#!/usr/bin/env node
/**
 * scripts/lead.mjs — create or enrich an ERPNext Lead from any source.
 *
 * The receptionist (container/ari-bridge/caller-lookup.mjs) auto-creates leads
 * from phone calls. This is the GENERAL, host-side entry point: "log a lead for
 * X" from a call, SMS, email, web form, trade show, or manual note.
 *
 * What it does:
 *   1. DEDUP by phone / email → if an existing Lead matches, ENRICH it (fill only
 *      blank fields, add equipment tags, append a note). Else CREATE.
 *   2. Parse a free-form --name ("Ray from EnergyX", "Dave, engineer") via the same
 *      parseCallerName guards the receptionist uses.
 *   3. Map --interest free text → canonical equipment tags (applied as ERPNext tags).
 *   4. Source/industry: set ONLY if given — NEVER guessed (Link validator rejects
 *      bad values and blocks the whole insert; see feedback_lead_source_omit_when_uncertain).
 *   5. Warn (don't block) if the phone/email already belongs to a Contact (possible
 *      existing customer).
 *
 * Usage:
 *   node scripts/lead.mjs --name "Ray from EnergyX" --phone 5125551234 --interest "4 ton low profile chiller"
 *   node scripts/lead.mjs --email jane@acme.com --first Jane --last Doe --company Acme --source "Website" --interest "shell and tube"
 *   node scripts/lead.mjs --phone 5125551234 --interest "RTU chiller"        # enrich existing by phone
 *   node scripts/lead.mjs ... --dry-run                                       # preview, no write
 */
import { readFileSync } from 'node:fs';
import { erpPost, erpPut, getList, getDoc, callMethod, addComment } from './lib/shipping/erp.mjs';
// phoneDigits = the digit match key (dedupe). formatPhone = XXX-XXX-XXXX for
// stored/display values. Shared with the receptionist + Drupal import paths.
import { phoneDigits as normalizePhone, formatPhone } from './lib/phone.mjs';

// v2 container: env file lives in the agent group workspace (machine-local, not in git).
let _envText = '';
try { _envText = readFileSync(process.env.CHILLX_ENV_FILE || '/workspace/agent/.chillx-env', 'utf8'); } catch { /* rely on process.env */ }
for (const line of _envText.split('\n')) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2).replace(/-/g, '_');
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) out[k] = true; else { out[k] = n; i++; }
  }
  return out;
}

// ── parseCallerName — ported from container/ari-bridge/caller-lookup.mjs (source of
// truth there). Keep the 3 guards in sync if that one changes. ──────────────────
const ROLE_KEYWORD_RE = /\b(engineer(ing)?|manager|owner|president|vp|director|operator|technician|supervisor|specialist|consultant|administrator|foreman|designer|installer|contractor|sales|rep|representative|associate|agent|analyst|ceo|cto|cfo|coo|founder|partner|head|chief|principal|coordinator|officer|executive|architect|developer|scientist|tech|mechanic|plumber|electrician|hvac)\b/i;
function parseCallerName(nameSource) {
  if (!nameSource) return { firstName: '', lastName: '', jobTitle: '', company: '' };
  let personPart = String(nameSource).replace(/\([^)]*\)/g, '').trim();
  let company = '', jobTitle = '';
  const fromMatch = personPart.match(/^(.+?)\s+from\s+(.+)$/i);
  if (fromMatch) { personPart = fromMatch[1].trim(); company = fromMatch[2].trim(); }
  const commaIdx = personPart.indexOf(',');
  if (commaIdx >= 0) {
    const candidate = personPart.slice(commaIdx + 1).trim().split(',')[0].trim();
    if (candidate && ROLE_KEYWORD_RE.test(candidate)) jobTitle = candidate;
    personPart = personPart.slice(0, commaIdx).trim();
  }
  personPart = personPart.replace(/[,.;:'"\s]+$/, '').trim();
  const parts = personPart.split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '', jobTitle, company };
}

// ── Equipment-interest → canonical CRM tags ──────────────────────────────────────
const EQUIP_TAGS = [
  [/low.?profile/i, 'Chiller: Low Profile'],
  [/\brtu\b|roof.?top/i, 'Chiller: RTU'],
  [/process chiller/i, 'Chiller: Process'],
  [/\bchiller\b/i, 'Chiller'],
  [/air.?handler|\bahu\b|hydronic air/i, 'Air Handler'],
  [/shell.?(and|&).?tube|\bscts\b|\bsctt\b|heat exchanger/i, 'Shell & Tube HX'],
  [/tank section/i, 'Tank Section'],
  [/dragon breath|unit heater/i, 'Unit Heater'],
  [/\bpump\b/i, 'Pump'],
];
function mapInterestToTags(interest) {
  if (!interest) return [];
  const tags = new Set();
  for (const [re, tag] of EQUIP_TAGS) if (re.test(interest)) tags.add(tag);
  if ([...tags].some((t) => t.startsWith('Chiller:')) && tags.has('Chiller')) tags.delete('Chiller');
  return [...tags];
}

const LEAD_FIELDS = ['name', 'lead_name', 'first_name', 'last_name', 'company_name', 'email_id', 'phone', 'mobile_no', 'status', 'source', 'job_title', 'territory'];

async function findExistingLead({ phone, email }) {
  const seen = new Map();
  const tryF = async (f) => { try { for (const r of await getList('Lead', f, LEAD_FIELDS, 'modified desc', 5)) seen.set(r.name, r); } catch {} };
  if (phone) {
    // Match across the common stored formats (receptionist stores digits; web forms vary).
    const variants = [phone, `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`, `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}`];
    for (const v of variants) { await tryF([['phone', '=', v]]); await tryF([['mobile_no', '=', v]]); }
  }
  if (email) await tryF([['email_id', '=', email]]);
  return [...seen.values()][0] || null;
}

async function contactWarning({ phone, email }) {
  try {
    const f = [];
    if (email) f.push(['email_id', '=', email]);
    if (!f.length && phone) f.push(['mobile_no', '=', phone]);
    if (!f.length) return null;
    const rows = await getList('Contact', f[0] ? [f[0]] : [], ['name'], 'modified desc', 1);
    return rows[0]?.name || null;
  } catch { return null; }
}

async function applyTags(name, tags) {
  const applied = [];
  for (const tag of tags) {
    try { await callMethod('frappe.desk.doctype.tag.tag.add_tag', { dt: 'Lead', dn: name, tag }); applied.push(tag); } catch {}
  }
  return applied;
}

async function main() {
  const args = parseArgs(process.argv);
  const phone = args.phone ? normalizePhone(args.phone) : null;
  const email = args.email ? String(args.email).trim().toLowerCase() : null;
  const interest = args.interest && args.interest !== true ? String(args.interest) : null;
  const tags = mapInterestToTags(interest);

  // Name: explicit --first/--last win; else parse --name.
  const parsed = parseCallerName(args.name && args.name !== true ? args.name : '');
  const firstName = (args.first && args.first !== true ? args.first : parsed.firstName) || '';
  const lastName = (args.last && args.last !== true ? args.last : parsed.lastName) || '';
  const jobTitle = (args.title && args.title !== true ? args.title : parsed.jobTitle) || '';
  let companyName = (args.company && args.company !== true ? args.company : parsed.company) || '';
  if (companyName.includes(',')) companyName = companyName.split(',')[0].trim();

  if (!firstName && !companyName && !phone && !email) {
    throw new Error('Need at least one of --name/--first, --company, --phone, or --email to identify the lead.');
  }

  const dryRun = !!args.dry_run;
  const existing = await findExistingLead({ phone, email });

  if (existing) {
    // ENRICH — fill only blank fields, never overwrite.
    const patch = {};
    if ((!existing.first_name || existing.first_name === 'UNKNOWN CALLER') && firstName) patch.first_name = firstName.toUpperCase();
    if (!existing.last_name && lastName) patch.last_name = lastName.toUpperCase();
    if (!existing.company_name && companyName) patch.company_name = companyName.toUpperCase();
    if (!existing.email_id && email) patch.email_id = email;
    if (!existing.phone && phone) patch.phone = formatPhone(phone);
    if (!existing.mobile_no && phone) patch.mobile_no = formatPhone(phone);
    if (!existing.job_title && jobTitle) patch.job_title = jobTitle;
    if (!existing.source && args.source && args.source !== true) patch.source = args.source;

    console.log(`[lead] DEDUP HIT → enrich existing ${existing.name} (${existing.lead_name})`);
    console.log(`[lead] field patch: ${Object.keys(patch).length ? JSON.stringify(patch) : '(none — all present)'}`);
    console.log(`[lead] tags to add: ${tags.length ? tags.join(', ') : '(none)'}`);
    if (dryRun) { console.log('[lead] DRY RUN — no write.'); return; }

    if (Object.keys(patch).length) await erpPut(`/api/resource/Lead/${encodeURIComponent(existing.name)}`, patch);
    const applied = await applyTags(existing.name, tags);
    const noteBits = [interest ? `Interest: ${interest}` : null, args.notes && args.notes !== true ? args.notes : null, args.source && args.source !== true ? `Source: ${args.source}` : null].filter(Boolean);
    if (noteBits.length) await addComment('Lead', existing.name, `<div><b>Lead enriched (lead skill)</b><br>${noteBits.join('<br>')}</div>`);
    console.log(`✓ enriched ${existing.name}${Object.keys(patch).length ? ` | patched ${Object.keys(patch).join(',')}` : ''}${applied.length ? ` | tags +${applied.join(',')}` : ''}`);
    return;
  }

  // CREATE
  const displayName = (firstName + (lastName ? ' ' + lastName : '')).trim() || companyName
    || (phone ? formatPhone(phone) : email);
  const body = {
    doctype: 'Lead',
    first_name: firstName ? firstName.toUpperCase() : 'UNKNOWN CALLER',
    last_name: lastName ? lastName.toUpperCase() : undefined,
    lead_name: String(displayName).toUpperCase(),
    company_name: companyName ? companyName.toUpperCase() : undefined,
    job_title: (jobTitle && (!companyName || jobTitle.toLowerCase() !== companyName.toLowerCase())) ? jobTitle : undefined,
    email_id: email || undefined,
    phone: phone ? formatPhone(phone) : undefined,
    mobile_no: phone ? formatPhone(phone) : undefined,
    status: 'Lead',
    territory: (args.territory && args.territory !== true ? args.territory : 'United States'),
    // source ONLY if given — never guessed (hard rule). request_type implied by a product interest.
    ...(args.source && args.source !== true ? { source: args.source } : {}),
    ...(interest ? { request_type: 'Product Enquiry' } : {}),
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

  const custWarn = await contactWarning({ phone, email });
  console.log(`[lead] CREATE → ${body.lead_name}${body.company_name ? ` (${body.company_name})` : ''}`);
  console.log(`[lead] ${JSON.stringify(body)}`);
  console.log(`[lead] tags: ${tags.length ? tags.join(', ') : '(none)'}${args.source && args.source !== true ? '' : '  | source: OMITTED (not given — never guessed)'}`);
  if (custWarn) console.log(`[lead] ⚠ a Contact already exists for this phone/email (${custWarn}) — may be an existing customer. Creating Lead anyway.`);
  if (dryRun) { console.log('[lead] DRY RUN — no write.'); return; }

  const created = await erpPost('/api/resource/Lead', body);
  const name = created.data.name;
  const applied = await applyTags(name, tags);
  const noteBits = [interest ? `Interest: ${interest}` : null, args.notes && args.notes !== true ? args.notes : null].filter(Boolean);
  await addComment('Lead', name, `<div><b>Lead created (lead skill)</b> ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CDT${args.source && args.source !== true ? ` · source ${args.source}` : ''}${custWarn ? ` · ⚠ existing Contact ${custWarn}` : ''}${noteBits.length ? `<br>${noteBits.join('<br>')}` : ''}</div>`);
  console.log(`✓ created ${name} (${body.lead_name})${applied.length ? ` | tags +${applied.join(',')}` : ''}`);
}

main().catch((e) => { console.error(`\n✗ lead FAILED: ${e.message}`); process.exit(1); });
