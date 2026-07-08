// Color canonicalization — frontend mirror of api/_lib/styleMatrix.js canonColor.
// KEEP IN SYNC. The same physical color arrives spelled differently (CASE:
// "Black" vs "BLACK"; abbreviation: "Light Wash" vs "Lt Wash", "…with Tint" vs
// "…w Tint"; punctuation: "Navy/Peach" vs "NAVY/PEACH"). The matrix groups rows
// by the raw `color` string, so variants split into duplicate rows. Map every
// spelling to ONE canonical, display-friendly label so the frontend seed (from a
// document's raw line colors) lands on the same canonical row the backend
// payload builds. DETERMINISTIC — independent of which variants are present.
const COLOR_ABBREV: Record<string, string> = { LT: "LIGHT", DK: "DARK", MED: "MEDIUM", W: "WITH", WTH: "WITH", BLCK: "BLACK", CBO: "COMBO", CAM: "CAMO" };

export function canonColor(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return s;
  const words = s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(" ");
  return words
    .map((w) => COLOR_ABBREV[w] || w)
    .map((w) => (w ? w[0] + w.slice(1).toLowerCase() : w))
    .join(" ");
}
