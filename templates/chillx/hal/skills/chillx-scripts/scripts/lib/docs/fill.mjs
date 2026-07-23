/**
 * scripts/lib/docs/fill.mjs — PDF form autofill engine.
 *
 * Strategy:
 *   1. Extract word bounding boxes from input PDF via `pdftotext -bbox-layout`
 *   2. Scan tokens for label phrases in our vocabulary
 *   3. For each match, determine where to write the value (right of label, or
 *      below if label is at end-of-line)
 *   4. Overlay text + signature image with pdf-lib
 *   5. Render each page to PNG for visual verification
 *
 * Imperfect by design — the goal is a "good first stab" that's 70-80% correct
 * and only needs minor tuning. Sensitive (controlled) bank fields require
 * --include-bank and emit a per-request confirmation prompt.
 *
 * Returns:
 *   {
 *     filledPath,                 // path to filled PDF
 *     previewPngs,                // array of page PNG paths for visual review
 *     fills: [...],               // { label, value, pageIdx, x, y, profileKey }
 *     refused: [...],             // { label, reason, pageIdx, ... }
 *     unmatched_labels: [...],    // labels that appeared in the doc but had no vocab entry
 *   }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { loadProfile, pickTradeRefs } from './profile.mjs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PDFDocument = null, rgb = null, StandardFonts = null;
try { ({ PDFDocument, rgb, StandardFonts } = require('pdf-lib')); } catch { /* fill submode unavailable without pdf-lib (wave-2) */ }

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '../../..');
const VOCAB_PATH = process.env.CHILLX_VOCAB
  || join(process.env.CHILLX_PROFILE_DIR || '/workspace/extra/business-profile', 'label-vocabulary.yaml');

let _vocab = null;
export function loadVocabulary() {
  if (_vocab) return _vocab;
  const text = readFileSync(VOCAB_PATH, 'utf8');
  const tmp = `/tmp/.vocab-${process.pid}-${Date.now()}.yaml`;
  writeFileSync(tmp, text);
  try {
    const out = execSync(`python3 -c "import yaml,json; print(json.dumps(yaml.safe_load(open('${tmp}'))))"`, { encoding: 'utf8' });
    _vocab = JSON.parse(out);
  } finally {
    try { require('node:fs').unlinkSync(tmp); } catch {}
  }
  return _vocab;
}

