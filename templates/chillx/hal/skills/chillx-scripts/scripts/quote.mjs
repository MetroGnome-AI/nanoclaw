#!/usr/bin/env node
/**
 * scripts/quote.mjs — single entry point for shipping rate quotes.
 *
 * Destination + dims → carrier-picked, density-classed, ×markup rate table.
 * Read-only — never books, never writes ERPNext.
 *
 * Usage:
 *   node scripts/quote.mjs --so SO-2026-04175 --dims 48x42x75 --weight 190
 *   node scripts/quote.mjs --drupal 43293 --dims 48x42x75 --weight 190
 *   node scripts/quote.mjs --quote Q-2026-03268               # dims auto-pulled from the quote's item
 *   node scripts/quote.mjs --lead CRM-LEAD-2026-00105 --billing --willcall --dims 42x48x50 --weight 145 --echo
 *   node scripts/quote.mjs --to "Berino,NM,88024" --dims 20x20x20 --weight 19 --fedex --residential
 *
 * Destination (one): --so | --quote | --lead | --drupal | --to "City,ST,ZIP"
 * Package: --dims LxWxH (in), --weight N (lb). Auto-pulled from the resolved doc's
 *          first item description if omitted and available.
 *          --item <code|keyword>  resolve class/NMFC/weight from past shipments (EchoShip
 *                  cache) + dims from the Item master. e.g. --item "4 ton low profile".
 *                  LTL rates on class+weight, so dims are optional when a class is found.
 * Address: --billing (use billing addr instead of shipping; will-call default)
 * Mode:    --fedex | --echo  (default: auto — LTL if ≥150 lb or any dim > 48")
 * Will-call: --willcall   (strip ALL accessorials — terminal/dock pickup, no delivery)
 * LTL:     --nmfc NNNNN (default 114115) --class NN (default density-derived)
 *          --liftgate  --residential   (ignored under --willcall)
 * Other:   --markup 1.165  --pickup YYYY-MM-DD
 *          --all  (LTL: show every carrier, not just cheapest 15; FedEx: show Express too)
 * LTL view always pins FedEx Freight (Economy + Priority, marked ★) — our go-to carriers —
 * even when they fall outside the cheapest-15 window. TForce is always excluded.
 */
import { readFileSync } from 'node:fs';
import { getRates } from './lib/shipping/echoship.mjs';
import { getRate as fedexRate } from './lib/shipping/fedex.mjs';
import { resolveDestination } from './lib/shipping/resolve-destination.mjs';
import { resolveDims, extractDims } from './lib/shipping/dims.mjs';
import { getDoc } from './lib/shipping/erp.mjs';
import { logRun } from './lib/intro/run-log.mjs';

// v2 container: env file lives in the agent group workspace (machine-local, not in git).
let _envText = '';
try { _envText = readFileSync(process.env.CHILLX_ENV_FILE || '/workspace/agent/.chillx-env', 'utf8'); } catch { /* rely on process.env */ }
for (const line of _envText.split('\n')) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const ORIGIN = { city: 'BERTRAM', state: 'TX', zip: '78605' };
const DEFAULT_MARKUP = 1.165;

// Carriers we never book — silently filtered from every quote (user directive 2026-06-17).
const BLOCKED_CARRIERS = [/tforce/i, /t-?\s*force/i];
// Our default LTL carriers — always surfaced in the quote, even outside the cheapest-N window.
const PREFERRED_CARRIERS = [/fedex/i]; // EchoShip returns these as "FedEx Economy" / "FedEx Priority"

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function classFromDensity(pcf) {
  if (pcf < 1) return '400';
  if (pcf < 2) return '300';
  if (pcf < 4) return '250';
  if (pcf < 6) return '175';
  if (pcf < 8) return '150';
  if (pcf < 10) return '125';
  if (pcf < 12) return '110';
  if (pcf < 15) return '100';
  if (pcf < 22.5) return '92.5';
  if (pcf < 30) return '85';
  return '70';
}

