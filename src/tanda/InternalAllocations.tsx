// src/tanda/InternalAllocations.tsx
//
// P16 / M18 — Allocations Workbench. Standalone cross-SO allocation screen.
// Shows all open SO demand grouped by style/color → SKU (size) → competing SO
// lines, with editable per-line allocation cells (manual add/release) and an
// Auto-allocate run (Priority full-fill: factor-approved → credit-card → oldest)
// that previews the exact size-level result before applying. Availability and the
// hard factor-credit gate are enforced server-side by apply_allocations().

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const numCell: React.CSSProperties = { ...inputStyle, width: "7ch", textAlign: "right", padding: "4px 6px" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };

type Demand = {
  line_id: string; so_id: string; so_number: string | null; order_date: string | null;
  requested_ship_date: string | null; cancel_date: string | null; so_status: string; customer_id: string; customer_name: string | null;
  is_factored: boolean; factor_approval_status: string | null; factor_reference: string | null;
  factor_approved_cents: number | string | null; has_card: boolean; item_id: string; sku_code: string | null;
  color: string | null; size: string | null; description: string | null; qty_ordered: number | string;
  qty_allocated: number | string; qty_shipped: number | string; open_qty: number | string; unit_price_cents: number | string | null;
};
type Avail = { item_id: string; on_hand_qty: number | string; reserved_qty: number | string; available_qty: number | string };
type Customer = { id: string; name: string; customer_code?: string };
type Proposal = {
  line_id: string; so_id: string; so_number: string | null; item_id: string; sku_code: string | null;
  color: string | null; size: string | null; customer_name: string | null; tier: number;
  current_allocated: number; proposed_allocated: number; grant: number; blocked_reason?: string;
};

// Rows are now grouped under a per-SO sub-header (customer · start-ship · cancel),
// so the former per-row Customer / Start-Ship columns are redundant and dropped.
const COLUMNS: ColumnDef[] = [
  { key: "tier",       label: "Priority" },
  { key: "ordered",    label: "Ordered" },
  { key: "allocated",  label: "Allocated" },
  { key: "open",       label: "Open" },
];
const TABLE_KEY = "tangerine:allocations:columns:v2";

const TIER_BADGE: Record<number, { label: string; color: string }> = {
  1: { label: "factor",  color: C.success },
  2: { label: "card",    color: C.primary },
  3: { label: "oldest",   color: C.textSub },
  9: { label: "blocked",  color: C.warn },
};
// Mirror server tierOf() so badges match the auto-allocate result.
function tierOf(d: Demand): number {
  if (d.is_factored) {
    const ok = d.factor_approval_status === "approved" && String(d.factor_reference || "").trim() !== "";
    return ok ? 1 : 9;
  }
  if (d.has_card) return 2;
  return 3;
}
const n = (v: number | string | null | undefined) => Number(v ?? 0);

// One group per sales order. The sub-header carries the SO's customer + dates;
// `lines` are that SO's demand rows (one per size-level SKU still open).
type SoGroup = {
  so_id: string; so_number: string | null; customer_name: string | null;
  requested_ship_date: string | null; cancel_date: string | null; order_date: string | null;
  so_status: string; tier: number; lines: Demand[]; available: number; demand: number;
};

