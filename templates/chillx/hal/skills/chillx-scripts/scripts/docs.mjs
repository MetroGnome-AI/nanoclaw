#!/usr/bin/env node
/**
 * scripts/docs.mjs — single entry point for CHILLX business-doc operations.
 *
 * Submodes:
 *   profile         — print canonical business profile facts (read-only)
 *   send            — draft a Gmail with named docs as attachments
 *   list-docs       — list all known doc aliases
 *   fill            — STUB (v2): fill a blank vendor form from the profile
 *
 * Examples:
 *   node scripts/docs.mjs profile                                  # full profile
 *   node scripts/docs.mjs profile entity.ein                       # one field
 *   node scripts/docs.mjs profile bank_reference                   # one block
 *   node scripts/docs.mjs send --to josue@example.com --docs w9,coi,sales-tax-permit
 *   node scripts/docs.mjs send --to josue@example.com --docs w9 --subject "CHILLX W-9" --message "Per your request"
 *   node scripts/docs.mjs send --to ap@vendor.com --cc buyer@vendor.com --docs w9,voided-check --yes-sensitive
 *   node scripts/docs.mjs send --to ap@vendor.com --reply-to-msg <gmailMsgId> --docs w9 --message "Per your note below"
 *   node scripts/docs.mjs list-docs
 *
 * Flags for `send`:
 *   --to <email>          primary recipient(s), comma-separated (required)
 *   --cc <email>          CC recipient(s), comma-separated (optional)
 *   --reply-to-msg <id>   Gmail message id to reply to in-thread; threads the draft
 *                         and derives "Re: <original subject>" unless --subject given
 *   --docs <list>         comma-separated doc aliases (required; see list-docs)
 *   --subject / --message / --recipient-name / --yes-sensitive / --dry-run
 *
 * Lock-execute discipline. Sensitive fields enforced in scripts/lib/docs/profile.mjs.
 */
import { loadProfile, safeProfile, sensitivityOf, pickTradeRefs } from './lib/docs/profile.mjs';
import { resolveAttachments, buildBody, createGmailDraft } from './lib/docs/send.mjs';
import { fillForm } from './lib/docs/fill.mjs';
import { logRun } from './lib/intro/run-log.mjs';

function parseArgs(argv) {
  const submode = argv[2];
  const rest = argv.slice(3);
  const out = { _: [], submode };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
      out[key.replace(/-/g, '_')] = out[key];
    } else {
      out._.push(a);
    }
  }
  return out;
}

function getByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, k) => acc?.[k], obj);
}

function printValue(v, prefix = '') {
  if (v == null) { console.log(`${prefix}(null)`); return; }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    console.log(`${prefix}${v}`); return;
  }
  if (Array.isArray(v)) {
    for (const [i, item] of v.entries()) { console.log(`${prefix}[${i}]`); printValue(item, prefix + '  '); }
    return;
  }
  for (const [k, val] of Object.entries(v)) {
    if (val == null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      console.log(`${prefix}${k}: ${val ?? '(null)'}`);
    } else {
      console.log(`${prefix}${k}:`);
      printValue(val, prefix + '  ');
    }
  }
}

async function cmdProfile(args) {
  const profile = loadProfile();
  const path = args._[0];
  const value = getByPath(profile, path);
  if (value === undefined) {
    console.error(`No such field: "${path}"`);
    process.exit(1);
  }
  if (path) {
    const sens = sensitivityOf(profile, path);
    console.log(`# ${path} (sensitivity: ${sens})`);
  } else {
    console.log(`# CHILLX business profile — full read`);
  }
  printValue(value);
}

async function cmdListDocs(args) {
  const profile = loadProfile();
  const attachments = profile.attachments || {};
  console.log(`# Known doc aliases (use with --docs):\n`);
  const groups = {
    'Tax': ['w9', 'sales-tax-permit', 'tx-resale-cert'],
    'Identity': ['ein-proof', '147c', 'dba', 'formation'],
    'Banking (sensitive)': ['voided-check', 'ach-wire'],
    'Payment instructions': ['check-instructions'],
    'Insurance': ['coi', 'insurance-policy'],
  };
  for (const [group, aliases] of Object.entries(groups)) {
    console.log(`## ${group}`);
    for (const a of aliases) {
      console.log(`  ${a}`);
    }
    console.log('');
  }
  console.log('## Raw attachment keys (also accepted):\n');
  for (const k of Object.keys(attachments)) console.log(`  ${k}`);
}

