// Supabase REST access for Phase 2 ecom tables. Mirrors the pattern
// in wholesalePlanningRepository.ts — same SB_URL + SB_HEADERS idiom,
// same chunked upsert strategy for bulk writes.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type { IpChannel, IpItem, IpCategory, IpSalesEcomRow } from "../../types/entities";
import type { IpProductChannelStatus } from "../../types/entities";
import type {
  IpEcomForecast,
  IpEcomOverrideEvent,
  IpProductChannelStatusExt,
} from "../types/ecom";

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

export const ecomRepo = {
  // ── reads for compute + grid ─────────────────────────────────────────────
  async listChannels(): Promise<IpChannel[]> {
    return sbGet<IpChannel>(`ip_channel_master?select=*&channel_type=in.(ecom,marketplace)&limit=1000`);
  },
  async listCategories(): Promise<IpCategory[]> {
    return sbGet<IpCategory>(`ip_category_master?select=*&limit=5000`);
  },
  async listItems(): Promise<IpItem[]> {
    return sbGet<IpItem>(`ip_item_master?select=*&limit=20000`);
  },
  async listEcomSales(sinceIso: string): Promise<IpSalesEcomRow[]> {
    return sbGet<IpSalesEcomRow>(
      `ip_sales_history_ecom?select=*&order_date=gte.${sinceIso}&limit=200000`,
    );
  },
  async listProductChannelStatus(): Promise<IpProductChannelStatusExt[]> {
    // The Phase 0 table has all the Phase 2 columns after the migration;
    // a simple select=* is enough.
    return sbGet<IpProductChannelStatusExt>("ip_product_channel_status?select=*&limit=50000");
  },

  // ── forecast rows ────────────────────────────────────────────────────────
  async listForecast(planningRunId: string): Promise<IpEcomForecast[]> {
    return sbGet<IpEcomForecast>(
      `ip_ecom_forecast?select=*&planning_run_id=eq.${planningRunId}&order=week_start.asc,channel_id.asc,sku_id.asc&limit=200000`,
    );
  },
  async upsertForecast(rows: Array<Omit<IpEcomForecast, "id" | "created_at" | "updated_at">>): Promise<void> {
    if (rows.length === 0) return;
    const url = "ip_ecom_forecast?on_conflict=planning_run_id,channel_id,sku_id,week_start";
    const prefer = "return=minimal,resolution=merge-duplicates";
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      try {
        await sbPost<IpEcomForecast>(url, chunk, prefer);
      } catch (e) {
        if (e instanceof Error && e.message.includes("PGRST204") && e.message.includes("planned_buy_qty")) {
          const stripped = chunk.map(({ planned_buy_qty: _a, ...rest }) => rest);
          await sbPost<IpEcomForecast>(url, stripped, prefer);
        } else {
          throw e;
        }
      }
    }
  },
  async patchForecastBuyQty(forecastId: string, planned_buy_qty: number | null): Promise<IpEcomForecast> {
    const rows = await sbPatch<IpEcomForecast>(`ip_ecom_forecast?id=eq.${forecastId}`, { planned_buy_qty });
    if (!rows[0]) throw new Error(`patchForecastBuyQty: no row returned for ${forecastId}`);
    return rows[0];
  },
  async patchForecastOverride(
    forecastId: string,
    override_qty: number,
    final_forecast_qty: number,
  ): Promise<IpEcomForecast> {
    const rows = await sbPatch<IpEcomForecast>(`ip_ecom_forecast?id=eq.${forecastId}`, {
      override_qty,
      final_forecast_qty,
      protected_ecom_qty: final_forecast_qty,
    });
    if (!rows[0]) throw new Error(`patchForecastOverride: no row returned for ${forecastId}`);
    return rows[0];
  },
  async patchForecastFlags(
    forecastId: string,
    flags: { promo_flag?: boolean; launch_flag?: boolean; markdown_flag?: boolean; notes?: string | null },
  ): Promise<IpEcomForecast> {
    const [updated] = await sbPatch<IpEcomForecast>(`ip_ecom_forecast?id=eq.${forecastId}`, flags);
    return updated;
  },

  // ── override audit ───────────────────────────────────────────────────────
  async listOverrides(planningRunId: string): Promise<IpEcomOverrideEvent[]> {
    return sbGet<IpEcomOverrideEvent>(
      `ip_ecom_override_events?select=*&planning_run_id=eq.${planningRunId}&order=created_at.desc&limit=100000`,
    );
  },
  async createOverride(row: Omit<IpEcomOverrideEvent, "id" | "created_at">): Promise<IpEcomOverrideEvent> {
    const rows = await sbPost<IpEcomOverrideEvent>("ip_ecom_override_events", [row]);
    if (!rows[0]) throw new Error("createOverride: no row returned");
    return rows[0];
  },
};

export type EcomRepo = typeof ecomRepo;

// Re-export the Phase 0 Shopify channel-status reader as a typed bridge
// so the rest of the code can keep talking to one shape.
export type { IpProductChannelStatus };
