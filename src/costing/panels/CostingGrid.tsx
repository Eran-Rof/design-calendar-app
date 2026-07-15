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

import React, { useState, useEffect } from "react";
import { useCostingStore } from "../store/costingStore";
import { computeLineMath } from "../hooks/useCostingMath";
import { usePlanFlow, effectiveLineStatus } from "../hooks/usePlanFlow";
import StylePickerCell from "./StylePickerCell";
import MasterPickerCell from "./MasterPickerCell";
import LineStatusCell from "./LineStatusCell";
import ColorPickerCell from "./ColorPickerCell";
import VendorGridCell from "./VendorGridCell";
import ComplianceChipCell from "./ComplianceChipCell";
import ScalePickerCell from "./ScalePickerCell";
import FabricPickerCell from "./FabricPickerCell";
import HistoricalCostCell from "./HistoricalCostCell";
import RowAttachmentsCell from "./RowAttachmentsCell";
import ColumnsButton from "./ColumnsButton";
import CostSuggestModal from "./CostSuggestModal";
import SizeCurveModal from "./SizeCurveModal";
import DateRangePresets from "../../tanda/components/DateRangePresets";
import { usePersistedHiddenColumns } from "../../inventory-planning/panels/wholesale-planning/hooks/usePersistedHiddenColumns";
import { fetchStyleSeedSku, generateRfqs, searchStyles } from "../services/costingApi";
import { resolveCost } from "../../shared/costResolution";
import { confirmDialog, notify } from "../../shared/ui/warn";
import { marginTierColor } from "../../techpack/calc";
import { useCanSeeMargins } from "../../hooks/useCanSeeMargins";
import {
  isDdpProject, lineCostBasis, lineMarginPct, solveCostFromMargin, solveSellFromMargin,
  rowMissingFields, projectHeaderMissing, num as cnum,
} from "../lib/completeness";
import type { CostingLine } from "../types";
import type { StyleHit } from "../services/costingApi";

const fmtMoney = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Grand-total project amounts (footer cost/sales) render as whole dollars — no decimals.
const fmtMoney0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtQty   = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtPct   = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Uniform sizing for the grid's toolbar action buttons (Add row / Copy / Delete
// / Vendor RFQ) so they all stay the SAME width as each other and don't grow
// when a " (N)" selected-row-count suffix appears on selection.
const TOOLBAR_BTN: React.CSSProperties = { minWidth: 128, boxSizing: "border-box", textAlign: "center" };

function n(v: number | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === "number" ? v : Number(v);
  return isFinite(x) ? x : 0;
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
  { key: "_status",        label: "Status",   width: 110 },
  { key: "style_code",     label: "Style#",   width: 130 },
  { key: "description",    label: "Description", width: 220 },
  { key: "size_scale_label", label: "Scale",  width: 140 },
  { key: "fabric_code",    label: "Fabric",   width: 200 },
  { key: "fit",            label: "Fit",      width: 90 },
  { key: "color",          label: "Color",    width: 100 },
  { key: "bottom_closure", label: "Closures", width: 100 },
  { key: "waist_type",     label: "Waist",    width: 90 },
  { key: "comment",        label: "Comment",  width: 160 },
  { key: "target_qty",     label: "Qty",      width: 80,  align: "right", numeric: true },
  { key: "_vendor",        label: "Vendor",   width: 200 },
  { key: "avg_cost",       label: "Avg Cost", width: 130, align: "right" },
  { key: "_history",       label: "PO History", width: 100, align: "center" },
  { key: "target_cost",    label: "Tgt Cost", width: 80,  align: "right", numeric: true },
  { key: "fob_cost",       label: "FOB",      width: 80,  align: "right", numeric: true },
  { key: "duty_rate",      label: "Duty %",   width: 70,  align: "right", numeric: true },
  { key: "freight",        label: "Freight",  width: 80,  align: "right", numeric: true },
  { key: "insurance",      label: "Insur",    width: 70,  align: "right", numeric: true },
  { key: "other_costs",    label: "Other",    width: 70,  align: "right", numeric: true },
  { key: "_landed",        label: "Landed",   width: 80,  align: "right" },
  // Slim column; its header is stacked on two lines ("Sell Tgt" / "Frm Mrgn")
  // in the header render. label stays one-line plain for the column-toggle list.
  { key: "_sell_from_margin", label: "Sell Tgt Frm Mrgn", width: 78, align: "right" },
  { key: "sell_target",    label: "Sell Tgt", width: 80,  align: "right", numeric: true },
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
  { key: "_docs",          label: "Docs",     width: 56, align: "center" },
];

const TOTAL_WIDTH = COLUMNS.reduce((s, c) => s + c.width, 0);

