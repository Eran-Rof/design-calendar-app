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
  // Pack-to-unit multiplier resolved from the master at compute time.
  // 1 for non-prepack rows. >1 (e.g. 24, 60) for prepacks. Carried on
  // the row so the grid cell can render the toggle's "show as packs"
  // mode and the small faded "PPKn × packs" or "PPKn = N units"
  // annotation without re-running ppkMultiplier on every render.
  ppkMult: number;
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
  // Clean style-level description from ip_item_master, e.g.
  // "LAIDBACK Baggy Fit". Falls back to the row's own dirty Xoro
  // description when the master has nothing. Display layer should
  // prefer this over `description` to avoid showing the SKU + color +
  // size composite Xoro packs into variant descriptions.
  master_description?: string | null;
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
export interface ATSSoEvent { sku: string; date: string; qty: number; orderNumber: string; customerName: string; unitPrice: number; totalPrice: number; store: string; customerPo?: string; cancelDate?: string; }
export interface UploadWarningItem { sku: string; qty: number; orderNumber?: string; poNumber?: string; customerName?: string; vendor?: string; }
export interface UploadWarning { severity: "error" | "warn"; field: string; affected: number; total: number; message: string; items?: UploadWarningItem[]; }
export interface ExcelData { syncedAt: string; skus: ATSSkuData[]; pos: ATSPoEvent[]; sos: ATSSoEvent[]; warnings?: UploadWarning[]; columnNames?: { inventory: string[]; purchases: string[]; orders: string[] }; }
export interface CtxMenu { x: number; y: number; anchorY: number; pos: ATSPoEvent[]; sos: ATSSoEvent[]; onHand: number; skuStore: string; cellKey: string; cellEl: HTMLElement | null; flipped: boolean; arrowLeft: number; unitCost?: number; ppkMult?: number; }
export interface SummaryCtxMenu {
  type: "onHand" | "onOrder" | "onPO";
  row: ATSRow;
  pos: ATSPoEvent[];
  sos: ATSSoEvent[];
  cellEl: HTMLElement;
  // Anchor position captured at click time. Used as the popup's
  // initial JSX inline style so the first paint is already in the
  // right place. Without this the popup briefly rendered at (0,0)
  // and the layout-effect reposition was racing the first paint —
  // visible as a missed arrow-overlap on most cells.
  initialX: number;
  initialY: number;
}
