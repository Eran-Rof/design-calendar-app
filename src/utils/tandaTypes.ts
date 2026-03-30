// ── PO WIP Types & Constants ──────────────────────────────────────────────────
// Shared between TandA.tsx and any module that needs PO/milestone types.

export interface SyncFilters {
  poNumbers: string[];
  dateFrom: string;
  dateTo: string;
  vendors: string[];
  statuses: string[];
}

export interface XoroPO {
  PoNumber?: string;
  VendorName?: string;
  DateOrder?: string;
  DateExpectedDelivery?: string;
  VendorReqDate?: string;
  StatusName?: string;
  CurrencyCode?: string;
  Memo?: string;
  Tags?: string;
  PaymentTermsName?: string;
  ShipMethodName?: string;
  CarrierName?: string;
  BuyerName?: string;
  BrandName?: string;
  TotalAmount?: number;
  Items?: XoroPOItem[];
  PoLineArr?: XoroPOItem[];
  _archived?: boolean;
  _archivedAt?: string;
}

export interface XoroPOItem {
  ItemNumber?: string;
  Description?: string;
  QtyOrder?: number;
  QtyReceived?: number;
  QtyRemaining?: number;
  UnitPrice?: number;
  Discount?: number;
}

export interface LocalNote {
  id: string;
  po_number: string;
  note: string;
  status_override?: string;
  created_at: string;
  user_name: string;
}

export interface User {
  id: string;
  username?: string;
  name?: string;
  password: string;
  role?: string;
  color?: string;
  initials?: string;
  avatar?: string | null;
}

export interface WipTemplate {
  id: string;
  phase: string;
  category: string;
  daysBeforeDDP: number;
  status: string;
  notes: string;
}

export interface Milestone {
  id: string;
  po_number: string;
  phase: string;
  category: string;
  sort_order: number;
  days_before_ddp: number;
  expected_date: string | null;
  actual_date: string | null;
  status: string;
  status_date: string | null;
  status_dates: Record<string, string> | null;
  notes: string;
  note_entries: { text: string; user: string; date: string }[] | null;
  updated_at: string;
  updated_by: string;
  variant_statuses: Record<string, { status: string; status_date: string | null }> | null;
}

export interface DCVendor {
  id: string;
  name: string;
  wipLeadOverrides?: Record<string, number>;
}

export interface DmConversation {
  chatId: string;
  recipient: string;
  recipientName: string;
  messages: any[];
}

export type View = "dashboard" | "list" | "detail" | "templates" | "email" | "teams" | "activity" | "vendors" | "timeline" | "archive";

// ── Constants ────────────────────────────────────────────────────────────────

export const ALL_PO_STATUSES = ["Open", "Released", "Received", "Partially Received", "Closed", "Cancelled", "Pending", "Draft"];
export const ACTIVE_PO_STATUSES = ["Open", "Released", "Partially Received", "Pending", "Draft"];

export const STATUS_COLORS: Record<string, string> = {
  Open:       "#3B82F6",
  Released:   "#8B5CF6",
  Received:   "#10B981",
  Closed:     "#6B7280",
  Cancelled:  "#EF4444",
  Pending:    "#F59E0B",
  Draft:      "#9CA3AF",
};

export const STATUS_OPTIONS = ["Open", "Released", "Received", "Closed", "Cancelled", "Pending", "Draft"];

export const WIP_CATEGORIES = ["Pre-Production", "Fabric T&A", "Samples", "Production", "Transit"];

export const MILESTONE_STATUSES = ["Not Started", "In Progress", "Complete", "Delayed", "N/A"];

export const MILESTONE_STATUS_COLORS: Record<string, string> = {
  "Not Started": "#6B7280",
  "In Progress": "#3B82F6",
  "Complete": "#10B981",
  "Delayed": "#EF4444",
  "N/A": "#9CA3AF",
};

export const DEFAULT_WIP_TEMPLATES: WipTemplate[] = [
  { id: "wip_labdip",    phase: "Lab Dip / Strike Off",      category: "Pre-Production", daysBeforeDDP: 120, status: "Not Started", notes: "" },
  { id: "wip_trims",     phase: "Trims",                     category: "Pre-Production", daysBeforeDDP: 110, status: "Not Started", notes: "" },
  { id: "wip_rawgoods",  phase: "Raw Goods Available",       category: "Fabric T&A",     daysBeforeDDP: 100, status: "Not Started", notes: "" },
  { id: "wip_fabprint",  phase: "Fabric at Printing Mill",   category: "Fabric T&A",     daysBeforeDDP: 90,  status: "Not Started", notes: "" },
  { id: "wip_fabfg",     phase: "Fabric Finished Goods",     category: "Fabric T&A",     daysBeforeDDP: 80,  status: "Not Started", notes: "" },
  { id: "wip_fabfact",   phase: "Fabric at Factory",         category: "Fabric T&A",     daysBeforeDDP: 70,  status: "Not Started", notes: "" },
  { id: "wip_fabcut",    phase: "Fabric at Cutting Line",    category: "Fabric T&A",     daysBeforeDDP: 60,  status: "Not Started", notes: "" },
  { id: "wip_fitsample", phase: "Fit Sample",                category: "Samples",        daysBeforeDDP: 90,  status: "Not Started", notes: "" },
  { id: "wip_ppsample",  phase: "PP Sample",                 category: "Samples",        daysBeforeDDP: 75,  status: "Not Started", notes: "" },
  { id: "wip_ppapproval",phase: "PP Approval",               category: "Samples",        daysBeforeDDP: 65,  status: "Not Started", notes: "" },
  { id: "wip_sizeset",   phase: "Size Set",                  category: "Samples",        daysBeforeDDP: 55,  status: "Not Started", notes: "" },
  { id: "wip_fabready",  phase: "Fabric Ready",              category: "Production",     daysBeforeDDP: 50,  status: "Not Started", notes: "" },
  { id: "wip_prodstart", phase: "Prod Start",                category: "Production",     daysBeforeDDP: 42,  status: "Not Started", notes: "" },
  { id: "wip_packstart", phase: "Packing Start",             category: "Production",     daysBeforeDDP: 28,  status: "Not Started", notes: "" },
  { id: "wip_prodend",   phase: "Prod End",                  category: "Production",     daysBeforeDDP: 21,  status: "Not Started", notes: "" },
  { id: "wip_topsample", phase: "Top Sample",                category: "Transit",        daysBeforeDDP: 18,  status: "Not Started", notes: "" },
  { id: "wip_exfactory", phase: "Ex Factory",                category: "Transit",        daysBeforeDDP: 14,  status: "Not Started", notes: "" },
  { id: "wip_packdocs",  phase: "Packing List / Docs Rec'd", category: "Transit",        daysBeforeDDP: 7,   status: "Not Started", notes: "" },
  { id: "wip_inhouse",   phase: "In House / DDP",            category: "Transit",        daysBeforeDDP: 0,   status: "Not Started", notes: "" },
];

