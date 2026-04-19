// Defensive parsers used at the ingest boundary. Upstream systems send
// mixed string/number types, and occasionally null or empty-string. Keep
// these pure and boring.

export function toOptionalString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") {
    return String(v);
  }
  return null;
}

export function toOptionalNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    // Strip common thousand separators and currency symbols — Xoro strings
    // occasionally arrive as "1,234.00".
    const clean = v.replace(/[,\s$]/g, "");
    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function toNumberOrZero(v: unknown): number {
  return toOptionalNumber(v) ?? 0;
}

// Accepts an ISO date, datetime, or Xoro's occasional "YYYY-MM-DD HH:MM:SS"
// and returns a YYYY-MM-DD string — or null on any failure. We intentionally
// throw nothing; the caller logs a data-quality issue instead.
export function toIsoDate(v: unknown): string | null {
  const s = toOptionalString(v);
  if (!s) return null;
  // Fast path: already "YYYY-MM-DD".
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function toIsoDateTime(v: unknown): string | null {
  const s = toOptionalString(v);
  if (!s) return null;
  const d = new Date(s.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function toBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "t", "yes", "y", "1", "active"].includes(s)) return true;
    if (["false", "f", "no", "n", "0", "inactive"].includes(s)) return false;
  }
  return fallback;
}
