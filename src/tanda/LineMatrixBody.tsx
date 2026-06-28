// src/tanda/LineMatrixBody.tsx
//
// Shared line-matrix body — the order/invoice modal's LINE BODY *is* the size
// matrix. Used by Sales Orders (mode="so"), Purchase Orders (mode="po"), and
// AR Invoices (mode="ar"); the `mode` prop drives the money-column label
// (Unit $ vs Unit Cost $), whether the projected-margin total renders, and
// whether on-hand/ATS hints show. "so" is the original Sales-Order behavior.
//
// ~95% of styles are matrix-driven, so the body is a stack of per-style
// color × size grids (the same EditableSizeMatrix the inventory matrix uses):
// pick a style → type ordered quantities straight into its grid, with an
// editable unit-money per color. A separate "+ Add non-matrix line" button adds
// a plain SKU/qty/$ row for the rare non-matrix item.
//
// Nothing is "added to the order" as a side step — the grids ARE the order.
// At save time the parent calls the imperative `resolve()` which turns every
// filled cell into an ip_item_master SKU (find-or-create via
// /api/internal/style-matrix/resolve-sku) plus the flat lines, and returns the
// SO line payload. This replaces the old two-step "Add by matrix → flat list".

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import { EditableSizeMatrix, matrixCellKey } from "../shared/matrix";
import type { EditableMatrixRow } from "../shared/matrix";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { distributeByPack, hasUsablePack, isPartialCarton, ceilToCarton, CARTON, packForInseam, type SizePack, type NestedSizePack } from "../shared/sizeScale";
import { explodePacks, packTotal, type PrepackBlock } from "../shared/prepack";
import { confirmDialog } from "../shared/ui/warn";
import type { OrderDocData, OrderDocStyle, OrderDocMatrixRow, OrderDocFlat } from "./orderDocument";

const C = {
  card: "#1E293B", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8",
  textSub: "#CBD5E1", primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  base: "#60A5FA",
};
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" };
const numInput: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 8px", borderRadius: 4, fontSize: 13, width: "100%", textAlign: "right", boxSizing: "border-box" };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };

type Style = { id: string; style_code: string; style_name?: string | null; description?: string | null; brand_id?: string | null; attributes?: { size_scale_pack?: SizePack | NestedSizePack } | null };
type MatrixSku = { id: string; color: string | null; size: string | null; inseam: string | null; on_hand_qty?: number; avg_cost_cents?: number | null };
type MatrixPayload = { style: { id: string; style_code: string }; sizes: string[]; colors: string[]; inseams: string[]; skus: MatrixSku[]; prepack?: PrepackBlock | null };
type FlatItem = { id: string; sku_code: string; style_code?: string | null; description?: string | null };

