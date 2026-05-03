export interface ATSRow {
  sku: string;
  description: string;
  category?: string;
  gender?: string;
  store?: string;
  dates: Record<string, number>;
  freeMap?: Record<string, number>; // free-to-sell qty per date (not needed for uncovered future SOs)
  onPO: number;
  onOrder: number;
  onHand: number;
  avgCost?: number;
  lastReceiptDate?: string;
  totalAmount?: number;
  // Phase 1 dark-ship fields populated by enrichWithItemMaster — sourced from
  // ip_item_master (the planning app's source of truth). Optional + nullable
  // so legacy rows + cache-not-loaded paths stay valid. UI does not yet read
  // these; Phase 2 will swap the grid columns to use them.
  master_category?: string | null;
  master_sub_category?: string | null;
  master_style?: string | null;
  master_color?: string | null;
  master_match_source?: "sku" | "style" | null;
  // Phase 3 collapse mode: present on synthetic aggregate rows produced by
  // collapseRows(). Leaf rows from compute.ts never set this. UI uses it to
  // render an expand triangle, blank inapplicable cells, and disable
  // SKU-merge drag/drop.
  __collapsed?: {
    level: "category" | "subCategory" | "style";
    key: string;
    childCount: number;
  } | null;
}

export interface ATSSnapshot {
  id: string;
  sku: string;
  description: string;
  category?: string;
  date: string;
  qty_available: number;
  qty_on_hand: number;
  qty_on_order: number;
  source: "xoro" | "excel";
  synced_at: string;
}

export interface ATSSkuData { sku: string; description: string; category?: string; gender?: string; store?: string; onHand: number; onPO: number; onOrder: number; lastReceiptDate?: string; totalAmount?: number; avgCost?: number; }
export interface ATSPoEvent { sku: string; date: string; qty: number; poNumber: string; vendor: string; store: string; unitCost: number; }
export interface ATSSoEvent { sku: string; date: string; qty: number; orderNumber: string; customerName: string; unitPrice: number; totalPrice: number; store: string; }
export interface UploadWarningItem { sku: string; qty: number; orderNumber?: string; poNumber?: string; customerName?: string; vendor?: string; }
export interface UploadWarning { severity: "error" | "warn"; field: string; affected: number; total: number; message: string; items?: UploadWarningItem[]; }
export interface ExcelData { syncedAt: string; skus: ATSSkuData[]; pos: ATSPoEvent[]; sos: ATSSoEvent[]; warnings?: UploadWarning[]; columnNames?: { inventory: string[]; purchases: string[]; orders: string[] }; }
export interface CtxMenu { x: number; y: number; anchorY: number; pos: ATSPoEvent[]; sos: ATSSoEvent[]; onHand: number; skuStore: string; cellKey: string; cellEl: HTMLElement | null; flipped: boolean; arrowLeft: number; unitCost?: number; }
export interface SummaryCtxMenu { type: "onHand" | "onOrder" | "onPO"; row: ATSRow; pos: ATSPoEvent[]; sos: ATSSoEvent[]; cellEl: HTMLElement; }
