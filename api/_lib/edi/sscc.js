// api/_lib/edi/sscc.js
//
// Server-side SSCC-18 (Serial Shipping Container Code) generation for outbound
// 856 ASN carton (tare) labels. This is a faithful JS port of the browser GS1
// service (src/gs1/services/gtinService.ts) — the SAME GS1 Mod-10 algorithm —
// because the serverless EDI layer (api/_lib) cannot import the app's TS build.
// Kept pure + dependency-free so it is trivially unit-testable.
//
// SSCC-18 layout: [extension(1)][gs1_prefix(N)][serial_ref(16-N)][check(1)] = 18.

// GS1 Mod-10 check digit for an N-digit string. Positions counted from the
// RIGHT: odd → ×3, even → ×1. check = (10 − sum mod 10) mod 10.
export function gs1CheckDigit(digits) {
  const n = digits.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const posFromRight = n - i;
    sum += parseInt(digits[i], 10) * (posFromRight % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

// Build an 18-digit SSCC. gs1Prefix is the GS1 company prefix (7–10 digits
// typical); serialReference fills the remaining (16 − prefixLength) digits,
// left-padded with zeros. Throws on malformed input so a bad config fails loud.
export function buildSscc18(extensionDigit, gs1Prefix, serialReference) {
  const ext = String(extensionDigit);
  if (!/^\d$/.test(ext)) throw new Error(`buildSscc18: extension digit must be 0-9, got "${ext}"`);
  const prefix = String(gs1Prefix);
  if (!/^\d+$/.test(prefix)) throw new Error(`buildSscc18: prefix "${prefix}" must be numeric`);
  const serialLen = 16 - prefix.length;
  if (serialLen < 1) throw new Error(`buildSscc18: prefix length ${prefix.length} leaves no room for a serial reference`);
  const maxSerial = Math.pow(10, serialLen) - 1;
  const serial = Math.abs(Math.trunc(Number(serialReference) || 0)) % (maxSerial + 1);
  const base17 = `${ext}${prefix}${String(serial).padStart(serialLen, "0")}`;
  if (base17.length !== 17) throw new Error(`buildSscc18: constructed base length ${base17.length}, expected 17`);
  return `${base17}${gs1CheckDigit(base17)}`;
}

export function validateSscc18(sscc) {
  if (!/^\d{18}$/.test(String(sscc || ""))) return false;
  return gs1CheckDigit(String(sscc).slice(0, 17)) === parseInt(String(sscc)[17], 10);
}

// Deterministic non-negative integer from an arbitrary id (uuid / number / text)
// so a given shipment always mints the same SSCC serials (idempotent re-queue).
export function serialFromId(id) {
  const s = String(id ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}