export default function InternalAllocations() {
  const [demand, setDemand] = useState<Demand[]>([]);
  const [avail, setAvail] = useState<Record<string, Avail>>({});
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [onlyShort, setOnlyShort] = useState(false);
  // PART 40 — SO→allocation auto-open. A Sales Order opens Allocations via
  // ?m=sales_allocations&so=<so_number>; seed the search with that SO so the
  // workbench lands pre-filtered to it. Read once on mount.
  const initialSo = useMemo(() => {
    if (typeof window === "undefined") return "";
    try { return (new URLSearchParams(window.location.search).get("so") || "").trim(); } catch { return ""; }
  }, []);
  // Generic drill seed: ?q= (e.g. the Inventory Snapshot's Allocated click →
  // style number) seeds the search WITHOUT the ?so= one-shot SO-focus behavior.
  const initialQ = useMemo(() => {
    if (typeof window === "undefined") return "";
    try { return (new URLSearchParams(window.location.search).get("q") || "").trim(); } catch { return ""; }
  }, []);
  const { value: search, debouncedValue: dSearch, setValue: setSearch } = useDebouncedSearch(initialQ || initialSo, 250);
  const [focusSo] = useState(initialSo);
  // The ?so= deep-link seed is one-shot, not sticky: strip it (and its
  // include_all companion) from the URL on exit so re-opening Allocations from
  // the menu lands with an empty search instead of re-seeding the prior SO #.
  useEffect(() => () => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("so") || url.searchParams.has("so_id") || url.searchParams.has("include_all")) {
        url.searchParams.delete("so"); url.searchParams.delete("so_id"); url.searchParams.delete("include_all");
        window.history.replaceState(window.history.state, "", url.toString());
      }
    } catch { /* noop */ }
  }, []);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingLine, setSavingLine] = useState<string | null>(null);

  // Auto-allocate preview dialog. Strategy chosen at run time (re-previews live).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRows, setPreviewRows] = useState<Proposal[]>([]);
  const [previewScopeLabel, setPreviewScopeLabel] = useState("");
  const [previewItemIds, setPreviewItemIds] = useState<string[]>([]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [strategy, setStrategy] = useState<"priority_full" | "fair_share" | "capped">("priority_full");
  const [capPct, setCapPct] = useState("50");
  const [capBasis, setCapBasis] = useState<"sku" | "style_color">("sku");

  // Undo — every allocation captures the prior allocated qty of the affected
  // lines so the last run (auto / batch / cell) can be reverted in one click.
  const [lastUndo, setLastUndo] = useState<{ label: string; snapshot: { line_id: string; prev_qty: number }[] } | null>(null);
  // Batch select — check lines to set/clear their allocation together.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchQty, setBatchQty] = useState("");
  // Post-allocation summary popup.
  const [summary, setSummary] = useState<{ label: string; count: number; units: number; pctFilled: number; rows: { so: string; sku: string; size: string; granted: number; newAlloc: number }[] } | null>(null);
  const [summaryShowRows, setSummaryShowRows] = useState(false);
  // Configurable allocation priority rules (auto-allocate order + tie-break).
  const ALLOC_DEFAULT_RULES = { priority_order: ["factor_approved", "credit_card", "oldest"], tie_break: "order_date" };
  const [rules, setRules] = useState<{ priority_order: string[]; tie_break: string }>(ALLOC_DEFAULT_RULES);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesDraft, setRulesDraft] = useState<{ priority_order: string[]; tie_break: string }>(ALLOC_DEFAULT_RULES);
  const [rulesSaving, setRulesSaving] = useState(false);

  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(TABLE_KEY, COLUMNS);
  const isVisible = (k: string) => visibleColumns.has(k);

  // Per-SO flow actions (run the whole order without leaving the workbench):
  // Allocate · Ship · Invoice · Wave (3PL). actionBusy gates a single SO at a time.
  const [actionBusy, setActionBusy] = useState<string | null>(null); // so_id in flight
  const [tplProviders, setTplProviders] = useState<{ id: string; name: string; code?: string | null }[]>([]);
  useEffect(() => {
    fetch("/api/internal/tpl-providers").then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (Array.isArray(j?.providers)) setTplProviders(j.providers.filter((p: { is_active?: boolean }) => p.is_active !== false));
    }).catch(() => {});
  }, []);
  // Carriers for the Ship modal — sourced from the Carrier Master (#1032).
  const [carriers, setCarriers] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => {
    fetch("/api/internal/carriers").then((r) => (r.ok ? r.json() : [])).then((d) => {
      if (Array.isArray(d)) setCarriers(d);
    }).catch(() => {});
  }, []);

  // Ship modal — carrier / service / tracking / date for the SO in scope.
  const [shipFor, setShipFor] = useState<SoGroup | null>(null);
  const [shipCarrier, setShipCarrier] = useState("");
  const [shipService, setShipService] = useState("");
  const [shipTracking, setShipTracking] = useState("");
  const [shipDate, setShipDate] = useState(new Date().toISOString().slice(0, 10));
  // Wave modal — pick a 3PL provider, POST the (parallel-built) wave endpoint.
  const [waveFor, setWaveFor] = useState<SoGroup | null>(null);
  const [waveProviderId, setWaveProviderId] = useState("");

  async function allocateSo(g: SoGroup) {
    if (!g.so_id) return;
    setActionBusy(g.so_id);
    try {
      const r = await fetch(`/api/internal/sales-orders/${g.so_id}/allocate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { notify(j.error || `HTTP ${r.status}`, "error"); return; }
      notify(j.message || "Allocation run complete.", j.fully_allocated ? "success" : "info");
      await load();
    } finally { setActionBusy(null); }
  }
  function openShip(g: SoGroup) { setShipFor(g); setShipCarrier(""); setShipService(""); setShipTracking(""); setShipDate(new Date().toISOString().slice(0, 10)); }
  async function shipSo() {
    const g = shipFor; if (!g?.so_id) return;
    setActionBusy(g.so_id);
    try {
      const r = await fetch(`/api/internal/sales-orders/${g.so_id}/ship`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carrier: shipCarrier.trim() || null, service_level: shipService.trim() || null, tracking_number: shipTracking.trim() || null, ship_date: shipDate }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { notify(j.error || `HTTP ${r.status}`, "error"); return; }
      notify(j.message || "Shipment recorded.", j.sales_order_status === "shipped" ? "success" : "info");
      setShipFor(null); await load();
    } finally { setActionBusy(null); }
  }
  async function invoiceSo(g: SoGroup) {
    if (!g.so_id) return;
    setActionBusy(g.so_id);
    try {
      const r = await fetch(`/api/internal/sales-orders/${g.so_id}/create-invoice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { notify(j.error || `HTTP ${r.status}`, "error"); return; }
      notify(j.message || (j.invoice_number ? `Draft AR invoice ${j.invoice_number} created.` : "Draft invoice created."), "success");
      await load();
    } finally { setActionBusy(null); }
  }
  function openWave(g: SoGroup) { setWaveFor(g); setWaveProviderId(tplProviders[0]?.id || ""); }
  async function waveSo() {
    const g = waveFor; if (!g?.so_id) return;
    if (!waveProviderId) { notify("Pick a 3PL provider to wave this order.", "error"); return; }
    setActionBusy(g.so_id);
    try {
      const r = await fetch(`/api/internal/sales-orders/${g.so_id}/wave`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tpl_provider_id: waveProviderId, actor_user_id: null }),
      });
      if (r.status === 404) { notify("Wave endpoint not yet available — try again shortly (deploy in progress).", "info"); setWaveFor(null); return; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { notify(j.error || `HTTP ${r.status}`, "error"); return; }
      const msg = j.message || (j.transmitted ? "Waved to 3PL — EDI 940 transmitted." : "Waved to 3PL (940 queued).");
      notify(msg, "success");
      setWaveFor(null); await load();
    } finally { setActionBusy(null); }
  }

  async function load() {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (customerId) p.set("customer_id", customerId);
      if (onlyShort) p.set("only_short", "1");
      // Show-all-rows: when focused on a single SO (opened from Sales Orders and
      // the search still equals that SO #), ask the server for ALL of that SO's
      // lines — including shipped / invoiced ones the demand view hides — so the
      // operator sees the complete order, not just open-qty rows. Otherwise the
      // search term is a normal multi-field filter (q).
      const focused = !!focusSo && dSearch.trim() === focusSo;
      if (focused) { p.set("so", focusSo); p.set("include_all", "1"); }
      else if (dSearch.trim()) p.set("q", dSearch.trim());
      const r = await fetch(`/api/internal/allocations?${p.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const j = await r.json() as { demand: Demand[]; availability: Avail[] };
      setDemand(Array.isArray(j.demand) ? j.demand : []);
      const m: Record<string, Avail> = {};
      for (const a of j.availability || []) m[a.item_id] = a;
      setAvail(m);
      setEdits({});
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [customerId, onlyShort, dSearch]);

  // Load the saved priority rules once.
  useEffect(() => {
    fetch("/api/internal/allocations/rules").then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (j?.priority_order && j?.tie_break) setRules({ priority_order: j.priority_order, tie_break: j.tie_break });
    }).catch(() => {});
  }, []);
  function openRules() { setRulesDraft({ priority_order: [...rules.priority_order], tie_break: rules.tie_break }); setRulesOpen(true); }
  function moveCriterion(i: number, dir: -1 | 1) {
    setRulesDraft((p) => {
      const order = [...p.priority_order]; const j = i + dir;
      if (j < 0 || j >= order.length) return p;
      [order[i], order[j]] = [order[j], order[i]];
      return { ...p, priority_order: order };
    });
  }
  async function saveRules() {
    setRulesSaving(true);
    try {
      const r = await fetch("/api/internal/allocations/rules", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rulesDraft) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { notify(j.error || `HTTP ${r.status}`, "error"); return; }
      setRules({ priority_order: j.priority_order, tie_break: j.tie_break });
      setRulesOpen(false);
      notify("Allocation priority rules saved. Re-run auto-allocate to apply.", "success");
    } finally { setRulesSaving(false); }
  }
  const CRITERION_LABEL: Record<string, string> = { factor_approved: "Factor-approved", credit_card: "Credit-card on file", oldest: "Oldest (by date) — everyone else" };
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=1000").then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setCustomers(a as Customer[]); }).catch(() => {});
  }, []);

  // Build the SO → lines tree. One group per sales order; its demand rows are
  // listed under a single sub-header (customer · start-ship · cancel).
  const soGroups = useMemo<SoGroup[]>(() => {
    const bySo = new Map<string, SoGroup>();
    for (const d of demand) {
      let g = bySo_get(bySo, d);
      g.lines.push(d);
      g.demand += n(d.open_qty);
    }
    // Available stock is per item_id (size SKU); count each item once per SO so a
    // SO spanning multiple lines of the same SKU doesn't double-count availability.
    for (const g of bySo.values()) {
      const seen = new Set<string>();
      for (const d of g.lines) {
        if (d.item_id && !seen.has(d.item_id)) { seen.add(d.item_id); g.available += n(avail[d.item_id]?.available_qty); }
      }
      // Sort each SO's lines by style/color then size for a stable read.
      g.lines.sort((a, b) =>
        String(a.description || "").localeCompare(String(b.description || "")) ||
        String(a.color || "").localeCompare(String(b.color || "")) ||
        String(a.size || "").localeCompare(String(b.size || "")));
    }
    // Order SOs by priority tier, then earliest requested-ship, then SO number.
    return [...bySo.values()].sort((a, b) =>
      a.tier - b.tier ||
      String(a.requested_ship_date || "9999").localeCompare(String(b.requested_ship_date || "9999")) ||
      String(a.so_number || "~").localeCompare(String(b.so_number || "~")));
  }, [demand, avail]);

  const demandByLine = useMemo(() => new Map(demand.map((d) => [d.line_id, d])), [demand]);

  // Apply allocations (set allocated qty per line). When trackUndo, snapshot the
  // PRIOR allocated qty of each touched line so "↩ Undo" can revert the run.
  async function applyAllocations(allocations: { line_id: string; qty: number }[], label = "Allocation", trackUndo = true): Promise<boolean> {
    const snapshot = allocations.map((a) => ({ line_id: a.line_id, prev_qty: n(demandByLine.get(a.line_id)?.qty_allocated) }));
    const r = await fetch("/api/internal/allocations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allocations }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { notify(j.error || `HTTP ${r.status}`, "error"); return false; }
    if (trackUndo && snapshot.length) setLastUndo({ label, snapshot });
    const skipped = Array.isArray(j.skipped) ? j.skipped : [];
    if (skipped.length) notify(`${j.message} ${skipped.map((s: { reason: string }) => s.reason).join("; ")}`, "info");
    else notify(j.message || "Allocated.", "success");
    return true;
  }

  // Revert the last allocation run to the snapshotted prior quantities.
  async function undoLast() {
    if (!lastUndo) return;
    const ok = await confirmDialog(`Undo "${lastUndo.label}"? This restores ${lastUndo.snapshot.length} line(s) to their previous allocated quantity.`, { confirmText: "Undo", icon: "↩" });
    if (!ok) return;
    if (await applyAllocations(lastUndo.snapshot.map((s) => ({ line_id: s.line_id, qty: s.prev_qty })), "undo", false)) {
      setLastUndo(null); setSummary(null); await load();
    }
  }

  // Batch — set/clear the allocation on every checked line.
  function toggleSelect(lineId: string) { setSelected((p) => { const c = new Set(p); if (c.has(lineId)) c.delete(lineId); else c.add(lineId); return c; }); }
  function selectAllVisible() { setSelected(new Set(demand.map((d) => d.line_id))); }
  async function batchApply(qty: number) {
    const ids = [...selected];
    if (ids.length === 0) return;
    const ok = await confirmDialog(`Set allocated = ${qty} on ${ids.length} selected line(s)? (Cannot drop below already-shipped qty.)`, { confirmText: "Apply", icon: "" });
    if (!ok) return;
    if (await applyAllocations(ids.map((id) => ({ line_id: id, qty })), `batch set ${qty} (${ids.length} lines)`)) {
      setSelected(new Set()); setBatchQty(""); await load();
    }
  }

  async function commitCell(d: Demand) {
    const raw = edits[d.line_id];
    if (raw == null) return;
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty < 0) { notify("Allocation must be a number ≥ 0.", "error"); return; }
    if (qty === n(d.qty_allocated)) { setEdits((p) => { const c = { ...p }; delete c[d.line_id]; return c; }); return; }
    setSavingLine(d.line_id);
    try { if (await applyAllocations([{ line_id: d.line_id, qty }])) await load(); }
    finally { setSavingLine(null); }
  }

  // Open the dialog for a scope; the live preview is (re)fetched by the effect
  // below whenever the scope or chosen strategy/cap changes.
  function runAutoAllocate(itemIds: string[], scopeLabel: string) {
    setPreviewItemIds(itemIds); setPreviewScopeLabel(scopeLabel); setPreviewRows([]); setPreviewOpen(true);
  }
  async function fetchPreview() {
    setPreviewBusy(true);
    try {
      const payload: Record<string, unknown> = { strategy, item_ids: previewItemIds };
      if (strategy === "capped") { payload.cap_pct = Number(capPct) || 0; payload.cap_basis = capBasis; }
      const r = await fetch("/api/internal/allocations/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { notify(j.error || `HTTP ${r.status}`, "error"); setPreviewRows([]); return; }
      setPreviewRows((Array.isArray(j.proposals) ? j.proposals : []) as Proposal[]);
    } finally { setPreviewBusy(false); }
  }
  useEffect(() => {
    if (!previewOpen) return;
    if (strategy === "capped" && (!(Number(capPct) > 0) || Number(capPct) > 100)) { setPreviewRows([]); return; } // wait for a valid %
    void fetchPreview();
    /* eslint-disable-next-line */
  }, [previewOpen, previewItemIds, strategy, capPct, capBasis]);

  async function applyPreview() {
    const granted = previewRows.filter((p) => p.grant > 0);
    const allocations = granted.map((p) => ({ line_id: p.line_id, qty: p.proposed_allocated }));
    if (allocations.length === 0) { setPreviewOpen(false); return; }
    const ok = await confirmDialog(`Apply ${allocations.length} allocation(s) for ${previewScopeLabel}?`, { confirmText: "Apply", icon: "" });
    if (!ok) return;
    setPreviewBusy(true);
    try {
      if (await applyAllocations(allocations, `auto-allocate (${previewScopeLabel})`)) {
        // Build the post-allocation summary popup (rows + % of open demand filled).
        const units = granted.reduce((s, p) => s + p.grant, 0);
        const openTotal = previewRows.reduce((s, p) => s + n(demandByLine.get(p.line_id)?.open_qty), 0);
        const pctFilled = openTotal > 0 ? Math.round((units / openTotal) * 100) : 0;
        const rows = granted.map((p) => ({ so: p.so_number || "(draft)", sku: p.sku_code || "—", size: p.size || "—", granted: p.grant, newAlloc: p.proposed_allocated }));
        setPreviewOpen(false);
        setSummaryShowRows(false);
        setSummary({ label: previewScopeLabel, count: granted.length, units, pctFilled, rows });
        await load();
      }
    } finally { setPreviewBusy(false); }
  }

  const exportRows = useMemo(() => {
    const body = demand.map((d) => ({
      so_number: d.so_number || "(draft)", customer: d.customer_name || d.customer_id,
      style: d.description || "", color: d.color || "", size: d.size || "", sku_code: d.sku_code || "",
      priority: TIER_BADGE[tierOf(d)].label, start_ship: d.requested_ship_date || "", cancel: d.cancel_date || "",
      ordered: n(d.qty_ordered), allocated: n(d.qty_allocated), open: n(d.open_qty),
      available: n(avail[d.item_id]?.available_qty),
    }));
    // #23 — append a TOTAL footer row summing the numeric qty columns so the
    // spreadsheet carries the same totals an operator reads off the grid.
    if (body.length) {
      body.push({
        so_number: "TOTAL", customer: "", style: "", color: "", size: "", sku_code: "",
        priority: "", start_ship: "", cancel: "",
        ordered: body.reduce((s, r) => s + r.ordered, 0),
        allocated: body.reduce((s, r) => s + r.allocated, 0),
        open: body.reduce((s, r) => s + r.open, 0),
        available: body.reduce((s, r) => s + r.available, 0),
      });
    }
    return body;
  }, [demand, avail]);

  // First column is the SKU·Size descriptor (always shown); the rest follow COLUMNS.
  const colSpan = 1 + ["tier", "ordered", "allocated", "open"].filter(isVisible).length;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Allocations</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={btnSecondary} onClick={openRules} title="Set the auto-allocate priority order (factor / card / oldest) + tie-break">Rules</button>
          {lastUndo && (
            <button style={{ ...btnSecondary, color: C.warn, borderColor: C.warn }} disabled={previewBusy} onClick={() => void undoLast()}
              title={`Revert: ${lastUndo.label}`}>Undo last</button>
          )}
          <button style={{ ...btnPrimary, background: C.violet }} disabled={previewBusy || loading || demand.length === 0}
            onClick={() => void runAutoAllocate([], "all visible demand")} title="Preview, choose the rule (priority / fair-share / capped %), then apply — across all visible demand">
            {previewBusy ? "…" : "Auto-allocate all"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ width: 240 }}>
          <SearchableSelect value={customerId || null} onChange={(v) => setCustomerId(v || "")}
            options={[{ value: "", label: "All customers" }, ...customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))]}
            placeholder="All customers" />
        </div>
        <DynamicSearchInput value={search} onChange={setSearch} placeholder="Search style / SKU / color / size / customer / SO #" ariaLabel="Search allocations" wrapperStyle={{ maxWidth: 300 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={onlyShort} onChange={(e) => setOnlyShort(e.target.checked)} /> Only with open qty
        </label>
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <div style={{ flex: 1 }} />
        <TablePrefsButton tableKey={TABLE_KEY} columns={COLUMNS} visibleColumns={visibleColumns} onToggle={toggleColumn} onReset={resetToDefault} />
        <ExportButton rows={exportRows as unknown as Array<Record<string, unknown>>} filename="allocations" sheetName="Allocations"
          columns={[
            { key: "so_number", header: "SO #" }, { key: "customer", header: "Customer" },
            { key: "style", header: "Style" }, { key: "color", header: "Color" }, { key: "size", header: "Size" },
            { key: "sku_code", header: "SKU" }, { key: "priority", header: "Priority" },
            { key: "start_ship", header: "Start Ship", format: "date" }, { key: "cancel", header: "Cancel", format: "date" },
            { key: "ordered", header: "Ordered" }, { key: "allocated", header: "Allocated" }, { key: "open", header: "Open" }, { key: "available", header: "Available" },
          ] as ExportColumn<Record<string, unknown>>[]} />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      {/* PART 40 — when opened from a Sales Order, the workbench lands focused on
          that SO (its number seeded into the search). Show + offer to clear it. */}
      {focusSo && search === focusSo && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#1e1b4b", border: `1px solid ${C.violet}`, borderRadius: 6, padding: "6px 12px", marginBottom: 10, fontSize: 13 }}>
          <span>Focused on sales order <b style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{focusSo}</b> (opened from Sales Orders) — showing <b>all</b> its lines{onlyShort ? ", restricted to open qty by the filter below" : ", including shipped / invoiced lines"}.</span>
          <button style={{ ...btnSecondary, padding: "3px 10px", fontSize: 12 }} onClick={() => setSearch("")}>Show all demand</button>
        </div>
      )}

      {/* When the "Only with open qty" filter is on, some lines may be hidden. */}
      {onlyShort && (
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>
          ⓘ Showing only lines with open qty. Uncheck <b>“Only with open qty”</b> to see every line (including fully-allocated / shipped).
        </div>
      )}

      {/* Batch bar — check lines (☑ in the SO column) then set or clear their
          allocation together. */}
      <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
        <button style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }} onClick={selectAllVisible} disabled={demand.length === 0}>Select all ({demand.length})</button>
        {selected.size > 0 && <button style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }} onClick={() => setSelected(new Set())}>Clear selection</button>}
        {selected.size > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "4px 10px", border: `1px solid ${C.primary}`, borderRadius: 6 }}>
            <b style={{ color: C.primary }}>{selected.size} selected</b>
            <span style={{ color: C.textMuted }}>set allocated</span>
            <input type="text" inputMode="decimal" value={batchQty} onChange={(e) => setBatchQty(e.target.value)} placeholder="qty" style={{ ...numCell, width: "6ch" }} />
            <button style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12, color: C.primary, borderColor: C.primary }} disabled={!(Number(batchQty) >= 0 && batchQty !== "")} onClick={() => void batchApply(Math.round(Number(batchQty)))}>Apply</button>
            <button style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12, color: C.danger, borderColor: "#7f1d1d" }} onClick={() => void batchApply(0)} title="Release the allocation on the selected lines">Clear allocated</button>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.textMuted }}>Next after allocating → open the order in <b>Sales Orders</b>, then <b>Ship</b> the allocated qty and <b>Create AR invoice</b>.</span>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Style · Color · Size</th>
            {isVisible("tier") && <th style={th}>Priority</th>}
            {isVisible("ordered") && <th style={{ ...th, textAlign: "right" }}>Ordered</th>}
            {isVisible("allocated") && <th style={{ ...th, textAlign: "right" }}>Allocated</th>}
            {isVisible("open") && <th style={{ ...th, textAlign: "right" }}>Open</th>}
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={colSpan}>Loading…</td></tr>}
            {!loading && soGroups.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={colSpan}>No open demand to allocate. (Confirm sales orders to populate this workbench.)</td></tr>}
            {!loading && soGroups.map((g) => {
              const gCollapsed = collapsed[g.so_id];
              const itemIds = [...new Set(g.lines.map((l) => l.item_id).filter(Boolean))];
              const gBadge = TIER_BADGE[g.tier] || TIER_BADGE[3];
              return (
                <FragmentRows key={g.so_id}>
                  {/* Per-SO sub-header — Customer · Start Ship · Cancel. Styled like
                      the main header row; one per sales order. */}
                  <tr style={{ background: "#0b1220" }}>
                    <td style={{ ...th, textTransform: "none", letterSpacing: 0, fontSize: 13, color: C.text }} colSpan={colSpan}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span onClick={() => setCollapsed((p) => ({ ...p, [g.so_id]: !p[g.so_id] }))} style={{ cursor: "pointer", color: C.textMuted }}>{gCollapsed ? "▶" : "▼"}</span>
                        {/* PART 44 — clickable SO # → back to the Sales Orders panel,
                            focused on this SO (reverse of the SO→Allocations drill).
                            Mirrors openAllocations(): full-page hop to ?m=sales_orders
                            &so=<SO#>, which InternalSalesOrders reads to seed its SO
                            search box. SO number is resolved (never a UUID). */}
                        {g.so_number ? (
                          <span
                            onClick={() => { window.location.href = `?m=sales_orders&so=${encodeURIComponent(g.so_number || "")}`; }}
                            title="Open this sales order"
                            style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, color: C.primary, cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}
                          >{g.so_number}</span>
                        ) : (
                          <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700 }}>(draft)</span>
                        )}
                        <span style={{ color: C.textMuted }}>·</span>
                        <span style={{ fontWeight: 600 }}>{g.customer_name || "—"}</span>
                        <span style={{ color: C.textMuted }}>·</span>
                        <span style={{ color: C.textSub }}>Start Ship <b style={{ color: C.text }}>{g.requested_ship_date || "—"}</b></span>
                        <span style={{ color: C.textMuted }}>·</span>
                        <span style={{ color: C.textSub }}>Cancel <b style={{ color: C.text }}>{g.cancel_date || "—"}</b></span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: gBadge.color, border: `1px solid ${gBadge.color}`, borderRadius: 4, padding: "1px 6px" }} title={g.tier === 9 ? "Factored SO not approved — cannot allocate" : ""}>{gBadge.label}</span>
                        <span style={{ color: C.textMuted, fontWeight: 400, fontSize: 11 }}>
                          <span style={{ color: g.available > 0 ? C.success : C.textMuted }}>avail {g.available}</span> · demand {g.demand}
                        </span>
                        <div style={{ flex: 1 }} />
                        {(() => {
                          const busy = actionBusy === g.so_id;
                          const st = g.so_status;
                          const canAllocate = ["confirmed", "allocated", "fulfilling"].includes(st) && g.tier !== 9;
                          const canShip = ["allocated", "fulfilling"].includes(st);
                          const canInvoice = ["confirmed", "allocated", "fulfilling", "shipped"].includes(st);
                          const canWave = ["allocated", "fulfilling"].includes(st);
                          const aBtn: React.CSSProperties = { ...btnSecondary, padding: "3px 10px", fontSize: 12 };
                          return (
                            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                              <button style={{ ...aBtn, color: C.violet, borderColor: "#5b21b6" }}
                                disabled={previewBusy || g.available <= 0 || g.tier === 9}
                                onClick={() => void runAutoAllocate(itemIds, `${g.so_number || "(draft)"} · ${g.customer_name || ""}`)} title="Preview + apply a priority full-fill for this sales order">Auto</button>
                              <button style={{ ...aBtn, color: canAllocate ? C.primary : C.textMuted, borderColor: canAllocate ? C.primary : C.cardBdr }}
                                disabled={busy || !canAllocate} onClick={() => void allocateSo(g)}
                                title={canAllocate ? "Reserve available stock to this order's lines" : g.tier === 9 ? "Factored SO not approved — cannot allocate" : `Cannot allocate a ${st} order`}>{busy ? "…" : "Allocate"}</button>
                              <button style={{ ...aBtn, color: canShip ? C.success : C.textMuted, borderColor: canShip ? C.success : C.cardBdr }}
                                disabled={busy || !canShip} onClick={() => openShip(g)}
                                title={canShip ? "Record a carrier shipment for the allocated qty" : `Allocate the order first (status: ${st})`}>Ship</button>
                              <button style={{ ...aBtn, color: canInvoice ? C.warn : C.textMuted, borderColor: canInvoice ? C.warn : C.cardBdr }}
                                disabled={busy || !canInvoice} onClick={() => void invoiceSo(g)}
                                title={canInvoice ? "Create a draft AR invoice for the open qty" : `Cannot invoice a ${st} order`}>Invoice</button>
                              <button style={{ ...aBtn, color: canWave ? C.violet : C.textMuted, borderColor: canWave ? "#5b21b6" : C.cardBdr }}
                                disabled={busy || !canWave} onClick={() => openWave(g)}
                                title={canWave ? "Wave this order to a 3PL provider (EDI 940)" : `Allocate the order first (status: ${st})`}>Wave</button>
                            </span>
                          );
                        })()}
                      </div>
                    </td>
                  </tr>
                  {/* This SO's demand line rows (one per open size-level SKU). */}
                  {!gCollapsed && g.lines.map((d) => {
                    const tier = tierOf(d);
                    const badge = TIER_BADGE[tier] || TIER_BADGE[3];
                    const editVal = edits[d.line_id] ?? String(n(d.qty_allocated));
                    const shipFloor = n(d.qty_shipped);
                    const a = avail[d.item_id];
                    return (
                      <tr key={d.line_id}>
                        <td style={{ ...td, paddingLeft: 26 }}>
                          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                            <input type="checkbox" checked={selected.has(d.line_id)} onChange={() => toggleSelect(d.line_id)} />
                            <span>
                              {(d.description || "—")} <span style={{ color: C.textMuted }}>·</span> {(d.color || "—")} <span style={{ color: C.textMuted }}>·</span> size {d.size || "—"}
                              <span style={{ color: C.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11, marginLeft: 8 }}>{d.sku_code || ""}</span>
                              <span style={{ color: C.textMuted, fontSize: 11, marginLeft: 8 }}>(avail {n(a?.available_qty)})</span>
                            </span>
                          </label>
                        </td>
                        {isVisible("tier") && <td style={td}><span title={tier === 9 ? "Factored SO not approved — cannot allocate" : ""} style={{ fontSize: 11, fontWeight: 600, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 4, padding: "1px 6px" }}>{badge.label}</span></td>}
                        {isVisible("ordered") && <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n(d.qty_ordered)}</td>}
                        {isVisible("allocated") && <td style={{ ...td, textAlign: "right" }}>
                          <input type="text" inputMode="decimal" value={editVal}
                            onChange={(e) => setEdits((p) => ({ ...p, [d.line_id]: e.target.value }))}
                            onBlur={() => void commitCell(d)}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEdits((p) => { const c = { ...p }; delete c[d.line_id]; return c; }); }}
                            disabled={savingLine === d.line_id}
                            title={shipFloor > 0 ? `Cannot go below shipped (${shipFloor})` : "Set allocated qty (0 releases)"}
                            style={{ ...numCell, opacity: savingLine === d.line_id ? 0.5 : 1, borderColor: edits[d.line_id] != null ? C.primary : C.cardBdr }} />
                        </td>}
                        {isVisible("open") && <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: n(d.open_qty) > 0 ? C.warn : C.textMuted }}>{n(d.open_qty)}</td>}
                      </tr>
                    );
                  })}
                </FragmentRows>
              );
            })}
          </tbody>
        </table>
      </div>

      {previewOpen && (
        <div onClick={() => !previewBusy && setPreviewOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(980px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 18 }}>Auto-allocate — {previewScopeLabel}</h3>

            {/* Strategy chosen at run time. Priority tiering (factor-approved →
                credit-card → oldest) applies to every mode; allocation always
                resolves per size-level SKU, so a % target never fills a 0-stock size. */}
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {([
                ["priority_full", "Priority full-fill"],
                ["fair_share", "Fair-share (pro-rata)"],
                ["capped", "Capped %"],
              ] as const).map(([k, lbl]) => (
                <button key={k} onClick={() => setStrategy(k)}
                  style={{ ...btnSecondary, padding: "5px 12px", fontSize: 12, color: strategy === k ? "white" : C.textSub, background: strategy === k ? C.violet : "transparent", borderColor: strategy === k ? C.violet : C.cardBdr }}>{lbl}</button>
              ))}
              {strategy === "capped" && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input type="text" inputMode="decimal" value={capPct} onChange={(e) => setCapPct(e.target.value)}
                    style={{ ...numCell, width: "5ch" }} title="Cap each order to this % of its open qty" />
                  <span style={{ fontSize: 12, color: C.textMuted }}>% of</span>
                  <SearchableSelect value={capBasis} onChange={(v) => setCapBasis(v as "sku" | "style_color")}
                    options={[
                      { value: "sku", label: "each SKU line" },
                      { value: "style_color", label: "each style/color" },
                    ]}
                    inputStyle={{ ...inputStyle, padding: "5px 8px", fontSize: 12 }} />
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
              {strategy === "priority_full" && <>Fill each order 100% in priority order (<b>factor-approved → credit-card → oldest</b>) until stock runs out.</>}
              {strategy === "fair_share" && <>Spread available stock <b>pro-rata</b> across competing orders so each gets the same share of its open qty (leftover by priority).</>}
              {strategy === "capped" && <>Priority full-fill, but cap each {capBasis === "sku" ? "order line" : "order's style/color total"} at <b>{capPct || "?"}%</b> of its open qty. Bounded by real per-size availability.</>}
            </div>

            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <th style={th}>SO #</th><th style={th}>Customer</th><th style={th}>SKU · Size</th><th style={th}>Priority</th>
                  <th style={{ ...th, textAlign: "right" }}>Now</th><th style={{ ...th, textAlign: "right" }}>+Grant</th><th style={{ ...th, textAlign: "right" }}>→ New</th>
                </tr></thead>
                <tbody>
                  {previewBusy && <tr><td style={td} colSpan={7}>Computing…</td></tr>}
                  {!previewBusy && previewRows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={7}>Nothing to allocate — no available stock or open demand in scope.</td></tr>}
                  {!previewBusy && previewRows.map((p) => (
                    <tr key={p.line_id} style={{ opacity: p.blocked_reason ? 0.6 : 1 }}>
                      <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>{p.so_number || "(draft)"}</td>
                      <td style={td}>{p.customer_name || "—"}</td>
                      <td style={td}>{p.sku_code || "—"} <span style={{ color: C.textMuted }}>· {p.size || "—"}</span></td>
                      <td style={td}><span style={{ fontSize: 11, color: TIER_BADGE[p.tier]?.color || C.text }}>{TIER_BADGE[p.tier]?.label || p.tier}</span></td>
                      <td style={{ ...td, textAlign: "right" }}>{p.current_allocated}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 700, color: p.grant > 0 ? C.success : C.textMuted }}>{p.blocked_reason ? <span style={{ color: C.warn, fontSize: 11 }} title={p.blocked_reason}>{p.blocked_reason}</span> : `+${p.grant}`}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{p.proposed_allocated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={btnSecondary} disabled={previewBusy} onClick={() => setPreviewOpen(false)}>Cancel</button>
              <button style={{ ...btnPrimary, background: C.violet }} disabled={previewBusy || previewRows.every((p) => p.grant <= 0)} onClick={() => void applyPreview()}>
                {previewBusy ? "…" : `Apply ${previewRows.filter((p) => p.grant > 0).length} allocation(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Allocation priority rules — reorder the criteria + pick the tie-break.
          The auto-allocate engine reads these server-side. */}
      {rulesOpen && (
        <div onClick={() => !rulesSaving && setRulesOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 18 }}>Allocation priority rules</h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>Auto-allocate fills competing orders in this order (top = first). A factored order with no approval is never allocated, whatever the order.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              {rulesDraft.priority_order.map((c, i) => (
                <div key={c} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: "8px 10px" }}>
                  <span><b style={{ color: C.violet, marginRight: 8 }}>{i + 1}</b>{CRITERION_LABEL[c] || c}</span>
                  <span style={{ display: "flex", gap: 4 }}>
                    <button style={{ ...btnSecondary, padding: "2px 8px", fontSize: 12, opacity: i === 0 ? 0.4 : 1 }} disabled={i === 0} onClick={() => moveCriterion(i, -1)}>↑</button>
                    <button style={{ ...btnSecondary, padding: "2px 8px", fontSize: 12, opacity: i === rulesDraft.priority_order.length - 1 ? 0.4 : 1 }} disabled={i === rulesDraft.priority_order.length - 1} onClick={() => moveCriterion(i, 1)}>↓</button>
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <span style={{ fontSize: 12, color: C.textMuted }}>Within the same tier, prefer the</span>
              <SearchableSelect value={rulesDraft.tie_break} onChange={(v) => setRulesDraft((p) => ({ ...p, tie_break: v }))}
                options={[
                  { value: "order_date", label: "earliest order date" },
                  { value: "ship_date", label: "earliest requested ship date" },
                ]}
                inputStyle={{ ...inputStyle, padding: "5px 8px", fontSize: 12 }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button style={{ ...btnSecondary, fontSize: 12 }} disabled={rulesSaving} onClick={() => setRulesDraft({ priority_order: ["factor_approved", "credit_card", "oldest"], tie_break: "order_date" })}>Reset to default</button>
              <span style={{ display: "flex", gap: 8 }}>
                <button style={btnSecondary} disabled={rulesSaving} onClick={() => setRulesOpen(false)}>Cancel</button>
                <button style={btnPrimary} disabled={rulesSaving} onClick={() => void saveRules()}>{rulesSaving ? "Saving…" : "Save rules"}</button>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Post-allocation summary — how many rows + what % of open demand filled.
          Waits for the user; "Show results" reveals the per-line grants. */}
      {summary && (
        <div onClick={() => setSummary(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(720px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 18 }}>Allocation complete</h3>
            <div style={{ display: "flex", gap: 20, marginBottom: 12, flexWrap: "wrap" }}>
              <div><div style={{ fontSize: 22, fontWeight: 700, color: C.success, fontVariantNumeric: "tabular-nums" }}>{summary.count}</div><div style={{ fontSize: 11, color: C.textMuted }}>lines allocated</div></div>
              <div><div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{summary.units.toLocaleString()}</div><div style={{ fontSize: 11, color: C.textMuted }}>units granted</div></div>
              <div><div style={{ fontSize: 22, fontWeight: 700, color: summary.pctFilled >= 100 ? C.success : C.warn, fontVariantNumeric: "tabular-nums" }}>{summary.pctFilled}%</div><div style={{ fontSize: 11, color: C.textMuted }}>of open demand filled</div></div>
            </div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{summary.label}. Use <b>Undo last</b> to revert. Next → ship the order(s) in <b>Sales Orders → Ship</b>, then <b>Create AR invoice</b>.</div>
            {summary.rows.length > 0 && (
              <button style={{ ...btnSecondary, padding: "5px 12px", fontSize: 12, marginBottom: 10 }} onClick={() => setSummaryShowRows((v) => !v)}>{summaryShowRows ? "Hide results" : "Show results"}</button>
            )}
            {summaryShowRows && (
              <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>SO #</th><th style={th}>SKU</th><th style={th}>Size</th><th style={{ ...th, textAlign: "right" }}>+Granted</th><th style={{ ...th, textAlign: "right" }}>→ Allocated</th></tr></thead>
                  <tbody>{summary.rows.map((r, i) => (
                    <tr key={i}><td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>{r.so}</td><td style={td}>{r.sku}</td><td style={td}>{r.size}</td><td style={{ ...td, textAlign: "right", color: C.success, fontWeight: 700 }}>+{r.granted}</td><td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{r.newAlloc}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={btnPrimary} onClick={() => setSummary(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Ship modal — carrier / service / tracking / date, then POST :id/ship. */}
      {shipFor && (
        <div onClick={() => actionBusy !== shipFor.so_id && setShipFor(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(480px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>Ship {shipFor.so_number || "(draft)"}</h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>{shipFor.customer_name || "—"} — ships the remaining allocated qty on every line.</div>
            <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: C.textSub }}>Carrier
                <div style={{ marginTop: 4 }}>
                  <SearchableSelect value={shipCarrier || null} onChange={(v) => setShipCarrier(v || "")}
                    options={carriers.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}`, searchHaystack: `${c.code} ${c.name}` }))}
                    placeholder="Search carrier…" />
                </div></label>
              <label style={{ fontSize: 12, color: C.textSub }}>Service level
                <input type="text" value={shipService} onChange={(e) => setShipService(e.target.value)} placeholder="e.g. Ground, 2-Day" style={{ ...inputStyle, width: "100%", marginTop: 4 }} /></label>
              <label style={{ fontSize: 12, color: C.textSub }}>Tracking number
                <input type="text" value={shipTracking} onChange={(e) => setShipTracking(e.target.value)} placeholder="(optional)" style={{ ...inputStyle, width: "100%", marginTop: 4 }} /></label>
              <label style={{ fontSize: 12, color: C.textSub }}>Ship date
                <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} style={{ ...inputStyle, width: "100%", marginTop: 4 }} /></label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={btnSecondary} disabled={actionBusy === shipFor.so_id} onClick={() => setShipFor(null)}>Cancel</button>
              <button style={{ ...btnPrimary, background: C.success }} disabled={actionBusy === shipFor.so_id} onClick={() => void shipSo()}>{actionBusy === shipFor.so_id ? "Shipping…" : "Record shipment"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Wave modal — pick a 3PL provider, POST :id/wave (built in parallel). */}
      {waveFor && (
        <div onClick={() => actionBusy !== waveFor.so_id && setWaveFor(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(480px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>Wave {waveFor.so_number || "(draft)"} to a 3PL</h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>{waveFor.customer_name || "—"} — creates a 3PL shipment and transmits an EDI 940 to the chosen provider.</div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: C.textSub, marginBottom: 4 }}>3PL provider</div>
              {tplProviders.length === 0 ? (
                <div style={{ fontSize: 12, color: C.warn }}>No 3PL providers configured. Add one in Inventory → 3PL first.</div>
              ) : (
                <SearchableSelect value={waveProviderId || null} onChange={(v) => setWaveProviderId(v || "")}
                  options={tplProviders.map((p) => ({ value: p.id, label: p.code ? `${p.name} (${p.code})` : p.name, searchHaystack: `${p.name} ${p.code || ""}` }))}
                  placeholder="(pick a 3PL provider…)" />
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={btnSecondary} disabled={actionBusy === waveFor.so_id} onClick={() => setWaveFor(null)}>Cancel</button>
              <button style={{ ...btnPrimary, background: C.violet }} disabled={actionBusy === waveFor.so_id || !waveProviderId} onClick={() => void waveSo()}>{actionBusy === waveFor.so_id ? "Waving…" : "Wave to 3PL"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Group multiple <tr> without an extra DOM node.
function FragmentRows({ children }: { children: React.ReactNode }) { return <>{children}</>; }

// Get-or-create the SoGroup for a demand row, seeding its header fields once.
function bySo_get(map: Map<string, SoGroup>, d: Demand): SoGroup {
  let g = map.get(d.so_id);
  if (!g) {
    g = {
      so_id: d.so_id, so_number: d.so_number, customer_name: d.customer_name,
      requested_ship_date: d.requested_ship_date, cancel_date: d.cancel_date, order_date: d.order_date,
      so_status: d.so_status, tier: tierOf(d), lines: [], available: 0, demand: 0,
    };
    map.set(d.so_id, g);
  }
  return g;
}