async function cmdSend(args) {
  const profile = loadProfile();
  const startedAt = Date.now();
  if (!args.to) throw new Error('--to <email> required');
  if (!args.docs) throw new Error('--docs <comma-separated-list> required (try `docs.mjs list-docs`)');

  const docNames = String(args.docs).split(',').map(s => s.trim()).filter(Boolean);
  console.log(`[docs send] to=${args.to} docs=[${docNames.join(', ')}]`);

  // Resolve attachments — this rclone-copies Drive paths to /tmp and computes SHA-256
  const attachments = await resolveAttachments(profile, docNames);

  console.log(`[docs send] attachments resolved:`);
  for (const a of attachments) {
    console.log(`  ${a.name.padEnd(20)} ${(a.size + ' bytes').padEnd(14)} sha256=${a.sha256.slice(0, 12)}…  sensitivity=${a.sensitivity}`);
  }

  // Confirm sensitive attachments
  const sensitive = attachments.filter(a => a.sensitivity === 'signed-pdf-only');
  if (sensitive.length && !args.yes_sensitive && !args.dry_run) {
    console.log(`\n⚠  Sensitive attachments queued: ${sensitive.map(a => a.name).join(', ')}`);
    console.log(`    Re-run with --yes-sensitive to confirm, or --dry-run to preview without sending to Gmail.`);
    return;
  }

  // Build body
  const recipientName = args.recipient_name || args['recipient-name'] || null;
  const cc = args.cc || null;
  const replyToMsgId = args.reply_to_msg || args['reply-to-msg'] || args.reply_to || args['reply-to'] || null;
  // When replying in-thread without an explicit --subject, leave subject null so
  // createGmailDraft derives "Re: <original subject>" and keeps the thread intact.
  const subject = args.subject || (replyToMsgId ? null : `CHILLX — ${docNames.join(' + ')}`);
  const message = args.message || null;

  // Pull Gmail signature
  let signature = '';
  try {
    let getGmailClient;
  try {
    ({ getGmailClient } = await import(process.env.CHILLX_GMAIL_CLIENT || '/home/eggers/nanoclaw/dist/integrations/gmail-client.js'));
  } catch {
    throw new Error('Gmail draft creation is unavailable in this deployment (wave-2: docs send submode needs the Gmail client + credentials).');
  }
    const g = await getGmailClient();
    const sa = await g.users.settings.sendAs.list({ userId: 'me' });
    const primary = sa.data.sendAs?.find(s => s.isPrimary) || sa.data.sendAs?.[0];
    signature = primary?.signature || '';
  } catch (e) {
    console.warn(`[docs send] signature pull failed: ${e.message}`);
  }

  const { html } = buildBody({ profile, recipientName, attachments, message, signature });

  if (args.dry_run) {
    console.log(`\n[docs send] DRY RUN — would create Gmail draft with:`);
    console.log(`  to:       ${args.to}`);
    if (cc) console.log(`  cc:       ${cc}`);
    if (replyToMsgId) console.log(`  reply-to: ${replyToMsgId} (in-thread reply)`);
    console.log(`  subject:  ${subject || '(derived "Re: <original>" on reply)'}`);
    console.log(`  attached: ${attachments.length} file(s), ${attachments.reduce((a, b) => a + b.size, 0)} bytes total`);
    console.log(`  body (HTML, truncated):`);
    console.log(html.slice(0, 600));
    return;
  }

  // Create Gmail draft
  const draft = await createGmailDraft({ to: args.to, cc, subject, html, attachments, replyToMsgId });
  const elapsedMs = Date.now() - startedAt;
  console.log(`\n[docs send] DRAFT created: ${draft.url}`);

  // Log to introspection run-log
  await logRun({
    discipline: 'lock-execute',
    task: `docs send to=${args.to}${cc ? ` cc=${cc}` : ''}${replyToMsgId ? ' (in-thread)' : ''} docs=[${docNames.join(',')}]`,
    outcome: 'success',
    details: {
      to: args.to,
      cc: cc || null,
      replyToMsgId: replyToMsgId || null,
      threadId: draft.threadId || null,
      docs: docNames,
      attachment_sha256: draft.attachments,
      draftUrl: draft.url,
      elapsedMs,
      harness_held: true,
    },
  });

  console.log(`\n✓ DOCS SEND COMPLETE in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  To:       ${args.to}`);
  if (draft.cc) console.log(`  Cc:       ${draft.cc}`);
  if (draft.threadId) console.log(`  Thread:   ${draft.threadId} (in-thread reply)`);
  console.log(`  Subject:  ${draft.subject}`);
  console.log(`  Docs:     ${docNames.join(', ')}`);
  console.log(`  Draft:    ${draft.url}`);
  console.log(`\n  Attachment SHA-256s (for later phishing-event verification):`);
  for (const a of draft.attachments) {
    console.log(`    ${a.name.padEnd(20)} ${a.sha256}`);
  }
}

