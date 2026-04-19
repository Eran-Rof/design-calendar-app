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
    return sbGet<IpItem>("ip_item_master?select=*&limit=20000");
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
    // Upsert via the uq_ip_wholesale_forecast_grain unique index. Chunk
    // to keep the payload manageable.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await sbPost<IpWholesaleForecast>(
        "ip_wholesale_forecast?on_conflict=planning_run_id,customer_id,sku_id,period_start",
        chunk,
        "return=minimal,resolution=merge-duplicates",
      );
    }
  },
  async patchForecastOverride(
    forecastId: string,
    override_qty: number,
    final_forecast_qty: number,
  ): Promise<IpWholesaleForecast> {
    const [updated] = await sbPatch<IpWholesaleForecast>(
      `ip_wholesale_forecast?id=eq.${forecastId}`,
      { override_qty, final_forecast_qty },
    );
    return updated;
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
