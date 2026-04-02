export interface ATSRow {
  sku: string;
  description: string;
  category?: string;
  store?: string;
  dates: Record<string, number>;
  freeMap?: Record<string, number>; // free-to-sell qty per date (not needed for uncovered future SOs)
  onOrder: number;
  onCommitted: number;
  onHand: number;
  avgCost?: number;
  lastReceiptDate?: string;
  totalAmount?: number;
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

export interface ATSSkuData { sku: string; description: string; category?: string; store?: string; onHand: number; onOrder: number; onCommitted?: number; lastReceiptDate?: string; totalAmount?: number; avgCost?: number; }
export interface ATSPoEvent { sku: string; date: string; qty: number; poNumber: string; vendor: string; store: string; unitCost: number; }
export interface ATSSoEvent { sku: string; date: string; qty: number; orderNumber: string; customerName: string; unitPrice: number; totalPrice: number; store: string; }
export interface UploadWarning { severity: "error" | "warn"; field: string; affected: number; total: number; message: string; }
export interface ExcelData { syncedAt: string; skus: ATSSkuData[]; pos: ATSPoEvent[]; sos: ATSSoEvent[]; warnings?: UploadWarning[]; columnNames?: { inventory: string[]; purchases: string[]; orders: string[] }; }
export interface CtxMenu { x: number; y: number; anchorY: number; pos: ATSPoEvent[]; sos: ATSSoEvent[]; onHand: number; skuStore: string; cellKey: string; cellEl: HTMLElement | null; flipped: boolean; arrowLeft: number; }
export interface SummaryCtxMenu { type: "onHand" | "onOrder" | "onPO"; row: ATSRow; pos: ATSPoEvent[]; sos: ATSSoEvent[]; cellEl: HTMLElement; }
