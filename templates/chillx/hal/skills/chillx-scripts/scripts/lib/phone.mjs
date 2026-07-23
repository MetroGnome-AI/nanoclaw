// Shared phone helpers for CHILLX. Two functions, two distinct purposes — keep
// them separate; they are NOT interchangeable.
//
//   phoneDigits(p) — the MATCH KEY. Strips to digits and drops a leading US '1'
//     from 11-digit numbers. This is what every dedupe / lookup / SMS+call
//     thread-unification path keys on. NEVER change its output shape.
//     (Identical to the receptionist's normalizePhone.)
//
//   formatPhone(p) — DISPLAY / STORAGE formatting only. A 10-digit US number
//     (or an 11-digit '1'-prefixed one) renders as 'XXX-XXX-XXXX' — hyphens,
//     canonical, NEVER dots and NEVER a '+1'. Everything else (short codes,
//     extensions, international, junk) passes through byte-for-byte unchanged.
//
// Both are pure: no I/O, no side effects.

export function phoneDigits(p) {
  const digits = String(p == null ? '' : p).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function formatPhone(p) {
  let d = String(p == null ? '' : p).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  return p; // pass-through: short codes, extensions, intl, junk left unchanged
}
