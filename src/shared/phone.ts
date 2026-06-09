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
