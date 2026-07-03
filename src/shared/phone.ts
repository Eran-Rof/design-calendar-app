// src/shared/phone.ts
//
// Force the US phone mask (XXX) XXX-XXXX as the operator types. Strips
// non-digits, caps at 10, and renders only as many groups as there are digits
// so partial entry isn't jarring. Pasting "5551234567" or "+1 (555) 123-4567"
// both normalise. Applied everywhere a phone is entered EXCEPT the Vendor
// master (vendors are frequently overseas, so their phones stay free-form).
//
// Lifted from the original inline helper in InternalEmployees so every panel
// shares one mask. A value beginning with "+" is treated as an explicit
// international number and passed through untouched rather than mangled into
// the US shape.
export function formatUsPhone(raw: string): string {
  const s = raw || "";
  if (s.trim().startsWith("+")) return s; // international — leave as typed
  const d = s.replace(/\D/g, "").slice(0, 10);
  if (d.length === 0) return "";
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// ── Vendor / Fabric phone country-code composition ──────────────────────────
// A separate dial-code field (numeric E.164 calling code, e.g. 1, 44, 880)
// drives the format of the number itself:
//   • code "1" (NANP, US/Canada) → national mask (NNN) NNN-NNNN
//   • every other country        → E.164  +<code><national digits>
// composePhone builds the stored/canonical value; localPhoneDigits recovers the
// national-number portion for the editable number box given the dial code.

export function composePhone(dialCode: string | number, raw: string): string {
  const code = String(dialCode ?? "").replace(/\D/g, "");
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (code === "1" || code === "") {
    const d = digits.slice(-10);
    if (d.length < 4) return `(${d}`;
    if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
  }
  return `+${code}${digits}`;
}

export function localPhoneDigits(dialCode: string | number, stored: string): string {
  const code = String(dialCode ?? "").replace(/\D/g, "");
  const all = String(stored ?? "").replace(/\D/g, "");
  if (!all) return "";
  if (code === "1" || code === "") return all.slice(-10);
  return all.startsWith(code) ? all.slice(code.length) : all;
}

// Best-effort recovery of the dial code from a stored phone, used when the
// vendor predates the phone_country_code column. Needs the known code list
// (longest-prefix wins so +880… isn't read as +88…). National-format values
// (no leading +) are assumed NANP → "1".
export function dialCodeFromStored(stored: string, knownCodes: number[]): string {
  const s = String(stored ?? "").trim();
  if (!s.startsWith("+")) return "1";
  const digits = s.replace(/\D/g, "");
  let best = "";
  for (const c of knownCodes) {
    const cs = String(c);
    if (digits.startsWith(cs) && cs.length > best.length) best = cs;
  }
  return best || "1";
}
