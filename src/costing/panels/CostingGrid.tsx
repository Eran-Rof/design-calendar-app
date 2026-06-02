// CostingGrid — BOYS-style row-per-style table for a Costing Project.
//
// Each row is one CostingLine. ~30 columns mirror the BOYS CSV order:
//   style#, style name, desc, size scale, fabric, fit, color, bottom closure,
//   waist, comment, qty (target_qty), vendor (selected vendor name),
//   target cost, sell target, sell, margin (live via useCostingMath + cell bg
//   tier color), priced date, LY cost, LY sold, LY margin, remarks.
//
// Live margin is recomputed via the techpack/calc.ts adapter — that file has
// 21 unit tests pinning the rounding + tier thresholds; we don't fork.

import React, { useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { computeLineMath } from "../hooks/useCostingMath";
import { usePlanFlow } from "../hooks/usePlanFlow";
import StylePickerCell from "./StylePickerCell";
import MasterPickerCell from "./MasterPickerCell";
import ColorPickerCell from "./ColorPickerCell";
import VendorGridCell from "./VendorGridCell";
import ComplianceChipCell from "./ComplianceChipCell";
import ScalePickerCell from "./ScalePickerCell";
import FabricPickerCell from "./FabricPickerCell";
import HistoricalCostCell from "./HistoricalCostCell";
import ColumnsButton from "./ColumnsButton";
import { usePersistedHiddenColumns } from "../../inventory-planning/panels/wholesale-planning/hooks/usePersistedHiddenColumns";
import { fetchStyleSeedSku, generateRfqs } from "../services/costingApi";
import { resolveCost } from "../../shared/costResolution";
import { appConfirm } from "../../utils/theme";
import { confirmDialog } from "../../shared/ui/warn";
import type { CostingLine } from "../types";
import type { StyleHit } from "../services/costingApi";

const fmtMoney = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty   = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtPct   = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function n(v: number | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === "number" ? v : Number(v);
  return isFinite(x) ? x : 0;
}

// Per-row action button — same height + padding for $ Qts and × so the
// end-of-row doesn't look ragged. minWidth so the × button isn't a tiny
// square wedged against $ Qts.
function ACTION_BTN_STYLE(bg: string, fg: string, border: string): React.CSSProperties {
  return {
    background: bg, color: fg,
    border: `1px solid ${border}`, borderRadius: 3,
    padding: "3px 8px", fontSize: 10, fontWeight: 600,
    cursor: "pointer", lineHeight: 1.4,
    minWidth: 30, height: 22,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
}

interface ColumnDef {
  key: string;
  label: string;
  width: number;
  align?: "left" | "right" | "center";
  numeric?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { key: "_drag",          label: "",         width: 24,  align: "center" },
  { key: "_select",        label: "",         width: 28,  align: "center" },
  { key: "style_code",     label: "Style#",   width: 130 },
  { key: "description",    label: "Description", width: 220 },
  { key: "size_scale_label", label: "Scale",  width: 80 },
  { key: "fabric_code",    label: "Fabric",   width: 110 },
  { key: "fit",            label: "Fit",      width: 90 },
  { key: "color",          label: "Color",    width: 100 },
  { key: "bottom_closure", label: "Closure",  width: 100 },
  { key: "waist_type",     label: "Waist",    width: 90 },
  { key: "comment",        label: "Comment",  width: 160 },
  { key: "target_qty",     label: "Qty",      width: 80,  align: "right", numeric: true },
  { key: "_vendor",        label: "Vendor",   width: 130 },
  { key: "avg_cost",       label: "Avg Cost", width: 130, align: "right" },
  { key: "_history",       label: "PO History", width: 100, align: "center" },
  { key: "target_cost",    label: "Tgt Cost", width: 80,  align: "right", numeric: true },
  { key: "fob_cost",       label: "FOB",      width: 80,  align: "right", numeric: true },
  { key: "duty_rate",      label: "Duty %",   width: 70,  align: "right", numeric: true },
  { key: "freight",        label: "Freight",  width: 80,  align: "right", numeric: true },
  { key: "insurance",      label: "Insur",    width: 70,  align: "right", numeric: true },
  { key: "other_costs",    label: "Other",    width: 70,  align: "right", numeric: true },
  { key: "_landed",        label: "Landed",   width: 80,  align: "right" },
  { key: "sell_target",    label: "Sell Tgt", width: 80,  align: "right", numeric: true },
  { key: "sell_price",     label: "Sell",     width: 80,  align: "right", numeric: true },
  { key: "_margin",        label: "Margin %", width: 80,  align: "right" },
  // LY comp — qty col dropped, replaced by sales-price (LY Sls Prc).
  // Mgn now computed display-side from (sls_prc - cost) / sls_prc.
  { key: "ly_unit_cost",   label: "LY Cost",     width: 80,  align: "right" },
  { key: "ly_unit_price",  label: "LY Sls Prc",  width: 90,  align: "right" },
  { key: "ly_margin_pct",  label: "LY Mgn %",    width: 80,  align: "right" },
  // T3 comp (trailing 3 months) — same three columns.
  { key: "t3_unit_cost",   label: "T3 Cost",     width: 80,  align: "right" },
  { key: "t3_unit_price",  label: "T3 Sls Prc",  width: 90,  align: "right" },
  { key: "t3_margin_pct",  label: "T3 Mgn %",    width: 80,  align: "right" },
  { key: "_compliance",    label: "Compliance", width: 180 },
  { key: "_actions",       label: "",         width: 90, align: "center" },
];

const TOTAL_WIDTH = COLUMNS.reduce((s, c) => s + c.width, 0);

export default function CostingGrid() {
  const lines = useCostingStore((s) => s.lines);
  const vendorQuotes = useCostingStore((s) => s.vendorQuotes);
  const project = useCostingStore((s) => s.project);
  const selectedLineId = useCostingStore((s) => s.selectedLineId);
  const stageFilter = useCostingStore((s) => s.stageFilter);
  const addLine = useCostingStore((s) => s.addLine);
  const updateLine = useCostingStore((s) => s.updateLine);
  const deleteLine = useCostingStore((s) => s.deleteLine);
  const reorderLines = useCostingStore((s) => s.reorderLines);
  const setSelectedLine = useCostingStore((s) => s.setSelectedLine);
  const setNotice = useCostingStore((s) => s.setNotice);
  const loadMasters = useCostingStore((s) => s.loadMasters);
  const loadVendorsForPicker = useCostingStore((s) => s.loadVendorsForPicker);
  const compPeriod = useCostingStore((s) => s.compPeriod);
  const setCompPeriod = useCostingStore((s) => s.setCompPeriod);
  const refreshComp = useCostingStore((s) => s.refreshComp);

  // Persisted column show/hide (localStorage). Toggleable via the
  // <ColumnsButton/> in the grid toolbar. visibleColumns derives from
  // COLUMNS minus the hidden set; visibleWidth keeps header/body/footer
  // minWidth in lockstep so nothing drifts when columns toggle.
  const { hiddenColumns, toggleColumn, resetColumns, setHiddenColumns } = usePersistedHiddenColumns("costing_grid_hidden_columns");
  const visibleColumns = COLUMNS.filter((c) => !hiddenColumns.has(c.key));
  const visibleWidth = visibleColumns.reduce((s, c) => s + c.width, 0);
  const toggleableColumns = COLUMNS.filter((c) => c.label && c.label.trim().length > 0).map((c) => ({ key: c.key, label: c.label }));

  // Row-selection checkboxes drive the "Generate Vendor RFQs" button.
  // Local Set so toggling is O(1) and we don't pollute the global store.
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const toggleRow = (id: string) => {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = (checked: boolean) => {
    setSelectedRowIds(checked ? new Set(lines.map((l) => l.id)) : new Set());
  };

  const onGenerateRfqs = async () => {
    if (!project || selectedRowIds.size === 0) return;
    const projectId = project.id;
    const lineIds = Array.from(selectedRowIds);
    setGenerating(true);
    try {
      let res = await generateRfqs(projectId, lineIds);

      // Duplicate-RFQ guard: handler returns needs_confirm (409) when an RFQ
      // already exists for the same style + color + vendor. Prompt, then
      // re-submit with allowDuplicate on OK.
      if ("needs_confirm" in res) {
        const ok = await confirmDialog(
          "An RFQ already exists for this style / color / vendor — do you want to create another?",
          {
            title: "Duplicate RFQ",
            confirmText: "Create anyway",
            cancelText: "Cancel",
            listItems: res.duplicates.map((d) =>
              [d.vendor, d.style_code, d.color].filter(Boolean).join(" · "),
            ),
          },
        );
        if (!ok) {
          setNotice("RFQ generation cancelled.", "info");
          return;
        }
        res = await generateRfqs(projectId, lineIds, true);
        if ("needs_confirm" in res) {
          // Shouldn't happen (allowDuplicate bypasses the guard), but guard anyway.
          setNotice("Could not generate RFQs: duplicate check did not clear.", "error");
          return;
        }
      }

      const parts = [];
      if (res.created.length > 0) {
        const vendorSummary = res.created.map((c) => `${c.vendor} (${c.line_count})`).join(", ");
        parts.push(`${res.created.length} RFQ${res.created.length === 1 ? "" : "s"} created: ${vendorSummary}`);
      }
      if (res.skipped_no_vendor && res.skipped_no_vendor.length > 0) {
        parts.push(`${res.skipped_no_vendor.length} line${res.skipped_no_vendor.length === 1 ? "" : "s"} skipped (no vendor picked)`);
      }
      if (res.errors && res.errors.length > 0) {
        parts.push(`${res.errors.length} error${res.errors.length === 1 ? "" : "s"} — see console`);
        // eslint-disable-next-line no-console
        console.error("[costing] generate-rfqs errors:", res.errors);
      }
      const message = parts.length > 0 ? parts.join(" · ") : (res.message || "No RFQs created.");
      setNotice(message, res.created.length > 0 ? "info" : "error");
      if (res.created.length > 0) setSelectedRowIds(new Set());
    } catch (e) {
      setNotice(`Could not generate RFQs: ${(e as Error).message}`, "error");
    } finally {
      setGenerating(false);
    }
  };

  // Load fit/closure/waist/comment masters on mount so the cell dropdowns
  // have their options populated. Settings view also calls this, but mounting
  // here makes the grid self-sufficient.
  React.useEffect(() => { loadMasters(); loadVendorsForPicker(); }, [loadMasters, loadVendorsForPicker]);

  // Auto-refresh LY + T3 comp whenever a line's (style_code, color,
  // selected_vendor_quote_id) tuple changes OR the operator changes the
  // comp period. Debounced 600ms so a sequence of cell edits (style
  // pick → color → vendor) coalesces into one refresh per row.
  // Snapshot tuples per line so we only fire when something actually
  // shifted (avoids re-fetching on every unrelated render).
  const compSigsRef = React.useRef<Map<string, string>>(new Map());
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const sigs = compSigsRef.current;
      const changed: string[] = [];
      for (const ln of lines) {
        if (!ln.style_code) continue;
        const sig = `${ln.style_code}|${ln.color || ""}|${ln.selected_vendor_quote_id || ""}|${compPeriod ? compPeriod.from + ":" + compPeriod.to : ""}`;
        if (sigs.get(ln.id) !== sig) {
          sigs.set(ln.id, sig);
          changed.push(ln.id);
        }
      }
      if (changed.length > 0) {
        void refreshComp(changed).catch(() => { /* error surfaced in store */ });
      }
    }, 600);
    return () => window.clearTimeout(t);
    // We watch the line shape + selected vendor + period — refresh fires
    // when any line's relevant fields change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.map((l) => `${l.id}:${l.style_code}:${l.color}:${l.selected_vendor_quote_id}`).join("~"), compPeriod?.from, compPeriod?.to]);

  // Chunk 6 — Plan Flow widget writes stageFilter to the store; we filter the
  // visible rows by per-line derived stage. lineStageById comes from the same
  // hook the widget uses, so counts and visible rows always match.
  const { lineStageById } = usePlanFlow();
  const visibleLines = stageFilter
    ? lines.filter((l) => lineStageById[l.id] === stageFilter)
    : lines;

  const [dragId, setDragId] = useState<string | null>(null);

  const onAdd = async () => {
    await addLine({});
  };

  // Style pick — prefill + seed target_cost.
  const onStylePick = async (line: CostingLine, style: StyleHit) => {
    const patch: Partial<CostingLine> = {
      style_master_id: style.id,
      style_code: style.style_code,
      style_name: style.style_name,
      description: style.description,
      category_id: style.category_id,
      fabric_code: style.base_fabric, // fuzzy; user can change
    };
    // Seed target_cost via the resolveCost cascade. We pull one SKU under
    // the style + its avg cost from ip_item_avg_cost and feed them in as
    // the direct-hit map. The cascade returns null cleanly if neither is
    // available, in which case target_cost stays untouched.
    if (style.style_code) {
      const seed = await fetchStyleSeedSku(style.style_code);
      if (seed && seed.sku_code) {
        const avgMap = new Map<string, number>();
        if (typeof seed.avg_cost === "number" && seed.avg_cost > 0) {
          avgMap.set(seed.sku_code, seed.avg_cost);
        }
        const resolved = resolveCost(seed.sku_code, { avgCostMap: avgMap });
        if (resolved.cost != null && resolved.cost > 0) {
          // Only seed avg_cost — Tgt Cost stays empty so the operator
          // decides what to enter. The Avg Cost cell has a "→ Tgt" copy
          // button that pushes the value into target_cost when wanted.
          patch.avg_cost = resolved.cost;
        }
      }
    }
    await updateLine(line.id, patch);
  };

  const onDragStart = (id: string) => (e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (targetId: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) return setDragId(null);
    const order = lines.map((l) => l.id);
    const fromIdx = order.indexOf(dragId);
    const toIdx = order.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return setDragId(null);
    order.splice(toIdx, 0, ...order.splice(fromIdx, 1));
    setDragId(null);
    await reorderLines(order);
  };

  // Footer totals — weighted margin = (sales − cost) / sales × 100.
  let totalQty = 0;
  let totalCost = 0;
  let totalSales = 0;
  for (const line of lines) {
    const qty = n(line.target_qty);
    const m = computeLineMath(line);
    const landed = m.landed_cost > 0 ? m.landed_cost : n(line.target_cost);
    totalQty += qty;
    totalCost += qty * landed;
    totalSales += qty * n(line.sell_price);
  }
  const weightedMargin = totalSales > 0 ? ((totalSales - totalCost) / totalSales) * 100 : 0;

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#E2E8F0", letterSpacing: ".04em", textTransform: "uppercase" }}>
          Costing grid · {stageFilter ? `${visibleLines.length} of ${lines.length}` : lines.length} {lines.length === 1 ? "line" : "lines"}
          {stageFilter && <span style={{ color: "#F59E0B", marginLeft: 8, fontSize: 11 }}>(filtered: {stageFilter})</span>}
        </h3>
        <button
          onClick={onAdd}
          style={{
            background: "#10B981", color: "#fff", border: "none",
            padding: "5px 14px", borderRadius: 4, cursor: "pointer",
            fontSize: 12, fontWeight: 600,
          }}
        >+ Add row</button>
        <button
          onClick={onGenerateRfqs}
          disabled={generating || selectedRowIds.size === 0}
          title={
            selectedRowIds.size === 0
              ? "Check rows in the grid first"
              : `Generate one RFQ per vendor across ${selectedRowIds.size} selected line${selectedRowIds.size === 1 ? "" : "s"}`
          }
          style={{
            background: selectedRowIds.size > 0 ? "#3B82F6" : "transparent",
            color: selectedRowIds.size > 0 ? "#fff" : "#64748B",
            border: `1px solid ${selectedRowIds.size > 0 ? "#3B82F6" : "#334155"}`,
            padding: "5px 14px", borderRadius: 4,
            cursor: generating || selectedRowIds.size === 0 ? "not-allowed" : "pointer",
            fontSize: 12, fontWeight: 600,
            opacity: generating ? 0.6 : 1,
          }}
        >
          {generating ? "Generating…" : `Vendor RFQ${selectedRowIds.size > 0 ? ` (${selectedRowIds.size})` : ""}`}
        </button>
        {/* Comp period from/to — drives /comp/ly + /comp/t3 windows.
            Empty = endpoint defaults (LY: trailing 365d shifted -12mo;
            T3: trailing 3 months). Each end stamped together — both
            need values for the override to apply. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 12 }}>
          <span style={{ fontSize: 10, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>Comp period</span>
          <input
            type="date"
            value={compPeriod?.from || ""}
            onChange={(e) => {
              const from = e.target.value || "";
              const to = compPeriod?.to || "";
              setCompPeriod(from && to ? { from, to } : null);
            }}
            title="Comp period FROM — LY shifts back 12 months from this window"
            style={{
              background: "#0F172A", color: "#E2E8F0",
              border: "1px solid #334155", borderRadius: 4,
              padding: "4px 6px", fontSize: 11, outline: "none",
              colorScheme: "dark",
            }}
          />
          <span style={{ color: "#64748B", fontSize: 11 }}>→</span>
          <input
            type="date"
            value={compPeriod?.to || ""}
            onChange={(e) => {
              const to = e.target.value || "";
              const from = compPeriod?.from || "";
              setCompPeriod(from && to ? { from, to } : null);
            }}
            title="Comp period TO"
            style={{
              background: "#0F172A", color: "#E2E8F0",
              border: "1px solid #334155", borderRadius: 4,
              padding: "4px 6px", fontSize: 11, outline: "none",
              colorScheme: "dark",
            }}
          />
          {compPeriod && (
            <button
              type="button"
              onClick={() => setCompPeriod(null)}
              title="Reset to endpoint defaults"
              style={{
                background: "transparent", color: "#F87171",
                border: "1px solid #7F1D1D", borderRadius: 3,
                padding: "2px 6px", fontSize: 10, cursor: "pointer",
              }}
            >reset</button>
          )}
        </div>
        <div style={{ marginLeft: "auto" }}>
          <ColumnsButton
            columns={toggleableColumns}
            hidden={hiddenColumns}
            onToggle={toggleColumn}
            onReset={resetColumns}
            onSetAll={(visible) => setHiddenColumns(visible ? [] : toggleableColumns.map((c) => c.key))}
          />
        </div>
      </div>

      <div style={{
        border: "1px solid #334155", borderRadius: 6,
        background: "#1E293B", overflowX: "auto",
      }}>
        {/* Header — cells use flex:0 0 width + box-sizing:border-box so the
            border doesn't push width outward, matching body + footer exactly. */}
        <div style={{ display: "flex", minWidth: visibleWidth, background: "#0F172A", position: "sticky", top: 0, zIndex: 5 }}>
          {visibleColumns.map((c) => {
            // Select-all checkbox in the _select column header.
            if (c.key === "_select") {
              const allChecked = lines.length > 0 && selectedRowIds.size === lines.length;
              const someChecked = selectedRowIds.size > 0 && !allChecked;
              return (
                <div key={c.key} style={{
                  flex: `0 0 ${c.width}px`, boxSizing: "border-box", overflow: "hidden",
                  padding: "8px 4px", textAlign: "center",
                  borderRight: "1px solid #475569",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={(el) => { if (el) el.indeterminate = someChecked; }}
                    onChange={(e) => toggleAll(e.target.checked)}
                    title="Select all rows for the Vendor RFQ button"
                  />
                </div>
              );
            }
            return (
              <div key={c.key} style={{
                flex: `0 0 ${c.width}px`, boxSizing: "border-box", overflow: "hidden",
                padding: "8px 10px", fontSize: 10, fontWeight: 700,
                color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em",
                textAlign: c.align || "left",
                borderRight: "1px solid #475569",
              }}>{c.label}</div>
            );
          })}
        </div>

        {/* Body */}
        {lines.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", color: "#64748B", fontSize: 12 }}>
            No lines yet — click "Add row" to start. Pick a style to auto-fill metadata + seed target cost.
          </div>
        )}
        {lines.length > 0 && visibleLines.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "#94A3B8", fontSize: 12 }}>
            No lines match the current stage filter. Clear the Plan Flow filter to see all {lines.length}.
          </div>
        )}
        {visibleLines.map((line) => {
          const math = computeLineMath(line);
          const isFocused = selectedLineId === line.id;
          return (
            <div
              key={line.id}
              // Row click only highlights — does NOT open the vendor panel.
              // The "$ Qts" button in actions column is the explicit panel trigger.
              onClick={() => setSelectedLine(line.id)}
              onDragOver={onDragOver}
              onDrop={onDrop(line.id)}
              // Hover background — visible against the row's #0F172A page bg.
              // #1E293B was too close to the page bg; #334155 has clear contrast.
              onMouseEnter={(e) => { if (!isFocused) e.currentTarget.style.background = "#334155"; }}
              onMouseLeave={(e) => { if (!isFocused) e.currentTarget.style.background = "transparent"; }}
              style={{
                display: "flex", minWidth: visibleWidth,
                borderTop: "1px solid #334155",
                background: isFocused ? "#172554" : "transparent",
                cursor: "default",
                transition: "background 0.12s",
              }}
            >
              {visibleColumns.map((c) => {
                const style: React.CSSProperties = {
                  flex: `0 0 ${c.width}px`, boxSizing: "border-box", overflow: "hidden",
                  padding: "0 4px",
                  fontSize: 12, color: "#E2E8F0",
                  textAlign: c.align || "left",
                  borderRight: "1px solid #475569",
                  borderBottom: "1px solid #475569",
                  display: "flex", alignItems: "center",
                  minHeight: 32,
                };

                // Drag handle
                if (c.key === "_drag") {
                  return (
                    <div
                      key={c.key} style={style}
                      draggable
                      onDragStart={onDragStart(line.id)}
                      onClick={(e) => e.stopPropagation()}
                      title="Drag to reorder"
                    >
                      <span style={{ color: "#64748B", fontSize: 14, cursor: "grab", width: "100%", textAlign: "center" }}>⋮⋮</span>
                    </div>
                  );
                }

                // Row-select checkbox — drives the "Vendor RFQ" toolbar button.
                if (c.key === "_select") {
                  return (
                    <div key={c.key} style={{ ...style, justifyContent: "center" }} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedRowIds.has(line.id)}
                        onChange={() => toggleRow(line.id)}
                        title="Include this row in the Vendor RFQ batch"
                      />
                    </div>
                  );
                }

                // Style picker
                if (c.key === "style_code") {
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <StylePickerCell
                        value={line.style_code}
                        onPick={(s) => onStylePick(line, s)}
                        onChange={(v) => updateLine(line.id, { style_code: v })}
                        cellStyle={{ padding: "4px 6px" }}
                      />
                    </div>
                  );
                }

                // Vendor — inline dropdown of existing quote-vendors for this
                // line; picking one calls selectQuote (marks as winner).
                if (c.key === "_vendor") {
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <VendorGridCell lineId={line.id} />
                    </div>
                  );
                }

                // Compliance — inline chips for current requirements + add dropdown.
                if (c.key === "_compliance") {
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <ComplianceChipCell lineId={line.id} />
                    </div>
                  );
                }

                // Avg cost — read-only seed from ip_item_avg_cost on style
                // pick. (The "→ Tgt" copy button was removed per operator
                // ask — the column is purely informational now.)
                if (c.key === "avg_cost") {
                  const v = line.avg_cost;
                  return (
                    <div key={c.key} style={{ ...style, color: "#94A3B8" }}>
                      <span style={{ width: "100%", padding: "0 6px", fontStyle: v == null ? "italic" : "normal" }}>
                        {v == null ? "—" : fmtMoney.format(v)}
                      </span>
                    </div>
                  );
                }

                // LY + T3 read-only display cells. Auto-compute margin
                // pct from (sls_prc - cost) / sls_prc when the server-
                // stamped margin is null but both legs are present, so
                // newly stamped rows show a value before the next refresh.
                if (c.key === "ly_unit_cost" || c.key === "t3_unit_cost") {
                  const v = c.key === "ly_unit_cost" ? line.ly_unit_cost : line.t3_unit_cost;
                  return (
                    <div key={c.key} style={{ ...style, color: "#94A3B8" }}>
                      <span style={{ width: "100%", padding: "0 6px" }}>
                        {v == null ? "—" : fmtMoney.format(v)}
                      </span>
                    </div>
                  );
                }
                if (c.key === "ly_unit_price" || c.key === "t3_unit_price") {
                  const v = c.key === "ly_unit_price" ? line.ly_unit_price : line.t3_unit_price;
                  return (
                    <div key={c.key} style={{ ...style, color: "#A7F3D0" }}>
                      <span style={{ width: "100%", padding: "0 6px" }}>
                        {v == null ? "—" : fmtMoney.format(v)}
                      </span>
                    </div>
                  );
                }
                if (c.key === "ly_margin_pct" || c.key === "t3_margin_pct") {
                  const isLy = c.key === "ly_margin_pct";
                  const stored = isLy ? line.ly_margin_pct : line.t3_margin_pct;
                  const cost = isLy ? line.ly_unit_cost : line.t3_unit_cost;
                  const price = isLy ? line.ly_unit_price : line.t3_unit_price;
                  // Server stamps weighted_margin_pct as a fraction (0.20 = 20%
                  // — matches ip_sales_history_wholesale.margin_pct semantics);
                  // the auto-compute fallback below produces a percentage. Scale
                  // the stored value by 100 so both branches feed the same unit
                  // into fmtPct.
                  let pct = stored != null ? stored * 100 : null;
                  if (pct == null && cost != null && price != null && price > 0) {
                    pct = ((price - cost) / price) * 100;
                  }
                  return (
                    <div key={c.key} style={{ ...style, color: "#94A3B8" }}>
                      <span style={{ width: "100%", padding: "0 6px" }}>
                        {pct == null ? "—" : `${fmtPct.format(pct)}%`}
                      </span>
                    </div>
                  );
                }

                // PO History — popover trigger; opens HistoricalCostCell
                // which pulls tanda_pos rows matching the line's style +
                // selected vendor (incl. archived). Read-only reference.
                if (c.key === "_history") {
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <HistoricalCostCell lineId={line.id} />
                    </div>
                  );
                }

                // Landed cost — computed
                if (c.key === "_landed") {
                  return (
                    <div key={c.key} style={{ ...style, color: "#A7F3D0", fontWeight: 600 }}>
                      <span style={{ width: "100%", padding: "0 6px" }}>
                        {math.landed_cost > 0 ? fmtMoney.format(math.landed_cost) : "—"}
                      </span>
                    </div>
                  );
                }

                // Margin — computed + tier color background
                if (c.key === "_margin") {
                  return (
                    <div key={c.key} style={{
                      ...style,
                      background: math.margin_pct ? math.tierColor + "33" : undefined,
                      color: math.tierColor,
                      fontWeight: 700,
                    }}>
                      <span style={{ width: "100%", padding: "0 6px" }}>
                        {math.margin_pct ? fmtPct.format(math.margin_pct) + "%" : "—"}
                      </span>
                    </div>
                  );
                }

                // Row actions — only delete now (vendor quotes side panel
                // removed in favour of the toolbar Vendor RFQ flow). Kept the
                // shared button style helper so width/height stays aligned
                // with any future additions.
                if (c.key === "_actions") {
                  return (
                    <div key={c.key} style={{ ...style, gap: 4, justifyContent: "center" }} onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => appConfirm(
                          `Delete this line${line.style_code ? ` (${line.style_code})` : ""}? This also removes its vendor + compliance data.`,
                          "Delete",
                          () => deleteLine(line.id),
                        )}
                        title="Delete row"
                        style={ACTION_BTN_STYLE("transparent", "#F87171", "#7F1D1D")}
                      >× Delete</button>
                    </div>
                  );
                }

                // Numeric input
                if (c.numeric) {
                  const key = c.key as keyof CostingLine;
                  const v = line[key];
                  const display = typeof v === "number"
                    ? (c.key === "target_qty" || c.key === "ly_qty" ? fmtQty.format(v) : fmtMoney.format(v))
                    : (v ?? "");
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <input
                        defaultValue={display === "" ? "" : String(display)}
                        type="text"
                        onBlur={(e) => {
                          const raw = e.target.value.replace(/[^0-9.\-]/g, "");
                          const num = raw === "" ? null : Number(raw);
                          updateLine(line.id, { [key]: isFinite(num as number) ? num : null } as Partial<CostingLine>);
                        }}
                        style={{
                          width: "100%", padding: "4px 6px", fontSize: 12,
                          textAlign: "right", background: "transparent",
                          border: "1px solid transparent", color: "#E2E8F0", outline: "none",
                        }}
                      />
                    </div>
                  );
                }

                // Master-list dropdowns (Fit / Closure / Waist / Comment).
                if (c.key === "fit" || c.key === "bottom_closure" || c.key === "waist_type" || c.key === "comment") {
                  const kind = c.key === "fit" ? "fit" : c.key === "bottom_closure" ? "closure" : c.key === "waist_type" ? "waist" : "comment";
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <MasterPickerCell
                        kind={kind as "fit" | "closure" | "waist" | "comment"}
                        value={(line[c.key as keyof CostingLine] as string | null) ?? null}
                        onChange={(v) => updateLine(line.id, { [c.key]: v } as Partial<CostingLine>)}
                      />
                    </div>
                  );
                }

                // Size scale — native select from scale_master.
                if (c.key === "size_scale_label") {
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <ScalePickerCell
                        value={line.size_scale_label}
                        onChange={(v) => updateLine(line.id, { size_scale_label: v })}
                      />
                    </div>
                  );
                }

                // Fabric — autocomplete from fabric_codes.
                if (c.key === "fabric_code") {
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <FabricPickerCell
                        value={line.fabric_code}
                        onChange={(v) => updateLine(line.id, { fabric_code: v })}
                      />
                    </div>
                  );
                }

                // Color — autocomplete from ip_item_master + extras.
                // Scoped to the line's style_code so the operator only sees
                // colors that style actually comes in (plus their global
                // freeform extras).
                if (c.key === "color") {
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <ColorPickerCell
                        value={line.color}
                        styleCode={line.style_code}
                        onChange={(v) => updateLine(line.id, { color: v })}
                      />
                    </div>
                  );
                }

                // Default: text input bound to the field name.
                const key = c.key as keyof CostingLine;
                const v = line[key];
                return (
                  <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                    <input
                      defaultValue={(v as string | null) ?? ""}
                      type="text"
                      onBlur={(e) => updateLine(line.id, { [key]: e.target.value || null } as Partial<CostingLine>)}
                      style={{
                        width: "100%", padding: "4px 6px", fontSize: 12,
                        background: "transparent", border: "1px solid transparent",
                        color: "#E2E8F0", outline: "none",
                      }}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Footer */}
        {lines.length > 0 && (
          <div style={{
            display: "flex", minWidth: visibleWidth,
            borderTop: "2px solid #475569",
            background: "#0F172A", fontWeight: 700, color: "#E2E8F0",
            fontSize: 12, position: "sticky", bottom: 0, zIndex: 4,
          }}>
            {visibleColumns.map((c) => {
              const style: React.CSSProperties = {
                flex: `0 0 ${c.width}px`, boxSizing: "border-box", overflow: "hidden",
                // Matches header pad so footer totals line up under header labels.
                padding: "8px 10px",
                textAlign: c.align || "left",
                borderRight: "1px solid #475569",
                display: "flex", alignItems: "center",
                minHeight: 36,
              };
              if (c.key === "style_code") {
                return <div key={c.key} style={style}>TOTAL</div>;
              }
              if (c.key === "target_qty") {
                return (
                  <div key={c.key} style={{ ...style, justifyContent: "flex-end" }}>
                    {fmtQty.format(totalQty)}
                  </div>
                );
              }
              if (c.key === "_landed") {
                return (
                  <div key={c.key} style={{ ...style, color: "#A7F3D0", justifyContent: "flex-end" }} title="Total cost = sum of qty × landed">
                    {fmtMoney.format(totalCost)}
                  </div>
                );
              }
              if (c.key === "sell_price") {
                return (
                  <div key={c.key} style={{ ...style, color: "#A7F3D0", justifyContent: "flex-end" }} title="Total sales = sum of qty × sell">
                    {fmtMoney.format(totalSales)}
                  </div>
                );
              }
              if (c.key === "_margin") {
                const color = weightedMargin >= 50 ? "#10B981" : weightedMargin >= 30 ? "#F59E0B" : "#EF4444";
                return (
                  <div key={c.key} style={{
                    ...style, color, background: color + "33", justifyContent: "flex-end",
                  }} title="Weighted overall margin">
                    {fmtPct.format(weightedMargin)}%
                  </div>
                );
              }
              return <div key={c.key} style={style} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