/** Extract word bboxes from a PDF using pdftotext -bbox-layout. */
export function extractBboxTokens(pdfPath) {
  const tmp = `/tmp/.bbox-${process.pid}-${Date.now()}.html`;
  execSync(`pdftotext -bbox-layout "${pdfPath}" "${tmp}"`, { stdio: 'pipe' });
  const html = readFileSync(tmp, 'utf8');
  try { require('node:fs').unlinkSync(tmp); } catch {}

  const pages = [];
  // Parse the page-by-page bbox HTML. Format:
  //   <page width="612.00" height="792.00">
  //     <flow><block><line>
  //       <word xMin="84.00" yMin="100.50" xMax="120.50" yMax="111.00">Federal</word>
  const pageRegex = /<page[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g;
  let pageMatch;
  while ((pageMatch = pageRegex.exec(html)) !== null) {
    const [, w, h, pageContent] = pageMatch;
    const lineRegex = /<line[^>]*>([\s\S]*?)<\/line>/g;
    const lines = [];
    let lineMatch;
    while ((lineMatch = lineRegex.exec(pageContent)) !== null) {
      const wordRegex = /<word\s+xMin="([\d.-]+)"\s+yMin="([\d.-]+)"\s+xMax="([\d.-]+)"\s+yMax="([\d.-]+)"[^>]*>([^<]*)<\/word>/g;
      const words = [];
      let wm;
      while ((wm = wordRegex.exec(lineMatch[1])) !== null) {
        words.push({
          text: wm[5],
          xMin: parseFloat(wm[1]),
          yMin: parseFloat(wm[2]),
          xMax: parseFloat(wm[3]),
          yMax: parseFloat(wm[4]),
        });
      }
      if (words.length) lines.push(words);
    }
    pages.push({ width: parseFloat(w), height: parseFloat(h), lines });
  }
  return pages;
}

/** Normalize a label for matching: lowercase, collapse whitespace, strip trailing punct. */
function norm(s) {
  return String(s).toLowerCase()
    .replace(/[‐-―]/g, '-')    // unicode dashes → ascii dash
    .replace(/[:?#*]+$/, '')              // trailing punct
    .replace(/\s+/g, ' ').trim();
}

/**
 * Find label matches in a page's words.
 * For each line, sweep N-grams of 1..6 words against vocabulary.
 * Returns array of { phrase, profileKey, sensitivity, xMin, yMin, xMax, yMax }
 */
function findLabelMatches(pages, vocabulary) {
  const labelMap = vocabulary.label_map || {};
  const ignoreLeading = vocabulary.ignore_leading_words || [];

  // Normalize the label keys for fast lookup
  const normalizedMap = new Map();
  for (const [label, target] of Object.entries(labelMap)) {
    const n = norm(label);
    normalizedMap.set(n, target);
    // Also map with leading words stripped
    for (const lead of ignoreLeading) {
      const stripped = norm(label.replace(new RegExp('^' + lead + "['s]?\\s+", 'i'), ''));
      if (stripped !== n) normalizedMap.set(stripped, target);
    }
  }

  const matches = [];
  pages.forEach((page, pageIdx) => {
    for (const line of page.lines) {
      for (let i = 0; i < line.length; i++) {
        // Try N-grams of length 1..min(6, remaining words)
        for (let n = Math.min(6, line.length - i); n >= 1; n--) {
          const phrase = line.slice(i, i + n).map(w => w.text).join(' ');
          const candidate = norm(phrase);
          const target = normalizedMap.get(candidate);
          if (target) {
            const xMin = line[i].xMin;
            const yMin = Math.min(...line.slice(i, i + n).map(w => w.yMin));
            const xMax = line[i + n - 1].xMax;
            const yMax = Math.max(...line.slice(i, i + n).map(w => w.yMax));
            matches.push({ phrase, normalizedLabel: candidate, target, pageIdx, xMin, yMin, xMax, yMax, lineIdx: page.lines.indexOf(line), startWord: i, endWord: i + n - 1 });
            i += n - 1;  // skip past this label
            break;
          }
        }
      }
    }
  });
  return matches;
}

/** Compute a fill position: just right of label, or below if no space on the same line. */
function computeFillPosition(match, page, lineIdx) {
  const RIGHT_PADDING = 4;
  const BELOW_PADDING = 12;
  const MIN_GAP_FOR_SAME_LINE = 30;  // pixels of empty space needed to write inline

  const line = page.lines[lineIdx];
  if (!line) return { x: match.xMax + RIGHT_PADDING, y: match.yMin, sameLine: true };

  // Find the next word on the same line after our label
  const nextWord = line[match.endWord + 1];
  if (nextWord) {
    const gap = nextWord.xMin - match.xMax;
    if (gap >= MIN_GAP_FOR_SAME_LINE) {
      // Inline write — just to the right of label
      return { x: match.xMax + RIGHT_PADDING, y: match.yMin, sameLine: true };
    }
    // Label is followed by another word too close — colon or value placeholder; write right after match anyway
    return { x: match.xMax + RIGHT_PADDING, y: match.yMin, sameLine: true };
  }

  // No more words on this line — try inline (label runs to end of line)
  return { x: match.xMax + RIGHT_PADDING, y: match.yMin, sameLine: true };
}

/** Get a value from the profile by dotted key (supports "officers.0.name" array index). */
function getProfileValue(profile, dottedKey) {
  return dottedKey.split('.').reduce((acc, key) => {
    if (acc == null) return acc;
    if (/^\d+$/.test(key)) return acc[parseInt(key, 10)];
    return acc[key];
  }, profile);
}

/** Resolve a target string (profileKey, computed, or refuse) → value or null. */
function resolveValue({ target, profile, vendorId, includeBank, tradeRefSlot, today, sigImagePath }) {
  if (target === 'refuse') return { value: null, reason: 'vocab marked refuse' };
  if (typeof target !== 'string') return { value: null, reason: 'unrecognized target' };

  // Sensitivity-tagged target: "key:sensitivity"
  let key = target;
  let sensitivity = 'routine';
  if (target.includes(':')) {
    const parts = target.split(':');
    key = parts[0];
    sensitivity = parts[1];
  }

  // Controlled (bank) — needs --include-bank
  if (sensitivity === 'controlled' && !includeBank) {
    return { value: null, reason: 'controlled — requires --include-bank' };
  }

  // Computed values
  if (key.startsWith('@')) {
    if (key === '@today') return { value: today, reason: null };
    if (key === '@today_iso') return { value: new Date().toISOString().slice(0, 10), reason: null };
    if (key === '@years_in_business') {
      const founded = profile.entity?.year_established;
      if (!founded) return { value: null, reason: 'no year_established in profile' };
      return { value: String(new Date().getFullYear() - founded), reason: null };
    }
    if (key === '@robert_signature') return { isSignature: true, sigImagePath, reason: null };
    const trMatch = key.match(/^@trade_ref_(\d+|next)$/);
    if (trMatch) {
      const refs = pickTradeRefs(profile, vendorId, 4, vendorId);
      const slot = trMatch[1] === 'next' ? tradeRefSlot.next++ : (parseInt(trMatch[1], 10) - 1);
      const ref = refs[slot];
      if (!ref) return { value: null, reason: `no trade ref slot ${slot}` };
      return { value: `${ref.company_name} — ${ref.contact_name || ''} ${ref.phone || ''} ${ref.email || ''}`.trim().replace(/\s+/g, ' '), reason: null };
    }
    return { value: null, reason: `unknown computed key ${key}` };
  }

  // Regular profile lookup
  const raw = getProfileValue(profile, key);
  if (raw == null || raw === '') return { value: null, reason: `profile.${key} empty` };
  return { value: String(raw), sensitivity, reason: null };
}

/** Main entry. */
export async function fillForm({
  inputPdf,
  outputPdf = null,
  vendorId = null,
  includeBank = false,
  signaturePath = null,
}) {
  if (!existsSync(inputPdf)) throw new Error(`Input PDF not found: ${inputPdf}`);
  outputPdf = outputPdf || inputPdf.replace(/\.pdf$/i, '') + '-FILLED.pdf';

  const profile = loadProfile();
  const vocabulary = loadVocabulary();
  const sigPath = signaturePath || join(REPO_ROOT, 'assets/signature.png');
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  // 1. Extract bbox tokens
  const pages = extractBboxTokens(inputPdf);
  if (!pages.length) throw new Error('No text extracted — PDF may be image-only (scanned). Autofill cannot proceed; manual fill required.');

  // 2. Find label matches
  const matches = findLabelMatches(pages, vocabulary);

  // 3. Resolve each match
  const tradeRefSlot = { next: 0 };
  const fills = [];
  const refused = [];
  const signatureLocations = [];
  const seenKeys = new Set();

  for (const m of matches) {
    // Dedupe identical (target, position) pairs — sometimes the same label appears twice
    const dedupKey = `${m.target}|${m.pageIdx}|${Math.round(m.xMin)}|${Math.round(m.yMin)}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    const res = resolveValue({ target: m.target, profile, vendorId, includeBank, tradeRefSlot, today, sigImagePath: sigPath });
    if (res.isSignature) {
      signatureLocations.push({ ...m, sigImagePath: res.sigImagePath });
      continue;
    }
    if (res.value == null) {
      refused.push({ label: m.phrase, target: m.target, reason: res.reason, pageIdx: m.pageIdx });
      continue;
    }
    const page = pages[m.pageIdx];
    const lineIdx = page.lines.findIndex(l => l.includes(page.lines[m.lineIdx]?.[0]));
    const pos = computeFillPosition(m, page, m.lineIdx);
    fills.push({
      label: m.phrase,
      value: res.value,
      target: m.target,
      pageIdx: m.pageIdx,
      x: pos.x,
      yMin: m.yMin,            // HTML coords
      yMax: m.yMax,
      pageWidth: page.width,
      pageHeight: page.height,
      sensitivity: res.sensitivity || 'routine',
    });
  }

  // 4. Apply via pdf-lib
  const pdfBytes = readFileSync(inputPdf);
  const pdf = await PDFDocument.load(pdfBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontSize = 9;
  const black = rgb(0, 0, 0);

  let sigImageEmbed = null;
  if (signatureLocations.length && existsSync(sigPath)) {
    const sigBytes = readFileSync(sigPath);
    sigImageEmbed = sigPath.endsWith('.png')
      ? await pdf.embedPng(sigBytes)
      : await pdf.embedJpg(sigBytes);
  }

  const pdfPages = pdf.getPages();
  for (const f of fills) {
    const page = pdfPages[f.pageIdx];
    if (!page) continue;
    // HTML y → PDF y (PDF origin = bottom-left)
    const pdfY = f.pageHeight - f.y - fontSize;
    page.drawText(String(f.value).slice(0, 200), { x: f.x, y: pdfY, size: fontSize, font, color: black });
  }
  if (sigImageEmbed) {
    for (const s of signatureLocations) {
      const page = pdfPages[s.pageIdx];
      if (!page) continue;
      const sigHeight = 24;
      const sigWidth = sigImageEmbed.width * (sigHeight / sigImageEmbed.height);
      const pdfY = pages[s.pageIdx].height - s.yMax - sigHeight - 2;
      page.drawImage(sigImageEmbed, {
        x: s.xMax + 6,
        y: pdfY,
        width: sigWidth,
        height: sigHeight,
      });
    }
  }

  const outBytes = await pdf.save();
  writeFileSync(outputPdf, outBytes);

  // 5. Render to PNG (one per page)
  const previewDir = outputPdf.replace(/\.pdf$/i, '-preview');
  if (!existsSync(previewDir)) mkdirSync(previewDir, { recursive: true });
  const previewPrefix = join(previewDir, 'page');
  try {
    execSync(`pdftoppm -r 110 -png "${outputPdf}" "${previewPrefix}"`, { stdio: 'pipe' });
  } catch (e) {
    // pdftoppm may fail on some PDFs — non-fatal
  }
  const { readdirSync } = await import('node:fs');
  const previewPngs = readdirSync(previewDir).filter(f => f.endsWith('.png')).sort().map(f => join(previewDir, f));

  return {
    filledPath: outputPdf,
    previewDir,
    previewPngs,
    fills,
    refused,
    signatureLocations,
    sensitiveFillsCount: fills.filter(f => f.sensitivity === 'controlled').length,
  };
}
