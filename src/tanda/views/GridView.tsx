import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { newWorkbook, renderStyledAoa, downloadExcelWorkbook } from "../../shared/excelLogo";
import {
  type XoroPO, type Milestone, type WipTemplate, type View,
  MILESTONE_STATUS_COLORS, MILESTONE_STATUSES, fmtDate, fmtCurrency, milestoneUid, isLineClosed, todayLocalIso,
} from "../../utils/tandaTypes";
import S from "../styles";
import { MilestoneDateInput } from "../detail/MilestoneDateInput";
import { useArrowKeyScroll } from "../../shared/grid/useArrowKeyScroll";
import { GridScrollbarStyles } from "../../shared/grid/GridScrollbarStyles";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { useTandaStore } from "../store/index";
import { PoMatrixPopover } from "./PoMatrixPopover";
import { SearchableSelect } from "../components/SearchableSelect";
import {
  PAGE_SIZE,
  MAX_UNDO,
  HIDEABLE_COL_KEYS,
  COL_WIDTHS,
  COL_LABELS,
  PHASE_SUB,
  PHASE_COLS,
  B_CELL,
  B_HDR,
  PHASE_DIV_COLOR,
  phaseDividerOverlay,
  phaseDividerHost,
  phaseDividerOverlayRight,
  phaseDividerOverlayBoundary,
  type HideableColKey,
} from "./gridView/constants";
import {
  normDateISO,
  buildFixedColsTpl,
  buildColTpl,
  isSizeToken,
  styleColorKey,
  itemSizeLabel,
  sizeSort,
  buildSizeVocab,
} from "./gridView/gridUtils";
import { NotesModal } from "./gridView/NotesModal";

// ── GridView ───────────────────────────────────────────────────────────────
interface GridViewProps {
  pos: XoroPO[];
  milestones: Record<string, Milestone[]>;
  buyers: string[];
  vendors: string[];
  setView: (v: View) => void;
  setSelected: (po: XoroPO | null) => void;
  setDetailMode: (m: any) => void;
  saveMilestone: (m: Milestone, skipHistory?: boolean) => void;
  saveMilestones: (ms: Milestone[]) => Promise<void>;
  ensureMilestones: (po: XoroPO) => Promise<Milestone[] | "needs_template"> | void;
  generateMilestones: (poNumber: string, ddpDate: string, vendorName?: string) => Milestone[];
  regenerateMilestones: (po: XoroPO) => Promise<void>;
  vendorHasTemplate: (vendorName: string) => boolean;
  templateVendorList: () => string[];
  getVendorTemplates: (vendor?: string) => WipTemplate[];
  saveVendorTemplates: (vendor: string, templates: WipTemplate[]) => void;
  user: { name?: string } | null;
}