async function cmdRefs(args) {
  const profile = loadProfile();
  const vendorId = args._[0] || args.vendor || null;
  const n = parseInt(args.n || '3', 10);
  const seed = args.seed || vendorId;
  const refs = pickTradeRefs(profile, vendorId, n, seed);
  const hint = vendorId ? (profile.vendor_category_hints?.[vendorId] || profile.vendor_category_hints?._default || []).join(', ') : '(no vendor — default ranking)';
  console.log(`# Trade refs for vendor: ${vendorId || '(none)'}`);
  console.log(`# Category hints: ${hint}\n`);
  for (const r of refs) {
    console.log(`  ${r.company_name}`);
    if (r.contact_name) console.log(`    Contact: ${r.contact_name}`);
    if (r.phone) console.log(`    Phone:   ${r.phone}`);
    if (r.email) console.log(`    Email:   ${r.email}`);
    if (r.address?.line1) console.log(`    Address: ${r.address.line1}, ${r.address.city}, ${r.address.state} ${r.address.zip}`);
    if (r.account_no) console.log(`    Account: ${r.account_no}`);
    console.log(`    [relationship=${r.relationship || '?'}, categories=${(r.categories || []).join(', ')}]`);
    console.log('');
  }
}

async function cmdFill(args) {
  const startedAt = Date.now();
  const inputPdf = args._[0] || args.input;
  if (!inputPdf) throw new Error('Usage: docs.mjs fill <input.pdf> [--output X] [--vendor VID] [--include-bank]');
  const outputPdf = args.output || null;
  const vendorId = args.vendor || null;
  const includeBank = args.include_bank === true || args.include_bank === 'true';

  console.log(`[docs fill] input:  ${inputPdf}`);
  console.log(`[docs fill] vendor: ${vendorId || '(none — generic ranking)'}`);
  console.log(`[docs fill] bank:   ${includeBank ? 'INCLUDED (per-request approval given)' : 'skipped (use --include-bank to include)'}`);

  const result = await fillForm({ inputPdf, outputPdf, vendorId, includeBank });

  console.log(`\n[docs fill] Filled ${result.fills.length} fields:`);
  for (const f of result.fills) {
    const pageLabel = `p${f.pageIdx + 1}`;
    const sensTag = f.sensitivity === 'controlled' ? ' ⚠CONTROLLED' : '';
    console.log(`  ${pageLabel.padEnd(4)} "${f.label.slice(0, 30).padEnd(30)}" → ${f.value.slice(0, 60)}${sensTag}`);
  }

  if (result.signatureLocations.length) {
    console.log(`\n[docs fill] Signature embedded at ${result.signatureLocations.length} location(s).`);
  }

  if (result.refused.length) {
    console.log(`\n[docs fill] Refused/skipped ${result.refused.length} fields (review manually):`);
    for (const r of result.refused) {
      console.log(`  p${r.pageIdx + 1} "${r.label.slice(0, 40).padEnd(40)}" → ${r.reason}`);
    }
  }

  console.log(`\n[docs fill] ✓ Filled PDF: ${result.filledPath}`);
  if (result.previewPngs.length) {
    console.log(`[docs fill] ✓ Page previews:`);
    for (const png of result.previewPngs) console.log(`  ${png}`);
    console.log(`\nReview each page above. If positions need adjustment, edit data/business-profile/label-vocabulary.yaml or report what's off and we'll tune.`);
  }

  const elapsedMs = Date.now() - startedAt;
  await logRun({
    discipline: 'lock-execute',
    task: `docs fill ${inputPdf}`,
    outcome: 'success',
    details: {
      inputPdf,
      outputPdf: result.filledPath,
      vendorId,
      includeBank,
      fields_filled: result.fills.length,
      fields_refused: result.refused.length,
      signature_locations: result.signatureLocations.length,
      sensitive_fills: result.sensitiveFillsCount,
      elapsedMs,
      harness_held: true,
    },
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.submode || args.submode === 'help' || args.submode === '--help' || args.submode === '-h') {
    console.log(`Usage: docs.mjs <submode> [args]\n`);
    console.log(`Submodes:`);
    console.log(`  profile [field.path]   — print canonical business profile facts`);
    console.log(`  send --to X --docs Y   — draft a Gmail with named docs attached`);
    console.log(`  list-docs              — list known doc aliases`);
    console.log(`  refs [vendor_id]       — pick relevant trade references for a vendor form`);
    console.log(`  fill (v2 stub)         — PDF form auto-fill (not yet implemented)`);
    console.log(``);
    console.log(`Examples:`);
    console.log(`  node scripts/docs.mjs profile entity.ein`);
    console.log(`  node scripts/docs.mjs send --to josue@example.com --docs w9,coi,sales-tax-permit`);
    return;
  }
  switch (args.submode) {
    case 'profile':   return cmdProfile(args);
    case 'send':      return cmdSend(args);
    case 'list-docs': return cmdListDocs(args);
    case 'refs':      return cmdRefs(args);
    case 'fill':      return cmdFill(args);
    default:
      console.error(`Unknown submode: "${args.submode}"`);
      console.error(`Try: node scripts/docs.mjs help`);
      process.exit(1);
  }
}

main().catch(async err => {
  console.error(`\n✗ DOCS FAILED: ${err.message}`);
  try {
    await logRun({
      discipline: 'lock-execute',
      task: `docs ${process.argv.slice(2).join(' ')}`,
      outcome: 'failed',
      details: { error: err.message, harness_held: false },
    });
  } catch {}
  process.exit(1);
});
