/**
 * scripts/lib/docs/send.mjs
 *
 * Build a Gmail draft for sending CHILLX business docs (W-9, COI, sales tax permit,
 * voided check, formation cert, etc.) with sensitivity enforcement.
 *
 * Always creates a DRAFT only — never auto-sends.
 *
 * Rules:
 *   - Sensitive content (wire instructions, bank account/routing) goes via attached
 *     PDF only, NEVER in the email body.
 *   - The body lists what's attached, but doesn't paraphrase sensitive contents.
 *   - SHA-256 of every attachment is computed + logged so we can later verify what
 *     was actually sent if a phishing event is suspected.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadProfile } from './profile.mjs';

/**
 * Resolve a doc spec to a list of attachment objects.
 * Each spec is a string key like 'w9', 'coi', 'sales_tax_permit', 'voided_check'.
 * Returns [{ name, path, localPath, sha256, sensitivity }]
 */
export async function resolveAttachments(profile, docNames) {
  const map = profile.attachments || {};
  const aliases = {
    w9: 'w9_signed_pdf',
    'w-9': 'w9_signed_pdf',
    w9_2026: 'w9_signed_pdf',
    coi: 'insurance_endorsement_pdf',
    'certificate-of-insurance': 'insurance_endorsement_pdf',
    'insurance-cert': 'insurance_endorsement_pdf',
    insurance_endorsement: 'insurance_endorsement_pdf',
    insurance_policy: 'insurance_policy_pdf',
    'sales-tax-permit': 'sales_tax_permit_pdf',
    permit: 'sales_tax_permit_pdf',
    'sales-tax': 'sales_tax_permit_pdf',
    'tx-resale-cert': 'tx_resale_cert_blank_pdf',
    'multi-state-resale': 'tx_resale_cert_blank_pdf',
    'voided-check': 'voided_check_pdf',
    bank: 'voided_check_pdf',
    'ach-wire': 'payment_instructions_ach_wire_pdf',
    wire: 'payment_instructions_ach_wire_pdf',
    'payment-instructions': 'payment_instructions_ach_wire_pdf',
    'check-instructions': 'payment_instructions_check_pdf',
    formation: 'formation_cert_pdf',
    'tx-cert': 'formation_cert_pdf',
    'ein-proof': 'ein_proof_pdf',
    ein: 'ein_proof_pdf',
    '147c': 'llc_147c_pdf',
    dba: 'dba_filing_pdf',
  };
  const sensitivityMap = {
    voided_check_pdf: 'signed-pdf-only',
    payment_instructions_ach_wire_pdf: 'signed-pdf-only',
    payment_instructions_check_pdf: 'routine',
    w9_signed_pdf: 'routine',
    insurance_endorsement_pdf: 'routine',
    insurance_policy_pdf: 'routine',
    sales_tax_permit_pdf: 'routine',
    tx_resale_cert_blank_pdf: 'routine',
    formation_cert_pdf: 'routine',
    ein_proof_pdf: 'routine',
    llc_147c_pdf: 'routine',
    dba_filing_pdf: 'routine',
  };

  const out = [];
  for (const name of docNames) {
    const norm = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/-$/, '').replace(/^-/, '');
    const key = aliases[norm] || aliases[norm.replace(/-/g, '_')] || Object.keys(map).find(k => k === norm || k === `${norm}_pdf`);
    if (!key) {
      throw new Error(`Unknown doc name: "${name}". Known: ${[...Object.keys(aliases), ...Object.keys(map)].join(', ')}`);
    }
    const drivePath = map[key];
    if (!drivePath) {
      throw new Error(`Profile has no path for "${key}". Update data/business-profile/chillx.yaml.`);
    }
    // Resolve gdrive: paths by rclone-copying to /tmp
    let localPath = drivePath;
    if (drivePath.startsWith('gdrive:')) {
      const fileName = drivePath.split('/').pop();
      const tmpDir = join(tmpdir(), `docs-send-${process.pid}`);
      execSync(`mkdir -p "${tmpDir}"`);
      localPath = join(tmpDir, fileName);
      execSync(`rclone copyto "${drivePath}" "${localPath}"`, { stdio: 'pipe' });
    }
    const bytes = readFileSync(localPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    out.push({
      name,
      key,
      drivePath,
      localPath,
      sha256,
      size: bytes.length,
      sensitivity: sensitivityMap[key] || 'routine',
    });
  }
  return out;
}

/**
 * Build a Gmail draft body. Body is plain text + HTML.
 * Refuses to embed any signed-pdf-only data inline.
 */
