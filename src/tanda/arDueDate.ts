// src/tanda/arDueDate.ts
//
// Pure due-date helper for the AR invoice editor. Mirrors the server-side
// compute_due_date RPC (payment_terms.due_days added to the anchor date) but
// runs client-side so the Due Date field can auto-populate the instant the
// operator picks payment terms or changes the invoice date.
//
// Kept dependency-free + pure so it is unit-tested in isolation.

/**
 * Returns `anchorDate` (YYYY-MM-DD) plus `dueDays` calendar days, as a
 * YYYY-MM-DD string. Returns null when either input is missing/invalid so the
 * caller can leave the field untouched.
 *
 * Uses UTC math to avoid the local-timezone off-by-one that `new Date("YYYY-MM-DD")`
 * would otherwise introduce around DST / negative offsets.
 */
export function computeDueDate(
  anchorDate: string | null | undefined,
  dueDays: number | null | undefined,
): string | null {
  if (!anchorDate || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) return null;
  if (dueDays == null || !Number.isFinite(dueDays) || dueDays < 0) return null;
  const d = new Date(anchorDate + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.round(dueDays));
  return d.toISOString().slice(0, 10);
}
