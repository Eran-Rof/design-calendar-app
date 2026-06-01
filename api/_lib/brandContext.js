// api/_lib/brandContext.js
//
// P15 Brand Master — Chunk 2: brand/channel request context.
//
// The client's <BrandSwitcher>/<ChannelSwitcher> write a per-tab selection and
// the fetch interceptor attaches it as `X-Brand-ID` / `X-Channel-ID` on every
// /api/internal call (mirrors X-Entity-ID). This module reads + validates that
// context and provides a silent-log observer for the dispatcher.
//
// SILENT-LOG (chunk 2): nothing filters yet. `brandObserve` only console.logs
// that a request carried a brand/channel selection — telemetry for which report
// routes are being viewed under a brand filter, so chunk 3 knows what to wire.
// Gated on BRAND_SCOPE_MODE (default off = total no-op). The active WHERE
// brand_id = $1 filtering arrives in chunk 3, per-report.
//
// Header-format validation only (no DB round-trip) — a bad/absent header means
// "All brands" (no filter), which is always the safe default.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readHeader(req, names) {
  const h = (req && req.headers) || {};
  for (const n of names) {
    const v = h[n] ?? h[n.toLowerCase()];
    if (v != null) {
      const s = String(v).trim();
      if (s.length > 0) return s;
    }
  }
  return null;
}

/** Raw X-Brand-ID header (trimmed) or null. */
export function readBrandHeader(req) {
  return readHeader(req, ["x-brand-id", "X-Brand-ID", "x-tangerine-brand-id"]);
}

/** Raw X-Channel-ID header (trimmed) or null. */
export function readChannelHeader(req) {
  return readHeader(req, ["x-channel-id", "X-Channel-ID", "x-tangerine-channel-id"]);
}

/**
 * Resolve the brand context for a request.
 * @returns {{ brand_id: string|null, source: 'header'|'all' }}
 *   brand_id = a valid uuid the caller selected, or null = "All brands".
 *   A malformed header is treated as "all" (safe default, never an error).
 */
export function resolveBrandContext(req) {
  const raw = readBrandHeader(req);
  if (raw && UUID_RE.test(raw)) return { brand_id: raw, source: "header" };
  return { brand_id: null, source: "all" };
}

/** Same shape for the channel axis. */
export function resolveChannelContext(req) {
  const raw = readChannelHeader(req);
  if (raw && UUID_RE.test(raw)) return { channel_id: raw, source: "header" };
  return { channel_id: null, source: "all" };
}

/** "off" (default) | "log" | "enforce". enforce is reserved for chunk 3+. */
export function brandScopeMode() {
  const m = String(process.env.BRAND_SCOPE_MODE || "off").toLowerCase();
  return m === "log" || m === "enforce" ? m : "off";
}

/**
 * Dispatcher hook — SILENT-LOG observability. No-op unless BRAND_SCOPE_MODE is
 * set AND the request actually carries a brand/channel selection. Never throws,
 * never blocks, never alters the response.
 */
export function brandObserve(req, pathname, method) {
  try {
    if (brandScopeMode() === "off") return;
    const b = resolveBrandContext(req);
    const c = resolveChannelContext(req);
    if (!b.brand_id && !c.channel_id) return; // "All" on both → nothing to note
    // eslint-disable-next-line no-console
    console.log(
      `[brand-scope log-only] ${String(method || "GET").toUpperCase()} ${pathname} ` +
      `brand=${b.brand_id || "all"} channel=${c.channel_id || "all"} (not filtered — chunk 2)`,
    );
  } catch {
    /* observability must never affect the request */
  }
}

// ─── Chunk 3: ACTIVE filtering (gated on BRAND_SCOPE_MODE=enforce) ────────────
//
// applyBrandScope / applyChannelScope take a supabase-js query builder and add
// `.eq(col, id)` when (a) BRAND_SCOPE_MODE === "enforce" AND (b) the request
// carries a specific brand/channel selection. Otherwise the query is returned
// UNCHANGED — so with the mode off (default) or "All" selected, behavior is
// identical to today. This is the single place reports opt into brand scoping:
//   let q = admin.from("ar_invoices").select(...).eq("entity_id", e);
//   q = applyBrandScope(q, req);
//   q = applyChannelScope(q, req);

/** Add a brand_id filter when enforcing + a brand is selected. Else unchanged. */
export function applyBrandScope(query, req, col = "brand_id") {
  if (brandScopeMode() !== "enforce") return query;
  const { brand_id } = resolveBrandContext(req);
  return brand_id ? query.eq(col, brand_id) : query;
}

/** Add a channel_id filter when enforcing + a channel is selected. Else unchanged. */
export function applyChannelScope(query, req, col = "channel_id") {
  if (brandScopeMode() !== "enforce") return query;
  const { channel_id } = resolveChannelContext(req);
  return channel_id ? query.eq(col, channel_id) : query;
}

/**
 * The brand_id to filter aggregate reports (RPCs) by — or null when scoping is
 * off / log / "All brands". Pass straight to an RPC param (p_brand_id) whose
 * function treats NULL as "all brands".
 */
export function activeBrandId(req) {
  if (brandScopeMode() !== "enforce") return null;
  return resolveBrandContext(req).brand_id; // uuid or null
}

/**
 * Collapse brand-split aging rows back to one row per (party, age_bucket),
 * summing the money + count. Needed because the brand-aware aging VIEW now
 * groups by brand too; this restores the original per-party output for "All"
 * (and is a harmless pass-through when already filtered to one brand).
 * @param {Array} rows  view rows incl. brand_id
 * @param {string} partyCol  "customer_id" (AR) or "vendor_id" (AP)
 */
export function collapseAgingByBucket(rows, partyCol) {
  const out = new Map();
  for (const r of rows || []) {
    const key = `${r[partyCol]}|${r.age_bucket}`;
    let agg = out.get(key);
    if (!agg) {
      agg = { ...r, outstanding_cents: 0, invoice_count: 0 };
      delete agg.brand_id;
      out.set(key, agg);
    }
    agg.outstanding_cents += Number(r.outstanding_cents || 0);
    agg.invoice_count += Number(r.invoice_count || 0);
  }
  return [...out.values()];
}

/**
 * P15 stock-pool — resolve the inventory_partition a receipt should land in.
 *
 * Given a brand and a side ("WS" wholesale | "EC" ecom), return the matching
 * pool's id. PT (and wholesale-only brands like MPL Epic / Sun & Stone) have a
 * single pool, so the side is ignored and that one pool is returned. Falls back
 * to the brand's WS pool, then to any pool for the brand. Returns null when the
 * brand has no pool configured (caller leaves the layer unpartitioned).
 *
 * @param {Object} admin  service-role client
 * @param {string} brandId
 * @param {"WS"|"EC"} [side="WS"]
 * @returns {Promise<string|null>} inventory_partition.id or null
 */
export async function resolveReceivingPartition(admin, brandId, side = "WS") {
  if (!brandId) return null;
  const { data } = await admin
    .from("inventory_partition")
    .select("id, code")
    .eq("brand_id", brandId);
  const pools = data || [];
  if (pools.length === 0) return null;
  if (pools.length === 1) return pools[0].id; // PT / wholesale-only — single pool
  const want = side === "EC" ? "-EC" : "-WS";
  const hit = pools.find((p) => (p.code || "").toUpperCase().endsWith(want));
  if (hit) return hit.id;
  const ws = pools.find((p) => (p.code || "").toUpperCase().endsWith("-WS"));
  return (ws || pools[0]).id;
}
