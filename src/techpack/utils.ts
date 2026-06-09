// Pure helpers shared across the TechPack app: id generator, today's
// date in YYYY-MM-DD, MM/DD/YYYY date formatter, and the $ currency
// formatter with comma grouping.
//
// Extracted from TechPack.tsx so future panel splits + the empty-
// state factories can import the same primitives without round-tripping
// through the 4k-line monolith.

/** 8-char random alphanumeric + epoch-tail. Sufficient uniqueness for
 *  client-side keys; never collides in practice during one session. */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Today's date in YYYY-MM-DD (UTC slice of ISO). Used as createdAt /
 *  updatedAt seed; matches how the rest of the app stores dates. */
export function today(): string {
  return new Date().toISOString().split("T")[0];
}

/** Render a date as DD/MM/YYYY for the operator. Null / empty / un-
 *  parseable input renders the em-dash placeholder. */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString("en-GB", { month: "2-digit", day: "2-digit", year: "numeric" });
  } catch {
    return d;
  }
}

/** Currency formatter: 2-decimal money with thousands separators.
 *  Locale-free implementation so tests are deterministic. */
export function fmtCurrency(n: number): string {
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Up-to-2-character initials from a display name. Splits on
 * whitespace, takes the first char of each word, joins +
 * uppercases. Used for avatar circles in the Teams + DM panels.
 *   "Eran Bitton"      → "EB"
 *   "single"           → "S"
 *   "a b c d"          → "AB" (capped at 2)
 *   ""                 → "" (caller can fall back to "??")
 */
export function initials(name: string): string {
  return name
    .split(" ")
    .map(w => w[0] || "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Strip every HTML tag from a string + trim the result. Used to
 * render Graph message bodies (which arrive as HTML) as a single
 * plain-text preview line in the Teams panel. Empty / null /
 * undefined input returns "".
 */
export function stripHtml(html: string | null | undefined): string {
  return (html || "").replace(/<[^>]+>/g, "").trim();
}