export function buildBody({ profile, recipientName, attachments, message = null, signature = '' }) {
  const items = attachments.map(a => `  • ${a.name} (${a.key})`).join('\n');
  const itemsHtml = attachments.map(a => `<li>${escapeHtml(a.name)} <span style="color:#888">(${escapeHtml(a.key)})</span></li>`).join('');
  const greeting = recipientName ? `Hi ${recipientName.split(' ')[0]},` : 'Hi,';
  const msgPara = message ? `<p>${escapeHtml(message)}</p>` : '<p>Please find the requested document(s) attached.</p>';

  const html = `
<div>
<p>${escapeHtml(greeting)}</p>
${msgPara}
<p>Attached:</p>
<ul>${itemsHtml}</ul>
<p>Let me know if you need anything further.</p>
<p>Thanks,<br>Rob</p>
${signature}
</div>`.trim();

  return { html, attachments };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Create a Gmail draft with attachments using the Gmail API.
 *
 * @param {object}   opts
 * @param {string}   opts.to            — primary recipient(s), comma-separated
 * @param {string=}  opts.cc            — CC recipient(s), comma-separated (optional)
 * @param {string=}  opts.subject       — subject. When replying in-thread and this
 *                                        is falsy or doesn't start with "Re:", it's
 *                                        replaced with "Re: <original subject>".
 * @param {string}   opts.html          — HTML body
 * @param {object[]} opts.attachments   — resolved attachment objects (localPath, etc.)
 * @param {string=}  opts.replyToMsgId  — Gmail message id to reply to in-thread.
 *                                        When set, the draft is threaded (threadId +
 *                                        In-Reply-To + References headers from the original).
 * @returns {{draftId, messageId, url, to, cc, subject, threadId, attachments}}
 */
export async function createGmailDraft({ to, cc = null, subject, html, attachments, replyToMsgId = null }) {
  let getGmailClient;
  try {
    ({ getGmailClient } = await import(process.env.CHILLX_GMAIL_CLIENT || '/home/eggers/nanoclaw/dist/integrations/gmail-client.js'));
  } catch {
    throw new Error('Gmail draft creation is unavailable in this deployment (wave-2: docs send submode needs the Gmail client + credentials).');
  }
  const g = await getGmailClient();
  const sa = await g.users.settings.sendAs.list({ userId: 'me' });
  const primary = sa.data.sendAs?.find(s => s.isPrimary) || sa.data.sendAs?.[0];
  const fromName = primary?.displayName || 'Robert Eggers';
  const fromEmail = primary?.sendAsEmail || 'Robert.Eggers@ChillXChillers.com';

  // If replying in-thread, fetch the original's threading headers + subject.
  let threadId = null;
  let inReplyTo = null;
  let references = null;
  if (replyToMsgId) {
    const orig = await g.users.messages.get({
      userId: 'me',
      id: replyToMsgId,
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'References', 'Subject'],
    });
    threadId = orig.data.threadId || null;
    const oh = Object.fromEntries((orig.data.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
    inReplyTo = oh['message-id'] || null;
    references = oh['references'] ? `${oh['references']} ${inReplyTo}`.trim() : inReplyTo;
    const origSubject = oh['subject'] || '';
    // Derive "Re: <original>" only when the caller didn't pass an explicit subject.
    // An explicit --subject is respected verbatim (threading still holds via
    // In-Reply-To / References regardless of the subject line).
    if (origSubject && !subject) {
      subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    }
  }

  // Multipart MIME with mixed (attachments) + alternative (HTML body)
  const boundaryMixed = `b1_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const boundaryAlt = `b2_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const headerLines = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${to}`,
  ];
  if (cc) headerLines.push(`Cc: ${cc}`);
  headerLines.push(`Subject: ${subject}`);
  if (inReplyTo) headerLines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headerLines.push(`References: ${references}`);
  headerLines.push(`MIME-Version: 1.0`);
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`);
  const headers = headerLines.join('\r\n');

  const bodyPart = [
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    ``,
    `--${boundaryAlt}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    html,
    `--${boundaryAlt}--`,
  ].join('\r\n');

  const attachParts = attachments.map(a => {
    const data = readFileSync(a.localPath).toString('base64');
    const ct = a.localPath.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    const filename = a.localPath.split('/').pop();
    return [
      `--${boundaryMixed}`,
      `Content-Type: ${ct}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      data,
    ].join('\r\n');
  }).join('\r\n');

  const raw = [headers, ``, bodyPart, attachParts, `--${boundaryMixed}--`].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64url');
  const message = { raw: encoded };
  if (threadId) message.threadId = threadId;
  const draft = await g.users.drafts.create({ userId: 'me', requestBody: { message } });
  const draftId = draft.data.id;
  const messageId = draft.data.message?.id;
  return {
    draftId,
    messageId,
    url: `https://mail.google.com/mail/u/0/#drafts/${messageId || draftId}`,
    to,
    cc,
    subject,
    threadId,
    attachments: attachments.map(a => ({ name: a.name, sha256: a.sha256, size: a.size })),
  };
}