export function GridView({
  pos, milestones, buyers, vendors, setView, setSelected, setDetailMode,
  saveMilestone, saveMilestones, ensureMilestones, generateMilestones, regenerateMilestones,
  vendorHasTemplate, templateVendorList, getVendorTemplates, saveVendorTemplates,
  user,
}: GridViewProps) {

  // Arrow-key scroll target. Wired to the gv-scroll wrapper below
  // so the operator can navigate the grid without clicking it
  // first; same hook ATS + the wholesale planning grid use.
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  useArrowKeyScroll(tableWrapRef);

  // Hidden column state. Persisted under gv_hidden_cols so the
  // planner's preference survives reloads. Closed-over by the
  // gridTemplateColumns builder below so any change re-flows the
  // grid without touching the per-row cell rendering.
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("gv_hidden_cols");
      if (!raw) return new Set();
      return new Set(JSON.parse(raw) as string[]);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem("gv_hidden_cols", JSON.stringify(Array.from(hiddenCols))); } catch { /* ignore */ }
  }, [hiddenCols]);
  const toggleCol = (k: string) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  // Canonical size vocabulary from the live Tangerine size_scales — drives the
  // style/color grouping so size detection follows the actual scales (incl.
  // paren sizes like S(7-8) and month sizes), not a fixed list. Loads once;
  // until it arrives the grouping uses the structural fallback in isSizeToken.
  const [sizeVocab, setSizeVocab] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    fetch(`${SB_URL}/rest/v1/size_scales?select=sizes,inseams`, { headers: SB_HEADERS })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => { if (!cancelled && Array.isArray(rows)) setSizeVocab(buildSizeVocab(rows)); })
      .catch(() => { /* fall back to structural detection */ });
    return () => { cancelled = true; };
  }, []);

  // Hidden-section (phase) state. Mirrors hiddenCols but keyed by phase
  // name, so the planner can collapse whole milestone sections (Lab Dip,
  // Strike Off, Trim, …) out of the grid. Persisted under gv_hidden_phases.
  // Only affects on-screen rendering — the Excel export still emits every
  // section (same precedent as hiddenCols not touching the export).
  const [hiddenPhases, setHiddenPhases] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("gv_hidden_phases");
      if (!raw) return new Set();
      return new Set(JSON.parse(raw) as string[]);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem("gv_hidden_phases", JSON.stringify(Array.from(hiddenPhases))); } catch { /* ignore */ }
  }, [hiddenPhases]);
  const togglePhase = (p: string) => {
    setHiddenPhases((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  const [colDropOpen, setColDropOpen] = useState(false);
  const colDropRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!colDropOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!colDropRef.current?.contains(e.target as Node)) setColDropOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [colDropOpen]);

  // Freeze-through-column state. null = no freeze. Otherwise the
  // selected column key marks the rightmost frozen column; every
  // visible column at or to the left of it gets position: sticky
  // when scrolling horizontally. Persisted under gv_freeze_key.
  const [freezeKey, setFreezeKey] = useState<HideableColKey | null>(() => {
    try {
      const raw = localStorage.getItem("gv_freeze_key");
      if (!raw || !HIDEABLE_COL_KEYS.includes(raw as HideableColKey)) return null;
      return raw as HideableColKey;
    } catch { return null; }
  });
  useEffect(() => {
    try {
      if (freezeKey) localStorage.setItem("gv_freeze_key", freezeKey);
      else localStorage.removeItem("gv_freeze_key");
    } catch { /* ignore */ }
  }, [freezeKey]);
  // Cumulative left offset (px) for each visible-cell index. Used to
  // build sticky-positioning CSS rules below. Index 0 corresponds
  // to the chevron column (always 32px), index 1 to notes (32px),
  // index 2..7 to the hideable data columns. A hidden column has
  // 0px width so its offset == previous offset.
  const cellOffsets = useMemo(() => {
    const widths: number[] = [32, 32];
    for (const k of HIDEABLE_COL_KEYS) {
      widths.push(hiddenCols.has(k) ? 0 : parseInt(COL_WIDTHS[k]));
    }
    const offsets: number[] = [];
    let acc = 0;
    for (const w of widths) { offsets.push(acc); acc += w; }
    return offsets;
  }, [hiddenCols]);
  // How many leading columns to freeze given the freezeKey. Always
  // includes chevron + notes (always-visible UI). Then includes
  // hideable columns through and including the chosen freezeKey.
  const freezeCount = useMemo(() => {
    if (!freezeKey) return 0;
    const idx = HIDEABLE_COL_KEYS.indexOf(freezeKey);
    if (idx < 0) return 0;
    return 2 + idx + 1; // chevron + notes + (idx+1) hideable cols
  }, [freezeKey]);

  const [search, setSearch]                     = useState("");
  const [filterVendor, setFilterVendor]         = useState("All");
  const [filterBuyer, setFilterBuyer]           = useState("All");

  // ── Named-range filter on the PO# column (row-2 header cell) ──────────────
  // The planner picks EITHER a PO-creation-date range (DateOrder) or a
  // PO-number range (trailing 6 digits of PoNumber). "From" alone means
  // "this value or newer/greater"; an optional "To" closes the range.
  // Results auto-sort ascending by the chosen axis. Persisted under
  // gv_range_filter so the selection survives reloads.
  type RangeMode = "date" | "po";
  interface RangeFilter { mode: RangeMode; from: string; to: string; }
  const [rangeFilter, setRangeFilter] = useState<RangeFilter | null>(() => {
    try {
      const raw = localStorage.getItem("gv_range_filter");
      return raw ? (JSON.parse(raw) as RangeFilter) : null;
    } catch { return null; }
  });
  useEffect(() => {
    try {
      if (rangeFilter) localStorage.setItem("gv_range_filter", JSON.stringify(rangeFilter));
      else localStorage.removeItem("gv_range_filter");
    } catch { /* ignore */ }
  }, [rangeFilter]);
  // Popover open + anchor. Fixed-positioned at the button so it escapes the
  // grid's overflow:scroll clip (same approach as the matrix peek popover).
  const [rangeAnchor, setRangeAnchor] = useState<{ x: number; y: number } | null>(null);
  // Draft form values while the popover is open; committed on Apply.
  const [rangeDraft, setRangeDraft]   = useState<RangeFilter>({ mode: "date", from: "", to: "" });

  const [expandedPoNum, setExpandedPoNum]       = useState<string | null>(null);
  // While ANY PO is expanded, force the freeze through Days from DDP
  // (all 8 fixed cols). This pins the expansion strip + line item
  // rows at left:0..766px so the operator can scroll horizontally
  // through phase columns without losing PO context. The user's
  // own freezeKey is restored as soon as nothing is expanded.
  // freezeCount === 8 is the only configuration that lets the
  // expansion's merged 1/9 cell participate in the sticky chain
  // without overlapping the scrolling phase columns (its width
  // matches the frozen area exactly).
  const effectiveFreezeCount = expandedPoNum != null ? 8 : freezeCount;
  const [expandViewMode, setExpandViewMode]     = useState<"line" | "matrix">("line");
  // Right-click matrix popover anchored at click-position. Lets the
  // planner peek a PO's size matrix without expanding the row.
  const [matrixPopover, setMatrixPopover]       = useState<{ po: XoroPO; x: number; y: number } | null>(null);
  const [buyerPoEditing, setBuyerPoEditing]     = useState<string | null>(null);
  const [buyerPoDraft, setBuyerPoDraft]     = useState("");
  const [page, setPage]                     = useState(0);
  // Each entry is a batch of milestones to restore together (supports cascade undo).
  const [undoStack, setUndoStack]           = useState<Milestone[][]>([]);
  const [notesModal, setNotesModal]         = useState<{
    po: XoroPO; ms: Milestone[]; filterPhase?: string; filterVariant?: string;
  } | null>(null);
  // Vendors the user dismissed this session — state so dismissal triggers re-render.
  const [dismissedTplVendors, setDismissedTplVendors] = useState<Set<string>>(new Set());
  const [tplCopyFrom, setTplCopyFrom] = useState("__default__");
  // When the set of available vendor templates grows (user or background load),
  // un-dismiss those vendors so they don't get permanently hidden if they were
  // dismissed before wipTemplates finished loading.
  const prevTemplateVendorCountRef = useRef<number>(0);
  useEffect(() => {
    const currentCount = templateVendorList().length;
    if (currentCount > prevTemplateVendorCountRef.current) {
      prevTemplateVendorCountRef.current = currentCount;
      // Remove any dismissed vendors that now have a template — they no longer
      // need re-prompting. Also remove those that still don't have one so they
      // can be re-surfaced (they may have been dismissed due to timing).
      setDismissedTplVendors(prev => {
        const next = new Set<string>();
        prev.forEach(v => {
          // Keep dismissed only if vendor now has a template (no need to re-show).
          if (templateVendorList().includes(v)) next.add(v);
        });
        return next;
      });
    }
  }, [templateVendorList]);
  // DDP confirmation modal — shown when a phase date change would shift the DDP.
  const [ddpChangeModal, setDDPChangeModal] = useState<{
    po: XoroPO;
    triggerMs: Milestone;
    newDate: string;
    newDDP: string;
    oldDDP: string;
    poMs: Milestone[];
  } | null>(null);
  // POs whose DDP was modified this session — highlighted orange.
  const [modifiedDDPs, setModifiedDDPs] = useState<Set<string>>(new Set());

  const ensureAttemptedRef = useRef<Set<string>>(new Set());

  // ── Sort ────────────────────────────────────────────────────────────────
  // Click a header to set the sort key; click again to flip direction; third
  // click clears. localStorage-persisted so the planner's preference survives
  // page reloads. Six sortable header columns: PO#, Vendor, Buyer, Buyer PO,
  // DDP, Days from DDP.
  type SortKey = "poNum" | "vendor" | "buyer" | "buyerPo" | "ddp" | "daysFromDdp";
  const [sortKey, setSortKey] = useState<SortKey | null>(() => {
    try { return (localStorage.getItem("gv_sort_key") as SortKey | null) || null; } catch { return null; }
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    try { return (localStorage.getItem("gv_sort_dir") as "asc" | "desc") || "asc"; } catch { return "asc"; }
  });
  useEffect(() => {
    try {
      if (sortKey) localStorage.setItem("gv_sort_key", sortKey);
      else localStorage.removeItem("gv_sort_key");
      localStorage.setItem("gv_sort_dir", sortDir);
    } catch { /* ignore */ }
  }, [sortKey, sortDir]);
  const onHeaderClick = (k: SortKey) => {
    if (sortKey !== k) { setSortKey(k); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    setSortKey(null); setSortDir("asc"); // third click clears
  };

  // Today's ISO date for the Days-from-DDP computation. Recomputed on
  // mount; intentional that it doesn't tick — the grid doesn't re-mount
  // mid-day and a stale offset of a few hours doesn't change planning
  // decisions.
  const todayIso = useMemo(() => todayLocalIso(), []);
  const daysFromDdp = useCallback((ddpIso: string | null | undefined): number | null => {
    if (!ddpIso) return null;
    const d = normDateISO(ddpIso);
    if (!d) return null;
    const t = new Date(todayIso + "T00:00:00").getTime();
    const dt = new Date(d + "T00:00:00").getTime();
    if (isNaN(dt) || isNaN(t)) return null;
    return Math.round((dt - t) / 86400000);
  }, [todayIso]);

  // Trailing numeric portion (last up to 6 digits) of a PO number, e.g.
  // "ROF-P001263" → 1263. Powers the named-range PO-number filter + sort.
  const poNumLast6 = useCallback((poNum: string | null | undefined): number | null => {
    const m = String(poNum ?? "").match(/(\d+)\s*$/);
    if (!m) return null;
    const n = parseInt(m[1].slice(-6), 10);
    return isNaN(n) ? null : n;
  }, []);

  // True when a PO falls inside the named range. Shared by the rows filter
  // and the auto-revert effect so the predicate lives in exactly one place.
  const matchesRange = useCallback((p: XoroPO, rf: RangeFilter): boolean => {
    if (rf.mode === "date") {
      const d = normDateISO(p.DateOrder);
      if (!d) return false;
      if (rf.from && d < rf.from) return false;
      if (rf.to   && d > rf.to)   return false;
      return true;
    }
    const n = poNumLast6(p.PoNumber);
    if (n == null) return false;
    const from = rf.from ? parseInt(rf.from, 10) : null;
    const to   = rf.to   ? parseInt(rf.to,   10) : null;
    if (from != null && n < from) return false;
    if (to   != null && n > to)   return false;
    return true;
  }, [poNumLast6]);

  // ── Rows ────────────────────────────────────────────────────────────────
  const rows = useMemo(() => {
    const s = search.toLowerCase();
    const rf = rangeFilter;
    const filtered = pos.filter(p => {
      if (filterVendor !== "All" && (p.VendorName ?? "") !== filterVendor) return false;
      if (filterBuyer  !== "All" && (p.BuyerName  ?? "") !== filterBuyer)  return false;
      // Named-range filter — PO creation date (DateOrder) OR trailing PO #.
      if (rf && !matchesRange(p, rf)) return false;
      if (!s) return true;
      return (
        (p.PoNumber   ?? "").toLowerCase().includes(s) ||
        (p.VendorName ?? "").toLowerCase().includes(s) ||
        (p.BuyerName  ?? "").toLowerCase().includes(s) ||
        (p.BuyerPo    ?? "").toLowerCase().includes(s)
      );
    });
    // An explicit header sort always wins. Otherwise, when a named range is
    // active, auto-sort ascending by the chosen axis (date or PO number) —
    // "sort results by date or number depending on the search selection".
    if (!sortKey) {
      if (rf) {
        return [...filtered].sort((a, b) => {
          if (rf.mode === "date") {
            const da = normDateISO(a.DateOrder) || "";
            const db = normDateISO(b.DateOrder) || "";
            if (da === db) return 0;
            if (!da) return 1;
            if (!db) return -1;
            return da < db ? -1 : 1;
          }
          const na = poNumLast6(a.PoNumber);
          const nb = poNumLast6(b.PoNumber);
          if (na == null && nb == null) return 0;
          if (na == null) return 1;
          if (nb == null) return -1;
          return na - nb;
        });
      }
      return filtered;
    }
    const dirMul = sortDir === "asc" ? 1 : -1;
    const cmp = (av: any, bv: any) => {
      // Nulls + empty strings sort to the END regardless of direction
      // so the planner can scan blanks separately at the bottom.
      const aEmpty = av == null || av === "";
      const bEmpty = bv == null || bv === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dirMul;
      return String(av).localeCompare(String(bv)) * dirMul;
    };
    const get = (p: XoroPO): any => {
      switch (sortKey) {
        case "poNum":       return p.PoNumber ?? "";
        case "vendor":      return (p.VendorName ?? "").toLowerCase();
        case "buyer":       return (p.BuyerName  ?? "").toLowerCase();
        case "buyerPo":     return (p.BuyerPo    ?? "").toLowerCase();
        case "ddp":         return p.DateExpectedDelivery ?? "";
        case "daysFromDdp": return daysFromDdp(p.DateExpectedDelivery) ?? Number.POSITIVE_INFINITY;
      }
    };
    return [...filtered].sort((a, b) => cmp(get(a), get(b)));
  }, [pos, search, filterVendor, filterBuyer, sortKey, sortDir, daysFromDdp, rangeFilter, poNumLast6, matchesRange]);

  useEffect(() => setPage(0), [search, filterVendor, filterBuyer, sortKey, sortDir, rangeFilter]);

  // Auto-revert: if the active named range matches ZERO POs (independent of the
  // search/vendor/buyer filters), drop it and fall back to the full PO list so
  // the planner is never stranded on an empty grid. A transient notice explains
  // why. Scoped to the range predicate only — other filters returning nothing
  // is a legitimate empty result and is left alone.
  const [rangeNotice, setRangeNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!rangeFilter) return;
    if (pos.some(p => matchesRange(p, rangeFilter))) return;
    const label = rangeFilter.mode === "date" ? "date range" : "PO-number range";
    setRangeFilter(null);
    setRangeNotice(`No POs matched that ${label} — showing all POs.`);
  }, [rangeFilter, pos, matchesRange]);
  // Clear the notice shortly after it appears (or immediately on next change).
  useEffect(() => {
    if (!rangeNotice) return;
    const t = setTimeout(() => setRangeNotice(null), 6000);
    return () => clearTimeout(t);
  }, [rangeNotice]);

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows   = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // First vendor on the current page that has no template and hasn't been dismissed.
  // Computed at render time so it re-evaluates automatically after wipTemplates loads
  // or after the user dismisses a vendor — no timing/false-positive issues.
  const tplModalVendor = useMemo(() => {
    for (const po of pageRows) {
      const vendorN = po.VendorName ?? "";
      if (vendorN && !vendorHasTemplate(vendorN) && !dismissedTplVendors.has(vendorN)) {
        return vendorN;
      }
    }
    return null;
  }, [pageRows, vendorHasTemplate, dismissedTplVendors]);

  // Auto-populate milestones for every PO on the current page.
  // Also detects partial milestones (PO has some phases but fewer than the current
  // template) and silently regenerates them so new template phases fill in.
  useEffect(() => {
    for (const po of pageRows) {
      if (!ensureMilestones) continue;
      const poNum    = po.PoNumber ?? "";
      const vendorN  = po.VendorName ?? "";
      const ddp      = normDateISO(po.DateExpectedDelivery);
      if (!poNum || !ddp) continue;

      const existing = milestones[poNum] || [];

      if (existing.length === 0) {
        // No milestones yet — try to generate.
        // We only block retries on SUCCESS (milestones saved) or hard error.
        // "needs_template" clears the ref so the effect retries automatically
        // once wipTemplates loads or the user creates a template.
        if (ensureAttemptedRef.current.has(poNum)) continue;
        ensureAttemptedRef.current.add(poNum);
        const normPo = ddp !== (po.DateExpectedDelivery ?? "") ? { ...po, DateExpectedDelivery: ddp } : po;
        void (async () => {
          try {
            const result = await ensureMilestones(normPo);
            // No template yet — clear so we retry when templates become available.
            if (result === "needs_template") ensureAttemptedRef.current.delete(poNum);
          } catch (e) {
            ensureAttemptedRef.current.delete(poNum);
            console.error("[Grid] ensureMilestones failed for", poNum, e);
          }
        })();
      } else if (vendorN && vendorHasTemplate(vendorN)) {
        // PO has milestones — check if they're partial (fewer phases than current template).
        const templatePhaseCount = getVendorTemplates(vendorN).length;
        const regenKey = poNum + "_regen";
        if (templatePhaseCount > 0 && existing.length < templatePhaseCount && !ensureAttemptedRef.current.has(regenKey)) {
          ensureAttemptedRef.current.add(regenKey);
          const normPo = ddp !== (po.DateExpectedDelivery ?? "") ? { ...po, DateExpectedDelivery: ddp } : po;
          void regenerateMilestones(normPo).catch(e => {
            ensureAttemptedRef.current.delete(regenKey);
            console.error("[Grid] regenerateMilestones failed for", poNum, e);
          });
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageRows, milestones, ensureMilestones, vendorHasTemplate, getVendorTemplates, regenerateMilestones]);

  // Every phase present across the visible POs, in template order. This is
  // the full set used by the export and the Sections hide-menu.
  const allPhases = useMemo(() => {
    const order = new Map<string, number>();
    rows.forEach(p => {
      (milestones[p.PoNumber ?? ""] || []).forEach(m => {
        const cur = order.get(m.phase);
        if (cur === undefined || m.sort_order < cur) order.set(m.phase, m.sort_order);
      });
    });
    return [...order.entries()].sort((a, b) => a[1] - b[1]).map(([phase]) => phase);
  }, [rows, milestones]);

  // The phases actually rendered on screen — allPhases minus the sections the
  // planner has hidden. Every grid render path (column template, headers, data
  // rows, expanded strips) reads this, so hiding a section reflows the grid
  // without touching the export, which keeps using allPhases.
  const phases = useMemo(
    () => allPhases.filter(p => !hiddenPhases.has(p)),
    [allPhases, hiddenPhases],
  );

  // ── Mutations ───────────────────────────────────────────────────────────
  // pushUndo accepts a batch (array) of milestones — all are restored together on undo.
  const pushUndo = useCallback((batch: Milestone | Milestone[]) => {
    const arr = Array.isArray(batch) ? batch : [batch];
    setUndoStack(s => [arr, ...s].slice(0, MAX_UNDO));
  }, []);

  const updateStatus = (po: XoroPO, m: Milestone, newStatus: string) => {
    pushUndo(m);
    const dates = { ...(m.status_dates || {}) };
    const iso   = todayLocalIso();
    if (newStatus !== "Not Started" && !dates[newStatus]) dates[newStatus] = iso;
    saveMilestone({
      ...m,
      status: newStatus,
      status_date: dates[newStatus] || null,
      status_dates: Object.keys(dates).length > 0 ? dates : null,
      updated_at: new Date().toISOString(),
      updated_by: user?.name || "",
    }, true);
  };

  const updateField = useCallback((m: Milestone, patch: Partial<Milestone>) => {
    pushUndo(m);
    saveMilestone({ ...m, ...patch, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
  }, [pushUndo, saveMilestone, user]);

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const [batch, ...rest] = undoStack;
    setUndoStack(rest);
    // Restore all milestones in the batch (single edit = 1 item, cascade = many).
    batch.forEach(prev => {
      saveMilestone({ ...prev, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
    });
  };

  // Add note to a specific milestone; optimistic store update so the UI
  // reflects the change immediately without waiting for the DB round-trip.
  const addNote = useCallback((milestone: Milestone, text: string) => {
    const now      = new Date();
    const dateStr  = todayLocalIso(now);
    const newEntry = { text, user: user?.name || "Unknown", date: dateStr };
    const updated  = {
      ...milestone,
      note_entries: [...(milestone.note_entries || []), newEntry],
      updated_at: now.toISOString(),
      updated_by: user?.name || "",
    };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  const editNote = useCallback((milestone: Milestone, index: number, newText: string) => {
    const entries = [...(milestone.note_entries || [])];
    entries[index] = { ...entries[index], text: newText };
    const updated = {
      ...milestone,
      note_entries: entries,
      updated_at: new Date().toISOString(),
      updated_by: user?.name || "",
    };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  const deleteNote = useCallback((milestone: Milestone, index: number) => {
    const entries = [...(milestone.note_entries || [])];
    entries.splice(index, 1);
    const updated = {
      ...milestone,
      note_entries: entries.length > 0 ? entries : null,
      updated_at: new Date().toISOString(),
      updated_by: user?.name || "",
    };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  // ── Per-line-item (variant) notes ───────────────────────────────────────
  // Stored in milestone.variant_notes[varKey] so each SKU group gets its
  // own note thread, independent of the PO-level note_entries.
  const addVariantNote = useCallback((milestone: Milestone, varKey: string, text: string) => {
    const now = new Date();
    const entry = { text, user: user?.name || "Unknown", date: todayLocalIso(now) };
    const vn = { ...(milestone.variant_notes || {}) };
    vn[varKey] = [...(vn[varKey] || []), entry];
    const updated = { ...milestone, variant_notes: vn, updated_at: now.toISOString(), updated_by: user?.name || "" };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  const editVariantNote = useCallback((milestone: Milestone, varKey: string, index: number, newText: string) => {
    const vn = { ...(milestone.variant_notes || {}) };
    const entries = [...(vn[varKey] || [])];
    entries[index] = { ...entries[index], text: newText };
    vn[varKey] = entries;
    const updated = { ...milestone, variant_notes: vn, updated_at: new Date().toISOString(), updated_by: user?.name || "" };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  const deleteVariantNote = useCallback((milestone: Milestone, varKey: string, index: number) => {
    const vn = { ...(milestone.variant_notes || {}) };
    const entries = [...(vn[varKey] || [])];
    entries.splice(index, 1);
    vn[varKey] = entries.length > 0 ? entries : [];
    const cleanVn = Object.fromEntries(Object.entries(vn).filter(([, v]) => v.length > 0));
    const updated = { ...milestone, variant_notes: Object.keys(cleanVn).length > 0 ? cleanVn : null, updated_at: new Date().toISOString(), updated_by: user?.name || "" };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  // ── Buyer dropdown options ────────────────────────────────────────────
  // All known buyers from POs + fixed stock options; always sorted.
  const buyerOptions = useMemo(() => {
    const fixed = ["ROF Stock", "PT Stock"];
    return [...new Set([...buyers, ...fixed])].sort();
  }, [buyers]);

  // ── PO field persist helpers ─────────────────────────────────────────────
  // Each helper: optimistic store update, then PATCH the dedicated column
  // AND the data JSONB blob so both stay in sync and survive page reload.
  const patchPO = async (poNumber: string, colPatch: Record<string, any>, dataPatch: Record<string, any>) => {
    const enc = encodeURIComponent(poNumber);
    // Read current data blob, merge, write back
    const res = await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${enc}&select=data`, { headers: SB_HEADERS });
    if (res.ok) {
      const rows = await res.json();
      if (rows?.[0]?.data) {
        const merged = { ...rows[0].data, ...dataPatch };
        await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${enc}`, {
          method: "PATCH",
          headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ ...colPatch, data: merged }),
        });
        return;
      }
    }
    // Fallback: just patch columns
    await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${enc}`, {
      method: "PATCH",
      headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(colPatch),
    });
  };

  const persistBuyerPo = async (poNumber: string, value: string) => {
    const trimmed = value.trim();
    useTandaStore.getState().updatePo(poNumber, { BuyerPo: trimmed });
    try {
      await patchPO(poNumber, { buyer_po: trimmed || null }, { BuyerPo: trimmed });
    } catch (e) { console.error("Failed to update buyer_po:", e); }
  };

  const persistBuyerName = async (poNumber: string, value: string) => {
    useTandaStore.getState().updatePo(poNumber, { BuyerName: value });
    try {
      await patchPO(poNumber, { buyer_name: value || null }, { BuyerName: value });
    } catch (e) { console.error("Failed to update buyer_name:", e); }
  };

  // ── Shared DDP persist helper ────────────────────────────────────────────
  const persistDDP = useCallback(async (poNum: string, newDDP: string) => {
    useTandaStore.getState().updatePo(poNum, { DateExpectedDelivery: newDDP });
    setModifiedDDPs(prev => new Set([...prev, poNum]));
    try {
      await patchPO(poNum, { date_expected: newDDP || null }, { DateExpectedDelivery: newDDP });
    } catch (e) { console.error("Failed to update DDP:", e); }
  }, []);

  // ── Cascade all milestones from a given DDP (helper used by both paths) ──
  const cascadeFromDDP = useCallback((poMs: Milestone[], newDDP: string, skipId?: string) => {
    const ddpDate = new Date(newDDP + "T00:00:00");
    for (const m of poMs) {
      if (skipId && m.id === skipId) continue;
      const shifted = new Date(ddpDate);
      shifted.setDate(shifted.getDate() - (m.days_before_ddp ?? 0));
      const newDate = shifted.toISOString().slice(0, 10);
      if (newDate !== normDateISO(m.expected_date ?? "")) {
        saveMilestone({
          ...m, expected_date: newDate,
          updated_at: new Date().toISOString(),
          updated_by: user?.name || "",
        }, true);
      }
    }
  }, [saveMilestone, user]);

  // ── Direct DDP edit (from DDP cell) ─────────────────────────────────────
  const updateDDP = useCallback(async (po: XoroPO, newDDP: string) => {
    const poNum = po.PoNumber ?? "";
    const poMs  = milestones[poNum] || [];
    const oldDDP = normDateISO(po.DateExpectedDelivery);
    if (!newDDP) { await persistDDP(poNum, newDDP); return; }
    if (poMs.length === 0) {
      await persistDDP(poNum, newDDP);
      // No milestones yet — generate fresh from new DDP.
      if (vendorHasTemplate(po.VendorName ?? "")) {
        const ms = generateMilestones(poNum, newDDP, po.VendorName);
        if (ms.length > 0) await saveMilestones(ms);
      }
      return;
    }
    // Snapshot ALL milestones + DDP as one undo batch before cascading.
    pushUndo(poMs);
    await persistDDP(poNum, newDDP);
    // Cascade all milestones.
    cascadeFromDDP(poMs, newDDP);
    // Auto-note on DDP milestone about the direct edit.
    if (oldDDP && oldDDP !== newDDP) {
      const ddpMs = poMs.find(m => (m.days_before_ddp ?? 0) === 0) || poMs[poMs.length - 1];
      if (ddpMs) addNote(ddpMs, `DDP updated from ${fmtDate(oldDDP)} to ${fmtDate(newDDP)} — all phase dates recalculated`);
    }
  }, [milestones, pushUndo, persistDDP, cascadeFromDDP, saveMilestones, generateMilestones, vendorHasTemplate, addNote]);

  // ── Phase date change — may imply a new DDP ──────────────────────────────
  // If the new date implies a different DDP, show a confirmation modal.
  // On confirm: update all milestones + DDP, mark orange, add auto-note.
  const updateMilestoneDate = useCallback((po: XoroPO, m: Milestone, newDate: string | null) => {
    if (!newDate) {
      updateField(m, { expected_date: null });
      return;
    }
    const poNum  = po.PoNumber ?? "";
    const poMs   = milestones[poNum] || [];
    const currentDDP = normDateISO(po.DateExpectedDelivery);

    // Compute the DDP implied by this phase date.
    const implied = new Date(newDate + "T00:00:00");
    implied.setDate(implied.getDate() + (m.days_before_ddp ?? 0));
    const newDDP = implied.toISOString().slice(0, 10);

    if (!currentDDP || newDDP === currentDDP || poMs.length <= 1) {
      // No DDP conflict — snapshot all affected milestones before updating.
      pushUndo(poMs.length > 1 ? poMs : m);
      saveMilestone({ ...m, expected_date: newDate, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
      if (poMs.length > 1) cascadeFromDDP(poMs, newDDP, m.id);
      return;
    }
    // DDP would change — ask user to confirm before cascading.
    // Snapshot stored on ddpChangeModal so handleDDPConfirm can push it.
    setDDPChangeModal({ po, triggerMs: m, newDate, newDDP, oldDDP: currentDDP, poMs });
  }, [milestones, pushUndo, saveMilestone, user, cascadeFromDDP]);

  // ── Confirm DDP change triggered by phase date edit ──────────────────────
  const handleDDPConfirm = useCallback(async () => {
    if (!ddpChangeModal) return;
    const { po, triggerMs, newDate, newDDP, oldDDP, poMs } = ddpChangeModal;
    setDDPChangeModal(null);
    const poNum = po.PoNumber ?? "";
    // Snapshot entire PO milestone set as one undo batch before any changes.
    pushUndo(poMs);
    // 1. Update the trigger milestone.
    saveMilestone({ ...triggerMs, expected_date: newDate, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
    // 2. Cascade all other milestones from new DDP.
    cascadeFromDDP(poMs, newDDP, triggerMs.id);
    // 3. Persist new DDP.
    await persistDDP(poNum, newDDP);
    // 4. Auto-note on the DDP milestone.
    const ddpMs = poMs.find(m => (m.days_before_ddp ?? 0) === 0) || poMs[poMs.length - 1];
    if (ddpMs) addNote(ddpMs, `DDP changed from ${fmtDate(oldDDP)} to ${fmtDate(newDDP)} — triggered by "${triggerMs.phase}" date change`);
  }, [ddpChangeModal, pushUndo, saveMilestone, user, cascadeFromDDP, persistDDP, addNote]);

  // ── Excel export ────────────────────────────────────────────────────────
  const exportToExcel = async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    // Export every section regardless of which the planner has hidden on
    // screen — a hidden section is a view preference, not a data exclusion.
    const phases = allPhases;
    // Canonical "ATS look" — see src/shared/excelLogo.ts.
    const HDR: any = {
      font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 10, name: "Calibri" },
      fill:      { fgColor: { rgb: "1F497D" }, patternType: "solid" },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: { top: { style: "thin", color: { rgb: "4472C4" } }, bottom: { style: "medium", color: { rgb: "4472C4" } }, left: { style: "thin", color: { rgb: "4472C4" } }, right: { style: "thin", color: { rgb: "4472C4" } } },
    };
    const HDR2: any = { ...HDR, fill: { fgColor: { rgb: "1F497D" }, patternType: "solid" }, font: { ...HDR.font, sz: 9 } };
    const cellBase: any = { font: { sz: 10, name: "Calibri" }, alignment: { vertical: "center" }, border: { top: { style: "thin", color: { rgb: "D0D8E4" } }, bottom: { style: "thin", color: { rgb: "D0D8E4" } }, left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } } };
    const cellAlt: any  = { ...cellBase, fill: { fgColor: { rgb: "EEF3FA" }, patternType: "solid" } };
    const mono = (b: any): any => ({ ...b, font: { ...b.font, name: "Courier New" } });

    const fixedHdrs1 = ["PO #", "Vendor", "Buyer", "Buyer PO", "DDP", "Days from DDP"];
    const subLabels = ["Due Date", "Status", "Status Date", "Days", "Notes"];
    // Lighter-blue (ATS spacer color) separator cell preceding each phase block.
    const SPACER_WCH = 1.8;
    const spacer = (): any => ({ v: "", t: "s", s: { fill: { fgColor: { rgb: "3278CC" }, patternType: "solid" }, border: {} } });

    const row1 = [
      ...fixedHdrs1.map(h => ({ v: h, t: "s", s: HDR })),
      ...phases.flatMap(p => [spacer(), ...[p, "", "", "", ""].map(h => ({ v: h, t: "s", s: HDR }))]),
    ];
    const row2 = [
      ...fixedHdrs1.map(() => ({ v: "", t: "s", s: HDR2 })),
      ...phases.flatMap(() => [spacer(), ...subLabels.map(h => ({ v: h, t: "s", s: HDR2 }))]),
    ];

    const dataRows = rows.map((po, ri) => {
      const base = ri % 2 === 0 ? cellBase : cellAlt;
      const poNum = po.PoNumber ?? "";
      const poMs  = milestones[poNum] || [];
      const phaseMap = new Map<string, Milestone>();
      poMs.forEach(m => phaseMap.set(m.phase, m));
      const ddp    = normDateISO(po.DateExpectedDelivery);
      const days   = ddp ? Math.ceil((new Date(ddp).getTime() - today.getTime()) / 86400000) : null;
      const daysTxt = days === null ? "" : days < 0 ? `${Math.abs(days)} late` : days === 0 ? "Today" : `${days}`;
      const fixed = [
        { v: poNum, t: "s", s: mono(base) }, { v: po.VendorName || "", t: "s", s: base },
        { v: po.BuyerName || "", t: "s", s: base }, { v: po.BuyerPo || "", t: "s", s: mono(base) },
        { v: fmtDate(ddp) || "", t: "s", s: base }, { v: daysTxt, t: "s", s: base },
      ];
      const phaseCells: any[] = [];
      phases.forEach(phase => {
        phaseCells.push(spacer()); // separator preceding each Due Date column
        const m = phaseMap.get(phase);
        if (!m) { for (let i = 0; i < PHASE_COLS; i++) phaseCells.push({ v: "", t: "s", s: base }); return; }
        const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
        const dTxt = m.status === "Complete" ? "Done" : m.status === "N/A" ? "" : daysRem === null ? "" : daysRem < 0 ? `${Math.abs(daysRem)} late` : daysRem === 0 ? "Today" : `${daysRem}`;
        const sdVal = (m.status_dates || {})[m.status] || m.status_date || "";
        const noteCount = (m.note_entries?.length || 0) + (m.notes ? 1 : 0);
        const allNoteText = [
          ...(m.note_entries || []).map(ne => `${ne.date} ${ne.user}: ${ne.text}`),
          ...(m.notes ? [m.notes] : []),
        ].join(" | ");
        phaseCells.push(
          { v: m.expected_date ? fmtDate(m.expected_date) || "" : "", t: "s", s: base },
          { v: m.status, t: "s", s: base },
          { v: sdVal ? fmtDate(sdVal) || "" : "", t: "s", s: base },
          { v: dTxt, t: "s", s: base },
          { v: noteCount > 0 ? allNoteText : "", t: "s", s: base },
        );
      });
      return [...fixed, ...phaseCells];
    });

    // Close the table with a defined rule under the last data row. Skip the
    // separator columns so they stay clean vertical bands (no border).
    const sepIdxs = new Set(phases.map((_, pi) => fixedHdrs1.length + pi * (PHASE_COLS + 1)));
    const BOTTOM_RULE: any = { style: "medium", color: { rgb: "1F497D" } };
    const lastRow = dataRows[dataRows.length - 1];
    if (lastRow) {
      for (let c = 0; c < lastRow.length; c++) {
        if (sepIdxs.has(c)) continue;
        const cell = lastRow[c];
        lastRow[c] = { ...cell, s: { ...cell.s, border: { ...(cell.s?.border || {}), bottom: BOTTOM_RULE } } };
      }
    }

    const aoa = [row1, row2, ...dataRows];
    const fixedWidths = [12, 22, 18, 14, 12, 14];
    const phaseWidths = phases.flatMap(() => [SPACER_WCH, 12, 14, 12, 10, 30]); // leading spacer per phase
    // Phase group-header merges, offset by the leading spacer in each block.
    const merges = phases.map((_, pi) => {
      const start = fixedHdrs1.length + pi * (PHASE_COLS + 1) + 1; // +1 = the leading spacer
      return { s: { r: 0, c: start }, e: { r: 0, c: start + PHASE_COLS - 1 } };
    });
    const wb = newWorkbook();
    renderStyledAoa(wb, "WIP Grid", aoa, {
      banner: { title: "WIP Grid", subtitle: `Production work-in-progress · ${new Date().toISOString().slice(0, 10)}`, cols: aoa[0].length },
      cols: [...fixedWidths, ...phaseWidths],
      rowHeights: [22, 16],
      merges,
      freeze: { xSplit: 6, ySplit: 2 },
    });
    await downloadExcelWorkbook(wb, `WIP_Grid_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // ── Cell styles ─────────────────────────────────────────────────────────
  // Data cells — no borderTop: only borderBottom draws horizontal lines.
  // Having both borderTop and borderBottom doubles up the lines and creates
  // ugly overlaps where they cross the thick phase-divider vertical borders.
  const cell: React.CSSProperties = {
    padding: "4px 7px",
    borderRight:  B_CELL,
    borderBottom: B_CELL,
    overflow: "hidden",
    fontSize: 11,
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
  };

  const hdr1: React.CSSProperties = {
    ...cell,
    background: "#162032",
    color: "#94A3B8",
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderTop:    B_HDR,   // top frame line — only on header
    borderBottom: B_HDR,
    borderRight:  B_HDR,
    whiteSpace: "normal",
    wordBreak: "break-word",
    minHeight: 38,
    alignItems: "center",
  };

  const hdr2: React.CSSProperties = {
    ...cell,
    background: "#111827",
    color: "#4B5563",
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderBottom: B_HDR,
    borderRight:  B_HDR,
    justifyContent: "center",
    minHeight: 24,
    padding: "3px 4px",
  };

  // Phase sub-cells — same base as cell, just smaller font/padding.
  const sub: React.CSSProperties = {
    ...cell,
    fontSize: 10,
    padding: "2px 4px",
  };

  // Left border on first column to close the outer frame.
  const firstCol: React.CSSProperties = { borderLeft: B_CELL };

  // Shared input style for the Named-Range popover fields.
  const rangeInput: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", background: "#0B1220",
    border: "1px solid #334155", borderRadius: 6, color: "#F1F5F9",
    fontSize: 12, padding: "6px 8px", outline: "none",
  };

  const ct    = buildColTpl(phases.length, hiddenCols);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  return (
    <div style={{ maxWidth: "100%", margin: "0 auto", padding: "0 12px" }}>
      <GridScrollbarStyles scope="gv-scroll" trackColor="#0F172A" thumbColor="#334155" thumbHoverColor="#475569" size={12} />
      {/* Sticky-left CSS for the frozen leading columns. nth-child
          targets each row's leading cells in order; CSS Grid keeps
          the cell at its template-driven track position so applying
          position: sticky + a hard-coded left offset pins it.
          Generates only when freezeCount > 0; rendering an empty
          <style> when no freeze is set keeps the DOM clean. The
          background here is a flat panel color — sticky cells don't
          inherit transparent row backgrounds, so without this they'd
          show content from the row scrolling underneath. zIndex=2
          keeps them above non-frozen siblings; zIndex=4 on phase-
          divider overlays already wins where it matters. */}
      {effectiveFreezeCount > 0 && (
        <style>{(() => {
          const rules: string[] = [];
          for (let i = 0; i < effectiveFreezeCount; i++) {
            const left = cellOffsets[i] ?? 0;
            // Data rows: each fixed cell at its cumulative offset, sticky with
            // the panel background so phase cells slide cleanly underneath.
            rules.push(`.gv-grid-row:not(.gv-expanded-row) > :nth-child(${i + 1}) { position: sticky; left: ${left}px; z-index: 2; background: #0F172A; }`);
          }
          // Expanded-detail rows merge cols 1-8 into ONE wide div
          // (gridColumn:"1 / 9"). Only safe to make that merged cell sticky
          // when the freeze covers ALL 8 fixed cols — its width matches the
          // frozen area's width exactly. Otherwise the merged DIV overhangs
          // into the scrolling phase area (the original PR #379 bug).
          // Background is set inline on each merged DIV (varies: infoBg /
          // infoBg2 / rowBg) so the sticky cell doesn't show data behind.
          if (effectiveFreezeCount === 8) {
            // Only the 4 row types whose merged cell is gridColumn:"1 / 9"
            // (info strip, item sub-header, empty state, per-group row) carry
            // gv-expanded-strip. The matrix view spans 1/last-col and is
            // excluded — sticking it at left:0 would prevent the operator
            // from scrolling to the right edge of the matrix.
            rules.push(`.gv-grid-row.gv-expanded-strip > :nth-child(1) { position: sticky; left: 0; z-index: 2; }`);
          }
          return rules.join("\n");
        })()}</style>
      )}

      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div style={{ ...S.filters, flexWrap: "wrap" }}>
        <input
          style={{ ...S.input, flex: 1, minWidth: 240, marginBottom: 0 }}
          placeholder="Search PO#, vendor, buyer, buyer PO…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <SearchableSelect
          value={filterVendor}
          onChange={v => setFilterVendor(v)}
          options={[{ value: "All", label: "All Vendors" }, ...vendors.map(v => ({ value: v, label: v }))]}
          inputStyle={{ ...S.select, width: 200 }}
        />
        <SearchableSelect
          value={filterBuyer}
          onChange={v => setFilterBuyer(v)}
          options={[{ value: "All", label: "All Buyers" }, ...buyerOptions.map(b => ({ value: b, label: b }))]}
          inputStyle={{ ...S.select, width: 200 }}
        />
        <button style={S.btnSecondary} onClick={() => { setSearch(""); setFilterVendor("All"); setFilterBuyer("All"); }}>Clear</button>

        {/* Columns & Sections dropdown — toggle which fixed columns AND which
            milestone sections (Lab Dip, Strike Off, Trim, …) are shown.
            Persisted to localStorage; matches the ATS / Planning toolbar
            pattern. The chevron + notes columns aren't listed because they're
            functional UI, not data. Hiding a section collapses its whole
            phase block out of the grid (export still emits every section). */}
        <div ref={colDropRef} style={{ position: "relative" }}>
          <button
            onClick={() => setColDropOpen(o => !o)}
            title="Show / hide grid columns and milestone sections"
            style={{ ...S.btnSecondary, display: "flex", alignItems: "center", gap: 6 }}
          >
            Columns &amp; Sections
            {(hiddenCols.size + hiddenPhases.size) > 0 && (
              <span style={{ background: "#0EA5E9", color: "#fff", borderRadius: 8, padding: "0 6px", fontSize: 10, fontWeight: 700 }}>
                {hiddenCols.size + hiddenPhases.size}
              </span>
            )}
            <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
          </button>
          {colDropOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: 8, zIndex: 50, minWidth: 220, maxHeight: "70vh", overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "#64748B", padding: "2px 8px 4px" }}>Columns</div>
              {HIDEABLE_COL_KEYS.map((k) => {
                const visible = !hiddenCols.has(k);
                return (
                  <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", cursor: "pointer", borderRadius: 6, color: visible ? "#E5E7EB" : "#6B7280", userSelect: "none" }}>
                    <input type="checkbox" checked={visible} onChange={() => toggleCol(k)} style={{ accentColor: "#10B981", cursor: "pointer" }} />
                    {COL_LABELS[k]}
                  </label>
                );
              })}
              {allPhases.length > 0 && (
                <>
                  <div style={{ borderTop: "1px solid #1E293B", margin: "6px 0" }} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 8px 4px" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "#64748B" }}>Sections</span>
                    <span style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => setHiddenPhases(new Set())}
                        disabled={hiddenPhases.size === 0}
                        style={{ ...S.btnGhost, fontSize: 10, padding: "1px 4px", opacity: hiddenPhases.size === 0 ? 0.4 : 1 }}
                      >All</button>
                      <button
                        onClick={() => setHiddenPhases(new Set(allPhases))}
                        disabled={hiddenPhases.size === allPhases.length}
                        style={{ ...S.btnGhost, fontSize: 10, padding: "1px 4px", opacity: hiddenPhases.size === allPhases.length ? 0.4 : 1 }}
                      >None</button>
                    </span>
                  </div>
                  {allPhases.map((p) => {
                    const visible = !hiddenPhases.has(p);
                    return (
                      <label key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", cursor: "pointer", borderRadius: 6, color: visible ? "#E5E7EB" : "#6B7280", userSelect: "none" }}>
                        <input type="checkbox" checked={visible} onChange={() => togglePhase(p)} style={{ accentColor: "#10B981", cursor: "pointer" }} />
                        {p}
                      </label>
                    );
                  })}
                </>
              )}
              {(hiddenCols.size + hiddenPhases.size) > 0 && (
                <button onClick={() => { setHiddenCols(new Set()); setHiddenPhases(new Set()); }} style={{ ...S.btnGhost, fontSize: 11, marginTop: 6, width: "100%", textAlign: "center" as const }}>
                  Show all
                </button>
              )}
            </div>
          )}
        </div>

        {/* Freeze dropdown — pin leftmost columns through the
            chosen one when scrolling horizontally. */}
        <div title="Pin leftmost columns through the selected one when scrolling horizontally">
          <SearchableSelect
            value={freezeKey ?? ""}
            onChange={(v) => setFreezeKey(v === "" ? null : v as HideableColKey)}
            options={[
              { value: "", label: "No freeze" },
              ...HIDEABLE_COL_KEYS.filter(k => !hiddenCols.has(k)).map((k) => ({ value: k, label: `Freeze through ${COL_LABELS[k]}` })),
            ]}
            inputStyle={{ ...S.select, width: 180 }}
          />
        </div>

        <button
          onClick={handleUndo}
          disabled={undoStack.length === 0}
          title={undoStack.length > 0 ? `Undo last change (${undoStack.length} available)` : "Nothing to undo"}
          style={{ ...S.btnSecondary, opacity: undoStack.length === 0 ? 0.35 : 1, display: "flex", alignItems: "center", gap: 5 }}
        >
          ↩ Undo
        </button>

        <button
          onClick={exportToExcel}
          title="Download as Excel"
          style={{ background: "#217346", border: "1px solid #145A2E", color: "#fff", borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
        >
          Excel
        </button>
      </div>

      {/* ── Create-template modal — shown for the first vendor on the page
           that has no template. Re-evaluates after wipTemplates loads so
           there are no false positives from early async timing. ──────── */}
      {tplModalVendor && (() => {
        const vendorN = tplModalVendor;
        const dismiss = () => setDismissedTplVendors(prev => new Set([...prev, vendorN]));
        return (
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={dismiss}
          >
            <div
              style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, width: "min(500px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ padding: "16px 20px", borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 16, fontWeight: 700 }}>Create Production Template</h2>
                <button onClick={dismiss} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
              </div>
              <div style={{ padding: "16px 20px" }}>
                <p style={{ color: "#D1D5DB", fontSize: 14, marginTop: 0, marginBottom: 16 }}>
                  No production template exists for <strong style={{ color: "#60A5FA" }}>{vendorN}</strong>. Create one to generate milestones for all their POs.
                </p>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ color: "#94A3B8", fontSize: 12, display: "block", marginBottom: 6 }}>Copy from</label>
                  <SearchableSelect
                    value={tplCopyFrom}
                    onChange={v => setTplCopyFrom(v)}
                    options={[{ value: "__default__", label: "Default Template" }, ...templateVendorList().map(v => ({ value: v, label: v }))]}
                    inputStyle={{ ...S.select, width: "100%" }}
                  />
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button style={{ ...S.btnSecondary, flex: 1 }} onClick={dismiss}>Cancel</button>
                  <button style={{ ...S.btnPrimary, flex: 2 }} onClick={async () => {
                    const copyFrom = tplCopyFrom || "__default__";
                    const source = getVendorTemplates(copyFrom === "__default__" ? undefined : copyFrom) || [];
                    const newTpls = source.map((t: WipTemplate) => ({ ...t, id: milestoneUid() }));
                    await saveVendorTemplates(vendorN, newTpls);
                    const vendorPos = pos.filter(p => p.VendorName === vendorN && p.DateExpectedDelivery);
                    // Clear ensureAttempted so the effect can retry any POs that were
                    // blocked waiting for this template to exist.
                    vendorPos.forEach(vpo => ensureAttemptedRef.current.delete(vpo.PoNumber ?? ""));
                    // Generate fresh milestones for POs with none; regenerate POs with partial milestones.
                    const allMs: Milestone[] = [];
                    for (const vpo of vendorPos) {
                      const existing = milestones[vpo.PoNumber ?? ""] || [];
                      if (existing.length === 0) {
                        const ms = generateMilestones(vpo.PoNumber ?? "", vpo.DateExpectedDelivery!, vendorN);
                        allMs.push(...ms);
                      } else {
                        // Has partial milestones — regenerate to pick up new phases.
                        void regenerateMilestones(vpo);
                      }
                    }
                    if (allMs.length > 0) await saveMilestones(allMs);
                    dismiss();
                  }}>
                    Create Template &amp; Generate Milestones
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>

        {/* ── Status bar + pagination ─────────────────────────────────── */}
        <div style={{ padding: "10px 14px", color: "#9CA3AF", fontSize: 13, borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>
            Showing {pageRows.length} of {rows.length} PO{rows.length !== 1 ? "s" : ""} · {phases.length} phase{phases.length !== 1 ? "s" : ""}
            {hiddenPhases.size > 0 && (
              <span style={{ marginLeft: 6, color: "#64748B" }}>({hiddenPhases.size} section{hiddenPhases.size !== 1 ? "s" : ""} hidden)</span>
            )}
            {rangeNotice && (
              <span style={{ marginLeft: 10, color: "#FBBF24", fontWeight: 600 }}>⤢ {rangeNotice}</span>
            )}
          </span>
          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                style={{ ...S.btnSecondary, padding: "3px 10px", fontSize: 11, opacity: page === 0 ? 0.4 : 1 }}>‹ Prev</button>
              <span style={{ color: "#6B7280", fontSize: 11 }}>Page {page + 1} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                style={{ ...S.btnSecondary, padding: "3px 10px", fontSize: 11, opacity: page >= totalPages - 1 ? 0.4 : 1 }}>Next ›</button>
            </div>
          )}
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>No POs match the filters.</div>
        ) : phases.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>
            {allPhases.length > 0
              ? "All sections are hidden — use Columns & Sections ▸ Sections ▸ All to show them."
              : "No milestones generated yet for the visible POs."}
          </div>
        ) : (
          <div ref={tableWrapRef} className="gv-scroll" style={{ overflowX: "scroll", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
            <div style={{ minWidth: "fit-content" }}>

              {/* ── Sticky two-row header ──────────────────────────────── */}
              <div style={{ position: "sticky", top: 0, zIndex: 3 }}>

                {/* Row 1 */}
                <div className="gv-grid-row" style={{ display: "grid", gridTemplateColumns: ct }}>
                  <span style={{ ...hdr1, ...firstCol }} />
                  <span style={{ ...hdr1 }} />
                  {(() => {
                    // Inline sort-header renderer. Returns a clickable
                    // header that shows ▲/▼ when active and toggles
                    // sort key + direction on click. Empty arrow when
                    // inactive so the column stays the same width and
                    // the row doesn't reflow when sort changes.
                    const SortHdr = ({ k, label, justify, boundary }: { k: SortKey; label: string; justify?: "center" | "flex-end"; boundary?: boolean }) => {
                      const active = sortKey === k;
                      const arrow = active ? (sortDir === "asc" ? "▲" : "▼") : "";
                      // Boundary overlay only renders when freeze is active. When active, the
                      // freeze CSS makes this cell position:sticky — that serves as the
                      // positioned ancestor for the absolute overlay. NOT using
                      // phaseDividerHost here — its inline `position: relative` would
                      // override the CSS sticky and break the freeze (see PR #403 hotfix).
                      const showBoundary = !!boundary && effectiveFreezeCount > 0;
                      return (
                        <span
                          onClick={() => onHeaderClick(k)}
                          title="Click to sort — click again to flip direction; third click clears"
                          style={{
                            ...hdr1,
                            ...(justify ? { justifyContent: justify } : {}),
                            ...(showBoundary ? { overflow: "visible" } : {}),
                            cursor: "pointer",
                            userSelect: "none" as const,
                            color: active ? "#C4B5FD" : undefined,
                          }}
                        >
                          {showBoundary && <span style={phaseDividerOverlayBoundary} />}
                          {label}
                          <span style={{ marginLeft: 4, fontSize: 10, opacity: active ? 1 : 0.3 }}>
                            {arrow || "↕"}
                          </span>
                        </span>
                      );
                    };
                    return (
                      <>
                        <SortHdr k="poNum"       label="PO #" />
                        <SortHdr k="vendor"      label="Vendor" />
                        <SortHdr k="buyer"       label="Buyer" />
                        <SortHdr k="buyerPo"     label="Buyer PO" justify="center" />
                        <SortHdr k="ddp"         label="DDP" justify="center" />
                        <SortHdr k="daysFromDdp" label="Days from DDP" justify="flex-end" boundary />
                      </>
                    );
                  })()}
                  {phases.map((p, i) => {
                    const isLastPhase = i === phases.length - 1;
                    return (
                      <span key={p} title={p} style={{
                        ...hdr1,
                        gridColumn: `span ${PHASE_COLS}`,
                        justifyContent: "center",
                        background: "#1A2535",
                        color: "#C4B5FD",
                        borderRight: B_HDR,
                        borderBottom: B_HDR,
                        position: "relative", zIndex: 1, overflow: "visible",
                      }}>
                        {/* Left divider — all phases; top:0 because this is the topmost row */}
                        <span style={{ ...phaseDividerOverlay, top: 0, height: "calc(100% + 2px)" }} />
                        {/* Right closing border on last phase */}
                        {isLastPhase && <span style={{ ...phaseDividerOverlayRight, top: 0, height: "calc(100% + 2px)" }} />}
                        {p}
                      </span>
                    );
                  })}
                </div>

                {/* Row 2 */}
                <div className="gv-grid-row" style={{ display: "grid", gridTemplateColumns: ct }}>
                  {Array.from({ length: 8 }).map((_, i) => {
                    // 8th cell (Days from DDP, i===7) hosts the fixed/phase boundary
                    // divider, but ONLY when freeze is active — see SortHdr comment
                    // above for why we can't use phaseDividerHost (would override the
                    // freeze CSS's position:sticky).
                    const showBoundary = i === 7 && effectiveFreezeCount > 0;
                    // 3rd cell (PO #, i===2) hosts the Named-Range filter button.
                    const isPoCol = i === 2;
                    return (
                      <span key={i} style={{ ...hdr2, ...(i === 0 ? firstCol : {}), ...(showBoundary ? { overflow: "visible" } : {}), ...(isPoCol ? { padding: 2 } : {}) }}>
                        {showBoundary && <span style={phaseDividerOverlayBoundary} />}
                        {isPoCol && (
                          <button
                            onClick={(e) => {
                              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setRangeDraft(rangeFilter ?? { mode: "date", from: "", to: "" });
                              setRangeAnchor(prev => (prev ? null : { x: r.left, y: r.bottom + 4 }));
                            }}
                            title="Filter PO# by a creation-date range or a PO-number range"
                            style={{
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 3,
                              width: "100%", background: rangeFilter ? "#4C1D95" : "transparent",
                              border: rangeFilter ? "1px solid #7C3AED" : "1px dashed #334155",
                              borderRadius: 4, color: rangeFilter ? "#DDD6FE" : "#64748B",
                              fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                              padding: "3px 4px", cursor: "pointer", lineHeight: 1.1,
                            }}
                          >
                            <span style={{ fontSize: 10 }}>⤢</span>
                            {rangeFilter ? "Range •" : "Range"}
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {phases.map((p, pi) => {
                    const isLastPhase = pi === phases.length - 1;
                    return (
                      <React.Fragment key={p}>
                        {/* Left divider on every Due Date sub-label */}
                        <span style={{ ...hdr2, ...phaseDividerHost }}>
                          <span style={phaseDividerOverlay} />
                          Due Date
                        </span>
                        <span style={{ ...hdr2 }}>Status</span>
                        <span style={{ ...hdr2 }}>Status Date</span>
                        <span style={{ ...hdr2 }}>Days</span>
                        {/* Right closing border on last phase Notes sub-label */}
                        <span style={{ ...hdr2, ...(isLastPhase ? phaseDividerHost : {}) }}>
                          {isLastPhase && <span style={phaseDividerOverlayRight} />}
                          Notes
                        </span>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* ── Data rows ─────────────────────────────────────────── */}
              {pageRows.map(po => {
                const poNum    = po.PoNumber ?? "";
                const poMs     = milestones[poNum] || [];
                const phaseMap = new Map<string, Milestone>();
                poMs.forEach(m => phaseMap.set(m.phase, m));

                const ddpRaw  = po.DateExpectedDelivery;
                const ddp     = normDateISO(ddpRaw);
                const days    = ddp ? Math.ceil((new Date(ddp + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
                const daysClr = days === null ? "#6B7280" : days < 0 ? "#EF4444" : days <= 7 ? "#F59E0B" : "#10B981";
                const daysTxt = days === null ? "—" : days < 0 ? `${Math.abs(days)} late` : days === 0 ? "Today" : `${days}`;
                const isEditing      = buyerPoEditing === poNum;
                const isExpanded    = expandedPoNum === poNum;
                const variantNoteCount = poMs.reduce((acc, m) => acc + Object.values(m.variant_notes || {}).reduce((s, arr) => s + arr.length, 0), 0);
                const poNoteCount = poMs.reduce((acc, m) => acc + (m.note_entries?.length || 0) + (m.notes ? 1 : 0), 0);
                const totalNoteCount = poNoteCount + variantNoteCount;
                const hasNotes = totalNoteCount > 0;

                return (
                  <div key={poNum}>
                  <div className="gv-grid-row" style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: isExpanded ? "#0D1929" : undefined }}>

                    {/* Expand */}
                    <span
                      style={{ ...cell, ...firstCol, justifyContent: "center", cursor: "pointer" }}
                      onClick={() => setExpandedPoNum(isExpanded ? null : poNum)}
                      title={isExpanded ? "Collapse" : "Expand line items & milestones"}
                    >
                      <span style={{ fontSize: 16, color: "#F97316", fontWeight: 700, lineHeight: 1 }}>
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </span>

                    {/* Row-level notes — opens all-PO notes + add form.
                         Tooltip preview: latest note text truncated. */}
                    {(() => {
                      const allEntries = [
                        ...poMs.flatMap(m => (m.note_entries || []).map(ne => ({ ...ne, phase: m.phase, variant: "" }))),
                        ...poMs.flatMap(m => Object.entries(m.variant_notes || {}).flatMap(([vk, arr]) => arr.map(ne => ({ ...ne, phase: m.phase, variant: vk })))),
                      ];
                      const latest = allEntries.length > 0 ? allEntries[allEntries.length - 1] : null;
                      const latestText = latest
                        ? `[${latest.phase}${latest.variant ? ` · ${latest.variant}` : ""}] ${latest.text}`
                        : "";
                      const tip = hasNotes
                        ? `${totalNoteCount} note${totalNoteCount !== 1 ? "s" : ""}${latestText ? `\nLatest: ${latestText.slice(0, 120)}` : ""}\n\nClick to view/add`
                        : "Add PO notes";
                      return (
                        <span
                          style={{ ...cell, justifyContent: "center", cursor: "pointer", flexDirection: "column", gap: 1, padding: "2px 4px" }}
                          onClick={() => setNotesModal({ po, ms: poMs })}
                          title={tip}
                        >
                          <span style={{ fontSize: 11, color: hasNotes ? "#60A5FA" : "#374151", lineHeight: 1 }}>Notes</span>
                          {hasNotes && <span style={{ fontSize: 8, fontWeight: 700, color: "#60A5FA", lineHeight: 1 }}>{totalNoteCount}</span>}
                        </span>
                      );
                    })()}

                    {/* PO # — left-click opens full detail; right-click
                         opens a compact matrix popover at the cursor so the
                         planner can sanity-check sizes / qtys without
                         leaving the grid. */}
                    <span
                      onClick={() => { setSelected(po); setDetailMode("milestones"); setView("list"); }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMatrixPopover({ po, x: e.clientX, y: e.clientY });
                      }}
                      style={{ ...cell, color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 12, cursor: "pointer", textDecoration: "underline", whiteSpace: "normal", wordBreak: "break-all" }}
                      title="Click: open full PO detail · Right-click: peek size matrix"
                    >
                      {poNum}
                    </span>

                    {/* Vendor */}
                    <span style={{ ...cell, color: "#D1D5DB", fontWeight: 600, whiteSpace: "normal", wordBreak: "break-word" }} title={po.VendorName || ""}>
                      {po.VendorName || "—"}
                    </span>

                    {/* Buyer — dropdown from all customers + ROF Stock + PT Stock */}
                    <span style={{ ...cell, padding: 2 }}>
                      <SearchableSelect
                        value={po.BuyerName || ""}
                        onChange={v => persistBuyerName(poNum, v)}
                        options={[{ value: "", label: "— unassigned —" }, ...buyerOptions.map(b => ({ value: b, label: b }))]}
                        inputStyle={{ background: "transparent", border: "none", color: po.BuyerName ? "#D1D5DB" : "#4B5563", fontSize: 11, padding: "2px 4px", width: "100%", fontWeight: 600, outline: "none", cursor: "pointer" }}
                      />
                    </span>

                    {/* Buyer PO */}
                    <span
                      style={{ ...cell, justifyContent: "center", cursor: isEditing ? "text" : "pointer", color: po.BuyerPo ? "#60A5FA" : "#4B5563", fontFamily: "monospace", padding: isEditing ? 0 : cell.padding }}
                      onClick={() => { if (!isEditing) { setBuyerPoEditing(poNum); setBuyerPoDraft(po.BuyerPo || ""); } }}
                      title={isEditing ? "" : "Click to edit"}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={buyerPoDraft}
                          onChange={e => setBuyerPoDraft(e.target.value)}
                          onBlur={() => { if (buyerPoEditing === poNum && buyerPoDraft !== (po.BuyerPo || "")) persistBuyerPo(poNum, buyerPoDraft); setBuyerPoEditing(null); }}
                          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); else if (e.key === "Escape") { setBuyerPoDraft(po.BuyerPo || ""); setBuyerPoEditing(null); } }}
                          style={{ width: "100%", height: "100%", background: "#0F172A", border: "1px solid #3B82F6", borderRadius: 0, color: "#F1F5F9", fontSize: 11, padding: "3px 6px", fontFamily: "monospace", boxSizing: "border-box", outline: "none", textAlign: "center" }}
                        />
                      ) : (po.BuyerPo || "—")}
                    </span>

                    {/* DDP — editable; changing cascades all milestone expected_dates.
                        normDateISO converts any Xoro date format to YYYY-MM-DD
                        which MilestoneDateInput requires. */}
                    <span style={{ ...cell, padding: 2, justifyContent: "center" }} title={ddp ? "Click to edit DDP — all phase dates will recalculate" : "Click to set DDP"}>
                      <MilestoneDateInput
                        value={ddp}
                        onCommit={v => { if (v !== ddp) updateDDP(po, v); }}
                        style={{ background: "transparent", border: `1px solid ${modifiedDDPs.has(poNum) ? "#F97316" : "#334155"}`, borderRadius: 3, color: modifiedDDPs.has(poNum) ? "#F97316" : ddp ? "#9CA3AF" : "#374151", fontSize: 11, fontWeight: modifiedDDPs.has(poNum) ? 700 : 400, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer", textAlign: "center" } as React.CSSProperties}
                      />
                    </span>

                    {/* Days from DDP — hosts the fixed/phase boundary divider when
                        freeze is active so it freezes with col 8 (otherwise the phase-1
                        left divider scrolls off). NOT using phaseDividerHost — its
                        position:relative would override the freeze CSS's position:sticky.
                        See SortHdr above for the same pattern. */}
                    {(() => {
                      const showBoundary = effectiveFreezeCount > 0;
                      return (
                        <span style={{ ...cell, justifyContent: "flex-end", color: daysClr, fontWeight: 700, ...(showBoundary ? { overflow: "visible" } : {}) }}>
                          {showBoundary && <span style={phaseDividerOverlayBoundary} />}
                          {daysTxt}
                        </span>
                      );
                    })()}

                    {/* Phase sub-cells */}
                    {phases.map((phase, pi) => {
                      const m = phaseMap.get(phase);

                      const isLastPhase = pi === phases.length - 1;
                      if (!m) {
                        return (
                          <React.Fragment key={phase}>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...phaseDividerHost }}>
                              <span style={phaseDividerOverlay} />
                              —
                            </span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...(isLastPhase ? phaseDividerHost : {}) }}>
                              {isLastPhase && <span style={phaseDividerOverlayRight} />}
                              —
                            </span>
                          </React.Fragment>
                        );
                      }

                      const daysRem = m.expected_date
                        ? Math.ceil((new Date(m.expected_date + "T00:00:00").getTime() - today.getTime()) / 86400000)
                        : null;
                      const dClr = m.status === "Complete" ? "#10B981" : m.status === "N/A" ? "#6B7280"
                        : daysRem === null ? "#6B7280" : daysRem < 0 ? "#EF4444" : daysRem <= 7 ? "#F59E0B" : "#10B981";
                      const dTxt = m.status === "Complete" ? "Done" : m.status === "N/A" ? "—"
                        : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)} late`
                        : daysRem === 0 ? "Today" : `${daysRem}`;
                      const sdVal        = (m.status_dates || {})[m.status] || m.status_date || "";
                      const phaseHasNotes = (m.note_entries && m.note_entries.length > 0) || !!m.notes;
                      const noteCount    = (m.note_entries?.length || 0) + (m.notes ? 1 : 0);

                      return (
                        <React.Fragment key={phase}>
                          {/* Due Date — left divider on every phase, content centered */}
                          <span style={{ ...sub, padding: 2, justifyContent: "center", ...phaseDividerHost }}>
                            <span style={phaseDividerOverlay} />
                            <MilestoneDateInput
                              value={normDateISO(m.expected_date ?? "")}
                              onCommit={v => updateMilestoneDate(po, m, v || null)}
                              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 3, color: "#9CA3AF", fontSize: 10, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer", textAlign: "center" } as React.CSSProperties}
                            />
                          </span>

                          {/* Status */}
                          <span style={{ ...sub, padding: 2 }}>
                            <SearchableSelect
                              value={m.status}
                              onChange={v => updateStatus(po, m, v)}
                              options={MILESTONE_STATUSES.map(s => ({ value: s, label: s }))}
                              inputStyle={{ background: "transparent", border: "none", color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 10, padding: "2px 4px", width: "100%", fontWeight: 600, outline: "none", cursor: "pointer" }}
                            />
                          </span>

                          {/* Status Date */}
                          <span style={{ ...sub, padding: 2 }}>
                            <MilestoneDateInput
                              value={sdVal}
                              onCommit={v => {
                                const val = v || null;
                                const dates = { ...(m.status_dates || {}) };
                                if (val) dates[m.status] = val; else delete dates[m.status];
                                updateField(m, { status_date: val, status_dates: Object.keys(dates).length > 0 ? dates : null });
                              }}
                              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 3, color: sdVal ? "#60A5FA" : "#334155", fontSize: 10, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer" } as React.CSSProperties}
                            />
                          </span>

                          {/* Days */}
                          <span style={{ ...sub, justifyContent: "center", color: dClr, fontWeight: 700 }}>
                            {dTxt}
                          </span>

                          {/* Per-phase notes — right closing border on last phase */}
                          <span
                            style={{ ...sub, justifyContent: "center", cursor: "pointer", padding: 2, ...(isLastPhase ? phaseDividerHost : {}) }}
                            onClick={() => setNotesModal({ po, ms: poMs, filterPhase: phase })}
                            title={phaseHasNotes ? `${noteCount} note${noteCount !== 1 ? "s" : ""} — click to view/add/edit` : `Add note for ${phase}`}
                          >
                            {isLastPhase && <span style={phaseDividerOverlayRight} />}
                            <span style={{ fontSize: 11, color: phaseHasNotes ? "#60A5FA" : "#374151" }}>
                              {phaseHasNotes ? `Notes ${noteCount}` : "Notes"}
                            </span>
                          </span>
                        </React.Fragment>
                      );
                    })}
                  </div>
                  {/* ── Inline expanded detail ── grid-aligned so phase
                       divider lines continue through item rows ─────── */}
                  {isExpanded && (() => {
                    const allItems  = po.Items ?? po.PoLineArr ?? [];
                    const sortedMs  = [...poMs].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
                    const infoBg    = "#06101D";
                    const infoBg2   = "#080F1A";

                    // Build style/color groups (strip trailing size from ItemNumber)
                    const groupMap = new Map<string, { key: string; desc: string; items: typeof allItems }>();
                    allItems.forEach((item, idx) => {
                      const k = styleColorKey(item.ItemNumber || "", item.Description || "", sizeVocab) || `item_${idx}`;
                      if (!groupMap.has(k)) groupMap.set(k, { key: k, desc: item.Description || "", items: [] });
                      groupMap.get(k)!.items.push(item);
                    });
                    const groups = [...groupMap.values()];

                    // Collect all unique detected sizes (for matrix col headers)
                    const sizeSet = new Set<string>();
                    allItems.forEach(it => { const sz = itemSizeLabel(it.ItemNumber || "", sizeVocab); if (sz) sizeSet.add(sz); });
                    const hasSizes   = sizeSet.size > 0;
                    const sortedSizes = [...sizeSet].sort(sizeSort);

                    // Total cost of lines still left to receive
                    // Closed/cancelled lines and fully-received lines contribute $0
                    const remainingCost = allItems.reduce((s, it) => {
                      const qty = isLineClosed(it) ? 0 : (it.QtyRemaining ?? Math.max(0, (it.QtyOrder ?? 0) - (it.QtyReceived ?? 0)));
                      return s + qty * (it.UnitPrice ?? 0);
                    }, 0);
                    const currency = po.CurrencyCode || "USD";

                    // Info fields for PO strip
                    const infoFields = [
                      { label: "Order Date",  val: fmtDate(po.DateOrder) },
                      { label: "Brand",       val: po.BrandName },
                      { label: "Remaining Cost", val: fmtCurrency(remainingCost, currency), highlight: true },
                      { label: "Ship Method", val: po.ShipMethodName },
                      { label: "Carrier",     val: po.CarrierName },
                      { label: "Payment",     val: po.PaymentTermsName },
                      { label: "Tags",        val: po.Tags },
                    ].filter(f => f.val) as { label: string; val: string; highlight?: boolean }[];

                    return (
                      <>
                        {/* ── PO info strip — phase spacers keep dividers alive ── */}
                        <div className="gv-grid-row gv-expanded-row gv-expanded-strip" style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: infoBg }}>
                          {/* minWidth:0 + overflow:hidden so the flex content can't push grid tracks
                              wider than their fixed px widths — keeps the phase-1 left divider aligned
                              with the data rows above/below. Wrapping handles content that doesn't fit. */}
                          <div style={{ gridColumn: "1 / 9", minWidth: 0, overflow: "visible", padding: "8px 14px 10px", display: "flex", gap: 18, alignItems: "center", borderLeft: B_CELL, borderBottom: "1px solid #1E293B", flexWrap: "wrap", background: infoBg, position: "sticky", left: 0, zIndex: 2 }}>
                            {/* Fixed/phase boundary divider — freezes with this sticky cell. */}
                            <span style={phaseDividerOverlayBoundary} />
                            <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{poNum}</span>
                            <span style={{ color: "#9CA3AF", fontSize: 12, fontWeight: 600 }}>{po.VendorName}</span>
                            {po.StatusName && <span style={{ background: "#1E293B", color: "#94A3B8", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{po.StatusName}</span>}
                            {infoFields.map(({ label, val, highlight }) => (
                              <span key={label} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                                <span style={{ color: "#374151", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
                                <span style={{ color: highlight ? "#F59E0B" : "#D1D5DB", fontSize: 11, fontWeight: highlight ? 700 : 400 }}>{val}</span>
                              </span>
                            ))}
                            {po.Memo && (
                              <span style={{ display: "flex", flexDirection: "column", gap: 1, maxWidth: 220 }}>
                                <span style={{ color: "#374151", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Memo</span>
                                <span style={{ color: "#6B7280", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{po.Memo}</span>
                              </span>
                            )}
                            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                              {(["line", "matrix"] as const).map(mode => (
                                <button key={mode} onClick={() => setExpandViewMode(mode)}
                                  style={{ background: expandViewMode === mode ? "#1E3A5F" : "transparent", border: `1px solid ${expandViewMode === mode ? "#3B82F6" : "#334155"}`, color: expandViewMode === mode ? "#93C5FD" : "#4B5563", borderRadius: 5, padding: "2px 10px", fontSize: 10, cursor: "pointer", fontWeight: expandViewMode === mode ? 700 : 400 }}
                                >{mode === "line" ? "By Line" : "Matrix"}</button>
                              ))}
                              <button onClick={() => setExpandedPoNum(null)} style={{ background: "none", border: "none", color: "#374151", fontSize: 14, cursor: "pointer", paddingLeft: 4 }} title="Collapse">✕</button>
                            </div>
                          </div>
                          {phases.map((phase, pi) => {
                            const isLast = pi === phases.length - 1;
                            return (
                              <React.Fragment key={phase}>
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg, ...phaseDividerHost }}><span style={phaseDividerOverlay} /></span>
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg }} />
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg }} />
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg }} />
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg, ...(isLast ? phaseDividerHost : {}) }}>{isLast && <span style={phaseDividerOverlayRight} />}</span>
                              </React.Fragment>
                            );
                          })}
                        </div>

                        {expandViewMode === "line" ? (
                          <>
                            {/* ── Item sub-header ─────────────────────────────── */}
                            <div className="gv-grid-row gv-expanded-row gv-expanded-strip" style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: infoBg2 }}>
                              {/* Fixed area: item key | line status | delivery */}
                              <div style={{ gridColumn: "1 / 9", padding: "3px 14px", borderLeft: B_CELL, borderBottom: B_CELL, display: "grid", gridTemplateColumns: "1fr 90px 80px", alignItems: "center", gap: 8, background: infoBg2, position: "sticky", left: 0, zIndex: 2, overflow: "visible" }}>
                                <span style={phaseDividerOverlayBoundary} />
                                <span style={{ color: "#4B5563", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Style / Color</span>
                                <span style={{ color: "#4B5563", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Line Status</span>
                                <span style={{ color: "#4B5563", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Delivery</span>
                              </div>
                              {phases.map((phase, pi) => {
                                const isLast = pi === phases.length - 1;
                                return (
                                  <React.Fragment key={phase}>
                                    <span style={{ ...hdr2, background: infoBg2, ...phaseDividerHost }}><span style={phaseDividerOverlay} />Due Date</span>
                                    <span style={{ ...hdr2, background: infoBg2 }}>Status</span>
                                    <span style={{ ...hdr2, background: infoBg2 }}>Status Date</span>
                                    <span style={{ ...hdr2, background: infoBg2 }}>Days</span>
                                    <span style={{ ...hdr2, background: infoBg2, ...(isLast ? phaseDividerHost : {}) }}>
                                      {isLast && <span style={phaseDividerOverlayRight} />}Notes
                                    </span>
                                  </React.Fragment>
                                );
                              })}
                            </div>

                            {/* ── One row per style/color group ──────────────── */}
                            {groups.length === 0 ? (
                              <div className="gv-grid-row gv-expanded-row gv-expanded-strip" style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: infoBg }}>
                                <div style={{ gridColumn: "1 / 9", padding: "8px 14px", borderLeft: B_CELL, borderBottom: B_CELL, color: "#374151", fontSize: 11, background: infoBg, position: "sticky", left: 0, zIndex: 2, overflow: "visible" }}>
                                  <span style={phaseDividerOverlayBoundary} />
                                  No line items on this PO.
                                </div>
                                {phases.map((phase, pi) => { const isLast = pi === phases.length - 1; return (
                                  <React.Fragment key={phase}>
                                    <span style={{ borderBottom: B_CELL, background: infoBg, ...phaseDividerHost }}><span style={phaseDividerOverlay} /></span>
                                    <span style={{ borderBottom: B_CELL, background: infoBg }} /><span style={{ borderBottom: B_CELL, background: infoBg }} /><span style={{ borderBottom: B_CELL, background: infoBg }} />
                                    <span style={{ borderBottom: B_CELL, background: infoBg, ...(isLast ? phaseDividerHost : {}) }}>{isLast && <span style={phaseDividerOverlayRight} />}</span>
                                  </React.Fragment>
                                ); })}
                              </div>
                            ) : groups.map((group, gIdx) => {
                              const groupItems = group.items;
                              const varKey   = group.key; // used as variant_statuses key
                              const closed   = groupItems.every(it => isLineClosed(it));
                              const rowBg    = gIdx % 2 === 0 ? infoBg : infoBg2;
                              const totalQty = groupItems.reduce((s, it) => s + (it.QtyOrder ?? 0), 0);

                              // Aggregate line status from Xoro items
                              const lineStatuses = [...new Set(groupItems.map(it => it.StatusName || "").filter(Boolean))];
                              const lineStatus   = lineStatuses.length === 1 ? lineStatuses[0] : lineStatuses.length > 1 ? "Mixed" : "—";
                              const lineStColor  = closed ? "#EF4444" : lineStatus === "Mixed" ? "#F59E0B" : lineStatus === "—" ? "#374151" : "#10B981";

                              // Aggregate delivery date from Xoro items — normalize
                              // to YYYY-MM-DD so comparisons against ddp work.
                              const deliveries = [...new Set(groupItems.map(it => normDateISO(it.DateExpectedDelivery)).filter(Boolean))];
                              const deliveryDisplay = deliveries.length === 0 ? "—" : deliveries.length === 1 ? fmtDate(deliveries[0]) : "Mixed";

                              return (
                                <div key={gIdx} className="gv-grid-row gv-expanded-row gv-expanded-strip" style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: rowBg }}>
                                  {/* Style/color + line status + delivery spanning 8 fixed cols */}
                                  <div style={{ gridColumn: "1 / 9", padding: "3px 14px", borderLeft: B_CELL, borderBottom: B_CELL, display: "grid", gridTemplateColumns: "1fr 90px 80px", alignItems: "center", gap: 8, opacity: closed ? 0.5 : 1, background: rowBg, position: "sticky", left: 0, zIndex: 2, overflow: "visible" }}>
                                    <span style={phaseDividerOverlayBoundary} />
                                    <span>
                                      <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 10 }}>{group.key}</span>
                                      {group.desc && group.desc !== group.key && <span style={{ color: "#4B5563", fontSize: 10, marginLeft: 6 }}>{group.desc}</span>}
                                      <span style={{ color: "#2D3748", fontSize: 9, marginLeft: 8 }}>Qty: {totalQty}</span>
                                    </span>
                                    <span style={{ textAlign: "center", color: lineStColor, fontSize: 10, fontWeight: 600 }}>{lineStatus}</span>
                                    <span style={{ textAlign: "center", color: "#9CA3AF", fontSize: 10 }}>{deliveryDisplay}</span>
                                  </div>
                                  {/* Phase sub-cells using varKey for variant_statuses */}
                                  {phases.map((phase, pi) => {
                                    const m = phaseMap.get(phase);
                                    const isLast = pi === phases.length - 1;
                                    if (!m) {
                                      return (
                                        <React.Fragment key={phase}>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...phaseDividerHost }}><span style={phaseDividerOverlay} />—</span>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...(isLast ? phaseDividerHost : {}) }}>{isLast && <span style={phaseDividerOverlayRight} />}—</span>
                                        </React.Fragment>
                                      );
                                    }
                                    const vs             = m.variant_statuses?.[varKey];
                                    const itemStatus     = vs?.status ?? m.status;
                                    const itemStatusDate = vs?.status_date ?? ((m.status_dates || {})[m.status] || m.status_date || "");
                                    const itemColor      = MILESTONE_STATUS_COLORS[itemStatus] || "#6B7280";
                                    // When a line item has its own delivery date, compute
                                    // phase dates from THAT date instead of the PO header DDP.
                                    const lineDDP = deliveries.length === 1 ? deliveries[0] : "";
                                    const lineExpected = (() => {
                                      if (!lineDDP || lineDDP === ddp) return m.expected_date;
                                      const d = new Date(lineDDP + "T00:00:00");
                                      if (isNaN(d.getTime())) return m.expected_date;
                                      d.setDate(d.getDate() - (m.days_before_ddp ?? 0));
                                      return d.toISOString().slice(0, 10);
                                    })();
                                    const daysRem        = lineExpected ? Math.ceil((new Date(lineExpected + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
                                    const dClr           = itemStatus === "Complete" ? "#10B981" : itemStatus === "N/A" ? "#6B7280" : daysRem === null ? "#6B7280" : daysRem < 0 ? "#EF4444" : daysRem <= 7 ? "#F59E0B" : "#10B981";
                                    const dTxt           = itemStatus === "Complete" ? "Done" : itemStatus === "N/A" ? "—" : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)} late` : daysRem === 0 ? "Today" : `${daysRem}`;
                                    return (
                                      <React.Fragment key={phase}>
                                        <span style={{ ...sub, padding: 2, justifyContent: "center", ...phaseDividerHost }}>
                                          <span style={phaseDividerOverlay} />
                                          <span
                                            style={{ color: lineExpected !== m.expected_date ? "#F59E0B" : "#9CA3AF", fontSize: 10, fontFamily: "monospace", textAlign: "center", width: "100%" }}
                                            title={lineExpected !== m.expected_date ? `Based on line delivery ${fmtDate(lineDDP)} (PO DDP: ${fmtDate(ddp)})` : ""}
                                          >
                                            {lineExpected ? fmtDate(lineExpected) : "—"}
                                          </span>
                                        </span>
                                        <span style={{ ...sub, padding: 2 }}>
                                          <SearchableSelect
                                            value={itemStatus}
                                            onChange={v => {
                                              if (closed) return;
                                              const iso = todayLocalIso();
                                              const vsNew = { ...(m.variant_statuses || {}) };
                                              const prev  = vsNew[varKey];
                                              vsNew[varKey] = { status: v, status_date: v !== "Not Started" ? (prev?.status_date || iso) : null };
                                              saveMilestone({ ...m, variant_statuses: vsNew, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                            }}
                                            disabled={closed}
                                            options={MILESTONE_STATUSES.map(s => ({ value: s, label: s }))}
                                            inputStyle={{ background: "transparent", border: "none", color: closed ? "#374151" : itemColor, fontSize: 10, padding: "2px 4px", width: "100%", fontWeight: 600, outline: "none", cursor: closed ? "default" : "pointer" }}
                                          />
                                        </span>
                                        <span style={{ ...sub, padding: 2 }}>
                                          <MilestoneDateInput
                                            value={itemStatusDate}
                                            onCommit={v => {
                                              const val = v || null;
                                              const vsNew = { ...(m.variant_statuses || {}) };
                                              const prev  = vsNew[varKey];
                                              vsNew[varKey] = { status: prev?.status ?? itemStatus, status_date: val };
                                              saveMilestone({ ...m, variant_statuses: vsNew, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                            }}
                                            style={{ background: "transparent", border: "1px solid #334155", borderRadius: 3, color: itemStatusDate ? "#60A5FA" : "#334155", fontSize: 10, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer" } as React.CSSProperties}
                                          />
                                        </span>
                                        <span style={{ ...sub, justifyContent: "center", color: dClr, fontWeight: 700 }}>{dTxt}</span>
                                        {/* Per-line-item notes — stored in variant_notes[varKey] */}
                                        {(() => {
                                          const vnEntries = m.variant_notes?.[varKey] || [];
                                          const vnCount = vnEntries.length;
                                          const vnHas = vnCount > 0;
                                          return (
                                            <span
                                              style={{ ...sub, justifyContent: "center", cursor: "pointer", padding: 2, ...(isLast ? phaseDividerHost : {}) }}
                                              onClick={() => setNotesModal({ po, ms: poMs, filterPhase: phase, filterVariant: varKey })}
                                              title={vnHas ? `${vnCount} note${vnCount !== 1 ? "s" : ""} for ${varKey} — click to view/add` : `Add note for ${varKey} · ${phase}`}
                                            >
                                              {isLast && <span style={phaseDividerOverlayRight} />}
                                              <span style={{ fontSize: 10, color: vnHas ? "#60A5FA" : "#374151" }}>
                                                {vnHas ? `Notes ${vnCount}` : "Notes"}
                                              </span>
                                            </span>
                                          );
                                        })()}
                                      </React.Fragment>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </>
                        ) : (
                          /* ── MATRIX VIEW — read-only, full size breakdown ── */
                          <div className="gv-grid-row gv-expanded-row" style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: infoBg }}>
                            <div style={{ gridColumn: `1 / ${8 + phases.length * 5 + 1}`, borderLeft: B_CELL, borderBottom: B_CELL, padding: "12px 14px", overflowX: "auto", background: infoBg }}>
                              {allItems.length === 0 ? (
                                <div style={{ color: "#374151", fontSize: 12 }}>No line items on this PO.</div>
                              ) : hasSizes ? (
                                /* Style/Color × Size matrix */
                                <table style={{ borderCollapse: "collapse", fontSize: 10 }}>
                                  <thead>
                                    <tr style={{ background: "#0F172A" }}>
                                      <th style={{ padding: "5px 10px", color: "#94A3B8", fontWeight: 700, textAlign: "left", borderBottom: "2px solid #334155", borderRight: "2px solid #334155", position: "sticky", left: 0, background: "#0F172A", zIndex: 2, minWidth: 180, whiteSpace: "nowrap" }}>Style / Color</th>
                                      {sortedSizes.map(sz => (
                                        <th key={sz} style={{ padding: "4px 8px", color: "#C4B5FD", fontWeight: 700, textAlign: "center", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 90, fontSize: 10, whiteSpace: "nowrap" }}>{sz}</th>
                                      ))}
                                      <th style={{ padding: "4px 8px", color: "#10B981", fontWeight: 700, textAlign: "center", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 90, whiteSpace: "nowrap" }}>Line Status</th>
                                      <th style={{ padding: "4px 8px", color: "#94A3B8", fontWeight: 700, textAlign: "center", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 60 }}>Total Qty</th>
                                      <th style={{ padding: "4px 8px", color: "#94A3B8", fontWeight: 700, textAlign: "center", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 80, whiteSpace: "nowrap" }}>Delivery</th>
                                      <th style={{ padding: "4px 8px", color: "#F59E0B", fontWeight: 700, textAlign: "right", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 70, whiteSpace: "nowrap" }}>Unit Cost</th>
                                      <th style={{ padding: "4px 8px", color: "#F59E0B", fontWeight: 700, textAlign: "right", borderBottom: "2px solid #334155", minWidth: 90, whiteSpace: "nowrap" }}>Total Cost</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {groups.map((group, gIdx) => {
                                      const rowBg = gIdx % 2 === 0 ? "#080F1A" : "#060C16";
                                      const closed = group.items.every(it => isLineClosed(it));
                                      const totalQty = group.items.reduce((s, it) => s + (it.QtyOrder ?? 0), 0);
                                      // Map size → item
                                      const sizeMap = new Map<string, typeof allItems[0]>();
                                      group.items.forEach(it => { const sz = itemSizeLabel(it.ItemNumber || "", sizeVocab); if (sz) sizeMap.set(sz, it); });
                                      // Delivery date
                                      const delivs = [...new Set(group.items.map(it => normDateISO(it.DateExpectedDelivery)).filter(Boolean))];
                                      const delivDisplay = delivs.length === 0 ? "—" : delivs.length === 1 ? fmtDate(delivs[0]) : "Mixed";
                                      return (
                                        <tr key={gIdx} style={{ background: rowBg }}>
                                          <td style={{ padding: "5px 10px", borderRight: "2px solid #334155", borderBottom: "1px solid #1E293B", position: "sticky", left: 0, background: rowBg, zIndex: 1 }}>
                                            <div style={{ color: closed ? "#374151" : "#D1D5DB", fontWeight: 600, fontSize: 11 }}>{group.desc || group.key}</div>
                                            <div style={{ color: "#2D3748", fontSize: 9, fontFamily: "monospace" }}>{group.key !== group.desc ? group.key : ""}</div>
                                          </td>
                                          {sortedSizes.map(sz => {
                                            const it = sizeMap.get(sz);
                                            if (!it) return <td key={sz} style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center", color: "#1E293B" }}>—</td>;
                                            return (
                                              <td key={sz} style={{ padding: "4px 6px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center" }}>
                                                <div style={{ color: "#9CA3AF", fontWeight: 700, fontSize: 11 }}>{it.QtyOrder ?? "—"}</div>
                                              </td>
                                            );
                                          })}
                                          {(() => {
                                            const statuses = [...new Set(group.items.map(it => it.StatusName || "").filter(Boolean))];
                                            const lineStatus = statuses.length === 0 ? "—" : statuses.length === 1 ? statuses[0] : "Mixed";
                                            const lineStColor = closed ? "#374151" : lineStatus === "Closed" || lineStatus === "Cancelled" ? "#EF4444" : lineStatus === "Mixed" ? "#F59E0B" : "#10B981";
                                            const activeItems = group.items.filter(it => !isLineClosed(it));
                                            const prices = [...new Set(activeItems.map(it => it.UnitPrice ?? 0))];
                                            const currency = po.CurrencyCode || "USD";
                                            const unitCostDisplay = activeItems.length === 0 ? "—" : prices.length === 1 ? fmtCurrency(prices[0], currency) : "Mixed";
                                            const totalCost = activeItems.reduce((s, it) => s + (it.QtyOrder ?? 0) * (it.UnitPrice ?? 0), 0);
                                            const totalCostDisplay = activeItems.length === 0 ? "—" : fmtCurrency(totalCost, currency);
                                            return (
                                              <>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center", color: lineStColor, fontWeight: 600, fontSize: 10 }}>{lineStatus}</td>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center", color: "#9CA3AF", fontWeight: 700 }}>{totalQty}</td>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center", color: "#9CA3AF", fontSize: 10 }}>{delivDisplay}</td>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "right", color: closed ? "#374151" : "#F59E0B", fontSize: 10 }}>{unitCostDisplay}</td>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", textAlign: "right", color: closed ? "#374151" : "#F59E0B", fontWeight: 700, fontSize: 10 }}>{totalCostDisplay}</td>
                                              </>
                                            );
                                          })()}
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              ) : (
                                /* No sizes detected — flat item list with status + delivery */
                                <table style={{ borderCollapse: "collapse", fontSize: 10, width: "100%" }}>
                                  <thead>
                                    <tr style={{ background: "#0F172A" }}>
                                      {["Item #", "Description", "Qty Ordered", "Qty Received", "Qty Remaining", "Line Status", "Delivery Date"].map(h => (
                                        <th key={h} style={{ padding: "5px 8px", color: "#6B7280", fontWeight: 700, textAlign: "left", borderBottom: "2px solid #1E293B", whiteSpace: "nowrap" }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {allItems.map((item, idx) => {
                                      const itClosed = isLineClosed(item);
                                      const stColor  = itClosed ? "#EF4444" : "#10B981";
                                      return (
                                        <tr key={idx} style={{ background: idx % 2 === 0 ? "#080F1A" : "#060C16", borderBottom: "1px solid #0D1929" }}>
                                          <td style={{ padding: "4px 8px", color: "#60A5FA", fontFamily: "monospace", opacity: itClosed ? 0.4 : 1 }}>{item.ItemNumber || "—"}</td>
                                          <td style={{ padding: "4px 8px", color: "#D1D5DB", opacity: itClosed ? 0.4 : 1 }}>{item.Description || "—"}</td>
                                          <td style={{ padding: "4px 8px", color: "#9CA3AF", textAlign: "right" }}>{item.QtyOrder ?? "—"}</td>
                                          <td style={{ padding: "4px 8px", color: (item.QtyReceived ?? 0) > 0 ? "#10B981" : "#4B5563", textAlign: "right" }}>{item.QtyReceived ?? 0}</td>
                                          <td style={{ padding: "4px 8px", color: "#9CA3AF", textAlign: "right" }}>{item.QtyRemaining ?? "—"}</td>
                                          <td style={{ padding: "4px 8px", color: stColor, fontWeight: 600 }}>{item.StatusName || "—"}</td>
                                          <td style={{ padding: "4px 8px", color: "#9CA3AF" }}>{fmtDate(item.DateExpectedDelivery) || "—"}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── DDP change confirmation modal ────────────────────────────────── */}
      {ddpChangeModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1010, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setDDPChangeModal(null)}
        >
          <div
            style={{ background: "#0F172A", border: "1px solid #F97316", borderRadius: 10, width: "min(460px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, color: "#F97316", fontSize: 15, fontWeight: 700 }}>DDP Date Will Change</h2>
              <button onClick={() => setDDPChangeModal(null)} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ padding: "16px 20px" }}>
              <p style={{ color: "#D1D5DB", fontSize: 13, margin: "0 0 12px" }}>
                Changing <strong style={{ color: "#C4B5FD" }}>{ddpChangeModal.triggerMs.phase}</strong> date
                will shift the DDP from{" "}
                <strong style={{ color: "#9CA3AF" }}>{fmtDate(ddpChangeModal.oldDDP)}</strong> to{" "}
                <strong style={{ color: "#F97316" }}>{fmtDate(ddpChangeModal.newDDP)}</strong>.
              </p>
              <p style={{ color: "#6B7280", fontSize: 12, margin: "0 0 16px" }}>
                All other phase dates will recalculate from the new DDP. A note will be added automatically.
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  style={{ ...S.btnSecondary, flex: 1 }}
                  onClick={() => setDDPChangeModal(null)}
                >
                  Cancel — keep original dates
                </button>
                <button
                  style={{ background: "#F97316", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, padding: "10px 16px", cursor: "pointer", flex: 2 }}
                  onClick={handleDDPConfirm}
                >
                  Accept — update DDP &amp; all phases
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Named-range filter popover (PO# column) ───────────────────────── */}
      {rangeAnchor && (
        <>
          {/* Click-away scrim */}
          <div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setRangeAnchor(null)} />
          <div
            style={{
              position: "fixed",
              left: Math.max(8, Math.min(rangeAnchor.x, window.innerWidth - 296)),
              top: rangeAnchor.y,
              zIndex: 1000, width: 288, boxSizing: "border-box",
              background: "#0F172A", border: "1px solid #334155", borderRadius: 10,
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)", padding: 14,
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#E5E7EB" }}>Named Range — PO #</span>
              <button onClick={() => setRangeAnchor(null)} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 16, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>

            {/* Mode toggle */}
            <div style={{ display: "flex", marginBottom: 12, border: "1px solid #334155", borderRadius: 8, overflow: "hidden" }}>
              {(["date", "po"] as RangeMode[]).map(mode => {
                const on = rangeDraft.mode === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => setRangeDraft(d => ({ ...d, mode, from: "", to: "" }))}
                    style={{ flex: 1, padding: "7px 4px", background: on ? "#4C1D95" : "transparent", color: on ? "#DDD6FE" : "#94A3B8", border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                  >
                    {mode === "date" ? "By Date" : "By PO #"}
                  </button>
                );
              })}
            </div>

            <div style={{ fontSize: 10, color: "#64748B", marginBottom: 10, lineHeight: 1.4 }}>
              {rangeDraft.mode === "date"
                ? "PO creation date (Order date). Leave “To” blank for that date or newer."
                : "Last 6 digits of the PO number. Leave “To” blank for that number or greater."}
            </div>

            <label style={{ display: "block", fontSize: 10, color: "#94A3B8", marginBottom: 3, fontWeight: 600 }}>From</label>
            {rangeDraft.mode === "date" ? (
              <input type="date" value={rangeDraft.from} onChange={e => setRangeDraft(d => ({ ...d, from: e.target.value }))} style={rangeInput} />
            ) : (
              <input type="number" inputMode="numeric" placeholder="e.g. 1255" value={rangeDraft.from} onChange={e => setRangeDraft(d => ({ ...d, from: e.target.value }))} style={rangeInput} />
            )}

            <label style={{ display: "block", fontSize: 10, color: "#94A3B8", margin: "8px 0 3px", fontWeight: 600 }}>
              To <span style={{ color: "#475569", fontWeight: 400 }}>(optional)</span>
            </label>
            {rangeDraft.mode === "date" ? (
              <input type="date" value={rangeDraft.to} onChange={e => setRangeDraft(d => ({ ...d, to: e.target.value }))} style={rangeInput} />
            ) : (
              <input type="number" inputMode="numeric" placeholder="(no upper limit)" value={rangeDraft.to} onChange={e => setRangeDraft(d => ({ ...d, to: e.target.value }))} style={rangeInput} />
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                onClick={() => { setRangeFilter(null); setRangeAnchor(null); }}
                title="Remove the range and show all POs"
                style={{ ...S.btnSecondary, flex: 1, fontSize: 12, padding: "7px 8px" }}
              >
                Clear
              </button>
              <button
                disabled={!rangeDraft.from}
                onClick={() => {
                  if (!rangeDraft.from) return;
                  // Clear any header sort so the range's own axis ordering applies.
                  setSortKey(null);
                  setRangeFilter({ ...rangeDraft });
                  setRangeAnchor(null);
                }}
                style={{ ...S.btnPrimary, flex: 2, fontSize: 12, padding: "7px 8px", opacity: rangeDraft.from ? 1 : 0.4, cursor: rangeDraft.from ? "pointer" : "not-allowed" }}
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Right-click matrix peek ───────────────────────────────────────── */}
      {matrixPopover && (
        <PoMatrixPopover
          po={matrixPopover.po}
          x={matrixPopover.x}
          y={matrixPopover.y}
          explodePpk={true}
          onClose={() => setMatrixPopover(null)}
        />
      )}

      {/* ── Notes modal ───────────────────────────────────────────────────── */}
      {notesModal && (
        <NotesModal
          key={`${notesModal.po.PoNumber ?? ""}::${notesModal.filterPhase ?? "_all"}::${notesModal.filterVariant ?? "_po"}`}
          po={notesModal.po}
          ms={milestones[notesModal.po.PoNumber ?? ""] || []}
          filterPhase={notesModal.filterPhase}
          filterVariant={notesModal.filterVariant}
          onClose={() => setNotesModal(null)}
          onAddNote={addNote}
          onEditNote={editNote}
          onDeleteNote={deleteNote}
          onAddVariantNote={addVariantNote}
          onEditVariantNote={editVariantNote}
          onDeleteVariantNote={deleteVariantNote}
        />
      )}

    </div>
  );
}
