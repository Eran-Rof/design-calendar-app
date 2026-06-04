// Data access for the Planning Reports suite.
//
// Reports aggregate client-side (same "load tables, compute in-app" pattern
// the rest of the planning app uses), so this module just pages every needed
// ip_* table down via the PostgREST Range header, projecting only the columns
// each report consumes to keep payloads lean. Aggregation lives in the pure
// report modules; this file is IO only.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";

const PAGE_SIZE = 1000;
const MAX_ROWS = 250_000; // safety ceiling; largest table (~78k) is well under

async function pageAll<T>(table: string, query: string): Promise<T[]> {
  if (!SB_URL) return [];
  const rows: T[] = [];
  const sep = query ? "&" : "";
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}${sep}`, {
      headers: { ...SB_HEADERS, "Range-Unit": "items", Range: `${from}-${to}` },
    });
    if (!r.ok) break;
    const batch = (await r.json()) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

// ── Row shapes (only the projected columns) ─────────────────────────────────
export interface RepItem {
  id: string; sku_code: string; style_code: string | null; description: string | null;
  category_id: string | null; color: string | null; size: string | null;
  unit_cost: number | null; lead_time_days: number | null; active: boolean | null;
}
export interface RepNamed { id: string; name: string }
export interface RepAvgCost { sku_code: string; avg_cost: number | null }
export interface RepVendor { id: string; name: string }
export interface RepSaleW {
  sku_id: string; customer_id: string | null; category_id: string | null; channel_id: string | null;
  txn_type: string | null; txn_date: string; qty: number | null; net_amount: number | null;
  margin_amount: number | null; order_number: string | null;
}
export interface RepInv {
  sku_id: string; warehouse_code: string | null; snapshot_date: string;
  qty_on_hand: number | null; qty_available: number | null; qty_committed: number | null;
  qty_on_order: number | null; qty_in_transit: number | null;
}
export interface RepOpenPo {
  sku_id: string; vendor_id: string | null; po_number: string | null; expected_date: string | null;
  qty_open: number | null; unit_cost: number | null; status: string | null;
}
export interface RepRec {
  planning_run_id: string; sku_id: string; category_id: string | null; period_code: string | null;
  recommendation_type: string | null; recommendation_qty: number | null; priority_level: string | null;
  shortage_qty: number | null; excess_qty: number | null; service_risk_flag: boolean | null;
}
export interface RepAccuracy {
  planning_run_id: string; forecast_type: string | null; sku_id: string | null; category_id: string | null;
  period_code: string | null; forecast_method: string | null;
  system_forecast_qty: number | null; final_forecast_qty: number | null; actual_qty: number | null;
  abs_error_system: number | null; abs_error_final: number | null;
  bias_system: number | null; bias_final: number | null;
}
export interface RepRun {
  id: string; name: string; planning_scope: string; status: string;
  source_snapshot_date: string | null; horizon_start: string | null; horizon_end: string | null;
}

// ── Masters (small, shared across reports) ──────────────────────────────────
export const reportsRepo = {
  listRuns: () =>
    pageAll<RepRun>("ip_planning_runs",
      "select=id,name,planning_scope,status,source_snapshot_date,horizon_start,horizon_end&order=created_at.desc"),

  listItems: () =>
    pageAll<RepItem>("ip_item_master",
      "select=id,sku_code,style_code,description,category_id,color,size,unit_cost,lead_time_days,active"),

  listCategories: () => pageAll<RepNamed>("ip_category_master", "select=id,name&order=name.asc"),
  listCustomers: () => pageAll<RepNamed>("ip_customer_master", "select=id,name&order=name.asc"),
  listChannels: () => pageAll<RepNamed>("ip_channel_master", "select=id,name&order=name.asc"),
  listVendors: () => pageAll<RepVendor>("ip_vendor_master", "select=id,name&order=name.asc"),
  listAvgCosts: () => pageAll<RepAvgCost>("ip_item_avg_cost", "select=sku_code,avg_cost"),

  // ── Fact tables ──────────────────────────────────────────────────────────
  listWholesaleSales: (fromIso: string, toIso: string) =>
    pageAll<RepSaleW>("ip_sales_history_wholesale",
      "select=sku_id,customer_id,category_id,channel_id,txn_type,txn_date,qty,net_amount,margin_amount,order_number" +
      `&txn_date=gte.${fromIso}&txn_date=lte.${toIso}`),

  listInventory: () =>
    pageAll<RepInv>("ip_inventory_snapshot",
      "select=sku_id,warehouse_code,snapshot_date,qty_on_hand,qty_available,qty_committed,qty_on_order,qty_in_transit"),

  listOpenPos: () =>
    pageAll<RepOpenPo>("ip_open_purchase_orders",
      "select=sku_id,vendor_id,po_number,expected_date,qty_open,unit_cost,status"),

  listRecommendations: (runId: string) =>
    pageAll<RepRec>("ip_inventory_recommendations",
      "select=planning_run_id,sku_id,category_id,period_code,recommendation_type,recommendation_qty,priority_level,shortage_qty,excess_qty,service_risk_flag" +
      `&planning_run_id=eq.${runId}`),

  listAccuracy: (runId: string) =>
    pageAll<RepAccuracy>("ip_forecast_accuracy",
      "select=planning_run_id,forecast_type,sku_id,category_id,period_code,forecast_method,system_forecast_qty,final_forecast_qty,actual_qty,abs_error_system,abs_error_final,bias_system,bias_final" +
      `&planning_run_id=eq.${runId}`),
};
