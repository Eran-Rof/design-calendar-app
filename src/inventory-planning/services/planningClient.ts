// Thin Supabase reader used by the data-quality admin page. REST-style
// (fetch) calls mirror the convention in the rest of the app: anon key,
// simple select=*, no pagination helper needed for Phase 0 sizes.

import { SB_HEADERS, SB_URL } from "../../utils/supabase";
import type {
  IpInventorySnapshot,
  IpItem,
  IpOpenPoRow,
  IpReceiptRow,
  IpSalesEcomRow,
  IpSalesWholesaleRow,
} from "../types/entities";

async function selectAll<T>(table: string, limit = 5000): Promise<T[]> {
  if (!SB_URL) return [];
  const r = await fetch(`${SB_URL}/rest/v1/${table}?select=*&limit=${limit}`, {
    headers: SB_HEADERS,
  });
  if (!r.ok) return [];
  return r.json();
}

export async function loadPlanningSnapshot() {
  const [items, inventory, salesWholesale, salesEcom, receipts, openPos] = await Promise.all([
    selectAll<IpItem>("ip_item_master"),
    selectAll<IpInventorySnapshot>("ip_inventory_snapshot"),
    selectAll<IpSalesWholesaleRow>("ip_sales_history_wholesale"),
    selectAll<IpSalesEcomRow>("ip_sales_history_ecom"),
    selectAll<IpReceiptRow>("ip_receipts_history"),
    selectAll<IpOpenPoRow>("ip_open_purchase_orders"),
  ]);
  return { items, inventory, salesWholesale, salesEcom, receipts, openPos };
}
