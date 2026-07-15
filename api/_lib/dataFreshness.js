// api/_lib/dataFreshness.js
//
// Data-freshness monitor. The Shadow-Mirror status ("green light") only reports
// whether the last mirror RUN errored — it never asks whether any data feed is
// actually current, so a feed that silently freezes (e.g. an orphaned on-hand
// table) stays green forever. This checks the AGE of each key feed's newest row
// and flags the stale ones, so "green" can be made to mean "fresh".
//
// evaluateFreshness() is pure (given the latest timestamps + now) and unit-
// tested; fetchFeedFreshness() does the IO.

// Each feed: the table + the column that advances when it refreshes, and the
// max age (hours) before it's considered stale. dateOnly cols (snapshot_date)
// are treated as midnight UTC.
export const FEED_CHECKS = [
  { key: "onhand_planning", label: "Planning on-hand (ip_inventory_snapshot, xoro)", table: "ip_inventory_snapshot", col: "snapshot_date", dateOnly: true, filter: { source: "tangerine" }, maxAgeHours: 40 },
  { key: "onhand_layers", label: "Live on-hand layers (inventory_layers, xoro_rest_size)", table: "inventory_layers", col: "created_at", filter: { source_kind: "xoro_rest_size" }, maxAgeHours: 40 },
  { key: "sales_wholesale", label: "Wholesale sales history", table: "ip_sales_history_wholesale", col: "created_at", maxAgeHours: 48 },
  { key: "open_pos", label: "Open POs (PO WIP / tanda_pos)", table: "tanda_pos", col: "synced_at", maxAgeHours: 48 },
  { key: "receipts", label: "Receipts history", table: "ip_receipts_history", col: "created_at", maxAgeHours: 48 },
];

// Pure: map of feedKey -> latest ISO timestamp (or null) → freshness verdict.
export function evaluateFreshness(latestByFeed, nowMs, checks = FEED_CHECKS) {
  const feeds = checks.map((c) => {
    const iso = latestByFeed?.[c.key] ?? null;
    if (!iso) {
      return { key: c.key, label: c.label, latest: null, age_hours: null, max_age_hours: c.maxAgeHours, stale: true, reason: "no rows" };
    }
    // snapshot_date (date-only) → treat as midnight UTC of that day.
    const ms = Date.parse(c.dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
    const ageH = Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / 3_600_000) : null;
    const stale = ageH == null || ageH > c.maxAgeHours;
    return { key: c.key, label: c.label, latest: iso, age_hours: ageH == null ? null : Math.round(ageH * 10) / 10, max_age_hours: c.maxAgeHours, stale };
  });
  const staleFeeds = feeds.filter((f) => f.stale);
  return { checked_at_ms: nowMs, any_stale: staleFeeds.length > 0, stale_count: staleFeeds.length, feeds };
}

// IO: read the newest row per feed, then evaluate. Best-effort per feed — a
// query error marks that feed unknown/stale rather than failing the whole check.
export async function fetchFeedFreshness(admin, now = () => new Date(), checks = FEED_CHECKS) {
  const latest = {};
  for (const c of checks) {
    try {
      let q = admin.from(c.table).select(c.col).order(c.col, { ascending: false }).limit(1);
      for (const [k, v] of Object.entries(c.filter || {})) q = q.eq(k, v);
      const { data, error } = await q.maybeSingle();
      latest[c.key] = error ? null : (data?.[c.col] ?? null);
    } catch {
      latest[c.key] = null;
    }
  }
  return evaluateFreshness(latest, now().getTime(), checks);
}
