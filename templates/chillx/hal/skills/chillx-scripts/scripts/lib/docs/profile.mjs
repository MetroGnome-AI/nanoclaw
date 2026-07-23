/**
 * scripts/lib/docs/profile.mjs
 *
 * Load the canonical CHILLX business profile and enforce sensitivity tags.
 *
 * Profile lives at data/business-profile/chillx.yaml. This module:
 *   - parses it
 *   - exposes a typed accessor with sensitivity enforcement
 *   - refuses to return signed-pdf-only / restricted fields from non-PDF-attachment paths
 *
 * Sensitivity model (see chillx.yaml header):
 *   public          — any context
 *   routine         — business forms, vendor onboarding; not marketing copy
 *   signed-pdf-only — must be sent via attached PDF (voided check, wire instructions)
 *   restricted      — fills only slots explicitly asking for that exact field
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from '../vendor/js-yaml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = process.env.CHILLX_PROFILE
  || resolve(process.env.CHILLX_PROFILE_DIR || '/workspace/extra/business-profile', 'chillx.yaml');

let _cached = null;

/** Parse YAML via vendored js-yaml (agent container has no python3/PyYAML). */
function parseYaml(text) {
  return yamlLoad(text);
}

export function loadProfile() {
  if (_cached) return _cached;
  const text = readFileSync(PROFILE_PATH, 'utf8');
  _cached = parseYaml(text);
  return _cached;
}

export const SENSITIVITY = {
  public: 0,                  // OK anywhere
  routine: 1,                 // OK in business forms, inline emails
  controlled: 2,              // bank account/routing — autofill into one form WITH per-request approval; never circulate
  'signed-pdf-only': 3,       // attached PDF only (legacy — currently unused after bank-detail rule change)
  restricted: 4,              // only fills slots that explicitly name the exact field (officer home addr, SSN)
};

/**
 * Get the sensitivity tag for a dotted key path.
 * Convention: `parent.fieldname_sensitivity` overrides default for `parent.fieldname`.
 * If unset, default = 'routine'.
 */
export function sensitivityOf(profile, dottedKey) {
  const parts = dottedKey.split('.');
  const last = parts.pop();
  let parent = profile;
  for (const p of parts) {
    if (parent == null) return 'routine';
    parent = parent[p];
  }
  if (!parent || typeof parent !== 'object') return 'routine';
  const explicit = parent[`${last}_sensitivity`];
  if (explicit) return explicit;
  return 'routine';
}

/**
 * Check if a field can be released in a given context.
 * Context is one of: 'inline-email', 'attached-pdf', 'business-form', 'marketing-copy'.
 *
 * Rules:
 *   inline-email     — public + routine OK; signed-pdf-only + restricted = REFUSE
 *   attached-pdf     — all sensitivity tags OK (consumer takes responsibility)
 *   business-form    — public + routine + restricted OK if slot asks explicitly; signed-pdf-only = REFUSE
 *   marketing-copy   — only public
 */
export function canRelease(sensitivity, context, options = {}) {
  if (context === 'attached-pdf') return true;
  if (context === 'marketing-copy') return sensitivity === 'public';
  if (context === 'inline-email') {
    return sensitivity === 'public' || sensitivity === 'routine';
  }
  if (context === 'business-form') {
    if (sensitivity === 'signed-pdf-only') return false;
    if (sensitivity === 'controlled') return options.includeBank === true;
    if (sensitivity === 'restricted') return options.slotExplicitlyAsksForRestrictedField === true;
    return true;
  }
  throw new Error(`Unknown context: ${context}`);
}

/**
 * Return a "safe profile" — same shape but every signed-pdf-only field replaced
 * with the literal string '<<see-attached-pdf>>' and every restricted field with
 * '<<restricted>>'. Used when building business forms / email bodies.
 */
export function safeProfile(profile, context, options = {}) {
  const walk = (obj, path = '') => {
    if (obj == null) return obj;
    if (Array.isArray(obj)) return obj.map((v, i) => walk(v, `${path}[${i}]`));
    if (typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.endsWith('_sensitivity')) { out[k] = v; continue; }
      const dotted = path ? `${path}.${k}` : k;
      const sens = sensitivityOf(profile, dotted);
      if (!canRelease(sens, context, options)) {
        out[k] = sens === 'signed-pdf-only' ? '<<see-attached-pdf>>' : '<<restricted>>';
      } else {
        out[k] = walk(v, dotted);
      }
    }
    return out;
  };
  return walk(profile);
}

/** Return canonical attachment paths for the given doc names. */
export function getAttachmentPaths(profile, docNames) {
  const map = profile.attachments || {};
  const out = {};
  for (const name of docNames) {
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const candidates = [
      key,
      `${key}_pdf`,
      key.replace(/_pdf$/, '') + '_pdf',
    ];
    for (const c of candidates) {
      if (map[c]) { out[name] = map[c]; break; }
    }
    if (!out[name]) out[name] = null;
  }
  return out;
}

/**
 * Pick N trade references for a target vendor.
 *
 * Rules:
 *   - Never include a ref whose exclude_when matches the target vendor id
 *   - Prefer refs whose `categories` overlap with the vendor's `vendor_category_hints`
 *   - Within equally-relevant refs, prefer `relationship: strong > good > casual`
 *   - If `seed` given, do deterministic rotation (so the same form gets the same refs)
 *
 * @param profile - loaded business profile
 * @param vendorId - target vendor id (matches vendor_category_hints key)
 * @param n - number of refs to return (default 3)
 * @param seed - optional seed string for deterministic rotation
 */
export function pickTradeRefs(profile, vendorId = null, n = 3, seed = null) {
  const hints = profile.vendor_category_hints || {};
  const categories = hints[vendorId] || hints._default || ['general'];

  const pool = (profile.trade_references || []).filter(r => {
    const excl = r.exclude_when || [];
    return !excl.includes(vendorId);
  });

  const RELATIONSHIP_WEIGHT = { strong: 3, good: 2, casual: 1, '': 0 };
  const score = (r) => {
    const cats = r.categories || [];
    const overlap = cats.filter(c => categories.includes(c)).length;
    return overlap * 10 + (RELATIONSHIP_WEIGHT[r.relationship] || 0);
  };

  // Sort by score desc, then by id for stable tie-breaking
  const scored = pool.map(r => ({ r, s: score(r) }))
    .sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id));

  // Rotate ONLY within equal-score buckets — relevance always wins
  if (seed && scored.length > n) {
    const hash = String(seed).split('').reduce((a, c) => ((a * 31) + c.charCodeAt(0)) | 0, 0);
    const buckets = new Map();
    for (const x of scored) {
      if (!buckets.has(x.s)) buckets.set(x.s, []);
      buckets.get(x.s).push(x.r);
    }
    const rotated = [];
    for (const [, bucket] of buckets) {
      const offset = Math.abs(hash) % bucket.length;
      rotated.push(...bucket.slice(offset), ...bucket.slice(0, offset));
    }
    return rotated.slice(0, n);
  }
  return scored.map(x => x.r).slice(0, n);
}
