/**
 * scripts/lib/shipping/dims.mjs
 *
 * Extract shipping dimensions and weight from ERPNext Item descriptions.
 * CHILLX convention: Item.description contains "Shipping Dimensions" or "Shipping Dims"
 * with patterns like:
 *   "Weight: 7 LBS" + "LxWxH: 14" x 8" x 6""
 *   "Dimensions: 17" x 6" x 6" @ 4.5 LBS"
 *   "DIMS: 21 x 6 x 6"
 *
 * Returns: { weight_lb, length, width, height } or throws if not found.
 * Fails LOUD — does not guess or fabricate.
 */

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractDims(itemDescription) {
  const text = stripHtml(itemDescription);

  // Weight: try "Weight: 7 LBS", "@ 4.5 LBS", "@ 7 lbs"
  let weight_lb = null;
  const wMatches = [
    /weight:\s*([\d.]+)\s*lbs?/i,
    /@\s*([\d.]+)\s*lbs?/i,
    /([\d.]+)\s*lbs?(?=\s|$|,|\))/i,
  ];
  for (const re of wMatches) {
    const m = text.match(re);
    if (m) { weight_lb = parseFloat(m[1]); break; }
  }

  // Dims: try multiple patterns
  let length = null, width = null, height = null;
  const dimMatches = [
    /(?:LxWxH|L\s*x\s*W\s*x\s*H|DIMS?|Dimensions?):\s*([\d.]+)\s*"?\s*[xX]\s*([\d.]+)\s*"?\s*[xX]\s*([\d.]+)/i,
    /([\d.]+)"\s*[xX]\s*([\d.]+)"\s*[xX]\s*([\d.]+)"?/,
    /([\d.]+)\s*[xX]\s*([\d.]+)\s*[xX]\s*([\d.]+)\s*(?:in|inches|")/i,
  ];
  for (const re of dimMatches) {
    const m = text.match(re);
    if (m) {
      length = parseFloat(m[1]);
      width = parseFloat(m[2]);
      height = parseFloat(m[3]);
      break;
    }
  }

  if (weight_lb == null || length == null || width == null || height == null) {
    return null;
  }
  return { weight_lb, length, width, height };
}

/**
 * Extract dims from an Item; throws if missing.
 * Used to fail loud rather than fabricate.
 */
export function requireDims(item) {
  const dims = extractDims(item.description) || (item.weight_per_unit ? null : null);
  if (!dims) {
    throw new Error(
      `Item ${item.item_code || item.name}: cannot extract shipping dimensions from description. ` +
      `Update the Item's description to include a "Shipping Dimensions" section with weight + LxWxH ` +
      `(e.g., "Weight: 7 LBS / LxWxH: 14" x 8" x 6"") or pass --dims/--weight overrides.`
    );
  }
  return dims;
}

/**
 * Resolve dims+weight from CLI args, falling back to an item description.
 * Single source used by both quote.mjs and ship.mjs.
 *
 * @param dimsArg  string "LxWxH" (e.g. "20x20x20") or falsy
 * @param weightArg string|number lb or falsy
 * @param itemDescription  fallback source (ERPNext item description) or null
 * @returns { weight_lb, length, width, height, source } or null if unresolved
 */
export function resolveDims({ dimsArg = null, weightArg = null, itemDescription = null } = {}) {
  let length = null, width = null, height = null, weight_lb = null;
  if (dimsArg) {
    const m = String(dimsArg).match(/^([\d.]+)\s*[xX]\s*([\d.]+)\s*[xX]\s*([\d.]+)$/);
    if (!m) throw new Error(`--dims must be LxWxH (e.g. 20x20x20), got "${dimsArg}"`);
    [length, width, height] = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  }
  if (weightArg != null && weightArg !== '') weight_lb = parseFloat(weightArg);

  // If anything is missing, fall back to the item description (extractDims).
  if (weight_lb == null || length == null) {
    const ex = itemDescription ? extractDims(itemDescription) : null;
    if (ex) {
      weight_lb = weight_lb ?? ex.weight_lb;
      length = length ?? ex.length;
      width = width ?? ex.width;
      height = height ?? ex.height;
    }
  }
  if (weight_lb == null || length == null || width == null || height == null) return null;
  const source = (dimsArg && weightArg) ? 'explicit' : (dimsArg || weightArg) ? 'explicit+item' : 'item';
  return { weight_lb, length, width, height, source };
}