export default function CostingGrid() {
  const lines = useCostingStore((s) => s.lines);
  const vendorQuotes = useCostingStore((s) => s.vendorQuotes);
  const project = useCostingStore((s) => s.project);
  const selectedLineId = useCostingStore((s) => s.selectedLineId);
  const stageFilter = useCostingStore((s) => s.stageFilter);
  const addLine = useCostingStore((s) => s.addLine);
  const duplicateLine = useCostingStore((s) => s.duplicateLine);
  const updateLine = useCostingStore((s) => s.updateLine);

  // Track pending revision prompts: after editing a sent/quoted line, wait 30 s
  // (to allow multiple rapid edits) then ask the operator whether to notify the
  // vendor of a revised RFQ. Key = lineId, value = setTimeout handle.
  const revisionTimers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const scheduleRevisionPrompt = React.useCallback((lineId: string) => {
    // Clear any existing timer for this line — user is still editing.
    const existing = revisionTimers.current.get(lineId);
    if (existing !== undefined) clearTimeout(existing);

    const handle = setTimeout(async () => {
      revisionTimers.current.delete(lineId);
      const ok = await confirmDialog(
        "This line is on an active RFQ. Do you want to send the vendor an updated RFQ with these changes?",
        { title: "Vendor data revised", confirmText: "Yes, send revision", cancelText: "Cancel" },
      );
      if (ok) {
        // Mark the line as revised so the status shows "Rvsd RFQ".
        // The vendor will see the updated costing data on their next RFQ view.
        void updateLine(lineId, { status: "revised" as Parameters<typeof updateLine>[1]["status"] });
      }
    }, 30_000);

    revisionTimers.current.set(lineId, handle);
  }, [updateLine]);

  // Wrap updateLine: quoted lines get an immediate confirm before saving;
  // sent/quoted lines get a 30-second debounced revision prompt after saving.
  const updateLineGuarded = React.useCallback(async (id: string, patch: Parameters<typeof updateLine>[1]) => {
    const line = useCostingStore.getState().lines.find((l) => l.id === id);
    const statusBefore = line?.status;

    if (statusBefore === "quoted") {
      const ok = await confirmDialog(
        "This line has an active vendor quote. Saving will overwrite the quoted values.",
        { title: "Line has been quoted", confirmText: "Save changes", cancelText: "Cancel" },
      );
      if (!ok) return;
    }

    const result = await updateLine(id, patch);

    // After saving, schedule a revision prompt for sent/quoted lines (but not
    // if the patch itself is only a status change — no data to revise).
    const isStatusOnlyPatch = Object.keys(patch).length === 1 && "status" in patch;
    if (!isStatusOnlyPatch && (statusBefore === "sent" || statusBefore === "quoted")) {
      scheduleRevisionPrompt(id);
    }

    return result;
  }, [updateLine, scheduleRevisionPrompt]);

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

  // Task 10 — DDP payment terms hide the cost-component columns (the vendor
  // quotes a delivered-duty-paid price, so FOB/Duty/Freight/Insurance/Landed/
  // Other are not entered separately) and rename "Tgt Cost" → "Trgt DDP".
  // Match /DDP/i against the project's payment_terms_name snapshot so "DDP",
  // "DDP 30", "DDP 60" etc. all trigger it.
  // Margin-visibility gate (P14 RBAC `margins:read`). When the caller lacks it,
  // the three margin% columns (Margin %, LY Mgn %, T3 Mgn %) and the weighted-
  // margin footer are dropped entirely — not just from the grid but from the
  // column-picker too, since all three surfaces derive from displayColumns.
  // Fail-open: canView is TRUE until enforcement is live. NOTE: _sell_from_margin
  // is a SELL PRICE (not a margin figure) and is intentionally NOT gated.
  const { canView: canViewMargins } = useCanSeeMargins();
  const MARGIN_COLS = React.useMemo(() => new Set(["_margin", "ly_margin_pct", "t3_margin_pct"]), []);

  const isDdp = isDdpProject(project);
  // The FOB→Landed component columns. Grouped under one "FOB / Landed Target"
  // band in the header (item 4) and hidden entirely in DDP mode (the vendor
  // quotes a single delivered price into "Tgt DDP Cost").
  const FOB_GROUP = ["fob_cost", "duty_rate", "freight", "insurance", "other_costs", "_landed"];
  const DDP_HIDDEN = new Set(FOB_GROUP);
  const displayColumns = COLUMNS
    .filter((c) => !(isDdp && DDP_HIDDEN.has(c.key)))
    .filter((c) => canViewMargins || !MARGIN_COLS.has(c.key))
    .map((c) => (isDdp && c.key === "target_cost" ? { ...c, label: "Tgt DDP Cost" } : c));

  const visibleColumns = displayColumns.filter((c) => !hiddenColumns.has(c.key));
  const visibleWidth = visibleColumns.reduce((s, c) => s + c.width, 0);
  const toggleableColumns = displayColumns.filter((c) => c.label && c.label.trim().length > 0).map((c) => ({ key: c.key, label: c.label }));

  // Row-selection checkboxes drive the "Generate Vendor RFQs" button.
  // Local Set so toggling is O(1) and we don't pollute the global store.
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);

  // Comp-period local draft. Holds a half-filled range so picking ONE date
  // no longer collapses the input back to empty (the old bug: onChange set
  // compPeriod=null whenever the other end was blank, immediately wiping the
  // value just typed). compPeriod (the store) is only set once BOTH ends are
  // filled — that's what compService needs. Seeded from any existing store value.
  const [compFrom, setCompFrom] = useState<string>(compPeriod?.from || "");
  const [compTo, setCompTo] = useState<string>(compPeriod?.to || "");
  const applyCompRange = (from: string, to: string) => {
    setCompFrom(from);
    setCompTo(to);
    setCompPeriod(from && to ? { from, to } : null);
  };
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
    if (!project) return;
    if (selectedRowIds.size === 0) {
      setNotice("Tick the checkbox on at least one row, then click Vendor RFQ.", "info");
      return;
    }
    const projectId = project.id;
    let lineIds = Array.from(selectedRowIds);

    // Item 2 — block sending incomplete rows. Offer to fix (cancel) or delete
    // the incomplete rows and send only the complete ones.
    const selectedLines = lines.filter((l) => selectedRowIds.has(l.id));
    const incomplete = selectedLines.filter((l) => rowMissingFields(l, isDdp).length > 0);
    if (incomplete.length > 0) {
      const completeIds = selectedLines
        .filter((l) => rowMissingFields(l, isDdp).length === 0)
        .map((l) => l.id);
      const proceed = await confirmDialog(
        `${incomplete.length} selected row${incomplete.length === 1 ? " is" : "s are"} incomplete and can't be sent. ` +
          `Fix them, or delete the incomplete row${incomplete.length === 1 ? "" : "s"}` +
          `${completeIds.length > 0 ? " and send the rest" : ""}?`,
        {
          title: "Incomplete rows",
          danger: true,
          confirmText: completeIds.length > 0 ? "Delete incomplete & send rest" : "Delete incomplete",
          cancelText: "Go back & fix",
          listItems: incomplete.map((l) =>
            `${l.style_code || "(no style)"} — missing: ${rowMissingFields(l, isDdp).join(", ")}`,
          ),
        },
      );
      if (!proceed) return; // operator chose to fix
      for (const l of incomplete) {
        // eslint-disable-next-line no-await-in-loop
        await deleteLine(l.id);
      }
      setSelectedRowIds(new Set(completeIds));
      if (completeIds.length === 0) {
        setNotice("Incomplete rows deleted. Nothing left to send.", "info");
        return;
      }
      lineIds = completeIds;
    }

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
        // RFQs are auto-sent to the vendor on create now (one step — no separate
        // "Send to Vendor" click). `sent` is true unless the auto-send hiccupped
        // (that case is surfaced in res.errors below), so reflect it in the toast.
        const allSent = res.created.every((c) => c.sent !== false);
        const verb = allSent ? "sent to vendor" : "created (some not sent — see errors)";
        parts.push(`${res.created.length} RFQ${res.created.length === 1 ? "" : "s"} ${verb}: ${vendorSummary}`);
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

  // Right-click context menu — opened per row at the cursor. Holds the target
  // line id + screen coords. Null = closed. Closes on outside-click / Escape /
  // scroll so it never strands over a moved row.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; lineId: string } | null>(null);
  // AI cost co-pilot modal — opened from the row context menu.
  const [suggestLineId, setSuggestLineId] = useState<string | null>(null);
  // AI size-curve modal — opened from the row context menu.
  const [sizeCurveLineId, setSizeCurveLineId] = useState<string | null>(null);
  const openContextMenu = (e: React.MouseEvent, lineId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, lineId });
  };
  const closeContextMenu = () => setCtxMenu(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeContextMenu(); };
    // Capture-phase outside-click + scroll close. The menu's own onMouseDown
    // stops propagation so clicking an item doesn't self-close before firing.
    const onDown = () => closeContextMenu();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onDown, true);
    };
  }, [ctxMenu]);

  const onDuplicateRow = async (lineId: string) => {
    closeContextMenu();
    const created = await duplicateLine(lineId);
    if (created) {
      await reseedCopyFromStyle(created);
      setNotice("Row duplicated below — pick a vendor for the new line.", "info");
    }
  };

  const onAdd = async () => {
    // Item 5 — gate row creation on a complete project header.
    const missing = projectHeaderMissing(project);
    if (missing.length > 0) {
      await confirmDialog(
        "Fill in the project header before adding rows. Missing:",
        {
          title: "Project header incomplete",
          confirmText: "OK",
          cancelText: "",
          listItems: missing,
        },
      );
      return;
    }
    await addLine({});
  };

  // Item 9 — operator edits Margin %. BIDIRECTIONAL so a margin always does
  // something sensible regardless of which leg is already filled:
  //  • Sell Tgt already set → back-solve the COST (DDP → Tgt DDP Cost; else FOB
  //    so landed hits the implied cost), holding the sell fixed. (worked already)
  //  • Sell Tgt NOT set, but a cost basis exists → CREATE the Sell Tgt from the
  //    cost + margin (sell = cost / (1 − m/100)), same math as "Sell Tgt Frm
  //    Mrgn", and remember the margin link (sell_target_margin_pct).
  const onMarginEdit = (line: CostingLine, raw: string) => {
    const m = Number(String(raw).replace(/[^0-9.\-]/g, ""));
    if (!isFinite(m)) return;
    if (cnum(line.sell_target) > 0) {
      const patch = solveCostFromMargin(line, isDdp, m);
      if (patch) void updateLineGuarded(line.id, patch);
      return;
    }
    // No Sell Tgt yet → derive it from the cost basis + entered margin.
    if (!(lineCostBasis(line, isDdp) > 0)) {
      notify(isDdp
        ? "Enter a Sell Tgt or a Tgt DDP Cost first — margin needs one to solve the other."
        : "Enter a Sell Tgt or a cost (FOB/Landed) first — margin needs one to solve the other.", "info");
      return;
    }
    const sell = solveSellFromMargin(line, isDdp, m);
    if (sell == null) { notify("Margin must be below 100%.", "info"); return; }
    void updateLineGuarded(line.id, { sell_target: sell, sell_target_margin_pct: m });
  };

  // "Sell Tgt Frm Mrgn" — operator types a target gross-margin %; auto-derive
  // Sell Tgt = cost basis / (1 − margin/100), holding cost fixed. Stores the
  // entered margin (sell_target_margin_pct) so the cell keeps showing it until
  // the operator overrides Sell Tgt directly (which clears it → cell blanks).
  const onSellFromMarginEdit = (line: CostingLine, raw: string) => {
    const trimmed = String(raw).trim();
    if (trimmed === "") {
      // Cleared the margin field → forget the derived-from-margin link.
      if (line.sell_target_margin_pct != null) void updateLineGuarded(line.id, { sell_target_margin_pct: null });
      return;
    }
    const m = Number(trimmed.replace(/[^0-9.\-]/g, ""));
    if (!isFinite(m)) return;
    if (!(lineCostBasis(line, isDdp) > 0)) {
      notify(isDdp ? "Enter a Tgt DDP Cost first — margin needs a cost to solve the sell price."
                   : "Enter a cost (FOB/Landed) first — margin needs a cost to solve the sell price.", "info");
      return;
    }
    const sell = solveSellFromMargin(line, isDdp, m);
    if (sell == null) { notify("Margin must be below 100%.", "info"); return; }
    void updateLineGuarded(line.id, { sell_target_margin_pct: m, sell_target: sell });
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
      fabric_codes: style.base_fabric ? [style.base_fabric] : [], // seed multi-select
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
    await updateLineGuarded(line.id, patch);
  };

  // After a Copy/Duplicate, re-derive the new line's OWN style data from the
  // Style Master — fabric + avg cost via the same seed path as a fresh style
  // pick, and the comp effect re-fetches its LY/T3 sales. So the copy carries
  // its own data rather than inheriting whatever was edited on the source.
  const reseedCopyFromStyle = async (line: CostingLine) => {
    if (!line.style_code) return;
    try {
      const hits = await searchStyles(line.style_code, { limit: 50 });
      const hit = hits.find((h) => h.style_code === line.style_code) || hits[0];
      if (hit) await onStylePick(line, hit);
    } catch { /* non-fatal — the copied values remain in place */ }
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
    // Cost basis: DDP → Tgt DDP Cost; otherwise landed (FOB-derived).
    const cost = lineCostBasis(line, isDdp);
    totalQty += qty;
    totalCost += qty * cost;
    totalSales += qty * n(line.sell_target);
  }
  const weightedMargin = totalSales > 0 ? ((totalSales - totalCost) / totalSales) * 100 : 0;

  return (
    <div style={{ marginTop: 20 }}>
      {/* Awarded rows render all their fonts green. !important overrides the
          per-cell inline colors; in-cell popovers portal to document.body so
          they're outside .costing-row-awarded and keep their normal palette. */}
      <style>{`.costing-row-awarded, .costing-row-awarded * { color: #34D399 !important; }`}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        {stageFilter && (
          <span style={{ color: "#F59E0B", fontSize: 11, fontWeight: 600 }}>Filtered: {stageFilter}</span>
        )}
        {(() => {
          const headerOk = projectHeaderMissing(project).length === 0;
          return (
            <button
              onClick={onAdd}
              title={headerOk ? "Add a new costing row" : "Complete the project header first"}
              style={{
                ...TOOLBAR_BTN,
                background: headerOk ? "#10B981" : "#334155",
                color: headerOk ? "#fff" : "#64748B",
                border: headerOk ? "none" : "1px solid #475569",
                padding: "5px 14px", borderRadius: 4,
                cursor: "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >+ Add row</button>
          );
        })()}
        <button
          onClick={async () => {
            const ids = Array.from(selectedRowIds);
            for (const id of ids) {
              const c = await duplicateLine(id);
              if (c) await reseedCopyFromStyle(c);
            }
            setSelectedRowIds(new Set());
            setNotice(`${ids.length} row${ids.length === 1 ? "" : "s"} copied below — update vendor for each new line.`, "info");
          }}
          disabled={selectedRowIds.size === 0}
          title={selectedRowIds.size === 0 ? "Select a row first to copy it" : `Copy ${selectedRowIds.size} selected row${selectedRowIds.size === 1 ? "" : "s"}`}
          style={{
            ...TOOLBAR_BTN,
            background: selectedRowIds.size > 0 ? "#6366F1" : "transparent",
            color: selectedRowIds.size > 0 ? "#fff" : "#64748B",
            border: `1px solid ${selectedRowIds.size > 0 ? "#6366F1" : "#334155"}`,
            padding: "5px 14px", borderRadius: 4,
            cursor: selectedRowIds.size === 0 ? "not-allowed" : "pointer",
            fontSize: 12, fontWeight: 600,
          }}
        >Copy{selectedRowIds.size > 0 ? ` (${selectedRowIds.size})` : ""}</button>
        <button
          onClick={async () => {
            const ids = Array.from(selectedRowIds);
            const selectedLines = lines.filter((l) => ids.includes(l.id));
            const ok = await confirmDialog(
              `Delete ${ids.length} selected row${ids.length === 1 ? "" : "s"}? This also removes their vendor + compliance data.`,
              {
                title: "Delete rows",
                danger: true,
                confirmText: `Delete ${ids.length} row${ids.length === 1 ? "" : "s"}`,
                cancelText: "Cancel",
                listItems: selectedLines.map((l) => l.style_code || "(no style)"),
              },
            );
            if (!ok) return;
            for (const id of ids) await deleteLine(id);
            setSelectedRowIds(new Set());
            setNotice(`${ids.length} row${ids.length === 1 ? "" : "s"} deleted.`, "info");
          }}
          disabled={selectedRowIds.size === 0}
          title={selectedRowIds.size === 0 ? "Select rows to delete" : `Delete ${selectedRowIds.size} selected row${selectedRowIds.size === 1 ? "" : "s"}`}
          style={{
            ...TOOLBAR_BTN,
            background: selectedRowIds.size > 0 ? "#EF4444" : "transparent",
            color: selectedRowIds.size > 0 ? "#fff" : "#64748B",
            border: `1px solid ${selectedRowIds.size > 0 ? "#EF4444" : "#334155"}`,
            padding: "5px 14px", borderRadius: 4,
            cursor: selectedRowIds.size === 0 ? "not-allowed" : "pointer",
            fontSize: 12, fontWeight: 600,
          }}
        >✕ Delete{selectedRowIds.size > 0 ? ` (${selectedRowIds.size})` : ""}</button>
        <button
          onClick={onGenerateRfqs}
          disabled={generating}
          title={
            selectedRowIds.size === 0
              ? "Tick a row checkbox first, then click to generate RFQs"
              : `Generate one RFQ per vendor across ${selectedRowIds.size} selected line${selectedRowIds.size === 1 ? "" : "s"}`
          }
          style={{
            ...TOOLBAR_BTN,
            background: selectedRowIds.size > 0 ? "#3B82F6" : "transparent",
            color: selectedRowIds.size > 0 ? "#fff" : "#64748B",
            border: `1px solid ${selectedRowIds.size > 0 ? "#3B82F6" : "#334155"}`,
            padding: "5px 14px", borderRadius: 4,
            cursor: generating ? "not-allowed" : "pointer",
            fontSize: 12, fontWeight: 600,
            opacity: generating ? 0.6 : 1,
          }}
        >
          {generating ? "Generating…" : `Vendor RFQ${selectedRowIds.size > 0 ? ` (${selectedRowIds.size})` : ""}`}
        </button>
        {/* Comp period from/to — drives /comp/ly + /comp/t3 windows.
            Empty = endpoint defaults (LY: trailing 365d shifted -12mo;
            T3: trailing 3 months). Both ends need values for the override to
            apply, but each end can be picked independently — local draft state
            holds a half-filled range so picking one date no longer wipes it.

            Tangerine T7 <DateRangePresets/> chips (LY / This Month / Last
            Month / …) feed the same draft. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 12 }}>
          <span style={{ fontSize: 10, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>Comp period</span>
          <input
            type="date"
            value={compFrom}
            onChange={(e) => applyCompRange(e.target.value, compTo)}
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
            value={compTo}
            onChange={(e) => applyCompRange(compFrom, e.target.value)}
            title="Comp period TO"
            style={{
              background: "#0F172A", color: "#E2E8F0",
              border: "1px solid #334155", borderRadius: 4,
              padding: "4px 6px", fontSize: 11, outline: "none",
              colorScheme: "dark",
            }}
          />
          {/* Preset dropdown — shared <DateRangePresets> in dropdown form so the
              comp-period row stays on the Vendor RFQ line and matches the preset
              dropdowns across the Tangerine panels. */}
          <DateRangePresets
            variant="dropdown"
            from={compFrom}
            to={compTo}
            onChange={(fromVal, toVal) => {
              // "Custom…" returns empty strings — clear and let the operator
              // pick from/to manually; otherwise apply the computed range.
              if (!fromVal && !toVal) { setCompFrom(""); setCompTo(""); setCompPeriod(null); return; }
              applyCompRange(fromVal, toVal);
            }}
          />
          {(compFrom || compTo) && (
            <button
              type="button"
              onClick={() => { setCompFrom(""); setCompTo(""); setCompPeriod(null); }}
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
        {/* Header — a sticky 2-tier block: a grouping band over the FOB→Landed
            columns (item 4), then the column labels. Cells use flex:0 0 width +
            box-sizing:border-box so borders don't push width, matching body. */}
        <div style={{ position: "sticky", top: 0, zIndex: 5 }}>
        {!isDdp && (() => {
          const grp = visibleColumns.filter((c) => FOB_GROUP.includes(c.key));
          if (grp.length === 0) return null;
          const grpWidth = grp.reduce((s, c) => s + c.width, 0);
          const firstKey = grp[0].key;
          return (
            <div style={{ display: "flex", minWidth: visibleWidth, background: "#0F172A" }}>
              {visibleColumns.map((c) => {
                if (c.key === firstKey) {
                  return (
                    <div key="_fobband" style={{
                      flex: `0 0 ${grpWidth}px`, boxSizing: "border-box",
                      borderRight: "1px solid #475569", borderBottom: "1px solid #334155",
                      padding: "5px 8px", textAlign: "center",
                      fontSize: 9, fontWeight: 700, color: "#FBBF24",
                      textTransform: "uppercase", letterSpacing: ".08em",
                    }}>FOB / Landed Target</div>
                  );
                }
                if (FOB_GROUP.includes(c.key)) return null; // merged into the band cell
                return <div key={`band_${c.key}`} style={{ flex: `0 0 ${c.width}px`, boxSizing: "border-box" }} />;
              })}
            </div>
          );
        })()}
        <div style={{ display: "flex", minWidth: visibleWidth, background: "#0F172A" }}>
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
            // Narrow margin-derive column: stack the header on two lines
            // ("Sell Tgt" / "Frm Mrgn") so the column can stay slim.
            const headerContent = c.key === "_sell_from_margin"
              ? (<><div>Sell Tgt</div><div>Frm Mrgn %</div></>)
              : c.label;
            return (
              <div key={c.key} style={{
                flex: `0 0 ${c.width}px`, boxSizing: "border-box", overflow: "hidden",
                padding: c.key === "_sell_from_margin" ? "5px 4px" : "8px 10px",
                fontSize: 10, fontWeight: 700, lineHeight: 1.1,
                color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em",
                textAlign: c.align || "left",
                borderRight: "1px solid #475569",
              }}>{headerContent}</div>
            );
          })}
        </div>
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
          // Awarded line → render the whole row's fonts green. Keyed on the
          // EFFECTIVE per-line status (a Closed line that was awarded is no
          // longer green). The scoped `.costing-row-awarded *` rule below uses
          // !important to override the cells' inline colors; popovers portal to
          // document.body so they stay unaffected.
          const isAwarded = effectiveLineStatus(line) === "awarded";
          return (
            <div
              key={line.id}
              className={isAwarded ? "costing-row-awarded" : undefined}
              // Row click only highlights — does NOT open the vendor panel.
              // The "$ Qts" button in actions column is the explicit panel trigger.
              onClick={() => setSelectedLine(line.id)}
              onContextMenu={(e) => openContextMenu(e, line.id)}
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

                // Per-line status pill (Draft / On RFQ / Awarded / Closed).
                if (c.key === "_status") {
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <LineStatusCell
                        line={line}
                        onChange={(s) => updateLine(line.id, { status: s })}
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
                        onChange={(v) => updateLineGuarded(line.id, { style_code: v })}
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

                // Margin — auto-filled from Sell Tgt vs cost basis (item 8) and
                // EDITABLE: typing a margin back-solves the cost (item 9).
                // Sell Tgt Frm Mrgn — type a target margin % → auto-derives Sell
                // Tgt (sell = cost / (1 − m/100)). Shows the stored margin; blanks
                // when the operator overrides Sell Tgt directly (handled in the
                // sell_target numeric onBlur, which clears sell_target_margin_pct).
                if (c.key === "_sell_from_margin") {
                  const mv = line.sell_target_margin_pct;
                  const hasMv = typeof mv === "number" && isFinite(mv);
                  return (
                    <div key={c.key} style={{ ...style, padding: 0 }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
                        <input
                          key={`sfm_${line.id}_${hasMv ? mv.toFixed(2) : ""}`}
                          defaultValue={hasMv ? fmtPct.format(mv) : ""}
                          type="text"
                          inputMode="decimal"
                          title={isDdp
                            ? "Type a target margin % → sets Sell Tgt from Tgt DDP Cost. Editing Sell Tgt directly clears this."
                            : "Type a target margin % → sets Sell Tgt from the cost basis (Landed). Editing Sell Tgt directly clears this."}
                          placeholder="—"
                          onBlur={(e) => onSellFromMarginEdit(line, e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          style={{
                            flex: 1, minWidth: 0, padding: "4px 2px 4px 6px", fontSize: 12, fontWeight: 600,
                            textAlign: "right", background: "transparent",
                            border: "1px solid transparent", color: "#93C5FD", outline: "none",
                          }}
                        />
                        <span style={{ fontSize: 11, fontWeight: 600, color: "#93C5FD", paddingRight: 6, opacity: hasMv ? 1 : 0.45, pointerEvents: "none" }}>%</span>
                      </div>
                    </div>
                  );
                }

                if (c.key === "_margin") {
                  const marginVal = lineMarginPct(line, isDdp);
                  const hasMargin = cnum(line.sell_target) > 0 && marginVal !== 0;
                  const color = marginTierColor(marginVal);
                  return (
                    <div key={c.key} style={{
                      ...style, padding: 0,
                      background: hasMargin ? color + "33" : undefined,
                    }} onClick={(e) => e.stopPropagation()}>
                      <input
                        key={`margin_${line.id}_${marginVal.toFixed(2)}`}
                        defaultValue={hasMargin ? fmtPct.format(marginVal) : ""}
                        type="text"
                        title={isDdp
                          ? "Edit margin → with no Sell Tgt set yet it creates the Sell Tgt from the cost; with a Sell Tgt set it back-solves Tgt DDP Cost"
                          : "Edit margin → with no Sell Tgt set yet it creates the Sell Tgt from the cost; with a Sell Tgt set it back-solves FOB so Landed hits target"}
                        placeholder="—"
                        onBlur={(e) => onMarginEdit(line, e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        style={{
                          width: "100%", padding: "4px 6px", fontSize: 12, fontWeight: 700,
                          textAlign: "right", background: "transparent",
                          border: "1px solid transparent", color, outline: "none",
                        }}
                      />
                    </div>
                  );
                }

                // Docs — per-row document attachments. Opens a portaled modal
                // wrapping the shared <DocumentAttachmentList> for this line
                // (context_table="costing_lines"). Every line is persisted on
                // creation so line.id is always a real costing_lines id.
                if (c.key === "_docs") {
                  return (
                    <div key={c.key} style={{ ...style, justifyContent: "center" }} onClick={(e) => e.stopPropagation()}>
                      <RowAttachmentsCell lineId={line.id} styleCode={line.style_code} />
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
                        // key tied to the numeric value so the uncontrolled
                        // input remounts after a commit and re-displays the
                        // thousands-separated defaultValue (e.g. 12,000).
                        key={`${c.key}_${v == null ? "" : String(v)}`}
                        defaultValue={display === "" ? "" : String(display)}
                        type="text"
                        onBlur={(e) => {
                          const raw = e.target.value.replace(/[^0-9.\-]/g, "");
                          const num = raw === "" ? null : Number(raw);
                          const patch = { [key]: isFinite(num as number) ? num : null } as Partial<CostingLine>;
                          // Overriding Sell Tgt by hand breaks the derived-from-margin
                          // link → blank the "Sell Tgt Frm Mrgn" cell.
                          if (key === "sell_target" && line.sell_target_margin_pct != null) {
                            patch.sell_target_margin_pct = null;
                          }
                          void updateLineGuarded(line.id, patch);
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
                        onChange={(v) => updateLineGuarded(line.id, { [c.key]: v } as Partial<CostingLine>)}
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
                        onChange={(v) => updateLineGuarded(line.id, { size_scale_label: v })}
                      />
                    </div>
                  );
                }

                // Fabric — multi-select autocomplete from Tangerine fabric_codes.
                // Stores the array in fabric_codes; mirrors the first element into
                // the legacy single fabric_code column for RFQ generation +
                // back-compat readers.
                if (c.key === "fabric_code") {
                  const codes = Array.isArray(line.fabric_codes) && line.fabric_codes.length > 0
                    ? line.fabric_codes
                    : (line.fabric_code ? [line.fabric_code] : []);
                  return (
                    <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                      <FabricPickerCell
                        value={codes}
                        onChange={(next) => updateLineGuarded(line.id, {
                          fabric_codes: next,
                          fabric_code: next.length > 0 ? next[0] : null,
                        })}
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
                        onChange={(v) => updateLineGuarded(line.id, { color: v })}
                      />
                    </div>
                  );
                }

                // Default: text input bound to the field name (e.g. Description).
                const key = c.key as keyof CostingLine;
                const v = line[key];
                return (
                  <div key={c.key} style={style} onClick={(e) => e.stopPropagation()}>
                    <input
                      // key tied to the value so this uncontrolled input REMOUNTS
                      // when the field changes programmatically — e.g. picking a
                      // different style repopulates Description. Without it the cell
                      // keeps showing the previous style's text (defaultValue is read
                      // once on mount only).
                      key={`${c.key}_${(v as string | null) ?? ""}`}
                      defaultValue={(v as string | null) ?? ""}
                      type="text"
                      onBlur={(e) => void updateLineGuarded(line.id, { [key]: e.target.value || null } as Partial<CostingLine>)}
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
              // Total cost lands under Landed (non-DDP) or Tgt DDP Cost (DDP,
              // where the Landed column is hidden).
              if (c.key === "_landed" || (isDdp && c.key === "target_cost")) {
                return (
                  <div key={c.key} style={{ ...style, color: "#A7F3D0", justifyContent: "flex-end" }} title="Total cost = Σ qty × cost basis">
                    {fmtMoney0.format(totalCost)}
                  </div>
                );
              }
              if (c.key === "sell_target") {
                return (
                  <div key={c.key} style={{ ...style, color: "#A7F3D0", justifyContent: "flex-end" }} title="Total sales = Σ qty × Sell Tgt">
                    {fmtMoney0.format(totalSales)}
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

      {/* Right-click context menu — anchored at the cursor. Dark costing
          theme. onMouseDown stops propagation so the window-level outside-
          click listener doesn't close it before the item's onClick fires. */}
      {ctxMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: ctxMenu.y,
            left: ctxMenu.x,
            zIndex: 1000,
            background: "#0F172A",
            border: "1px solid #334155",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            padding: 4,
            minWidth: 220,
          }}
        >
          <button
            type="button"
            onClick={() => onDuplicateRow(ctxMenu.lineId)}
            style={{
              display: "block", width: "100%", textAlign: "left",
              background: "transparent", color: "#E2E8F0",
              border: "none", borderRadius: 4,
              padding: "8px 12px", fontSize: 12, fontWeight: 500,
              cursor: "pointer", whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#1E293B"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            Duplicate row (pick new vendor)
          </button>
          <button
            type="button"
            onClick={() => { setSuggestLineId(ctxMenu.lineId); closeContextMenu(); }}
            style={{
              display: "block", width: "100%", textAlign: "left",
              background: "transparent", color: "#E2E8F0",
              border: "none", borderRadius: 4,
              padding: "8px 12px", fontSize: 12, fontWeight: 500,
              cursor: "pointer", whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#1E293B"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            AI cost suggestion
          </button>
          <button
            type="button"
            onClick={() => { setSizeCurveLineId(ctxMenu.lineId); closeContextMenu(); }}
            style={{
              display: "block", width: "100%", textAlign: "left",
              background: "transparent", color: "#E2E8F0",
              border: "none", borderRadius: 4,
              padding: "8px 12px", fontSize: 12, fontWeight: 500,
              cursor: "pointer", whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#1E293B"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            AI size curve
          </button>
        </div>
      )}

      {/* AI cost co-pilot modal */}
      {suggestLineId && (() => {
        const sline = lines.find((l) => l.id === suggestLineId);
        if (!sline) return null;
        return (
          <CostSuggestModal
            line={sline}
            onApply={(patch) => updateLineGuarded(sline.id, patch)}
            onClose={() => setSuggestLineId(null)}
          />
        );
      })()}

      {/* AI size-curve modal */}
      {sizeCurveLineId && (() => {
        const sline = lines.find((l) => l.id === sizeCurveLineId);
        if (!sline) return null;
        return <SizeCurveModal line={sline} onClose={() => setSizeCurveLineId(null)} />;
      })()}
    </div>
  );
}
