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
    const rows = await sbGet<{ value: string }>("app_data?key=eq.ats_excel_data&select=value");
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
    return sbGetAll<IpOpenPoRow>("ip_open_purchase_orders?select=*&order=expected_date.asc");
  },
  async listOpenSos(): Promise<IpOpenSoRow[]> {
    return sbGetAll<IpOpenSoRow>("ip_open_sales_orders?select=*&order=ship_date.asc");
  },
  async listReceipts(sinceIso: string): Promise<IpReceiptRow[]> {
    return sbGetAll<IpReceiptRow>(
      `ip_receipts_history?select=*&received_date=gte.${sinceIso}&order=received_date.asc`,
    );
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
  // PostgREST caps single-fetch responses (typically 1000 rows on default
  // configurations) regardless of the limit= value, so paginate explicitly.
  // Without this, multi-month horizons silently truncated to the earliest
  // periods only — the user saw "only Apr/May" when the run spanned Apr–Aug.
  async listForecast(planningRunId: string): Promise<IpWholesaleForecast[]> {
    // No ORDER BY — the multi-column sort hammered the 8s statement
    // timeout once the forecast grew past ~10k rows. Caller loads
    // everything into memory and joins; row order doesn't matter.
    // Order by id (PK) gives us a stable cursor for offset paging.
    const out: IpWholesaleForecast[] = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const chunk = await sbGet<IpWholesaleForecast>(
        `ip_wholesale_forecast?select=*&planning_run_id=eq.${planningRunId}&order=id.asc&limit=${PAGE}&offset=${offset}`,
      );
      out.push(...chunk);
      if (chunk.length < PAGE) break;
      if (offset > 1_000_000) break;
    }
    return out;
  },
  async upsertForecast(rows: Array<Omit<IpWholesaleForecast, "id" | "created_at" | "updated_at">>): Promise<void> {
    if (rows.length === 0) return;
    const url = "ip_wholesale_forecast?on_conflict=planning_run_id,customer_id,sku_id,period_start";
    const prefer = "return=minimal,resolution=merge-duplicates";
    // 5 secondary indexes + 3 FK checks per row — chunks above ~250 can
    // tip past Supabase's 8s statement timeout (57014).
    const INITIAL_CHUNK = 200;
    const MIN_CHUNK = 25;

    type Row = (typeof rows)[number];
    const postChunk = async (chunk: Row[]): Promise<void> => {
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

    for (let i = 0; i < rows.length; i += INITIAL_CHUNK) {
      await postChunk(rows.slice(i, i + INITIAL_CHUNK));
    }
  },
  async patchForecastOverride(
    forecastId: string,
    override_qty: number,
    final_forecast_qty: number,
  ): Promise<IpWholesaleForecast> {
    const rows = await sbPatch<IpWholesaleForecast>(
      `ip_wholesale_forecast?id=eq.${forecastId}`,
      { override_qty, final_forecast_qty },
    );
    if (!rows[0]) throw new Error(`patchForecastOverride: no row returned for ${forecastId}`);
    return rows[0];
  },
  async patchForecastBuyerRequest(
    forecastId: string,
    buyer_request_qty: number,
    final_forecast_qty: number,
  ): Promise<void> {
    const rows = await sbPatch<IpWholesaleForecast>(
      `ip_wholesale_forecast?id=eq.${forecastId}`,
      { buyer_request_qty, final_forecast_qty },
    );
    if (!rows[0]) throw new Error(`patchForecastBuyerRequest: no row returned for ${forecastId}`);
  },
  async patchForecastBuyQty(forecastId: string, planned_buy_qty: number | null): Promise<void> {
    const rows = await sbPatch<IpWholesaleForecast>(
      `ip_wholesale_forecast?id=eq.${forecastId}`,
      { planned_buy_qty },
    );
    if (!rows[0]) throw new Error(`patchForecastBuyQty: no row returned for ${forecastId}`);
  },
  async patchForecastUnitCostOverride(forecastId: string, unit_cost_override: number | null): Promise<void> {
    const rows = await sbPatch<IpWholesaleForecast>(
      `ip_wholesale_forecast?id=eq.${forecastId}`,
      { unit_cost_override },
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
    await sbPost(
      "ip_planner_bucket_buys?on_conflict=planning_run_id,bucket_key",
      [{ planning_run_id: planningRunId, ...args }],
      "resolution=merge-duplicates,return=minimal",
    );
  },
  async deleteBucketBuy(planningRunId: string, bucketKey: string): Promise<void> {
    await sbDelete(`ip_planner_bucket_buys?planning_run_id=eq.${planningRunId}&bucket_key=eq.${encodeURIComponent(bucketKey)}`);
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
  ): Promise<void> {
    // Recommendations are fully regenerated each run; clear then insert.
    await sbDelete(`ip_wholesale_recommendations?planning_run_id=eq.${planningRunId}`);
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await sbPost<IpWholesaleRecommendation>(
        "ip_wholesale_recommendations",
        chunk,
        "return=minimal",
      );
    }
  },
};

export type WholesaleRepo = typeof wholesaleRepo;
