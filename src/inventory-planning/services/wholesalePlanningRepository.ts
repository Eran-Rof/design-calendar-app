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
  IpItemAvgCost,
  IpOpenPoRow,
  IpOpenSoRow,
  IpReceiptRow,
  IpSalesWholesaleRow,
} from "../types/entities";
import type {
  IpFutureDemandRequest,
  IpPlannerOverride,
  IpPlanningRun,
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
// in 1000-row pages using Range headers.
async function sbGetAll<T>(pathWithoutLimit: string): Promise<T[]> {
  assertSupabase();
  const out: T[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const sep = pathWithoutLimit.includes("?") ? "&" : "?";
    const url = `${SB_URL}/rest/v1/${pathWithoutLimit}${sep}limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) throw new Error(`Supabase GET ${url} failed: ${r.status} ${await r.text()}`);
    const chunk = (await r.json()) as T[];
    out.push(...chunk);
    if (chunk.length < PAGE) break;
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
  async listItems(): Promise<IpItem[]> {
    // Paginate so a 20k+ catalog (Xoro items-sync + auto-create from
    // invoice ingest can easily exceed the previous 20000 cap) doesn't
    // truncate. PostgREST limit caps at 1000/req on most configurations.
    const out: IpItem[] = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const chunk = await sbGet<IpItem>(`ip_item_master?select=*&order=sku_code.asc&limit=${PAGE}&offset=${offset}`);
      out.push(...chunk);
      if (chunk.length < PAGE) break;
      if (offset > 200_000) break; // safety cap
    }
    return out;
  },
  // Canonical avg cost per SKU — fed by Xoro/Excel ingest. Covers SKUs
  // not currently in ATS inventory. Returns an empty map (not an error)
  // when the table is empty or the migration hasn't been applied yet.
  async listItemAvgCostBySku(): Promise<Map<string, number>> {
    try {
      const rows = await sbGet<IpItemAvgCost>("ip_item_avg_cost?select=sku_code,avg_cost&limit=50000");
      const out = new Map<string, number>();
      for (const r of rows) {
        if (r.sku_code && typeof r.avg_cost === "number" && r.avg_cost > 0) {
          out.set(r.sku_code, r.avg_cost);
        }
      }
      return out;
    } catch {
      return new Map();
    }
  },
  // Read avg unit cost per SKU from the ATS app's persisted Excel snapshot.
  // Stored as a JSON-stringified blob in app_data under key=ats_excel_data;
  // the relevant slice is `skus[i] = { sku, avgCost }`. ATS only carries
  // costs for in-stock SKUs — used as a fallback when ip_item_avg_cost
  // has no row.
  async listAtsAvgCostBySku(): Promise<Map<string, number>> {
    let rows: Array<{ value: string }>;
    try {
      rows = await withRetryOn57014("listAtsAvgCostBySku",
        () => sbGet<{ value: string }>("app_data?key=eq.ats_excel_data&select=value"));
    } catch {
      // Cost lookup is auxiliary — failing to load it shouldn't
      // block the whole grid build. Return an empty map so the
      // caller can keep going.
      return new Map();
    }
    const raw = rows[0]?.value;
    if (!raw) return new Map();
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return new Map();
    }
    const skus = (parsed as { skus?: Array<{ sku?: string; avgCost?: number }> } | null)?.skus;
    if (!Array.isArray(skus)) return new Map();
    const out = new Map<string, number>();
    for (const s of skus) {
      if (s?.sku && typeof s.avgCost === "number" && s.avgCost > 0) out.set(s.sku, s.avgCost);
    }
    return out;
  },
  async listWholesaleSales(sinceIso: string): Promise<IpSalesWholesaleRow[]> {
    return sbGetAll<IpSalesWholesaleRow>(
      `ip_sales_history_wholesale?select=*&txn_date=gte.${sinceIso}&order=txn_date.asc`,
    );
  },
  async listInventorySnapshots(): Promise<IpInventorySnapshot[]> {
    return sbGetAll<IpInventorySnapshot>("ip_inventory_snapshot?select=*&order=snapshot_date.desc");
  },
  async listOpenPos(): Promise<IpOpenPoRow[]> {
    return withRetryOn57014("listOpenPos",
      () => sbGetAll<IpOpenPoRow>("ip_open_purchase_orders?select=*&order=expected_date.asc"));
  },
  async listOpenSos(): Promise<IpOpenSoRow[]> {
    return withRetryOn57014("listOpenSos",
      () => sbGetAll<IpOpenSoRow>("ip_open_sales_orders?select=*&order=ship_date.asc"));
  },
  async listReceipts(sinceIso: string): Promise<IpReceiptRow[]> {
    return withRetryOn57014("listReceipts",
      () => sbGetAll<IpReceiptRow>(
        `ip_receipts_history?select=*&received_date=gte.${sinceIso}&order=received_date.asc`,
      ));
  },

  // ── Planning runs ────────────────────────────────────────────────────────
  async listPlanningRuns(scope = "wholesale"): Promise<IpPlanningRun[]> {
    return sbGet<IpPlanningRun>(
      `ip_planning_runs?select=*&planning_scope=eq.${scope}&order=created_at.desc&limit=200`,
    );
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
    // Start small so the first request fits inside the anon-role 8s
    // statement timeout — the prior 500-row initial page was hitting
    // 500 (Internal Server Error) on the very first call for runs
    // with thousands of rows. The halving fallback below still kicks
    // in if even 250 is too many under load.
    const INITIAL_PAGE = 250;
    const MIN_PAGE = 50;
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
    options: { signal?: AbortSignal; onProgress?: (rowsDone: number, totalRows: number) => void } = {},
  ): Promise<void> {
    if (rows.length === 0) return;
    const url = "ip_wholesale_forecast?on_conflict=planning_run_id,customer_id,sku_id,period_start";
    const prefer = "return=minimal,resolution=merge-duplicates";
    // 5 secondary indexes + 3 FK checks per row — chunks above ~250 can
    // tip past Supabase's 8s statement timeout (57014).
    const INITIAL_CHUNK = 200;
    const MIN_CHUNK = 25;
    const { signal, onProgress } = options;

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
        if (msg.includes("PGRST204") && (msg.includes("ly_reference_qty") || msg.includes("planned_buy_qty") || msg.includes("unit_cost_override"))) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const stripped = chunk.map(({ ly_reference_qty: _a, planned_buy_qty: _b, unit_cost_override: _c, ...rest }) => rest);
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
    return sbGet(
      `ip_wholesale_forecast_tbd?planning_run_id=eq.${planningRunId}&select=*&limit=20000`,
    );
  },
  // Plain INSERT for planner-added TBD rows. Each call creates a
  // distinct row regardless of (style, color, customer, period)
  // duplication — the partial unique index on
  // ip_wholesale_forecast_tbd (added in migration 20260511) only
  // constrains rows where is_user_added=false, so user-added rows
  // can multiply at will. Sets is_user_added=true server-side too
  // as a belt-and-suspenders.
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
  async listOpenRequests(): Promise<IpFutureDemandRequest[]> {
    return sbGet<IpFutureDemandRequest>(
      "ip_future_demand_requests?select=*&request_status=eq.open&order=target_period_start.asc&limit=10000",
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
    } = {},
  ): Promise<void> {
    const { signal, onProgress, onPhase } = options;
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
    }
  },

};

export type WholesaleRepo = typeof wholesaleRepo;
