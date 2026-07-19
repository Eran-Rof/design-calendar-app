// Supabase REST access for Phase 1 wholesale planning. Uses the same
// SB_URL + SB_HEADERS convention as the rest of the app.
//
// This layer does not compute anything — it reads and writes rows.
// Services above it orchestrate compute + persistence.

import { SB_HEADERS, SB_URL } from "../../utils/supabase";
import type {
  IpCategory,
  IpCustomer,
  IpInventorySnapshot,
  IpItem,
  IpOpenPoRow,
  IpOpenSoRow,
  IpReceiptRow,
  IpSalesWholesaleRow,
} from "../types/entities";
import type {
  IpFutureDemandRequest,
  IpPlannerOverride,
  IpPlanningRun,
  IpSupplySource,
  IpWholesaleForecast,
  IpWholesaleRecommendation,
} from "../types/wholesale";

function assertSupabase(): void {
  if (!SB_URL) throw new Error("Supabase URL not configured");
}

// Thrown when an in-flight forecast build is cancelled via AbortSignal.
// Catch this in the UI to render an informational toast rather than an
// error toast.
export class BuildCancelledError extends Error {
  constructor() {
    super("Build cancelled");
    this.name = "BuildCancelledError";
  }
}

async function sbGet<T>(path: string): Promise<T[]> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`Supabase GET ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Paginated GET — PostgREST caps single-fetch responses at db_role.max_rows
// (default 1000) regardless of the &limit= value. Walks through the table
// in `pageSize`-row pages using limit/offset.
//
// Each page is wrapped in withRetryOn57014 so a deep-offset page that
// tips over Postgres' anon-role statement timeout (8s) gets a single
// retry instead of failing the whole load. The retry restarts only the
// failing page, not from offset=0.
async function sbGetAll<T>(pathWithoutLimit: string, pageSize = 1000): Promise<T[]> {
  assertSupabase();
  const out: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = pathWithoutLimit.includes("?") ? "&" : "?";
    const url = `${SB_URL}/rest/v1/${pathWithoutLimit}${sep}limit=${pageSize}&offset=${offset}`;
    const chunk = await withRetryOn57014(
      `sbGetAll offset=${offset}`,
      async () => {
        const r = await fetch(url, { headers: SB_HEADERS });
        if (!r.ok) throw new Error(`Supabase GET ${url} failed: ${r.status} ${await r.text()}`);
        return (await r.json()) as T[];
      },
    );
    out.push(...chunk);
    if (chunk.length < pageSize) break;
    if (offset > 1_000_000) break;
  }
  return out;
}

async function sbPost<T>(path: string, body: unknown, prefer = "return=representation"): Promise<T[]> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase POST ${path} failed: ${r.status} ${await r.text()}`);
  return prefer.includes("return=minimal") ? ([] as T[]) : r.json();
}

async function sbPatch<T>(path: string, body: unknown): Promise<T[]> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase PATCH ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Retry single-row writes that hit Postgres statement timeout
// (SQLSTATE 57014). Single-row upserts on tables with FK + RLS +
// updated_at triggers occasionally hit the anon-role 8s timeout under
// lock contention (planner typing rapidly into multiple aggregate
// cells, or a concurrent build holding the row). Exponential backoff
// across three attempts (250ms, 1s, 3s) is enough to ride out the
// transient pressure without making the planner wait absurdly long
// when the issue is real.
async function withRetryOn57014<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [250, 1000, 3000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = msg.includes("57014") || msg.toLowerCase().includes("statement timeout") || msg.toLowerCase().includes("canceling statement");
      if (!isTimeout || attempt === delays.length) throw e;
      // eslint-disable-next-line no-console
      console.warn(`[planning-repo] ${label} hit 57014 (attempt ${attempt + 1} of ${delays.length + 1}); retrying in ${delays[attempt]}ms`);
      await new Promise((res) => setTimeout(res, delays[attempt]));
    }
  }
  throw lastErr;
}

// Broader than withRetryOn57014, which retries statement-timeouts ONLY.
// A one-off Supabase 5xx / connection blip is NOT a 57014, so it slipped
// past the retry and — because the avg-cost loaders used to
// `catch { return new Map() }` — silently blanked EVERY grid unit cost
// (the avg-cost map is the primary input to the whole cost cascade).
export function isTransientDbError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return msg.includes("57014")
    || lower.includes("statement timeout")
    || lower.includes("canceling statement")
    || msg.includes(" 500 ") || lower.includes("internal server error")
    || msg.includes(" 502 ") || msg.includes(" 503 ") || msg.includes(" 504 ")
    || lower.includes("bad gateway") || lower.includes("service unavailable")
    || lower.includes("gateway timeout") || lower.includes("fetch failed")
    || lower.includes("network") || lower.includes("econnreset")
    || lower.includes("timeout");
}

// Pure: canonical sku_code → avg_cost, dropping blank/zero/non-numeric.
export function avgCostRowsToMap(rows: Array<{ sku_code?: string | null; avg_cost?: number | null }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.sku_code && typeof r.avg_cost === "number" && r.avg_cost > 0) {
      out.set(r.sku_code, r.avg_cost);
    }
  }
  return out;
}

// Load a sku_code → avg_cost map with transient-resilient retries.
// CRITICAL: a failed load must NOT masquerade as an empty table. The
// avg-cost map feeds every grid unit cost, so a silent empty here blanks
// EVERY cost with no signal (this exact silent catch caused an
// all-costs-blank production incident on 2026-07-19). On a hard/final
// failure we log LOUDLY (visible in Vercel logs) and return empty so the
// grid still renders — but the failure is now observable, not invisible.
async function loadAvgCostMap(table: string, label: string): Promise<Map<string, number>> {
  const delays = [250, 1000, 3000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const rows = await sbGet<{ sku_code: string; avg_cost: number }>(
        `${table}?select=sku_code,avg_cost&limit=50000`,
      );
      return avgCostRowsToMap(rows);
    } catch (e) {
      lastErr = e;
      if (!isTransientDbError(e) || attempt === delays.length) break;
      // eslint-disable-next-line no-console
      console.warn(`[planning-repo] ${label} transient load error (attempt ${attempt + 1} of ${delays.length + 1}); retrying in ${delays[attempt]}ms`);
      await new Promise((res) => setTimeout(res, delays[attempt]));
    }
  }
  // eslint-disable-next-line no-console
  console.error(`[planning-repo] ${label} FAILED to load ${table} after retries — grid unit costs blank this build:`, lastErr);
  return new Map();
}

async function sbDelete(path: string): Promise<void> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: SB_HEADERS,
  });
  if (!r.ok) throw new Error(`Supabase DELETE ${path} failed: ${r.status} ${await r.text()}`);
}