// ── Helper functions ─────────────────────────────────────────────────────────

export function milestoneUid() {
  return "ms_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Get effective qty for a PO line item: QtyRemaining for partially received, QtyOrder otherwise. */
export function itemQty(item: any): number {
  if (item.QtyRemaining != null) return item.QtyRemaining;
  if (item.QtyReceived != null && item.QtyReceived > 0) return (item.QtyOrder ?? 0) - item.QtyReceived;
  return item.QtyOrder ?? 0;
}

export function poTotal(po: XoroPO): number {
  const items = po.Items ?? po.PoLineArr ?? [];
  const hasReceived = items.some((i: any) => (i.QtyReceived ?? 0) > 0);
  if (hasReceived) {
    return items.reduce((s, i: any) => s + itemQty(i) * (i.UnitPrice ?? 0), 0);
  }
  if (po.TotalAmount != null) return po.TotalAmount;
  return items.reduce((s, i) => s + itemQty(i) * (i.UnitPrice ?? 0), 0);
}

export function normalizeSize(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s.]+/g, "");
  if (s === "s" || s === "sm" || s === "sml" || s === "small") return "Small";
  if (s === "m" || s === "med" || s === "medium") return "Medium";
  if (s === "l" || s === "lg" || s === "lrg" || s === "large") return "Large";
  if (s === "xl" || s === "xlg" || s === "xlarge" || s === "xtralarge" || s === "extralarge") return "Xlarge";
  if (s === "xxl" || s === "2xl" || s === "2x") return "XXL";
  if (s === "xxxl" || s === "3xl" || s === "3x") return "3XL";
  if (s === "xxxxl" || s === "4xl" || s === "4x") return "4XL";
  return raw;
}

export const ALPHA_SZ_ORDER: Record<string, number> = { Small: 1, Medium: 2, Large: 3, Xlarge: 4, XXL: 5, "3XL": 6, "4XL": 7 };

export function sizeSort(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  const oa = ALPHA_SZ_ORDER[a], ob = ALPHA_SZ_ORDER[b];
  if (oa !== undefined && ob !== undefined) return oa - ob;
  if (oa !== undefined) return 1;
  if (ob !== undefined) return -1;
  return a.localeCompare(b);
}

export function mapXoroRaw(raw: any[]): XoroPO[] {
  return raw.map((item: any) => {
    const h = item.poHeader ?? item;
    const lines = item.poLines ?? item.PoLineArr ?? item.Items ?? [];
    return {
      PoNumber:              h.OrderNumber ?? h.PoNumber ?? "",
      VendorName:            h.VendorName ?? "",
      DateOrder:             h.DateOrder ?? "",
      DateExpectedDelivery:  h.DateExpectedDelivery ?? "",
      VendorReqDate:         h.VendorReqDate ?? "",
      StatusName:            h.StatusName ?? "",
      CurrencyCode:          h.CurrencyCode ?? "USD",
      Memo:                  h.Memo ?? "",
      Tags:                  h.Tags ?? "",
      PaymentTermsName:      h.PaymentTermsName ?? "",
      ShipMethodName:        h.ShipMethodName ?? "",
      CarrierName:           h.CarrierName ?? "",
      BuyerName:             h.BuyerName ?? "",
      BrandName:             h.BrandName ?? h.Brand ?? "",
      TotalAmount:           h.TotalAmount ?? 0,
      Items: lines.map((l: any) => ({
        ItemNumber:  l.PoItemNumber ?? l.ItemNumber ?? "",
        Description: l.Description ?? l.Title ?? "",
        QtyOrder:    l.QtyOrder ?? 0,
        QtyReceived: l.QtyReceived ?? 0,
        QtyRemaining: l.QtyRemaining ?? (l.QtyOrder ?? 0) - (l.QtyReceived ?? 0),
        UnitPrice:   l.UnitPrice ?? l.EffectiveUnitPrice ?? 0,
      })),
    } as XoroPO;
  });
}

export function fmtDate(d?: string): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}/${dt.getFullYear()}`;
}

export function fmtCurrency(n?: number, code = "USD"): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);
}
