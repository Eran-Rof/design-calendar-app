// Thin Supabase reader used by the data-quality admin page. REST-style
// (fetch) calls mirror the convention in the rest of the app: anon key.
//
// IMPORTANT: these tables outgrew Phase 0. ip_item_master is ~12.7k rows,
// ip_sales_history_wholesale ~46k, ip_inventory_snapshot ~78k. A single
// capped select truncates the result, which silently breaks the cross-row
// checks — the orphan-sales scan compares each sales row's sku_id against
// the loaded item set, so any item beyond the cap makes its (perfectly
// valid) sales rows look like orphans. That produced thousands of FALSE
// "error" rows on the DQ page. We now page through every table via the
// PostgREST Range header so the scan sees the complete dataset.

import { SB_HEADERS, SB_URL } from "../../utils/supabase";
import type {
  IpInventorySnapshot,
  IpItem,
  IpOpenPoRow,
  IpReceiptRow,
  IpSalesEcomRow,
  IpSalesWholesaleRow,
} from "../types/entities";

const PAGE_SIZE = 1000;
// Safety ceiling so a runaway table can't OOM the browser. Well above the
// current largest table (~78k). If a table ever exceeds this the scan is
// partial — surfaced via the `truncated` flag below.
const MAX_ROWS = 250_000;

async function selectAllPaged<T>(table: string): Promise<{ rows: T[]; truncated: boolean }> {
  if (!SB_URL) return { rows: [], truncated: false };
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const r = await fetch(`${SB_URL}/rest/v1/${table}?select=*`, {
      headers: { ...SB_HEADERS, "Range-Unit": "items", Range: `${from}-${to}` },
    });
    if (!r.ok) break;
    const batch = (await r.json()) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export interface PlanningSnapshot {
  items: IpItem[];
  inventory: IpInventorySnapshot[];
  salesWholesale: IpSalesWholesaleRow[];
  salesEcom: IpSalesEcomRow[];
  receipts: IpReceiptRow[];
  openPos: IpOpenPoRow[];
  /** Tables whose row count hit MAX_ROWS — the scan only saw a prefix. */
  truncatedTables: string[];
}

export async function loadPlanningSnapshot(): Promise<PlanningSnapshot> {
  const [items, inventory, salesWholesale, salesEcom, receipts, openPos] = await Promise.all([
    selectAllPaged<IpItem>("ip_item_master"),
    selectAllPaged<IpInventorySnapshot>("ip_inventory_snapshot"),
    selectAllPaged<IpSalesWholesaleRow>("ip_sales_history_wholesale"),
    selectAllPaged<IpSalesEcomRow>("ip_sales_history_ecom"),
    selectAllPaged<IpReceiptRow>("ip_receipts_history"),
    selectAllPaged<IpOpenPoRow>("ip_open_purchase_orders"),
  ]);
  const named: Array<[string, { truncated: boolean }]> = [
    ["ip_item_master", items],
    ["ip_inventory_snapshot", inventory],
    ["ip_sales_history_wholesale", salesWholesale],
    ["ip_sales_history_ecom", salesEcom],
    ["ip_receipts_history", receipts],
    ["ip_open_purchase_orders", openPos],
  ];
  return {
    items: items.rows,
    inventory: inventory.rows,
    salesWholesale: salesWholesale.rows,
    salesEcom: salesEcom.rows,
    receipts: receipts.rows,
    openPos: openPos.rows,
    truncatedTables: named.filter(([, v]) => v.truncated).map(([n]) => n),
  };
}