// ── Masters / history / supply ─────────────────────────────────────────────
export const wholesaleRepo = {
  async listCustomers(): Promise<IpCustomer[]> {
    return sbGet<IpCustomer>("ip_customer_master?select=*&order=name.asc&limit=5000");
  },
  async listVendors(): Promise<Array<{ id: string; vendor_code: string; name: string }>> {
    return sbGet<{ id: string; vendor_code: string; name: string }>(
      "ip_vendor_master?select=id,vendor_code,name&order=name.asc&limit=5000",
    );
  },
  // Placeholder customer for "supply only" forecast rows — items with
  // open POs or on-SO but no sales-history pair show up under this
  // customer in the grid so the planner can see incoming inventory.
  // Idempotent: returns the existing id on subsequent calls.
  async ensureSupplyPlaceholderCustomer(): Promise<string> {
    const code = "INTERNAL:SUPPLY_ONLY";
    const existing = await sbGet<{ id: string }>(`ip_customer_master?select=id&customer_code=eq.${encodeURIComponent(code)}&limit=1`);
    if (existing[0]?.id) return existing[0].id;
    const created = await sbPost<{ id: string }>(
      "ip_customer_master?on_conflict=customer_code",
      [{ customer_code: code, name: "(Supply Only)" }],
      "resolution=merge-duplicates,return=representation",
    );
    if (created[0]?.id) return created[0].id;
    // Fallback fetch in case Supabase didn't return the id on a merge.
    const refetch = await sbGet<{ id: string }>(`ip_customer_master?select=id&customer_code=eq.${encodeURIComponent(code)}&limit=1`);
    if (!refetch[0]?.id) throw new Error("ensureSupplyPlaceholderCustomer: could not resolve id");
    return refetch[0].id;
  },
  async listCategories(): Promise<IpCategory[]> {
    return sbGet<IpCategory>("ip_category_master?select=*&order=name.asc&limit=5000");
  },
  // Insert a planner-typed customer into ip_customer_master. Used by
  // the "Add as NEW customer" path on the TBD customer cell. The
  // customer_code is required + unique; we derive it from the name
  // (uppercase, alphanumeric + dashes) and append a short suffix on
  // collision so the planner doesn't have to think about codes.
  async insertCustomer(name: string): Promise<{ id: string; name: string }> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("insertCustomer: name required");
    // Reuse an existing customer when the planner re-types a name
    // already in the master. Without this the unique-name constraint
    // returns 409 and the picker fails — even though the right
    // answer is "just use the existing row." Match case-insensitively
    // since the planner's spelling won't match storage casing.
    const encoded = encodeURIComponent(trimmed.replace(/[%,]/g, " "));
    const existing = await sbGetAll<{ id: string; name: string }>(
      `ip_customer_master?select=id,name&name=ilike.${encoded}`,
    ).catch(() => [] as { id: string; name: string }[]);
    const hit = existing.find((r) => r.name.trim().toLowerCase() === trimmed.toLowerCase());
    if (hit) return { id: hit.id, name: hit.name };
    const baseCode = trimmed
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    let code = baseCode || "CUSTOMER";
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // Stamp external_refs.planning_added so the orange NEW
        // badge persists across reloads — until something else
        // (Xoro / Shopify integration, manual master refresh)
        // populates the customer's real upstream identifiers.
        const created = await withRetryOn57014("insertCustomer", () => sbPost<{ id: string; name: string }>(
          "ip_customer_master",
          [{ customer_code: code, name: trimmed, external_refs: { planning_added: "1" } }],
          "return=representation",
        ));
        if (created[0]?.id) return { id: created[0].id, name: created[0].name };
        throw new Error("insertCustomer: no id returned");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("23505") || attempt === 3) throw e;
        code = `${baseCode}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      }
    }
    throw new Error("insertCustomer: could not resolve unique code");
  },
  // Distinct color values from the active item master. Used by the
  // grid's TBD color picker for isNew detection without paying the
  // full listItems() round trip every render. Returns lowercased,
  // de-duped strings — order isn't meaningful.
  async listMasterColorsLower(): Promise<Set<string>> {
    const rows = await sbGetAll<{ color: string | null }>("ip_item_master?select=color&active=eq.true&color=not.is.null");
    const out = new Set<string>();
    for (const r of rows) {
      const c = r.color?.trim();
      if (c) out.add(c.toLowerCase());
    }
    return out;
  },
  // Per-style set of known colors from item master (lowercased).
  // Drives the TBD color picker's two-tier "new" badging:
  //   - color in master for THIS style          → no badge
  //   - color in master for OTHER styles only   → green "NEW for style"
  //   - color not in master anywhere            → orange "NEW COLOR"
  // Returns a Map keyed by style_code, with each value a Set of
  // lowercased color strings.
  async listMasterColorsByStyleLower(): Promise<Map<string, Set<string>>> {
    type Row = { style_code: string | null; color: string | null };
    const rows = await sbGetAll<Row>("ip_item_master?select=style_code,color&active=eq.true&style_code=not.is.null&color=not.is.null");
    const out = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.style_code || !r.color) continue;
      const style = r.style_code;
      const c = r.color.trim().toLowerCase();
      if (!c) continue;
      let set = out.get(style);
      if (!set) { set = new Set<string>(); out.set(style, set); }
      set.add(c);
    }
    return out;
  },

  // Distinct (style_code, color, group_name, sub_category_name) tuples
  // from the active item master. Used by the TBD style + color
  // pickers so the planner can pick a sibling style in the same
  // category even when that sibling has no demand pairs in the
  // current run (and therefore no rows in buildGridRows).
  async listMasterStyles(): Promise<Array<{ style_code: string; group_name: string | null; sub_category_name: string | null }>> {
    type RawItem = { style_code: string | null; sku_code: string; attributes: Record<string, unknown> | null; active: boolean };
    const rows = await sbGetAll<RawItem>("ip_item_master?select=style_code,sku_code,attributes,active&active=eq.true");
    const out = new Map<string, { style_code: string; group_name: string | null; sub_category_name: string | null }>();
    for (const r of rows) {
      const style = r.style_code ?? r.sku_code;
      if (!style || out.has(style)) continue;
      const attrs = r.attributes ?? {};
      const group = typeof attrs.group_name === "string" ? attrs.group_name.trim() || null : null;
      const sub = typeof attrs.category_name === "string" ? attrs.category_name.trim() || null : null;
      out.set(style, { style_code: style, group_name: group, sub_category_name: sub });
    }
    return Array.from(out.values()).sort((a, b) => a.style_code.localeCompare(b.style_code));
  },

  // Units-per-pack for every active Prepack Matrix in Tangerine, keyed
  // by lowercased ppk_style_code. unitsPerPack = Σ qty_per_pack across
  // the matrix's sizes — the authoritative pack size when a style's
  // PPK token carries no digit (e.g. "RYB0412PPK"). Mirrors the
  // server's ppkUnitsPerPackByStyle so the planning grid can convert
  // eaches ⇄ packs consistently with the rest of the suite. Styles with
  // no active matrix are simply absent from the map (caller warns).
  async listPrepackUnitsPerPack(): Promise<Map<string, number>> {
    type Matrix = { id: string; ppk_style_code: string | null };
    type Size = { matrix_id: string; qty_per_pack: number | null };
    const matrices = await sbGetAll<Matrix>(
      "prepack_matrices?select=id,ppk_style_code&is_active=eq.true&ppk_style_code=not.is.null",
    );
    const out = new Map<string, number>();
    if (matrices.length === 0) return out;
    const byId = new Map(matrices.map((m) => [m.id, m] as const));
    // Batch the size fetch by matrix id (PostgREST `in.()`), chunked to
    // keep the URL well under length limits.
    const ids = matrices.map((m) => m.id);
    const unitsByMatrix = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const list = chunk.map((id) => `"${id}"`).join(",");
      const sizes = await sbGetAll<Size>(`prepack_matrix_sizes?select=matrix_id,qty_per_pack&matrix_id=in.(${list})`);
      for (const s of sizes) {
        const q = Number(s.qty_per_pack) || 0;
        if (q > 0) unitsByMatrix.set(s.matrix_id, (unitsByMatrix.get(s.matrix_id) ?? 0) + q);
      }
    }
    for (const [id, units] of unitsByMatrix) {
      const m = byId.get(id);
      if (m?.ppk_style_code && units > 0) out.set(m.ppk_style_code.trim().toLowerCase(), units);
    }
    return out;
  },
  async listItems(): Promise<IpItem[]> {
    // Cursor pagination (sku_code > last) instead of OFFSET. Deep
    // OFFSET on a 10k+ row table forces the planner to read+skip
    // OFFSET rows from the index before returning LIMIT — combined
    // with the JSONB `attributes` TOAST reads, page 7 (offset=3000)
    // started timing out at the 8s anon statement-timeout cap right
    // after the nightly's massive UPSERTs (autovacuum pressure).
    //
    // Cursor reads exactly PAGE rows from the unique sku_code index
    // each call regardless of depth — flat-time pagination across
    // any catalog size. Same total row count, no OFFSET cost.
    //
    // Explicit column list: skips external_refs (Xoro JSONB import
    // payload, can be many KB per row) and other columns no IP caller
    // reads. JSONB blob was previously the bulk of every fetch.
    const COLS = "id,sku_code,style_code,description,category_id,color,size,inseam,unit_cost,moq_units,pack_size,attributes";
    const PAGE = 500;
    const out: IpItem[] = [];
    let lastSku: string | null = null;

    for (let pageNo = 0; pageNo < 400; pageNo++) {
      const cursor = lastSku ? `&sku_code=gt.${encodeURIComponent(lastSku)}` : "";
      const chunk = await withRetryOn57014(
        `listItems page=${pageNo} after=${lastSku ?? "start"}`,
        () => sbGet<IpItem>(`ip_item_master?select=${COLS}&order=sku_code.asc&limit=${PAGE}${cursor}`),
      );
      out.push(...chunk);
      if (chunk.length < PAGE) break;
      lastSku = chunk[chunk.length - 1].sku_code;
    }
    return out;
  },
  // Canonical avg cost per SKU — fed by Xoro/Excel ingest. Covers SKUs
  // not currently in ATS inventory. Returns an empty map (not an error)
  // when the table is empty or the migration hasn't been applied yet.
  async listItemAvgCostBySku(): Promise<Map<string, number>> {
    return loadAvgCostMap("ip_item_avg_cost", "listItemAvgCostBySku");
  },
  // Avg unit cost per SKU from the materialized ip_ats_avg_cost table
  // (canonicalized at write time by useExcelUpload.upsertAtsAvgCost or
  // the SQL backfill in 20260521010000_ip_ats_avg_cost.sql). Replaces
  // the prior path that pulled the full 7.4MB app_data['ats_excel_data']
  // blob on every forecast build. The blob path was also silently broken
  // — it keyed the Map by raw `sku` ("RYA1408 - Black") and the grid
  // looked it up by `item.sku_code` ("RYA1408-BLACK"), so 0/2241 lookups
  // hit. The new table stores canonical sku_code, so matches actually
  // land. Used as a fallback when ip_item_avg_cost has no row for a SKU.
  async listAtsAvgCostBySku(): Promise<Map<string, number>> {
    return loadAvgCostMap("ip_ats_avg_cost", "listAtsAvgCostBySku");
  },
  async listWholesaleSales(sinceIso: string): Promise<IpSalesWholesaleRow[]> {
    // Trimmed select — drops the unused order_number / invoice_number
    // / txn_type / unit_price / gross_amount / discount_amount /
    // currency / source / raw_payload_id / source_line_key / channel_id
    // columns. accuracyService is the only caller that reads net_amount
    // so it's retained.
    //
    // pageSize=500 (not the default 1000): the full-year invoice replay
    // brought this table past 46k rows, and 1000-row pages at offset
    // 16k+ were tipping over the 8s statement timeout (57014). Halving
    // page size keeps each request comfortably inside the budget; total
    // wall time barely changes since PostgREST batches efficiently.
    return sbGetAll<IpSalesWholesaleRow>(
      `ip_sales_history_wholesale?select=sku_id,customer_id,category_id,txn_date,qty,qty_units,net_amount,margin_amount,margin_pct&txn_date=gte.${sinceIso}&order=txn_date.asc`,
      500,
    );
  },
  async listInventorySnapshots(warehouses?: readonly string[]): Promise<IpInventorySnapshot[]> {
    // Single source of truth (docs/tangerine/onhand-single-source-of-truth.md):
    // on-hand is the Xoro REST by-size pull, re-sourced as source='tangerine'
    // (PR #1786). Read THAT source only, optionally filtered to a channel's
    // warehouse set — latestOnHandBySku then sums across those warehouses per
    // SKU. `warehouse_code` is kept so the per-warehouse dedup/sum works (it was
    // previously trimmed, which silently collapsed multi-warehouse SKUs to one).
    // Passing no warehouses reads all of them (e.g. a total-company view).
    const whFilter = warehouses && warehouses.length
      ? `&warehouse_code=in.(${warehouses.map((w) => `"${encodeURIComponent(w)}"`).join(",")})`
      : "";
    return sbGetAll<IpInventorySnapshot>(
      `ip_inventory_snapshot?select=sku_id,snapshot_date,qty_on_hand,qty_available,qty_committed,warehouse_code,source&source=eq.tangerine${whFilter}&order=snapshot_date.desc`,
    );
  },
  async listOpenPos(channel: "wholesale" | "ecom" | "all" = "wholesale", supplySource: IpSupplySource = "xoro"): Promise<IpOpenPoRow[]> {
    // Trimmed: drops vendor_id / buyer_name / po_line_number /
    // order_date / qty_ordered / qty_received / currency / status /
    // source / raw_payload_id / source_line_key / last_seen_at. Big
    // win on this hot path — every grid build re-reads every open
    // PO. Kept: po_number (scenario detail display).
    //
    // Channel filter: defaults to "wholesale" so the wholesale
    // planning grid never sees ecom POs (which were polluting
    // receipts and understating buy recs). Pass "ecom" from the
    // ecom planning service; "all" is for diagnostics only.
    //
    // Source filter (M31 dir-B): native Tangerine POs aren't
    // channel-segmented, so 'tangerine' takes all tangerine open POs and
    // skips the channel filter. 'xoro' excludes tangerine rows (and keeps
    // the channel scope) — identical to the prior behavior.
    if (supplySource === "tangerine") {
      return withRetryOn57014("listOpenPos",
        () => sbGetAll<IpOpenPoRow>(
          `ip_open_purchase_orders?select=sku_id,qty_open,expected_date,unit_cost,customer_id,po_number,channel&source=eq.tangerine&order=expected_date.asc`,
        ));
    }
    const channelFilter = channel === "all" ? "" : `&channel=eq.${channel}`;
    return withRetryOn57014("listOpenPos",
      () => sbGetAll<IpOpenPoRow>(
        `ip_open_purchase_orders?select=sku_id,qty_open,expected_date,unit_cost,customer_id,po_number,channel&source=neq.tangerine${channelFilter}&order=expected_date.asc`,
      ));
  },
  async listOpenSos(): Promise<IpOpenSoRow[]> {
    // Trimmed: drops customer_name / so_number / cancel_date /
    // qty_ordered / qty_shipped / unit_price / currency / status /
    // store / source / source_line_key / last_seen_at. SO grid only
    // needs the four aggregation keys + qty.
    return withRetryOn57014("listOpenSos",
      () => sbGetAll<IpOpenSoRow>(
        "ip_open_sales_orders?select=sku_id,customer_id,qty_open,ship_date&order=ship_date.asc",
      ));
  },
  // Detail lookups for the planning grid's right-click context menu.
  // Wide SELECT — these methods only run when the planner asks for
  // details on a single cell (rare). Period filter applies to the
  // already-bucketed display so a row showing "On PO 1,234 in Apr" gets
  // exactly the lines making up that bucket.
  async listOpenPoLinesForCell(args: {
    sku_ids: string[];
    period_start: string;
    period_end: string;
    customer_id: string | null;
  }): Promise<IpOpenPoRow[]> {
    if (args.sku_ids.length === 0) return [];
    const skuFilter = `&sku_id=in.(${args.sku_ids.join(",")})`;
    // customer_id = null means "match the supply-only placeholder OR no
    // customer attached". For wholesale + ecom we filter to exactly the
    // requested customer.
    const custFilter = args.customer_id == null
      ? ""
      : `&customer_id=eq.${args.customer_id}`;
    return sbGetAll<IpOpenPoRow>(
      `ip_open_purchase_orders?select=*${skuFilter}` +
      `&expected_date=gte.${args.period_start}&expected_date=lte.${args.period_end}` +
      custFilter +
      `&order=expected_date.asc`,
    );
  },
  async listOpenSoLinesForCell(args: {
    sku_ids: string[];
    period_start: string;
    period_end: string;
    customer_id: string | null;
  }): Promise<IpOpenSoRow[]> {
    if (args.sku_ids.length === 0) return [];
    const skuFilter = `&sku_id=in.(${args.sku_ids.join(",")})`;
    const custFilter = args.customer_id == null
      ? ""
      : `&customer_id=eq.${args.customer_id}`;
    return sbGetAll<IpOpenSoRow>(
      `ip_open_sales_orders?select=*${skuFilter}` +
      `&ship_date=gte.${args.period_start}&ship_date=lte.${args.period_end}` +
      custFilter +
      `&order=ship_date.asc`,
    );
  },
  async listReceipts(sinceIso: string): Promise<IpReceiptRow[]> {
    // Trimmed: drops vendor_id / po_number / receipt_number /
    // warehouse_code / source / raw_payload_id / source_line_key.
    return withRetryOn57014("listReceipts",
      () => sbGetAll<IpReceiptRow>(
        `ip_receipts_history?select=sku_id,received_date,qty&received_date=gte.${sinceIso}&order=received_date.asc`,
      ));
  },

  // ── Planning runs ────────────────────────────────────────────────────────
  async listPlanningRuns(scope = "wholesale"): Promise<IpPlanningRun[]> {
    return sbGet<IpPlanningRun>(
      `ip_planning_runs?select=*&planning_scope=eq.${scope}&order=created_at.desc&limit=200`,
    );
  },
  // EVERY run regardless of scope — for the Planning Admin "Runs" panel, so the
  // operator can see/delete reconciliation + orphaned scenario runs that the
  // scope-filtered workbench dropdowns hide.
  async listAllPlanningRuns(): Promise<IpPlanningRun[]> {
    return sbGet<IpPlanningRun>(`ip_planning_runs?select=*&order=created_at.desc&limit=500`);
  },
  async getPlanningRun(id: string): Promise<IpPlanningRun | null> {
    const rows = await sbGet<IpPlanningRun>(`ip_planning_runs?select=*&id=eq.${id}&limit=1`);
    return rows[0] ?? null;
  },
  async createPlanningRun(row: Omit<IpPlanningRun, "id" | "created_at" | "updated_at">): Promise<IpPlanningRun> {
    const [created] = await sbPost<IpPlanningRun>("ip_planning_runs", [row]);
    return created;
  },
  async updatePlanningRun(id: string, patch: Partial<IpPlanningRun>): Promise<IpPlanningRun> {
    const [updated] = await sbPatch<IpPlanningRun>(`ip_planning_runs?id=eq.${id}`, patch);
    return updated;
  },
  // Drop a planning run. The Phase 1 + 4 migrations declare
  // ON DELETE CASCADE on the run_id FKs across forecast, recs, TBD,
  // bucket buys, overrides, scenarios — so deleting the parent row
  // is sufficient to clean up the entire run.
  async deletePlanningRun(id: string): Promise<void> {
    await sbDelete(`ip_planning_runs?id=eq.${id}`);
  },

  // ── Forecast rows ────────────────────────────────────────────────────────
  // Cursor-based seek pagination (id > last_seen_id) instead of OFFSET.
  // Two reasons:
  //   1) OFFSET 0 with ORDER BY id was timing out (57014) when the
  //      composite index (planning_run_id, id) wasn't available — the
  //      fallback plan sorts the entire matching set before slicing.
  //      A range scan over the PK btree avoids the sort entirely.
  //   2) Page-size halving on 57014: if a single 500-row page still
  //      times out, retry from the same cursor with half the page.
  //      Mirrors the upsert side's halving pattern.
  async listForecast(planningRunId: string): Promise<IpWholesaleForecast[]> {
    const out: IpWholesaleForecast[] = [];
    // 100 rows per chunk fits well under the anon-role 8s timeout
    // for typical wholesale runs. Was 250, which still tripped 500
    // (Internal Server Error) on cursor-paginated chunks deeper
    // into the run when concurrent writes held locks. Smaller pages
    // = more round trips but no console noise on load. The halving
    // fallback below stays as a safety net if 100 still times out.
    const INITIAL_PAGE = 100;
    const MIN_PAGE = 25;
    let cursor: string | null = null;
    let page = INITIAL_PAGE;

    while (true) {
      const cursorClause = cursor ? `&id=gt.${cursor}` : "";
      const url = `ip_wholesale_forecast?select=*&planning_run_id=eq.${planningRunId}${cursorClause}&order=id.asc&limit=${page}`;
      let chunk: IpWholesaleForecast[];
      try {
        chunk = await sbGet<IpWholesaleForecast>(url);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const lower = msg.toLowerCase();
        // Halve on any transient — Supabase frequently returns a
        // bare 500 (no "57014" / "canceling statement" in the body)
        // for the same statement-timeout root cause. Without a
        // broader match the first chunk's 500 was bubbling up and
        // logging in the planner's console even though the load
        // ultimately succeeded after halving.
        const isTransient = msg.includes("57014")
          || lower.includes("statement timeout")
          || lower.includes("canceling statement")
          || msg.includes(" 500 ")
          || lower.includes("internal server error")
          || msg.includes(" 502 ")
          || msg.includes(" 503 ")
          || msg.includes(" 504 ");
        if (isTransient && page > MIN_PAGE) {
          page = Math.max(MIN_PAGE, Math.floor(page / 2));
          continue;
        }
        throw e;
      }
      out.push(...chunk);
      if (chunk.length < page) break;
      cursor = chunk[chunk.length - 1].id;
      // Once we recover from a timeout, keep walking at the smaller
      // page size — bumping back up just risks tripping the same wall.
      if (out.length > 5_000_000) break;
    }
    return out;
  },
  async upsertForecast(
    rows: Array<Omit<IpWholesaleForecast, "id" | "created_at" | "updated_at">>,
    options: {
      signal?: AbortSignal;
      onProgress?: (rowsDone: number, totalRows: number) => void;
      onChunk?: (chunkSize: number) => void;
    } = {},
  ): Promise<void> {
    if (rows.length === 0) return;
    const url = "ip_wholesale_forecast?on_conflict=planning_run_id,customer_id,sku_id,period_start";
    const prefer = "return=minimal,resolution=merge-duplicates";
    // 5 secondary indexes + 3 FK checks per row — chunks above ~250 can
    // tip past Supabase's 8s statement timeout (57014).
    const INITIAL_CHUNK = 200;
    const MIN_CHUNK = 25;
    const { signal, onProgress, onChunk } = options;

    type Row = (typeof rows)[number];
    const postChunk = async (chunk: Row[]): Promise<void> => {
      if (signal?.aborted) throw new BuildCancelledError();
      try {
        await sbPost<IpWholesaleForecast>(url, chunk, prefer);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // PGRST204 = column not in schema cache (migration pending). Retry
        // without the optional planner-editable columns so builds survive
        // before the ALTER TABLEs run on the target environment.
        if (msg.includes("PGRST204") && (msg.includes("ly_reference_qty") || msg.includes("planned_buy_qty") || msg.includes("unit_cost_override") || msg.includes("historical_margin_pct"))) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const stripped = chunk.map(({ ly_reference_qty: _a, planned_buy_qty: _b, unit_cost_override: _c, historical_margin_pct: _d, ...rest }) => rest);
          await sbPost<IpWholesaleForecast>(url, stripped, prefer);
          return;
        }
        // 57014 = canceling statement due to statement timeout. Halve the
        // chunk and retry; FK + index maintenance scales roughly linearly.
        if (msg.includes("57014") && chunk.length > MIN_CHUNK) {
          const half = Math.max(MIN_CHUNK, Math.floor(chunk.length / 2));
          for (let j = 0; j < chunk.length; j += half) {
            await postChunk(chunk.slice(j, j + half));
          }
          return;
        }
        throw e;
      }
    };

    let done = 0;
    for (let i = 0; i < rows.length; i += INITIAL_CHUNK) {
      const chunk = rows.slice(i, i + INITIAL_CHUNK);
      await postChunk(chunk);
      done += chunk.length;
      onProgress?.(done, rows.length);
      onChunk?.(chunk.length);
    }
  },
  async patchForecastOverride(
    forecastId: string,
    override_qty: number,
    final_forecast_qty: number,
  ): Promise<IpWholesaleForecast> {
    const rows = await withRetryOn57014("patchForecastOverride", () =>
      sbPatch<IpWholesaleForecast>(`ip_wholesale_forecast?id=eq.${forecastId}`, { override_qty, final_forecast_qty }),
    );
    if (!rows[0]) throw new Error(`patchForecastOverride: no row returned for ${forecastId}`);
    return rows[0];
  },
  async patchForecastBuyerRequest(
    forecastId: string,
    buyer_request_qty: number,
    final_forecast_qty: number,
  ): Promise<void> {
    const rows = await withRetryOn57014("patchForecastBuyerRequest", () =>
      sbPatch<IpWholesaleForecast>(`ip_wholesale_forecast?id=eq.${forecastId}`, { buyer_request_qty, final_forecast_qty }),
    );
    if (!rows[0]) throw new Error(`patchForecastBuyerRequest: no row returned for ${forecastId}`);
  },
  async patchForecastBuyQty(forecastId: string, planned_buy_qty: number | null): Promise<void> {
    const rows = await withRetryOn57014("patchForecastBuyQty", () =>
      sbPatch<IpWholesaleForecast>(`ip_wholesale_forecast?id=eq.${forecastId}`, { planned_buy_qty }),
    );
    if (!rows[0]) throw new Error(`patchForecastBuyQty: no row returned for ${forecastId}`);
  },
  async patchForecastUnitCostOverride(forecastId: string, unit_cost_override: number | null): Promise<void> {
    const rows = await withRetryOn57014("patchForecastUnitCostOverride", () =>
      sbPatch<IpWholesaleForecast>(`ip_wholesale_forecast?id=eq.${forecastId}`, { unit_cost_override }),
    );
    if (!rows[0]) throw new Error(`patchForecastUnitCostOverride: no row returned for ${forecastId}`);
  },
  // ── Bucket-level buys (for collapsed grid rows) ─────────────────────
  // Each row represents one (planning_run, bucket_key) pair where
  // bucket_key encodes the collapse mode + filter scope + the row's
  // dimensions. The grid renders the qty into the aggregate row's
  // Buy cell when the same view is reproduced.
  async listBucketBuys(planningRunId: string): Promise<Array<{
    bucket_key: string;
    qty: number;
    collapse_mode: string;
    customer_id: string | null;
    group_name: string | null;
    sub_category_name: string | null;
    gender: string | null;
    period_code: string;
    created_by: string | null;
    updated_at: string;
  }>> {
    return sbGet(
      `ip_planner_bucket_buys?planning_run_id=eq.${planningRunId}&select=bucket_key,qty,collapse_mode,customer_id,group_name,sub_category_name,gender,period_code,created_by,updated_at&limit=10000`,
    );
  },
  async upsertBucketBuy(
    planningRunId: string,
    args: {
      bucket_key: string;
      qty: number;
      collapse_mode: string;
      customer_id: string | null;
      group_name: string | null;
      sub_category_name: string | null;
      gender: string | null;
      period_code: string;
      created_by: string | null;
    },
  ): Promise<void> {
    await withRetryOn57014("upsertBucketBuy", () => sbPost(
      "ip_planner_bucket_buys?on_conflict=planning_run_id,bucket_key",
      [{ planning_run_id: planningRunId, ...args }],
      "resolution=merge-duplicates,return=minimal",
    ));
  },
  async deleteBucketBuy(planningRunId: string, bucketKey: string): Promise<void> {
    await withRetryOn57014("deleteBucketBuy", () => sbDelete(
      `ip_planner_bucket_buys?planning_run_id=eq.${planningRunId}&bucket_key=eq.${encodeURIComponent(bucketKey)}`,
    ));
  },
  // Plain bulk INSERT for cloning bucket buys into a snapshot run.
  // Each row gets a fresh uuid PK; planning_run_id on the rows is the
  // target run (caller pre-fills it). Chunked at 200 to stay under
  // PostgREST URL + statement-timeout limits.
  async bulkInsertBucketBuys(
    rows: Array<{
      planning_run_id: string;
      bucket_key: string;
      qty: number;
      collapse_mode: string;
      customer_id: string | null;
      group_name: string | null;
      sub_category_name: string | null;
      gender: string | null;
      period_code: string;
      created_by: string | null;
    }>,
    options: { onChunk?: (chunkSize: number) => void } = {},
  ): Promise<void> {
    if (rows.length === 0) return;
    const CHUNK = 200;
    const { onChunk } = options;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await withRetryOn57014("bulkInsertBucketBuys", () => sbPost(
        "ip_planner_bucket_buys",
        chunk,
        "return=minimal",
      ));
      onChunk?.(chunk.length);
    }
  },

  // ── TBD stock-buy rows ───────────────────────────────────────────────────
  // One row per (planning_run, style_code, period_start) by default.
  // Carries Buyer / Override / Buy values typed at any rollup grain.
  // Color starts as "TBD" and is editable by the planner; is_new_color
  // marks a value the master doesn't yet know about. Full lifecycle:
  //   ensureForRun  - on every grid open, seed one TBD row per style/period
  //                   that doesn't already have one (idempotent).
  //   list          - load all TBD rows for the run.
  //   upsert        - save planner edits.
  //   delete        - remove a TBD row (used by Add-row's undo).
  async listTbdRows(planningRunId: string): Promise<Array<{
    id: string;
    planning_run_id: string;
    style_code: string;
    color: string;
    is_new_color: boolean;
    is_user_added: boolean;
    customer_id: string;
    group_name: string | null;
    sub_category_name: string | null;
    period_start: string;
    period_end: string;
    period_code: string;
    buyer_request_qty: number;
    override_qty: number;
    final_forecast_qty: number;
    planned_buy_qty: number | null;
    unit_cost: number | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
  }>> {
    // order=created_at.asc,id.asc keeps row order stable across
    // rebuilds. Without it Postgres returns whatever heap order
    // happens to be — and an updated row can shift its slot after
    // a patch, so a buy-qty save triggered the visible row to swap
    // positions with its neighbor on the next fetch. The forecast_id
    // (React key) is stable so the cell content followed the right
    // row, but visually the qty appeared to migrate.
    return sbGet(
      `ip_wholesale_forecast_tbd?planning_run_id=eq.${planningRunId}&select=*&order=created_at.asc,id.asc&limit=20000`,
    );
  },
  // Plain INSERT for planner-added TBD rows. Each call creates a
  // distinct row regardless of (style, color, customer, period)
  // duplication — the partial unique index on
  // ip_wholesale_forecast_tbd (added in migration 20260511) only
  // constrains rows where is_user_added=false, so user-added rows
  // can multiply at will. Sets is_user_added=true server-side too
  // as a belt-and-suspenders.
  // Plain bulk INSERT for cloning TBD rows into a snapshot run.
  // is_user_added is preserved from the source so user-added rows
  // remain user-added in the snapshot (and stay outside the partial
  // unique index that constrains is_user_added=false). Chunked at
  // 200 to stay under PostgREST + 57014 limits.
  async bulkInsertTbdRows(
    rows: Array<{
      planning_run_id: string;
      style_code: string;
      color: string;
      is_new_color: boolean;
      is_user_added: boolean;
      customer_id: string;
      group_name: string | null;
      sub_category_name: string | null;
      period_start: string;
      period_end: string;
      period_code: string;
      buyer_request_qty: number;
      override_qty: number;
      final_forecast_qty: number;
      planned_buy_qty: number | null;
      unit_cost: number | null;
      notes: string | null;
    }>,
    options: { onChunk?: (chunkSize: number) => void } = {},
  ): Promise<void> {
    if (rows.length === 0) return;
    const CHUNK = 200;
    const { onChunk } = options;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await withRetryOn57014("bulkInsertTbdRows", () => sbPost(
        "ip_wholesale_forecast_tbd",
        chunk,
        "return=minimal",
      ));
      onChunk?.(chunk.length);
    }
  },
  async insertTbdRow(
    planningRunId: string,
    args: {
      style_code: string;
      color: string;
      is_new_color?: boolean;
      customer_id: string;
      group_name?: string | null;
      sub_category_name?: string | null;
      period_start: string;
      period_end: string;
      period_code: string;
      buyer_request_qty?: number;
      override_qty?: number;
      final_forecast_qty?: number;
      planned_buy_qty?: number | null;
      unit_cost?: number | null;
      notes?: string | null;
    },
  ): Promise<{ id: string }> {
    const created = await withRetryOn57014("insertTbdRow", () => sbPost<{ id: string }>(
      "ip_wholesale_forecast_tbd",
      [{ planning_run_id: planningRunId, is_user_added: true, ...args }],
      "return=representation",
    ));
    if (!created[0]?.id) throw new Error("insertTbdRow: no id returned");
    return { id: created[0].id };
  },

  // Idempotent upsert for AUTO-routed TBD rows. Used by saveTbdField
  // when a synthetic row needs persisting for the first time
  // (aggregate edit with no tbd_id yet). Cannot use PostgREST
  // ON CONFLICT because the unique index is now PARTIAL (WHERE
  // is_user_added=false) — PostgREST rejects partial indexes as
  // ON CONFLICT targets with SQLSTATE 42P10. Instead: SELECT first
  // to find the existing AUTO row at this grain, then PATCH or
  // INSERT. Race-condition catch on 23505 falls back to a re-SELECT
  // + PATCH.
  async upsertTbdRow(
    planningRunId: string,
    args: {
      style_code: string;
      color: string;
      is_new_color?: boolean;
      // Set true ONLY when the planner explicitly created this row
      // via "+ Add row". Aggregate-edit writes through saveTbdField
      // leave it false so the auto-synthesized catch-alls aren't
      // mistaken for planner-added rows.
      is_user_added?: boolean;
      customer_id: string;
      group_name?: string | null;
      sub_category_name?: string | null;
      period_start: string;
      period_end: string;
      period_code: string;
      buyer_request_qty?: number;
      override_qty?: number;
      final_forecast_qty?: number;
      planned_buy_qty?: number | null;
      unit_cost?: number | null;
      notes?: string | null;
    },
  ): Promise<{ id: string }> {
    const isUserAdded = args.is_user_added ?? false;
    // User-added rows: plain INSERT. They never merge with anything.
    if (isUserAdded) {
      const created = await withRetryOn57014("upsertTbdRow.insert", () => sbPost<{ id: string }>(
        "ip_wholesale_forecast_tbd",
        [{ planning_run_id: planningRunId, ...args }],
        "return=representation",
      ));
      if (!created[0]?.id) throw new Error("upsertTbdRow: no id returned");
      return { id: created[0].id };
    }
    // Auto path: SELECT first, then PATCH or INSERT. Returns the id
    // so the caller can stamp it into local state immediately —
    // future edits then use patchTbdRow directly without going
    // through this select/insert dance.
    return withRetryOn57014("upsertTbdRow.findOrInsert", async () => {
      const findUrl = `ip_wholesale_forecast_tbd?planning_run_id=eq.${planningRunId}`
        + `&style_code=eq.${encodeURIComponent(args.style_code)}`
        + `&color=eq.${encodeURIComponent(args.color)}`
        + `&customer_id=eq.${args.customer_id}`
        + `&period_start=eq.${args.period_start}`
        + `&is_user_added=eq.false`
        + `&select=id&limit=1`;
      const existing = await sbGet<{ id: string }>(findUrl);
      if (existing[0]?.id) {
        await sbPatch(`ip_wholesale_forecast_tbd?id=eq.${existing[0].id}`, args);
        return { id: existing[0].id };
      }
      // Insert. If a concurrent writer beat us to it (23505), fall
      // back to PATCH after a re-fetch.
      try {
        const created = await sbPost<{ id: string }>(
          "ip_wholesale_forecast_tbd",
          [{ planning_run_id: planningRunId, ...args }],
          "return=representation",
        );
        if (!created[0]?.id) throw new Error("upsertTbdRow: no id returned from insert");
        return { id: created[0].id };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("23505")) throw e;
        const refetch = await sbGet<{ id: string }>(findUrl);
        if (refetch[0]?.id) {
          await sbPatch(`ip_wholesale_forecast_tbd?id=eq.${refetch[0].id}`, args);
          return { id: refetch[0].id };
        }
        throw e;
      }
    });
  },
  async patchTbdRow(id: string, patch: Record<string, unknown>): Promise<void> {
    await withRetryOn57014("patchTbdRow", () => sbPatch(`ip_wholesale_forecast_tbd?id=eq.${id}`, patch));
  },
  async deleteTbdRow(id: string): Promise<void> {
    await withRetryOn57014("deleteTbdRow", () => sbDelete(`ip_wholesale_forecast_tbd?id=eq.${id}`));
  },
  // Bulk-delete every TBD row tied to a planning run whose notes are
  // tagged with the [fromRequest:…] marker. Used at the start of each
  // build so multiple TBD-color requests for the same (style, customer,
  // period) grain can each persist as their own row without accumulating
  // duplicates across rebuilds. Plain INSERT path on each request would
  // otherwise compound the row count every build.
  async deleteRequestDerivedTbdRows(planningRunId: string): Promise<number> {
    const ids = await sbGetAll<{ id: string }>(
      `ip_wholesale_forecast_tbd?select=id,notes&planning_run_id=eq.${planningRunId}&notes=like.${encodeURIComponent("[fromRequest:%")}`,
    );
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const inList = slice.map((r) => `"${r.id}"`).join(",");
      await sbDelete(`ip_wholesale_forecast_tbd?planning_run_id=eq.${planningRunId}&id=in.(${inList})`);
    }
    return ids.length;
  },

  // System-qty override: planner directly edits the System forecast.
  // Stored alongside the original system_forecast_qty so the grid can
  // show "changed from X to Y on DATE". Pass null to clear.
  async patchForecastSystemOverride(
    forecastId: string,
    system_forecast_qty_override: number | null,
    final_forecast_qty: number,
    overridden_by: string | null,
  ): Promise<void> {
    const overridden_at = system_forecast_qty_override != null ? new Date().toISOString() : null;
    const rows = await sbPatch<IpWholesaleForecast>(
      `ip_wholesale_forecast?id=eq.${forecastId}`,
      {
        system_forecast_qty_override,
        system_forecast_qty_overridden_at: overridden_at,
        system_forecast_qty_overridden_by: system_forecast_qty_override != null ? overridden_by : null,
        final_forecast_qty,
      },
    );
    if (!rows[0]) throw new Error(`patchForecastSystemOverride: no row returned for ${forecastId}`);
  },

  // ── Future demand requests ───────────────────────────────────────────────
  // Bulk-mark requests as applied — fires after the forecast pipeline
  // has consumed them. Caller passes the ids of every open request
  // whose (customer_id, sku_id, period_start) ended up in the
  // persisted forecast, so the planner can see at a glance which
  // requests are folded in vs still pending.
  async markRequestsApplied(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const inList = slice.map((id) => `"${id}"`).join(",");
      await sbPatch(`ip_future_demand_requests?id=in.(${inList})`, { request_status: "applied" });
    }
  },
  async listOpenRequests(): Promise<IpFutureDemandRequest[]> {
    return sbGet<IpFutureDemandRequest>(
      "ip_future_demand_requests?select=*&request_status=eq.open&order=target_period_start.asc&limit=10000",
    );
  },
  // Active requests for the build pipeline = open + applied (archived
  // excluded). Without including applied, a rebuild after the first
  // pass dropped every applied request's qty / customer / confidence
  // out of the forecast — the planner's edits silently vanished.
  async listActiveRequestsForBuild(): Promise<IpFutureDemandRequest[]> {
    return sbGet<IpFutureDemandRequest>(
      "ip_future_demand_requests?select=*&request_status=in.(open,applied)&order=target_period_start.asc&limit=10000",
    );
  },
  // Every request regardless of status. Used by the FutureDemandRequestsPanel
  // so the planner can filter to "applied" / "archived" client-side
  // (listOpenRequests only returns open and would yield zero rows when
  // filtering by another status).
  async listAllRequests(): Promise<IpFutureDemandRequest[]> {
    return sbGet<IpFutureDemandRequest>(
      "ip_future_demand_requests?select=*&order=target_period_start.asc&limit=10000",
    );
  },
  async createRequest(row: Omit<IpFutureDemandRequest, "id" | "created_at" | "updated_at">): Promise<IpFutureDemandRequest> {
    const [created] = await sbPost<IpFutureDemandRequest>("ip_future_demand_requests", [row]);
    return created;
  },
  async updateRequest(id: string, patch: Partial<IpFutureDemandRequest>): Promise<IpFutureDemandRequest> {
    const [updated] = await sbPatch<IpFutureDemandRequest>(`ip_future_demand_requests?id=eq.${id}`, patch);
    return updated;
  },
  async deleteRequest(id: string): Promise<void> {
    await sbDelete(`ip_future_demand_requests?id=eq.${id}`);
  },

  // ── Planner overrides ────────────────────────────────────────────────────
  async listOverrides(planningRunId: string): Promise<IpPlannerOverride[]> {
    return sbGet<IpPlannerOverride>(
      `ip_planner_overrides?select=*&planning_run_id=eq.${planningRunId}&order=created_at.desc&limit=100000`,
    );
  },
  async createOverride(row: Omit<IpPlannerOverride, "id" | "created_at" | "updated_at">): Promise<IpPlannerOverride> {
    const [created] = await sbPost<IpPlannerOverride>("ip_planner_overrides", [row]);
    return created;
  },

  // Wipe forecast rows for a run whose (customer_id, sku_id,
  // period_start) grain key is NOT in `inScopeGrainKeys`. Used by the
  // filtered-build path so a focused build (e.g. one style + 8 periods)
  // produces a run that contains ONLY the filtered slice — out-of-scope
  // rows from prior unfiltered builds are removed automatically.
  //
  // Recommendations are skipped here because replaceRecommendations()
  // already DELETEs all recs for the run before re-inserting the new
  // (filtered) set. Same with bucket buys — they're rebuilt from
  // planner edits each session and can be cleared independently.
  // Overrides + TBD rows are LEFT ALONE: the user might still want
  // their planner edits / stock-buys to live on rows that will be
  // re-built. Future work can scope those too if it becomes an issue.
  async wipeOutOfScopeForecast(
    planningRunId: string,
    inScopeGrainKeys: Set<string>,
  ): Promise<{ wiped: number }> {
    const all = await sbGetAll<{ id: string; customer_id: string; sku_id: string; period_start: string }>(
      `ip_wholesale_forecast?select=id,customer_id,sku_id,period_start&planning_run_id=eq.${planningRunId}&order=id.asc`,
    );
    const outOfScope = all.filter(
      (r) => !inScopeGrainKeys.has(`${r.customer_id}:${r.sku_id}:${r.period_start}`),
    );
    if (outOfScope.length === 0) return { wiped: 0 };
    const DELETE_CHUNK = 500;
    for (let i = 0; i < outOfScope.length; i += DELETE_CHUNK) {
      const ids = outOfScope.slice(i, i + DELETE_CHUNK).map((r) => r.id);
      const inList = ids.map((id) => `"${id}"`).join(",");
      await sbDelete(`ip_wholesale_forecast?planning_run_id=eq.${planningRunId}&id=in.(${inList})`);
    }
    return { wiped: outOfScope.length };
  },

  // Wipe EVERY row tied to a planning run — system-computed forecast,
  // recommendations, planner-authored TBD stock-buy rows, and
  // aggregate bucket buys. Used by the "Wipe + rebuild" path in
  // PlanningRunControls when the planner wants a clean slate.
  // ip_planner_overrides (the audit log of system-qty overrides) is
  // also dropped so the next build starts from raw history.
  // Chunked the same way replaceRecommendations is — single DELETE
  // WHERE planning_run_id=X over 16k rows reliably 57014's. Read ids,
  // delete in id-in-list batches.
  async wipePlanningRunData(planningRunId: string): Promise<{ forecast: number; recs: number; tbd: number; buckets: number; overrides: number }> {
    let forecast = 0, recs = 0, tbd = 0, buckets = 0, overrides = 0;
    const DELETE_CHUNK = 500;
    const wipeTable = async (table: string): Promise<number> => {
      const rows = await sbGetAll<{ id: string }>(
        `${table}?select=id&planning_run_id=eq.${planningRunId}&order=id.asc`,
      );
      for (let i = 0; i < rows.length; i += DELETE_CHUNK) {
        const ids = rows.slice(i, i + DELETE_CHUNK).map((r) => r.id);
        const inList = ids.map((id) => `"${id}"`).join(",");
        await sbDelete(`${table}?planning_run_id=eq.${planningRunId}&id=in.(${inList})`);
      }
      return rows.length;
    };
    forecast  = await wipeTable("ip_wholesale_forecast");
    recs      = await wipeTable("ip_wholesale_recommendations");
    tbd       = await wipeTable("ip_wholesale_forecast_tbd");
    buckets   = await wipeTable("ip_planner_bucket_buys");
    overrides = await wipeTable("ip_planner_overrides");
    return { forecast, recs, tbd, buckets, overrides };
  },

  // ── Recommendations ──────────────────────────────────────────────────────
  async listRecommendations(planningRunId: string): Promise<IpWholesaleRecommendation[]> {
    // Paginate — limit=200000 hits Supabase's 8s statement timeout
    // once recommendations grow past a few thousand rows. Order by id
    // (PK) avoids expensive multi-column sorts that also blew timeout.
    return sbGetAll<IpWholesaleRecommendation>(
      `ip_wholesale_recommendations?select=*&planning_run_id=eq.${planningRunId}&order=id.asc`,
    );
  },
  async replaceRecommendations(
    planningRunId: string,
    rows: Array<Omit<IpWholesaleRecommendation, "id" | "created_at">>,
    options: {
      signal?: AbortSignal;
      onProgress?: (rowsDone: number, totalRows: number) => void;
      onPhase?: (label: string) => void;
      onChunk?: (chunkSize: number) => void;
    } = {},
  ): Promise<void> {
    const { signal, onProgress, onPhase, onChunk } = options;
    if (signal?.aborted) throw new BuildCancelledError();

    // Chunked DELETE — a single DELETE WHERE planning_run_id=X against
    // 16k+ rows with 4 secondary indexes routinely tipped Supabase's 8s
    // statement timeout. Read the IDs first (cheap, indexed by run_id),
    // then DELETE by id-in-list in chunks. Belt-and-suspenders against
    // both the timeout AND PostgREST URL length limits.
    onPhase?.("Clearing previous recommendations");
    const existing = await sbGetAll<{ id: string }>(
      `ip_wholesale_recommendations?select=id&planning_run_id=eq.${planningRunId}&order=id.asc`,
    );
    const DELETE_CHUNK = 500;
    for (let i = 0; i < existing.length; i += DELETE_CHUNK) {
      if (signal?.aborted) throw new BuildCancelledError();
      const ids = existing.slice(i, i + DELETE_CHUNK).map((r) => r.id);
      const inList = ids.map((id) => `"${id}"`).join(",");
      await sbDelete(`ip_wholesale_recommendations?planning_run_id=eq.${planningRunId}&id=in.(${inList})`);
    }

    if (rows.length === 0) return;

    // Initial chunk 100 — the recommendations table has 4 secondary
    // indexes and an FK to ip_item_master. Same chunk-halving pattern
    // as upsertForecast for resilience under intermittent timeouts.
    const INITIAL_CHUNK = 100;
    const MIN_CHUNK = 25;
    type Row = (typeof rows)[number];
    const postChunk = async (chunk: Row[]): Promise<void> => {
      if (signal?.aborted) throw new BuildCancelledError();
      try {
        await sbPost<IpWholesaleRecommendation>("ip_wholesale_recommendations", chunk, "return=minimal");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("57014") && chunk.length > MIN_CHUNK) {
          const half = Math.max(MIN_CHUNK, Math.floor(chunk.length / 2));
          for (let j = 0; j < chunk.length; j += half) {
            await postChunk(chunk.slice(j, j + half));
          }
          return;
        }
        throw e;
      }
    };
    let done = 0;
    for (let i = 0; i < rows.length; i += INITIAL_CHUNK) {
      const chunk = rows.slice(i, i + INITIAL_CHUNK);
      await postChunk(chunk);
      done += chunk.length;
      onProgress?.(done, rows.length);
      onChunk?.(chunk.length);
    }
  },

};

export type WholesaleRepo = typeof wholesaleRepo;
