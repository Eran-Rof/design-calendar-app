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
  async upsertItemAvgCost(rows: Array<Omit<IpItemAvgCost, "updated_at">>): Promise<void> {
    if (rows.length === 0) return;
    const url = "ip_item_avg_cost?on_conflict=sku_code";
    const prefer = "return=minimal,resolution=merge-duplicates";
    for (let i = 0; i < rows.length; i += 500) {
      await sbPost<IpItemAvgCost>(url, rows.slice(i, i + 500), prefer);
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
    return sbGet<IpSalesWholesaleRow>(
      `ip_sales_history_wholesale?select=*&txn_date=gte.${sinceIso}&limit=200000`,
    );
  },
  async listInventorySnapshots(): Promise<IpInventorySnapshot[]> {
    return sbGet<IpInventorySnapshot>("ip_inventory_snapshot?select=*&order=snapshot_date.desc&limit=100000");
  },
  async listOpenPos(): Promise<IpOpenPoRow[]> {
    return sbGet<IpOpenPoRow>("ip_open_purchase_orders?select=*&limit=100000");
  },
  async listReceipts(sinceIso: string): Promise<IpReceiptRow[]> {
    return sbGet<IpReceiptRow>(
      `ip_receipts_history?select=*&received_date=gte.${sinceIso}&limit=100000`,
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
  async listForecast(planningRunId: string): Promise<IpWholesaleForecast[]> {
    return sbGet<IpWholesaleForecast>(
      `ip_wholesale_forecast?select=*&planning_run_id=eq.${planningRunId}&order=period_start.asc,customer_id.asc,sku_id.asc&limit=200000`,
    );
  },
  async upsertForecast(rows: Array<Omit<IpWholesaleForecast, "id" | "created_at" | "updated_at">>): Promise<void> {
    if (rows.length === 0) return;
    const url = "ip_wholesale_forecast?on_conflict=planning_run_id,customer_id,sku_id,period_start";
    const prefer = "return=minimal,resolution=merge-duplicates";
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      try {
        await sbPost<IpWholesaleForecast>(url, chunk, prefer);
      } catch (e) {
        // PGRST204 = column not in schema cache (migration pending). Retry
        // without the optional planner-editable columns so builds survive
        // before the ALTER TABLEs run on the target environment.
        if (e instanceof Error && e.message.includes("PGRST204") && (e.message.includes("ly_reference_qty") || e.message.includes("planned_buy_qty") || e.message.includes("unit_cost_override"))) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const stripped = chunk.map(({ ly_reference_qty: _a, planned_buy_qty: _b, unit_cost_override: _c, ...rest }) => rest);
          await sbPost<IpWholesaleForecast>(url, stripped, prefer);
        } else {
          throw e;
        }
      }
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
    return sbGet<IpWholesaleRecommendation>(
      `ip_wholesale_recommendations?select=*&planning_run_id=eq.${planningRunId}&limit=200000`,
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