// Resolve a freight profile for `--item <code|keyword>` so common products quote in one
// line. Sources, best-effort + non-blocking:
//   1. Item master (ERPNext): canonical name (for cache matching) + dims via extractDims
//   2. EchoShip sweeper cache: class / NMFC / weight from the most recent matching past BOL
// Returns { weight, nmfcClass, nmfcNumber, dims:{length,width,height}|null, sources }.
const PROFILE_CACHE = process.env.ECHOSHIP_CACHE || '/workspace/agent/data/echoship/shipments.json';
const PROFILE_STOP = new Set(['chillx', 'chillking', 'dragon', 'breath', 'the', 'and', 'with', 'for']);
const normDesc = (s) => String(s || '').toLowerCase().replace(/^\(\d+\)\s*/, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function resolveFreightProfile(itemArg) {
  const out = { weight: null, nmfcClass: null, nmfcNumber: null, dims: null, sources: [] };
  let key = String(itemArg);
  try {
    const im = await getDoc('Item', itemArg);
    if (im?.item_name) key = im.item_name;
    const dm = extractDims(im?.description);
    if (dm) { out.dims = { length: dm.length, width: dm.width, height: dm.height }; out.weight = dm.weight_lb ?? null; out.sources.push('item-master'); }
  } catch { /* ERPNext down or not a real item code — fall through to the cache */ }
  try {
    const cache = JSON.parse(readFileSync(PROFILE_CACHE, 'utf8'));
    const keyTokens = normDesc(key).split(' ').filter((t) => t && (t.length > 2 || /\d/.test(t)) && !PROFILE_STOP.has(t));
    let best = null, bestScore = 0, bestDate = '';
    for (const s of Object.values(cache.shipments || {})) {
      for (const it of (s.items || [])) {
        if (!keyTokens.length) continue;
        const d = normDesc(it.description);
        const score = keyTokens.filter((t) => d.includes(t)).length / keyTokens.length;
        const date = s.lastEmailDate || s.pickupDate || '';
        if (score >= 0.7 && (score > bestScore || (score === bestScore && date > bestDate))) { best = { s, it }; bestScore = score; bestDate = date; }
      }
    }
    if (best) {
      out.nmfcClass = out.nmfcClass || best.it.class || null;
      out.nmfcNumber = out.nmfcNumber || best.it.nmfc || null;
      out.weight = out.weight ?? best.it.weight ?? null;
      out.sources.push(`echoship-cache(BOL ${best.s.bol})`);
    }
  } catch { /* no cache yet */ }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();

  const dest = await resolveDestination({
    so: args.so, quote: args.quote, lead: args.lead, drupal: args.drupal, to: args.to,
    billing: !!args.billing, residential: !!args.residential,
  });
  if (!dest.address.zip) throw new Error(`Could not resolve a destination ZIP (got ${JSON.stringify(dest.address)})`);

  // --item: auto-resolve a freight profile (class/NMFC/weight from real past shipments,
  // dims from the Item master) so common products quote in one line instead of
  // hand-typing --weight/--class/--nmfc/--dims.
  if (args.item) {
    const fp = await resolveFreightProfile(args.item);
    if (fp.weight == null && fp.nmfcClass == null) {
      throw new Error(`--item "${args.item}": no freight profile found (EchoShip cache + Item master). Run "echoship-sweep sweep", or pass --weight/--class/--nmfc/--dims.`);
    }
    if (fp.weight != null && args.weight == null) args.weight = String(fp.weight);
    if (fp.nmfcClass && !args.class) args.class = fp.nmfcClass;
    if (fp.nmfcNumber && !args.nmfc) args.nmfc = fp.nmfcNumber;
    if (fp.dims && !args.dims) args.dims = `${fp.dims.length}x${fp.dims.width}x${fp.dims.height}`;
    if (!args.fedex && !args.echo) args.echo = true; // products resolved by --item are LTL by default
    console.log(`[quote] --item "${args.item}" → class ${fp.nmfcClass || '?'} / NMFC ${fp.nmfcNumber || '?'} / ${fp.weight ?? '?'}lb${fp.dims ? ` / ${fp.dims.length}x${fp.dims.width}x${fp.dims.height}` : ' / dims n/a'}  [${fp.sources.join(', ') || 'no match'}]`);
  }

  // Dims: explicit flags, else the resolved doc's first item description. LTL can rate on
  // class + weight alone, so dims are OPTIONAL when an explicit --class is present.
  const itemDesc = dest.doc?.items?.[0]?.description || null;
  const dims = resolveDims({ dimsArg: args.dims, weightArg: args.weight, itemDescription: itemDesc });
  const weight = dims ? dims.weight_lb : (args.weight != null && args.weight !== '' ? parseFloat(args.weight) : null);
  const L = dims?.length ?? null, W = dims?.width ?? null, H = dims?.height ?? null;
  const haveDims = L != null && W != null && H != null;
  const markup = parseFloat(args.markup) || DEFAULT_MARKUP;

  const maxDim = haveDims ? Math.max(L, W, H) : 0;
  const mode = args.fedex ? 'fedex' : args.echo ? 'echo' : (weight >= 150 || maxDim > 48) ? 'echo' : 'fedex';

  // FedEx parcel needs real dims (dim weight); LTL rates on class + weight.
  if (mode === 'fedex' && !haveDims) throw new Error('FedEx parcel needs --dims LxWxH and --weight N.');
  if (mode === 'echo' && weight == null) throw new Error('LTL needs --weight N (plus --class, or --dims to derive class).');
  if (mode === 'echo' && !haveDims && !args.class) throw new Error('LTL without dims needs an explicit --class (or pass --dims to derive it).');

  const cubicFt = haveDims ? (L * W * H) / 1728 : null;
  const pcf = cubicFt ? weight / cubicFt : null;
  const a = dest.address;

  console.log(`[quote] ${dest.company} → ${a.city}, ${a.state} ${a.zip}  (${dest.source}${args.billing ? ', billing addr' : ''})`);
  const pkgStr = haveDims ? `${L}x${W}x${H}" @ ${weight}lb  |  ${cubicFt.toFixed(1)}ft³  density ${pcf.toFixed(2)} PCF` : `${weight}lb  |  no dims — class-rated`;
  console.log(`[quote] ${pkgStr}  |  mode: ${mode.toUpperCase()}${args.fedex || args.echo ? '' : ' (auto)'}${args.willcall ? '  |  WILL-CALL (no accessorials)' : ''}${dims ? `  |  dims:${dims.source}` : ''}`);

  let rows = [];
  if (mode === 'echo') {
    const cls = args.class || classFromDensity(pcf);
    const nmfc = args.nmfc || '114115';
    let accessorials = [];
    if (!args.willcall) {
      accessorials = ['NOTIFYPRIORTODELIVERY'];
      if (args.liftgate) accessorials.push('LIFTGATEREQUIRED');
      if (a.residential) accessorials.push('RESIDENTIAL');
      if (args.restricted) accessorials.push('LIMITEDACCESSDELIVERY');  // FedEx Freight "Limited Access Delivery"
      if (args.inside) accessorials.push('INSIDEDELIVERY');
    }
    console.log(`[quote] LTL: NMFC ${nmfc} class ${cls}  accessorials: ${accessorials.length ? accessorials.join(', ') : '(none — will-call)'}`);
    const pickup = args.pickup || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const resp = await getRates({
      pickupDate: pickup, origin: ORIGIN,
      destination: { city: a.city, state: a.state, zip: a.zip },
      items: [{ description: args.desc || (dest.doc?.items?.[0]?.item_name) || 'CHILLX equipment, palletized', nmfcClass: cls, nmfcNumber: nmfc, weight, length: L, width: W, height: H, handlingUnitType: 'PALLETS', handlingUnitQuantity: 1, quantity: 1, stackable: false }],
      accessorials,
    });
    rows = (resp.Rates || []).map(r => ({ carrier: r.CarrierName, net: Number(r.TotalCharge) || 0, transit: (r.CarrierTransitDays ?? '?') + 'd' })).sort((x, y) => x.net - y.net);
  } else {
    const groundOnly = new Set(['FEDEX_GROUND', 'GROUND_HOME_DELIVERY']);
    const rates = await fedexRate({ ship_to: { city: a.city, state: a.state, zip: a.zip, residential: a.residential }, weight_lb: weight, dimensions: { length: L, width: W, height: H } });
    rows = rates.filter(r => r.netCharge != null && (args.all || groundOnly.has(r.serviceType)))
      .map(r => ({ carrier: r.serviceType, net: r.netCharge, transit: r.transit || (r.billingWeightLb ? `bill wt ${r.billingWeightLb}lb` : '') }))
      .sort((x, y) => x.net - y.net);
  }

  rows = rows.filter(r => !BLOCKED_CARRIERS.some(re => re.test(String(r.carrier))));

  if (!rows.length) { console.log('[quote] No rates returned.'); return; }
  // FedEx Freight (Economy/Priority) are our default LTL carriers — always surface them, even
  // when they fall outside the cheapest-N window. Marked ★. (echo/LTL mode only.)
  const isPreferred = (c) => mode === 'echo' && PREFERRED_CARRIERS.some(re => re.test(String(c)));
  const show = args.all ? rows.length : Math.min(rows.length, 15);
  const pinned = rows.slice(show).filter(r => isPreferred(r.carrier));
  const display = [...rows.slice(0, show), ...pinned];
  const hidden = rows.length - display.length;
  const note = args.all ? '' : `  (cheapest ${show}${pinned.length ? ' + FedEx Freight' : ''}${hidden > 0 ? `; ${hidden} more via --all` : ''})`;
  console.log(`\n${rows.length} option(s)${note}:\n`);
  console.log('     ' + 'CARRIER'.padEnd(36) + 'NET'.padStart(9) + '   CUSTOMER'.padStart(12) + '   TRANSIT');
  display.forEach((r, i) => {
    const star = isPreferred(r.carrier) ? '★' : ' ';
    console.log(`  ${String(i + 1).padStart(2)}${star}` + String(r.carrier).slice(0, 34).padEnd(36) + ('$' + r.net.toFixed(2)).padStart(9) + ('   $' + (r.net * markup).toFixed(2)).padStart(12) + '   ' + (r.transit || ''));
  });
  console.log(`\n  (customer column = net × ${markup}${mode === 'echo' ? '; ★ = FedEx Freight, our default' : ''})`);

  await logRun({
    discipline: 'lock-execute',
    task: `quote.mjs ${mode}${args.willcall ? ' willcall' : ''} ${a.city},${a.state} ${haveDims ? `${L}x${W}x${H}` : 'no-dims'}@${weight}lb`,
    outcome: 'success',
    details: { mode, willcall: !!args.willcall, item: args.item || null, source: dest.source, dest: a, dims, pcf: pcf != null ? Number(pcf.toFixed(2)) : null, cheapest: rows[0], elapsedMs: Date.now() - startedAt, harness_held: true },
  });
}

main().catch(async (err) => {
  console.error(`\n✗ QUOTE FAILED: ${err.message}`);
  try { await logRun({ discipline: 'lock-execute', task: `quote.mjs ${process.argv.slice(2).join(' ')}`, outcome: 'failed', details: { error: err.message } }); } catch {}
  process.exit(1);
});