// Read-only per-size explode preview for a PREPACK section: rows = colors with a
// pack count, columns = the matrix composition sizes, each cell = packs ×
// qty_per_pack. The order line stores PACKS; this is the size breakdown the rest
// of the suite (inventory explode, sales reporting) derives from those packs.
function PrepackExplodePreview({ rows, packsByRow, composition }: {
  rows: EditableMatrixRow[];
  packsByRow: Record<string, number>;
  composition: { size: string; qty_per_pack: number }[];
}) {
  const sizes = composition.map((c) => c.size);
  const active = rows.filter((r) => (packsByRow[r.key] || 0) > 0);
  const per = packTotal(composition);
  const PC = { headerBg: "#0F172A", head: "#6B7280", bdr: "#1E293B", sect: "#334155", amber: "#F59E0B", text: "#E5E7EB", muted: "#94A3B8", empty: "#475569" };
  if (active.length === 0) {
    return <div style={{ fontSize: 12, color: PC.muted, padding: "6px 2px" }}>Enter pack quantities above to see the per-size breakdown.</div>;
  }
  const colTotals: Record<string, number> = {};
  let grand = 0;
  for (const r of active) {
    const ex = explodePacks(packsByRow[r.key] || 0, composition);
    for (const sz of sizes) colTotals[sz] = (colTotals[sz] || 0) + (ex[sz] || 0);
    grand += (packsByRow[r.key] || 0) * per;
  }
  const cell: React.CSSProperties = { padding: "5px 10px", textAlign: "center", fontFamily: "monospace", fontSize: 12 };
  const th2: React.CSSProperties = { padding: "6px 10px", color: PC.head, fontSize: 10, textTransform: "uppercase", letterSpacing: 1, borderBottom: `2px solid ${PC.sect}`, textAlign: "center" };
  return (
    <div style={{ overflowX: "auto", background: PC.headerBg, borderRadius: 8, border: `1px solid ${PC.sect}`, marginTop: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th2, textAlign: "left" }}>Color</th>
            <th style={{ ...th2 }}>Packs</th>
            {sizes.map((sz) => <th key={sz} style={th2}>{sz}</th>)}
            <th style={th2}>Units</th>
          </tr>
        </thead>
        <tbody>
          {active.map((r) => {
            const packs = packsByRow[r.key] || 0;
            const ex = explodePacks(packs, composition);
            return (
              <tr key={r.key} style={{ borderBottom: `1px solid ${PC.bdr}` }}>
                <td style={{ ...cell, textAlign: "left", color: "#D1D5DB", fontFamily: "inherit" }}>{r.color || "—"}</td>
                <td style={{ ...cell, color: PC.text }}>{packs.toLocaleString()}</td>
                {sizes.map((sz) => <td key={sz} style={{ ...cell, color: ex[sz] ? PC.text : PC.empty }}>{ex[sz] ? ex[sz].toLocaleString() : "—"}</td>)}
                <td style={{ ...cell, color: PC.amber, fontWeight: 700 }}>{(packs * per).toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${PC.sect}` }}>
            <td style={{ ...cell, textAlign: "left", color: PC.muted, fontWeight: 700, fontFamily: "inherit" }}>Total</td>
            <td style={{ ...cell, color: PC.muted }} />
            {sizes.map((sz) => <td key={sz} style={{ ...cell, color: colTotals[sz] ? PC.amber : PC.empty, fontWeight: 700 }}>{colTotals[sz] ? colTotals[sz].toLocaleString() : "—"}</td>)}
            <td style={{ ...cell, color: PC.amber, fontWeight: 800 }}>{grand.toLocaleString()}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export type FlatLine = { key: number; inventory_item_id: string; qty_ordered: string; unit_price_dollars: string; label?: string; description?: string; line_total_dollars?: string; revenue_account_id?: string };
export type ResolvedLine = { inventory_item_id: string | null; qty_ordered: number; unit_price_cents: number; description?: string | null; line_total_cents?: number; revenue_account_id?: string | null; requested_ship_date?: string | null; vendor_confirmed_ship_date?: string | null; lot_number?: string | null };
export type SeedSection = { styleCode: string; cells: { color: string | null; size: string; inseam?: string | null; qty: number; unit?: string; lot?: string | null }[]; requestedShipDate?: string | null; vendorConfirmedShipDate?: string | null; defaultUnit?: string; quickFill?: Record<string, number> };
export interface LineMatrixBodyHandle {
  resolve: () => Promise<ResolvedLine[]>;
  /** Style codes currently in the matrix (resolved sections). */
  getStyleCodes: () => string[];
  /** Set the per-row unit (e.g. an awarded cost) for the given styles IN PLACE —
   *  does NOT touch quantities. Map key = style_code, value = unit string. */
  applyUnitByStyle: (byStyle: Record<string, string>) => void;
  /** Current filled lines for a printable document view, as a per-style color ×
   *  size MATRIX — read-only, NO SKU resolution / side effects (unlike resolve()). */
  getDocumentData: () => OrderDocData;
}

type Section = { id: number; styleId: string; payload: MatrixPayload | null; qty: Record<string, number>; unit: Record<string, string>; lot: Record<string, string>; loading: boolean; err: string | null; dates?: { requested?: string; confirmed?: string }; datesOpen?: boolean; quickFill?: Record<string, string>; explodeOpen?: boolean };

const rowKeyOf = (color: string | null, inseam: string | null) => `${color ?? ""}|${inseam ?? ""}`;
const skuCellKey = (color: string | null, size: string | null, inseam: string | null) => `${color ?? ""}|${size ?? ""}|${inseam ?? ""}`;

export interface LineMatrixBodyProps {
  /** Which modal owns this body. Drives the money-column label, whether the
   *  projected-margin total renders, and whether the on-hand/ATS hints show.
   *  "so" (default) reproduces today's Sales-Order behavior exactly. */
  mode?: "so" | "po" | "ar";
  editable: boolean;
  items: FlatItem[];                         // 500-item list for the non-matrix picker
  /** AR only — postable revenue/offset accounts for the per-flat-line revenue
   *  picker. SKU/matrix lines route revenue server-side; flat lines default to
   *  server-side (blank) but the operator may override here. */
  revenueAccounts?: { value: string; label: string }[];
  seed?: { sections: SeedSection[]; flat: FlatLine[] } | null;
  /** Show the faint on-hand number above each size cell. Off for Production
   *  fulfillment (the order is being made, not shipped from stock). Default true. */
  showOnHand?: boolean;
  /** ATS fulfillment: the number above each cell is real available-to-ship BY
   *  SIZE (on-hand + inbound − open reservations, from tangerine_size_onhand via
   *  /api/internal/ats-by-size) rather than raw on-hand. Overrides showOnHand. */
  atsMode?: boolean;
  /** ATS fulfillment ship-date window (the SO's requested ship date). When set,
   *  available-to-ship ADDS native PO inbound expected to arrive by this date. */
  atsAsOfDate?: string | null;
  onTotalsChange?: (t: BodyTotals) => void;
  /** Show the Add-style / Add-line buttons even when not directly editable
   *  (e.g. a confirmed SO). Defaults to `editable`. Clicking an add button
   *  calls onRequestEdit() first so the newly-added row is editable. */
  canAdd?: boolean;
  onRequestEdit?: () => void;
  /** PO: show a per-style "Requested in DC" + "Vendor-confirmed" date pair in
   *  each section header; the dates ride along on every resolved line of that
   *  style. Opt-in so SO / AR are unchanged. */
  showLineDates?: boolean;
  /** PO: default date (YYYY-MM-DD) used to PRE-FILL a newly-added style's
   *  "Requested in DC" (and, copied from it, "Vendor-confirmed") — sourced from
   *  the header "Requested in DC". Only applied to sections added via the button,
   *  never to seeded/existing lines. */
  lineDateDefault?: string | null;
  /** SO: report the brand of the primary (first) selected style so the header's
   *  Brand field can auto-populate from the style. null when no style with a
   *  brand is selected. Fires only when the resolved brand changes. */
  onPrimaryBrandChange?: (brandId: string | null) => void;
  /** Fires when the operator adds a style (matrix) or a non-matrix line. Lets the
   *  owning modal react — e.g. collapse the document header to make room for
   *  line entry. */
  onAddLine?: () => void;
  /** PO: fires when the operator CHANGES a style's "Vendor-confirmed ship" date
   *  (not the initial prefill). Lets the owning modal record an audit trail —
   *  e.g. append the change (with today's date) to the order notes. */
  onVendorConfirmedChange?: (styleCode: string, prev: string, next: string) => void;
}

export type BodyTotals = { qty: number; cents: number; costCents: number; marginPct: number; marginEstimated: boolean };
const MARGIN_FALLBACK = 0.21; // assumed gross margin when a style has no cost history

const LineMatrixBody = forwardRef<LineMatrixBodyHandle, LineMatrixBodyProps>(function LineMatrixBody(
  { mode = "so", editable, items, seed, showOnHand = true, atsMode = false, atsAsOfDate = null, onTotalsChange, canAdd, onRequestEdit, revenueAccounts, showLineDates = false, lineDateDefault = null, onPrimaryBrandChange, onAddLine, onVendorConfirmedChange }, ref,
) {
  // Per-mode presentation. PO buys (cost column, no margin, no availability);
  // SO / AR sell (price column, margin). Availability hints are SO-only.
  const moneyLabel = mode === "po" ? "Unit Cost $" : "Unit $";
  const showMargin = mode !== "po";
  const showAvail = mode === "so";
  const [styles, setStyles] = useState<Style[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [flat, setFlat] = useState<FlatLine[]>([]);
  // PO: per style+color lot column. Auto-stamped to the PO number at issue
  // server-side; shown here so the operator can view/override per line. Hidden on
  // SO/AR (lots populated by later scenarios). Default visible in PO mode.
  const [showLots, setShowLots] = useState(mode === "po");
  const [atsByItem, setAtsByItem] = useState<Record<string, number>>({});
  const [atsAsOf, setAtsAsOf] = useState<string | null>(null);
  const [atsLoading, setAtsLoading] = useState(false);
  // Pending "ordered more than ATS" warning for one cell (SO-from-ATS only).
  const [pendingAts, setPendingAts] = useState<
    | { sectionId: number; rowKey: string; size: string; color: string | null; entered: number; available: number; prevValue: number }
    | null
  >(null);
  const nextSectionId = useRef(1);
  const nextFlatKey = useRef(1);
  const seeded = useRef(false);
  const lastBrandRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/internal/style-master?limit=10000").then((r) => (r.ok ? r.json() : [])).then((a) => setStyles(Array.isArray(a) ? a : [])).catch(() => {});
  }, []);

  // Surface the primary style's brand (the first section whose style carries a
  // brand) so the SO header's Brand field auto-populates from the selected
  // style. Guarded by a ref so the callback fires only when the brand changes.
  useEffect(() => {
    if (!onPrimaryBrandChange) return;
    let brand: string | null = null;
    for (const s of sections) {
      if (!s.styleId) continue;
      const st = styles.find((x) => x.id === s.styleId);
      if (st?.brand_id) { brand = st.brand_id; break; }
    }
    if (brand !== lastBrandRef.current) { lastBrandRef.current = brand; onPrimaryBrandChange(brand); }
  }, [sections, styles, onPrimaryBrandChange]);

  // Fetch the size-matrix payload for a section's style.
  async function loadPayload(styleId: string): Promise<MatrixPayload | null> {
    const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return (await r.json()) as MatrixPayload;
  }
  function patchSection(id: number, patch: Partial<Section>) { setSections((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s))); }

  async function pickStyle(id: number, styleId: string) {
    patchSection(id, { styleId, payload: null, loading: !!styleId, err: null });
    if (!styleId) return;
    try { const p = await loadPayload(styleId); patchSection(id, { payload: p, loading: false }); }
    catch (e) { patchSection(id, { loading: false, err: e instanceof Error ? e.message : String(e) }); }
  }

  // New style/line pickers prepend (on TOP of existing styles, not the bottom),
  // and request edit mode so a just-added row is editable on a confirmed order.
  function addSection() {
    onRequestEdit?.(); onAddLine?.();
    // Pre-fill the new style's line dates from the header "Requested in DC" (PO).
    // Vendor-confirmed is copied from the same date. Adding a style also COLLAPSES
    // the date pickers on every previously-entered style (click to re-open).
    const seedDates = (showLineDates && lineDateDefault) ? { requested: lineDateDefault, confirmed: lineDateDefault } : undefined;
    setSections((p) => [
      { id: nextSectionId.current++, styleId: "", payload: null, qty: {}, unit: {}, lot: {}, loading: false, err: null, dates: seedDates, datesOpen: true },
      ...p.map((s) => ({ ...s, datesOpen: false })),
    ]);
  }
  function removeSection(id: number) { setSections((p) => p.filter((s) => s.id !== id)); }
  function setSectionDatesOpen(id: number, open: boolean) { setSections((p) => p.map((s) => (s.id === id ? { ...s, datesOpen: open } : s))); }
  function setExplodeOpen(id: number, open: boolean) { setSections((p) => p.map((s) => (s.id === id ? { ...s, explodeOpen: open } : s))); }
  function setQty(id: number, rowKey: string, size: string, n: number) {
    setSections((p) => p.map((s) => {
      if (s.id !== id) return s;
      const key = matrixCellKey(rowKey, size); const q = { ...s.qty };
      if (n > 0) q[key] = n; else delete q[key];
      return { ...s, qty: q };
    }));
  }
  // ATS available-to-ship for one matrix cell (null = unknown → don't warn):
  // resolve the cell's SKU, then read its loaded ATS availability.
  function atsAvailForCell(section: Section, rowKey: string, size: string): number | null {
    if (!section.payload) return null;
    const [color, inseam] = rowKey.split("|");
    const sku = section.payload.skus.find(
      (k) => skuCellKey(k.color, k.size, k.inseam || null) === skuCellKey(color || null, size, inseam || null),
    );
    if (!sku || !(sku.id in atsByItem)) return null; // no SKU yet / availability not loaded
    return atsByItem[sku.id] || 0;
  }
  // On committing a qty in an ATS-fulfilled SO, warn if it exceeds what's
  // available to ship (the operator can continue, clamp to ATS, or revert).
  function checkAtsCommit(section: Section, rowKey: string, size: string, value: number, prevValue: number) {
    if (!atsMode || !(value > 0)) return;
    const available = atsAvailForCell(section, rowKey, size);
    if (available == null || value <= available) return;
    const [color] = rowKey.split("|");
    setPendingAts({ sectionId: section.id, rowKey, size, color: color || null, entered: value, available, prevValue });
  }

  // Quick-fill: replace one color row's per-size quantities in a single update.
  // `perSize` carries a qty for every size (0 ⇒ clear that cell).
  function setRowQtys(id: number, rowKey: string, perSize: Record<string, number>) {
    setSections((p) => p.map((s) => {
      if (s.id !== id) return s;
      const q = { ...s.qty };
      for (const [size, n] of Object.entries(perSize)) {
        const key = matrixCellKey(rowKey, size);
        if (n > 0) q[key] = n; else delete q[key];
      }
      return { ...s, qty: q };
    }));
  }
  function setUnit(id: number, rowKey: string, v: string) { setSections((p) => p.map((s) => (s.id === id ? { ...s, unit: { ...s.unit, [rowKey]: v } } : s))); }
  function setLot(id: number, rowKey: string, v: string) { setSections((p) => p.map((s) => (s.id === id ? { ...s, lot: { ...s.lot, [rowKey]: v } } : s))); }
  function setAllLot(id: number, rows: EditableMatrixRow[], v: string) { setSections((p) => p.map((s) => (s.id === id ? { ...s, lot: Object.fromEntries(rows.map((r) => [r.key, v])) } : s))); }
  function setSectionDate(id: number, which: "requested" | "confirmed", v: string) {
    // Report a user EDIT of the Vendor-confirmed date (the initial prefill goes
    // through addSection, not here, so this only fires on a real change).
    if (which === "confirmed" && onVendorConfirmedChange) {
      const sec = sections.find((x) => x.id === id);
      const prev = sec?.dates?.confirmed || "";
      if (sec && v !== prev) {
        const code = sec.payload?.style?.style_code || styles.find((st) => st.id === sec.styleId)?.style_code || "";
        if (code) onVendorConfirmedChange(code, prev, v);
      }
    }
    setSections((p) => p.map((s) => (s.id === id ? { ...s, dates: { ...(s.dates || {}), [which]: v } } : s)));
  }
  // Carton conform — round every partial-carton cell in a section UP to the next
  // full carton of 24 (after the operator confirms via the clickable warning).
  async function conformCartons(id: number) {
    if (!(await confirmDialog(`Auto-change this style's quantities to full cartons of ${CARTON} (round each size up)?`))) return;
    setSections((p) => p.map((s) => {
      if (s.id !== id) return s;
      const q = { ...s.qty };
      for (const [k, v] of Object.entries(q)) if (isPartialCarton(v)) q[k] = ceilToCarton(v);
      return { ...s, qty: q };
    }));
  }
  function setAllUnit(id: number, rows: EditableMatrixRow[], v: string) { setSections((p) => p.map((s) => (s.id === id ? { ...s, unit: Object.fromEntries(rows.map((r) => [r.key, v])) } : s))); }

  function addFlat() { onRequestEdit?.(); onAddLine?.(); setFlat((p) => [{ key: nextFlatKey.current++, inventory_item_id: "", qty_ordered: "", unit_price_dollars: "" }, ...p]); }
  function updateFlat(idx: number, patch: Partial<FlatLine>) { setFlat((p) => p.map((l, i) => (i === idx ? { ...l, ...patch } : l))); }
  function removeFlat(idx: number) { setFlat((p) => p.filter((_, i) => i !== idx)); }

  // Seed (edit mode) once styles are available so styleCode → styleId resolves.
  useEffect(() => {
    if (seeded.current || !seed || styles.length === 0) return;
    seeded.current = true;
    if (seed.flat.length) { setFlat(seed.flat); nextFlatKey.current = Math.max(0, ...seed.flat.map((f) => f.key)) + 1; }
    for (const sec of seed.sections) {
      const st = styles.find((s) => s.style_code === sec.styleCode);
      const id = nextSectionId.current++;
      const qty: Record<string, number> = {}; const unit: Record<string, string> = {}; const lot: Record<string, string> = {};
      for (const c of sec.cells) {
        const rk = rowKeyOf(c.color, c.inseam ?? null);
        if (c.qty > 0) qty[matrixCellKey(rk, c.size)] = c.qty;
        if (c.unit) unit[rk] = c.unit;
        if (c.lot) lot[rk] = c.lot;
      }
      const dates = (sec.requestedShipDate || sec.vendorConfirmedShipDate) ? { requested: sec.requestedShipDate || undefined, confirmed: sec.vendorConfirmedShipDate || undefined } : undefined;
      const defaultUnit = sec.defaultUnit;
      // Per-color imported total → keyed by rowKey, shown in the Qty quick-fill box.
      const quickFill: Record<string, string> | undefined = sec.quickFill
        ? Object.fromEntries(Object.entries(sec.quickFill).map(([color, total]) => [rowKeyOf(color || null, null), String(total)]))
        : undefined;
      setSections((p) => [...p, { id, styleId: st?.id || "", payload: null, qty, unit, lot, loading: !!st, err: st ? null : `Style ${sec.styleCode} not found`, dates, quickFill }]);
      if (st) loadPayload(st.id).then((pl) => {
        // Apply a per-section default unit (e.g. an awarded RFQ cost) to every
        // color row that doesn't already carry a unit from a seeded cell.
        if (defaultUnit && pl) {
          const u: Record<string, string> = {};
          for (const r of rowsFor(pl)) u[r.key] = unit[r.key] || defaultUnit;
          patchSection(id, { payload: pl, loading: false, unit: u });
        } else patchSection(id, { payload: pl, loading: false });
      }).catch((e) => patchSection(id, { loading: false, err: e instanceof Error ? e.message : String(e) }));
    }
  }, [seed, styles]);

  // Build EditableSizeMatrix rows for a section payload.
  function rowsFor(payload: MatrixPayload | null): EditableMatrixRow[] {
    if (!payload) return [];
    // Key every row by the SKU's real inseam whenever the style HAS any inseam
    // (not only when it has >1). The SKUs are always stored with their real
    // inseam, so collapsing single-inseam rows to inseam=null made the cost /
    // on-hand / ATS cell lookups miss AND broke the edit/create-from-SO seed
    // round-trip (seeded cells carry the line's real inseam). A dedicated Inseam
    // COLUMN still only shows for >1 inseam (see `showRise` below); single-inseam
    // styles render one row per color exactly as before, just keyed correctly.
    const hasInseams = (payload.inseams?.length ?? 0) >= 1;
    const colors = payload.colors.length ? payload.colors : [...new Set((payload.skus || []).map((s) => s.color).filter(Boolean) as string[])];
    const colorList: (string | null)[] = colors.length ? colors : [null];
    const inseamList: (string | null)[] = hasInseams ? payload.inseams : [null];
    const out: EditableMatrixRow[] = [];
    for (const color of colorList) for (const inseam of inseamList) out.push({ key: rowKeyOf(color, inseam), color: color ?? null, rise: inseam ?? null });
    return out;
  }

  // ── Totals + projected margin ───────────────────────────────────────────────
  //   margin % = (revenue − cost) / revenue. Per cell the cost is the SKU's
  //   avg_cost_cents (Xoro/Excel history). When a cell has NO cost history we
  //   fall back to the assumed 21% gross margin (cost = price × 0.79) and flag
  //   the order's margin as "estimated" only when NO line had real cost data.
  const totals = useMemo<BodyTotals>(() => {
    let qty = 0, cents = 0, costCents = 0, realCostCells = 0;
    for (const s of sections) {
      const byCell = new Map<string, MatrixSku>();
      for (const sk of s.payload?.skus || []) byCell.set(skuCellKey(sk.color, sk.size, sk.inseam || null), sk);
      for (const [cell, n] of Object.entries(s.qty)) {
        if (!(n > 0)) continue;
        const [rowKey, size] = cell.split("__");
        const [color, inseam] = rowKey.split("|");
        const unit = Math.round((Number(s.unit[rowKey]) || 0) * 100);
        qty += n; cents += Math.round(n * unit);
        const sku = byCell.get(skuCellKey(color || null, size, inseam || null));
        const ac = sku?.avg_cost_cents != null ? Number(sku.avg_cost_cents) : null;
        if (ac != null && ac > 0) { costCents += Math.round(n * ac); realCostCells += 1; }
        else costCents += Math.round(n * unit * (1 - MARGIN_FALLBACK));
      }
    }
    for (const l of flat) {
      const q = Number(l.qty_ordered) || 0;
      if (q > 0) {
        const unit = Math.round((Number(l.unit_price_dollars) || 0) * 100);
        qty += q; cents += Math.round(q * unit);
        costCents += Math.round(q * unit * (1 - MARGIN_FALLBACK)); // flat lines have no matrix cost source
      } else if (mode === "ar") {
        // AR amount-only line (freight / fees / discounts): add its amount to the total.
        const totalStr = (l.line_total_dollars || "").replace(/,/g, "").trim();
        if (totalStr !== "") { const t = Math.round((Number(totalStr) || 0) * 100); cents += t; costCents += Math.round(t * (1 - MARGIN_FALLBACK)); }
      }
    }
    const marginPct = cents > 0 ? ((cents - costCents) / cents) * 100 : 0;
    return { qty, cents, costCents, marginPct, marginEstimated: realCostCells === 0 };
  }, [sections, flat]);
  useEffect(() => { onTotalsChange?.(totals); }, [totals, onTotalsChange]);

  // ── ATS-by-size availability ────────────────────────────────────────────────
  //   When the SO is set to ATS fulfillment, fetch real available-to-ship by
  //   size for every SKU currently in the loaded grids and show it above each
  //   cell (instead of raw on-hand). Re-runs when the set of SKUs changes.
  const allSkuIdsSig = useMemo(() => {
    const ids = new Set<string>();
    for (const s of sections) for (const sk of s.payload?.skus || []) if (sk.id) ids.add(sk.id);
    return [...ids].sort().join(",");
  }, [sections]);
  useEffect(() => {
    if (!atsMode) { setAtsByItem({}); setAtsAsOf(null); return; }
    const ids = allSkuIdsSig ? allSkuIdsSig.split(",") : [];
    if (ids.length === 0) { setAtsByItem({}); setAtsAsOf(null); return; }
    let cancelled = false;
    setAtsLoading(true);
    const reqBody: { item_ids: string[]; as_of_date?: string } = { item_ids: ids };
    if (atsAsOfDate) reqBody.as_of_date = atsAsOfDate; // window inbound supply to the ship date
    fetch("/api/internal/ats-by-size", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (cancelled) return;
        const map: Record<string, number> = {};
        for (const [id, v] of Object.entries(j.availability || {})) map[id] = Math.max(0, Number((v as { available?: number })?.available) || 0);
        setAtsByItem(map); setAtsAsOf(j.as_of || null);
      })
      .catch(() => { if (!cancelled) { setAtsByItem({}); setAtsAsOf(null); } })
      .finally(() => { if (!cancelled) setAtsLoading(false); });
    return () => { cancelled = true; };
  }, [atsMode, allSkuIdsSig, atsAsOfDate]);

  // ── Imperative resolve (called at save) ────────────────────────────────────
  useImperativeHandle(ref, () => ({
    async resolve(): Promise<ResolvedLine[]> {
      const lines: ResolvedLine[] = [];
      for (const s of sections) {
        if (!s.payload) continue;
        const byCell = new Map<string, MatrixSku>();
        for (const sk of s.payload.skus) byCell.set(skuCellKey(sk.color, sk.size, sk.inseam || null), sk);
        for (const [cell, n] of Object.entries(s.qty)) {
          if (!(n > 0)) continue;
          const [rowKey, size] = cell.split("__");
          const [color, inseam] = rowKey.split("|");
          const unitDollars = (s.unit[rowKey] || "").trim();
          const existing = byCell.get(skuCellKey(color || null, size, inseam || null));
          let itemId = existing?.id || null;
          if (!itemId) {
            const r = await fetch("/api/internal/style-matrix/resolve-sku", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ style_id: s.payload.style.id, style_code: s.payload.style.style_code, color: color || null, size, inseam: inseam || null }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.id) throw new Error(j.error || `Could not resolve SKU for ${color || ""} ${size} ${inseam || ""}`.trim());
            itemId = j.id as string;
          }
          const lotVal = (s.lot[rowKey] || "").trim();
          lines.push({
            inventory_item_id: itemId, qty_ordered: n, unit_price_cents: Math.round((Number(unitDollars) || 0) * 100),
            ...(showLineDates ? { requested_ship_date: s.dates?.requested || null, vendor_confirmed_ship_date: s.dates?.confirmed || null } : {}),
            ...(mode === "po" ? { lot_number: lotVal || null } : {}),
          });
        }
      }
      for (const l of flat) {
        const q = Number(l.qty_ordered) || 0;
        const unitCents = Math.round((Number(l.unit_price_dollars) || 0) * 100);
        if (mode === "ar") {
          // AR flat line: a SKU line (item + qty + unit) OR an amount-only line
          // (description + amount, no SKU — freight / fees / discounts).
          const totalStr = (l.line_total_dollars || "").replace(/,/g, "").trim();
          const totalCents = totalStr !== "" ? Math.round((Number(totalStr) || 0) * 100) : null;
          const hasSku = !!l.inventory_item_id && q > 0;
          if (!hasSku && totalCents == null) continue;
          lines.push({
            inventory_item_id: l.inventory_item_id || null,
            qty_ordered: hasSku ? q : 0,
            unit_price_cents: hasSku ? unitCents : 0,
            description: l.description?.trim() || null,
            line_total_cents: !hasSku && totalCents != null ? totalCents : undefined,
            revenue_account_id: l.revenue_account_id || null,
          });
          continue;
        }
        if (q > 0 && l.inventory_item_id) lines.push({ inventory_item_id: l.inventory_item_id, qty_ordered: q, unit_price_cents: unitCents });
      }
      return lines;
    },
    getStyleCodes(): string[] {
      const codes = new Set<string>();
      for (const s of sections) {
        const code = s.payload?.style?.style_code || styles.find((st) => st.id === s.styleId)?.style_code;
        if (code) codes.add(code);
      }
      return [...codes];
    },
    applyUnitByStyle(byStyle: Record<string, string>): void {
      setSections((p) => p.map((s) => {
        const code = s.payload?.style?.style_code || styles.find((st) => st.id === s.styleId)?.style_code;
        if (!code || !(code in byStyle)) return s;
        const unit = { ...s.unit };
        for (const r of rowsFor(s.payload)) unit[r.key] = byStyle[code]; // set price on every row; qty untouched
        return { ...s, unit };
      }));
    },
    getDocumentData(): OrderDocData {
      const styleGroups: OrderDocStyle[] = [];
      for (const s of sections) {
        const st = styles.find((x) => x.id === s.styleId);
        const code = s.payload?.style?.style_code || st?.style_code || "";
        const desc = st?.style_name || st?.description || null;
        // Pivot filled cells into per-(color×inseam) rows with a qty per size.
        const rowMap = new Map<string, OrderDocMatrixRow>();
        const sizesSeen = new Set<string>();
        for (const [cell, n] of Object.entries(s.qty)) {
          if (!(n > 0)) continue;
          const [rowKey, size] = cell.split("__");
          const [color, inseam] = rowKey.split("|");
          sizesSeen.add(size);
          let row = rowMap.get(rowKey);
          if (!row) { row = { color: color || null, inseam: inseam || null, unitDollars: Number((s.unit[rowKey] || "").replace(/,/g, "")) || 0, qtyBySize: {} }; rowMap.set(rowKey, row); }
          row.qtyBySize[size] = (row.qtyBySize[size] || 0) + n;
        }
        if (rowMap.size === 0) continue;
        // Size columns in scale order (from the loaded payload), limited to sizes
        // actually ordered; fall back to appearance order if no payload yet. For a
        // prepack the single column is the pack token (cells are PACK counts).
        const sizes = s.payload?.prepack
          ? [s.payload.prepack.pack_token]
          : (s.payload?.sizes?.length ? s.payload.sizes.filter((sz) => sizesSeen.has(sz)) : [...sizesSeen]);
        styleGroups.push({ style: code, description: desc, sizes, rows: [...rowMap.values()] });
      }
      const flats: OrderDocFlat[] = [];
      for (const l of flat) {
        const q = Number(l.qty_ordered) || 0;
        const totalStr = (l.line_total_dollars || "").replace(/,/g, "").trim();
        if (!(q > 0) && totalStr === "") continue;
        const unit = q > 0 ? Number((l.unit_price_dollars || "").replace(/,/g, "")) || 0 : (Number(totalStr) || 0);
        flats.push({ label: l.label || "(line)", description: l.description || null, qty: q > 0 ? q : 1, unitDollars: unit });
      }
      return { styles: styleGroups, flats };
    },
  }), [sections, flat, styles]);

  // Flat-picker options: merge any seeded label whose SKU isn't in the 500-item list.
  const flatOptions = useMemo(() => {
    const base = items.map((it) => ({ value: it.id, label: `${it.sku_code}${it.description ? ` — ${it.description}` : ""}`, searchHaystack: `${it.sku_code} ${it.style_code || ""} ${it.description || ""}` }));
    const have = new Set(items.map((i) => i.id));
    const extra = flat.filter((l) => l.inventory_item_id && l.label && !have.has(l.inventory_item_id)).map((l) => ({ value: l.inventory_item_id, label: l.label as string, searchHaystack: l.label as string }));
    return [{ value: "", label: "(select)" }, ...extra, ...base];
  }, [items, flat]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginBottom: 8 }}>
        {mode === "po" && (
          <button onClick={() => setShowLots((v) => !v)} style={btnSecondary}
            title={showLots ? "Hide the per-line Lot column" : "Show the per-line Lot column (auto-set to the PO number at issue)"}>
            {showLots ? "Hide lots" : "Show lots"}
          </button>
        )}
        {(canAdd ?? editable) && (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={addSection} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }}>Add style (matrix)</button>
            <button onClick={addFlat} style={btnSecondary}>+ Add non-matrix line</button>
          </div>
        )}
      </div>

      {/* Prominent order totals at the top of the lines section (≈4× the size of
          the small footer totals, which is kept below). Replaces the old "▲
          available-to-ship by size" caption per operator request. */}
      {(sections.length > 0 || flat.length > 0) && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "baseline", gap: 40, padding: "6px 4px 12px", borderBottom: `1px solid ${C.cardBdr}`, marginBottom: 12 }}>
          <span style={{ color: C.textMuted, fontSize: 18 }}>Total qty <b style={{ color: C.text, fontSize: 18, fontVariantNumeric: "tabular-nums", marginLeft: 8 }}>{totals.qty.toLocaleString()}</b></span>
          <span style={{ color: C.textMuted, fontSize: 18 }}>Total <b style={{ color: C.success, fontSize: 18, fontVariantNumeric: "tabular-nums", marginLeft: 8 }}>${(totals.cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></span>
          {showMargin && (
          <span style={{ color: C.textMuted, fontSize: 18, display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
            <span>Proj. margin <b style={{ color: totals.marginPct >= 20 ? C.success : C.warn, fontSize: 18, fontVariantNumeric: "tabular-nums", marginLeft: 8 }}>{totals.cents > 0 ? `${totals.marginPct.toFixed(1)}%` : "—"}</b></span>
            {totals.cents > 0 && totals.marginEstimated && <span style={{ fontSize: 11, color: C.textMuted }}>estimated — no cost data (assumes 21%)</span>}
          </span>
          )}
        </div>
      )}

      {sections.length === 0 && flat.length === 0 && (
        <div style={{ color: C.textMuted, fontSize: 13, padding: "16px 12px", border: `1px dashed ${C.cardBdr}`, borderRadius: 8, marginBottom: 12 }}>
          {editable ? "Click Add style (matrix) and type ordered quantities into the color × size grid. Most styles are matrix-driven; use + Add non-matrix line for the rare one-off SKU." : "No lines."}
        </div>
      )}

      {/* Non-matrix flat lines — rendered ABOVE the matrix sections so a newly-
          added line lands on top of existing data, like a new style. In AR mode
          these double as amount-only charge lines (freight / fees / discounts),
          with an optional per-line revenue account. */}
      {flat.length > 0 && (
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            {mode === "ar" ? (
              <>
                <colgroup><col style={{ width: 28 }} /><col /><col style={{ width: 150 }} /><col style={{ width: 60 }} /><col style={{ width: 84 }} /><col style={{ width: 90 }} /><col /><col style={{ width: 30 }} /></colgroup>
                <thead><tr><th style={th}>#</th><th style={th}>Description</th><th style={th}>SKU (optional)</th><th style={th}>Qty</th><th style={th}>Unit $</th><th style={th}>Amount $</th><th style={th}>Revenue acct</th><th style={th}></th></tr></thead>
                <tbody>
                  {flat.map((l, idx) => {
                    const hasSku = !!l.inventory_item_id && Number(l.qty_ordered) > 0;
                    return (
                      <tr key={l.key}>
                        <td style={td}>{idx + 1}</td>
                        <td style={td}><input type="text" value={l.description ?? ""} onChange={(e) => updateFlat(idx, { description: e.target.value })} disabled={!editable} placeholder="(freight / fee / item)" style={{ ...numInput, textAlign: "left" }} /></td>
                        <td style={td}><SearchableSelect value={l.inventory_item_id || null} onChange={(v) => updateFlat(idx, { inventory_item_id: v || "" })} options={flatOptions} placeholder="(none)" disabled={!editable} /></td>
                        <td style={td}><input type="text" inputMode="decimal" value={l.qty_ordered} onChange={(e) => updateFlat(idx, { qty_ordered: e.target.value })} disabled={!editable} placeholder="0" style={numInput} /></td>
                        <td style={td}><input type="text" inputMode="decimal" value={l.unit_price_dollars} onChange={(e) => updateFlat(idx, { unit_price_dollars: e.target.value })} onBlur={() => { const n = Number((l.unit_price_dollars || "").replace(/,/g, "")); if (l.unit_price_dollars.trim() !== "" && Number.isFinite(n)) updateFlat(idx, { unit_price_dollars: n.toFixed(2) }); }} disabled={!editable} placeholder="0.00" style={numInput} /></td>
                        <td style={td}><input type="text" inputMode="decimal" value={l.line_total_dollars ?? ""} onChange={(e) => updateFlat(idx, { line_total_dollars: e.target.value })} onBlur={() => { const s = (l.line_total_dollars || "").replace(/,/g, ""); const n = Number(s); if (s.trim() !== "" && Number.isFinite(n)) updateFlat(idx, { line_total_dollars: n.toFixed(2) }); }} disabled={!editable || hasSku} placeholder="amount" title="Amount-only line (no SKU): freight, fees, discounts" style={numInput} /></td>
                        <td style={td}><SearchableSelect value={l.revenue_account_id || null} onChange={(v) => updateFlat(idx, { revenue_account_id: v || "" })} options={[{ value: "", label: "(server default)" }, ...(revenueAccounts || [])]} placeholder="(server default)" disabled={!editable} /></td>
                        <td style={td}>{editable && <button type="button" onClick={() => removeFlat(idx)} style={btnDanger}>✕</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </>
            ) : (
              <>
                <colgroup><col style={{ width: 36 }} /><col /><col style={{ width: 100 }} /><col style={{ width: 120 }} /><col style={{ width: 36 }} /></colgroup>
                <thead><tr><th style={th}>#</th><th style={th}>Non-matrix SKU</th><th style={th}>Qty</th><th style={th}>{moneyLabel}</th><th style={th}></th></tr></thead>
                <tbody>
                  {flat.map((l, idx) => (
                    <tr key={l.key}>
                      <td style={td}>{idx + 1}</td>
                      <td style={td}><SearchableSelect value={l.inventory_item_id || null} onChange={(v) => updateFlat(idx, { inventory_item_id: v })} options={flatOptions} placeholder="(pick SKU…)" disabled={!editable} /></td>
                      <td style={td}><input type="text" inputMode="decimal" value={l.qty_ordered} onChange={(e) => updateFlat(idx, { qty_ordered: e.target.value })} disabled={!editable} placeholder="0" style={numInput} /></td>
                      <td style={td}><input type="text" inputMode="decimal" value={l.unit_price_dollars} onChange={(e) => updateFlat(idx, { unit_price_dollars: e.target.value })} onBlur={() => { const n = Number((l.unit_price_dollars || "").replace(/,/g, "")); if (l.unit_price_dollars.trim() !== "" && Number.isFinite(n)) updateFlat(idx, { unit_price_dollars: n.toFixed(2) }); }} disabled={!editable} placeholder="0.00" style={numInput} /></td>
                      <td style={td}>{editable && <button type="button" onClick={() => removeFlat(idx)} style={btnDanger}>✕</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        </div>
      )}

      {/* Per-style matrix sections. */}
      {sections.map((s) => {
        // PREPACK (pack-grain) style: order is entered as a number of PACKS per
        // color (single pack-token column), not per-size eaches. The backend
        // returns a `prepack` block (pack token + composition) for any PPK style.
        const pp = s.payload?.prepack || null;
        // Sizes that drive cell keys / locked-row filtering: the single pack token
        // for a prepack, else the garment size scale.
        const entrySizes = pp ? [pp.pack_token] : (s.payload?.sizes || []);
        const allRows = rowsFor(s.payload);
        // When locked (a confirmed order viewed read-only) show ONLY the color
        // rows that carry a quantity — the order, not the whole scale. Editable
        // (draft or "Add styles" mode) shows every color so any can be filled.
        const rows = editable ? allRows : allRows.filter((r) => entrySizes.some((sz) => (s.qty[matrixCellKey(r.key, sz)] || 0) > 0));
        const onHand: Record<string, number> = {};
        if (!pp && showAvail && (showOnHand || atsMode) && s.payload) for (const r of rows) { const [color, inseam] = r.key.split("|"); for (const sz of s.payload.sizes) { const sk = s.payload.skus.find((k) => skuCellKey(k.color, k.size, k.inseam || null) === skuCellKey(color || null, sz, inseam || null)); if (!sk) continue; const v = atsMode ? (atsByItem[sk.id] ?? 0) : sk.on_hand_qty; if (v != null) onHand[matrixCellKey(r.key, sz)] = Math.max(0, Number(v) || 0); } }
        // Per-style pack ratio (from Style Master → Scale) powers the quick-fill
        // Qty column. Only offered when editable and the style has a usable pack
        // for these sizes.
        const sizesList = s.payload?.sizes || [];
        // The pack ratio may be flat or per-inseam (Style Master → Scale).
        // Resolve it for the row's inseam (rowKey = `color|inseam`) so each inseam
        // row distributes by its own pack; a flat pack applies to every inseam.
        const rawPack = styles.find((st) => st.id === s.styleId)?.attributes?.size_scale_pack;
        const packForRow = (rk: string): SizePack => packForInseam(rawPack, rk.split("|")[1] || null);
        const packUsableFor = (rk: string) => editable && hasUsablePack(sizesList, packForRow(rk));
        // Per-color pack counts for the prepack explode preview (cell = pack token).
        const packsByRow: Record<string, number> = {};
        if (pp) for (const r of rows) packsByRow[r.key] = s.qty[matrixCellKey(r.key, pp.pack_token)] || 0;
        // Carton check (Phase C): a carton is packed per color×size SKU, so flag
        // each cell whose qty is a positive non-multiple of the carton size. Skipped
        // for prepacks — those cells are PACK counts, not eaches (no carton rule).
        const partialCells: { label: string; qty: number }[] = [];
        if (!pp) for (const r of rows) for (const sz of sizesList) {
          const q = s.qty[matrixCellKey(r.key, sz)] || 0;
          if (isPartialCarton(q)) partialCells.push({ label: `${r.color || "—"} ${sz}`, qty: q });
        }
        return (
          <div key={s.id} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, marginBottom: 12, background: C.card, padding: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", marginBottom: 10 }}>
              <SearchableSelect value={s.styleId || null} onChange={(v) => void pickStyle(s.id, v)} disabled={!editable}
                options={styles.map((st) => ({ value: st.id, label: `${st.style_code}${st.style_name ? ` — ${st.style_name}` : st.description ? ` — ${st.description}` : ""}`, searchHaystack: `${st.style_code} ${st.style_name || ""} ${st.description || ""}` }))}
                placeholder="(pick a style…)" />
              {editable && <button onClick={() => removeSection(s.id)} style={btnDanger} title="Remove this style">✕</button>}
            </div>
            {showLineDates && (s.datesOpen === false ? (
              // Collapsed (a later style was added) — show a compact summary; click to edit.
              <div role="button" tabIndex={0} onClick={() => setSectionDatesOpen(s.id, true)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSectionDatesOpen(s.id, true); }}
                title="Click to edit this style's dates"
                style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 10, fontSize: 12, color: C.textMuted, cursor: "pointer" }}>
                <span>In DC: <b style={{ color: C.textSub }}>{s.dates?.requested ? fmtDateDisplay(s.dates.requested) : "—"}</b></span>
                <span>Vendor-confirmed: <b style={{ color: C.textSub }}>{s.dates?.confirmed ? fmtDateDisplay(s.dates.confirmed) : "—"}</b></span>
                <span style={{ color: C.primary }}>✎ edit</span>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ fontSize: 11, color: C.textMuted }}>Requested in DC<br />
                  <input type="date" value={s.dates?.requested || ""} disabled={!editable} onChange={(e) => setSectionDate(s.id, "requested", e.target.value)}
                    style={{ background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "4px 8px", borderRadius: 4, fontSize: 13, colorScheme: "dark", marginTop: 2 }} />
                </label>
                <label style={{ fontSize: 11, color: C.textMuted }}>Vendor-confirmed ship<br />
                  <input type="date" value={s.dates?.confirmed || ""} disabled={!editable} onChange={(e) => setSectionDate(s.id, "confirmed", e.target.value)}
                    style={{ background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "4px 8px", borderRadius: 4, fontSize: 13, colorScheme: "dark", marginTop: 2 }} />
                </label>
                <button type="button" onClick={() => setSectionDatesOpen(s.id, false)} style={{ ...btnSecondary, fontSize: 11, padding: "4px 8px" }} title="Hide these dates">▴ hide</button>
              </div>
            ))}
            {s.loading && <div style={{ color: C.textMuted, fontSize: 13, padding: 8 }}>Loading size grid…</div>}
            {s.err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, fontSize: 13 }}>{s.err}</div>}
            {/* PREPACK (pack-grain) entry: a single PACKS column per color, plus a
                per-size breakdown ("explode") from the Prepack Matrix master. The
                order line stores PACKS; the explode is for display. */}
            {s.payload && pp && (
              <>
                <div style={{ fontSize: 12, color: C.textSub, margin: "2px 2px 8px", lineHeight: 1.5 }}>
                  Prepack — enter the number of <b>packs</b> per color (column <b>{pp.pack_token}</b>).{" "}
                  {pp.has_matrix
                    ? <>1 pack = <b>{pp.pack_total}</b> units: {pp.composition.map((c) => `${c.size}×${c.qty_per_pack}`).join(", ")}.</>
                    : <span style={{ color: C.warn }}>No size breakdown is defined for this prepack — packs will be ordered without an explode. Add one in Masters → Prepack Matrix.</span>}
                </div>
                <EditableSizeMatrix
                  rows={rows} sizes={[pp.pack_token]}
                  qty={s.qty} onQtyChange={(rk, sz, v) => setQty(s.id, rk, sz, v)}
                  unit={{ label: `${moneyLabel} / pack`, placeholder: "0.00", values: s.unit, onChange: (rk, v) => setUnit(s.id, rk, v), onSetAll: (v) => setAllUnit(s.id, rows, v), showLineTotal: true, forceDecimals: 2 }}
                  lot={mode === "po" && showLots ? {
                    values: s.lot,
                    onChange: (rk, v) => setLot(s.id, rk, v),
                    onSetAll: editable ? (v) => setAllLot(s.id, rows, v) : undefined,
                    placeholder: "PO# at issue",
                  } : undefined}
                />
                {pp.has_matrix && (
                  <div style={{ marginTop: 8 }}>
                    <button type="button" onClick={() => setExplodeOpen(s.id, s.explodeOpen === false)} style={{ ...btnSecondary, fontSize: 12, padding: "4px 10px" }}>
                      {s.explodeOpen === false ? "▸ Show size breakdown (explode)" : "▾ Hide size breakdown (explode)"}
                    </button>
                    {s.explodeOpen !== false && (
                      <PrepackExplodePreview rows={rows} packsByRow={packsByRow} composition={pp.composition} />
                    )}
                  </div>
                )}
              </>
            )}
            {/* Normal sized matrix (non-prepack styles). */}
            {s.payload && !pp && s.payload.sizes.length === 0 && <div style={{ color: C.warn, fontSize: 13, padding: 8 }}>This style has no size scale — use “+ Add non-matrix line”.</div>}
            {s.payload && !pp && s.payload.sizes.length > 0 && (
              <EditableSizeMatrix
                rows={rows} sizes={s.payload.sizes}
                showRise={(s.payload.inseams?.length ?? 0) > 1} riseLabel="Inseam"
                qty={s.qty} onQtyChange={(rk, sz, v) => setQty(s.id, rk, sz, v)} onHand={onHand}
                onHandTitle={atsMode ? `ATS${atsAsOfDate ? ` (${fmtDateDisplay(atsAsOfDate)})` : ""}` : "on-hand"}
                collapsibleSizes={mode === "so" || mode === "po"}
                onCellCommit={editable && atsMode ? (rk, sz, v, prev) => checkAtsCommit(s, rk, sz, v, prev) : undefined}
                unit={{ label: moneyLabel, placeholder: "0.00", values: s.unit, onChange: (rk, v) => setUnit(s.id, rk, v), onSetAll: (v) => setAllUnit(s.id, rows, v), showLineTotal: true, forceDecimals: 2 }}
                quickFill={editable ? {
                  onApply: (rk, total) => setRowQtys(s.id, rk, distributeByPack(total, sizesList, packForRow(rk))),
                  enabledFor: (rk) => packUsableFor(rk),
                  disabledTitle: "Set a size scale (pack) for this style in Style Master → Scale to enable quick-fill.",
                  valueFor: (rk) => s.quickFill?.[rk],
                } : undefined}
                lot={mode === "po" && showLots ? {
                  values: s.lot,
                  onChange: (rk, v) => setLot(s.id, rk, v),
                  onSetAll: editable ? (v) => setAllLot(s.id, rows, v) : undefined,
                  placeholder: "PO# at issue",
                } : undefined}
              />
            )}
            {editable && partialCells.length > 0 && (
              <div role="button" tabIndex={0} onClick={() => void conformCartons(s.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") void conformCartons(s.id); }}
                title={`Click to have Tangerine round these up to full cartons of ${CARTON}`}
                style={{ marginTop: 8, padding: "8px 12px", background: "#3b2f0b", border: `1px solid ${C.warn}`, borderRadius: 6, color: C.warn, fontSize: 12, cursor: "pointer" }}>
                Not full cartons of {CARTON}: {partialCells.map((c) => `${c.label} (${c.qty})`).join(", ")} — <u>click to auto-fix</u> (round up), or adjust by hand.
              </div>
            )}
          </div>
        );
      })}

      {/* SO-from-ATS over-availability warning. The operator can keep the qty
          (back-order beyond stock), clamp it to what's available, or revert. */}
      {pendingAts && (
        <div
          onClick={() => { setQty(pendingAts.sectionId, pendingAts.rowKey, pendingAts.size, pendingAts.prevValue); setPendingAts(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.warn}`, borderRadius: 10, padding: 22, width: "min(460px, 95vw)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.warn, marginBottom: 8 }}>Not enough available to ship</div>
            <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.5, marginBottom: 18 }}>
              There is not enough quantity available to fill the order for
              {" "}<strong>{pendingAts.color || "—"} {pendingAts.size}</strong>. You entered
              {" "}<strong>{pendingAts.entered.toLocaleString()}</strong>, but only
              {" "}<strong>{pendingAts.available.toLocaleString()}</strong> is available to ship (ATS).
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button type="button"
                onClick={() => { setQty(pendingAts.sectionId, pendingAts.rowKey, pendingAts.size, pendingAts.prevValue); setPendingAts(null); }}
                style={btnSecondary}>Cancel</button>
              <button type="button"
                onClick={() => { setQty(pendingAts.sectionId, pendingAts.rowKey, pendingAts.size, pendingAts.available); setPendingAts(null); }}
                style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }}>Change to ATS qty ({pendingAts.available.toLocaleString()})</button>
              <button type="button"
                onClick={() => setPendingAts(null)}
                style={{ ...btnSecondary, color: C.warn, borderColor: C.warn }}>Continue anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default LineMatrixBody;
