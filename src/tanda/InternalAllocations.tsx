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
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const numCell: React.CSSProperties = { ...inputStyle, width: "7ch", textAlign: "right", padding: "4px 6px" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };

type Demand = {
  line_id: string; so_id: string; so_number: string | null; order_date: string | null;
  requested_ship_date: string | null; so_status: string; customer_id: string; customer_name: string | null;
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

const COLUMNS: ColumnDef[] = [
  { key: "customer",   label: "Customer" },
  { key: "tier",       label: "Priority" },
  { key: "start_ship", label: "Start Ship" },
  { key: "ordered",    label: "Ordered" },
  { key: "allocated",  label: "Allocated" },
  { key: "open",       label: "Open" },
];
const TABLE_KEY = "tangerine:allocations:columns";

const TIER_BADGE: Record<number, { label: string; color: string }> = {
  1: { label: "🅕 factor",  color: C.success },
  2: { label: "💳 card",    color: C.primary },
  3: { label: "⏱ oldest",   color: C.textSub },
  9: { label: "⚠ blocked",  color: C.warn },
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

type Sku = { item_id: string; sku_code: string | null; size: string | null; avail: Avail | null; lines: Demand[] };
type Rollup = { key: string; style: string; color: string; skus: Sku[]; onHand: number; reserved: number; available: number; demand: number };

export default function InternalAllocations() {
  const [demand, setDemand] = useState<Demand[]>([]);
  const [avail, setAvail] = useState<Record<string, Avail>>({});
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [onlyShort, setOnlyShort] = useState(false);
  const { value: search, debouncedValue: dSearch, setValue: setSearch } = useDebouncedSearch("", 250);
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

  async function load() {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (customerId) p.set("customer_id", customerId);
      if (onlyShort) p.set("only_short", "1");
      if (dSearch.trim()) p.set("q", dSearch.trim());
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
  const CRITERION_LABEL: Record<string, string> = { factor_approved: "🅕 Factor-approved", credit_card: "💳 Credit-card on file", oldest: "⏱ Oldest (by date) — everyone else" };
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=1000").then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setCustomers(a as Customer[]); }).catch(() => {});
  }, []);

  // Build the style/color → SKU → lines tree.
  const rollups = useMemo<Rollup[]>(() => {
    const byRollup = new Map<string, Rollup>();
    for (const d of demand) {
      const style = (d.description || "—").trim();
      const color = (d.color || "—").trim();
      const rkey = `${style}||${color}`;
      let ru = byRollup.get(rkey);
      if (!ru) { ru = { key: rkey, style, color, skus: [], onHand: 0, reserved: 0, available: 0, demand: 0 }; byRollup.set(rkey, ru); }
      let sku = ru.skus.find((s) => s.item_id === d.item_id);
      if (!sku) {
        const a = avail[d.item_id] || null;
        sku = { item_id: d.item_id, sku_code: d.sku_code, size: d.size, avail: a, lines: [] };
        ru.skus.push(sku);
        ru.onHand += n(a?.on_hand_qty); ru.reserved += n(a?.reserved_qty); ru.available += n(a?.available_qty);
      }
      sku.lines.push(d);
      ru.demand += n(d.open_qty);
    }
    // Sort lines within a SKU by priority tier then oldest order.
    for (const ru of byRollup.values()) {
      ru.skus.sort((a, b) => String(a.size || "").localeCompare(String(b.size || "")));
      for (const s of ru.skus) {
        s.lines.sort((a, b) => {
          const ta = tierOf(a), tb = tierOf(b);
          if (ta !== tb) return ta - tb;
          return String(a.order_date || "9999").localeCompare(String(b.order_date || "9999"));
        });
      }
    }
    return [...byRollup.values()].sort((a, b) => a.style.localeCompare(b.style) || a.color.localeCompare(b.color));
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
    const ok = await confirmDialog(`Set allocated = ${qty} on ${ids.length} selected line(s)? (Cannot drop below already-shipped qty.)`, { confirmText: "Apply", icon: "⚡" });
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
    const ok = await confirmDialog(`Apply ${allocations.length} allocation(s) for ${previewScopeLabel}?`, { confirmText: "Apply", icon: "⚡" });
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

  const exportRows = useMemo(() => demand.map((d) => ({
    so_number: d.so_number || "(draft)", customer: d.customer_name || d.customer_id,
    style: d.description || "", color: d.color || "", size: d.size || "", sku_code: d.sku_code || "",
    priority: TIER_BADGE[tierOf(d)].label, start_ship: d.requested_ship_date || "",
    ordered: n(d.qty_ordered), allocated: n(d.qty_allocated), open: n(d.open_qty),
    available: n(avail[d.item_id]?.available_qty),
  })), [demand, avail]);

  const colSpan = 1 + ["customer", "tier", "start_ship", "ordered", "allocated", "open"].filter(isVisible).length;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>📊 Allocations</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={btnSecondary} onClick={openRules} title="Set the auto-allocate priority order (factor / card / oldest) + tie-break">⚙ Rules</button>
          {lastUndo && (
            <button style={{ ...btnSecondary, color: C.warn, borderColor: C.warn }} disabled={previewBusy} onClick={() => void undoLast()}
              title={`Revert: ${lastUndo.label}`}>↩ Undo last</button>
          )}
          <button style={{ ...btnPrimary, background: C.violet }} disabled={previewBusy || loading || demand.length === 0}
            onClick={() => void runAutoAllocate([], "all visible demand")} title="Preview, choose the rule (priority / fair-share / capped %), then apply — across all visible demand">
            {previewBusy ? "…" : "⚡ Auto-allocate all"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ width: 240 }}>
          <SearchableSelect value={customerId || null} onChange={(v) => setCustomerId(v || "")}
            options={[{ value: "", label: "All customers" }, ...customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))]}
            placeholder="All customers" />
        </div>
        <DynamicSearchInput value={search} onChange={setSearch} placeholder="Search style / SKU / SO #" ariaLabel="Search allocations" wrapperStyle={{ maxWidth: 240 }} />
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
            { key: "sku_code", header: "SKU" }, { key: "priority", header: "Priority" }, { key: "start_ship", header: "Start Ship", format: "date" },
            { key: "ordered", header: "Ordered" }, { key: "allocated", header: "Allocated" }, { key: "open", header: "Open" }, { key: "available", header: "Available" },
          ] as ExportColumn<Record<string, unknown>>[]} />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      {/* Batch bar — check lines (☑ in the SO column) then set or clear their
          allocation together. */}
      <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
        <button style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }} onClick={selectAllVisible} disabled={demand.length === 0}>☑ Select all ({demand.length})</button>
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
        <span style={{ fontSize: 11, color: C.textMuted }}>Next after allocating → open the order in <b>🛒 Sales Orders</b>, then <b>🚚 Ship</b> the allocated qty and <b>🧾 Create AR invoice</b>.</span>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>SO # / Style · Color · Size</th>
            {isVisible("customer") && <th style={th}>Customer</th>}
            {isVisible("tier") && <th style={th}>Priority</th>}
            {isVisible("start_ship") && <th style={th}>Start Ship</th>}
            {isVisible("ordered") && <th style={{ ...th, textAlign: "right" }}>Ordered</th>}
            {isVisible("allocated") && <th style={{ ...th, textAlign: "right" }}>Allocated</th>}
            {isVisible("open") && <th style={{ ...th, textAlign: "right" }}>Open</th>}
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={colSpan}>Loading…</td></tr>}
            {!loading && rollups.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={colSpan}>No open demand to allocate. (Confirm sales orders to populate this workbench.)</td></tr>}
            {!loading && rollups.map((ru) => {
              const rCollapsed = collapsed[ru.key];
              const itemIds = ru.skus.map((s) => s.item_id);
              return (
                <FragmentRows key={ru.key}>
                  {/* Style/color rollup header */}
                  <tr style={{ background: "#0b1220" }}>
                    <td style={{ ...td, fontWeight: 700 }} colSpan={1}>
                      <span onClick={() => setCollapsed((p) => ({ ...p, [ru.key]: !p[ru.key] }))} style={{ cursor: "pointer", color: C.textMuted, marginRight: 8 }}>{rCollapsed ? "▶" : "▼"}</span>
                      {ru.style} <span style={{ color: C.textMuted }}>·</span> {ru.color}
                      <span style={{ color: C.textMuted, fontWeight: 400, marginLeft: 10, fontSize: 11 }}>
                        on-hand {ru.onHand} · reserved {ru.reserved} · <span style={{ color: ru.available > 0 ? C.success : C.textMuted }}>avail {ru.available}</span> · demand {ru.demand}
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: "right" }} colSpan={Math.max(colSpan - 1, 1)}>
                      <button style={{ ...btnSecondary, padding: "3px 10px", fontSize: 12, color: C.violet, borderColor: "#5b21b6" }}
                        disabled={previewBusy || ru.available <= 0}
                        onClick={() => void runAutoAllocate(itemIds, `${ru.style} · ${ru.color}`)} title="Priority full-fill this style/color">⚡ Auto</button>
                    </td>
                  </tr>
                  {!rCollapsed && ru.skus.map((sku) => (
                    <FragmentRows key={sku.item_id}>
                      {/* SKU (size) sub-header */}
                      <tr>
                        <td style={{ ...td, paddingLeft: 28, color: C.textSub, fontWeight: 600 }} colSpan={1}>
                          {sku.sku_code || "—"} <span style={{ color: C.textMuted, fontWeight: 400 }}>· size {sku.size || "—"}</span>
                        </td>
                        <td style={{ ...td, color: C.textMuted, fontSize: 11 }} colSpan={Math.max(colSpan - 1, 1)}>
                          on-hand {n(sku.avail?.on_hand_qty)} · reserved {n(sku.avail?.reserved_qty)} · <span style={{ color: n(sku.avail?.available_qty) > 0 ? C.success : C.textMuted }}>available {n(sku.avail?.available_qty)}</span>
                        </td>
                      </tr>
                      {/* Competing SO lines */}
                      {sku.lines.map((d) => {
                        const tier = tierOf(d);
                        const badge = TIER_BADGE[tier] || TIER_BADGE[3];
                        const editVal = edits[d.line_id] ?? String(n(d.qty_allocated));
                        const shipFloor = n(d.qty_shipped);
                        return (
                          <tr key={d.line_id}>
                            <td style={{ ...td, paddingLeft: 24, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                                <input type="checkbox" checked={selected.has(d.line_id)} onChange={() => toggleSelect(d.line_id)} />
                                {d.so_number || "(draft)"}
                              </label>
                            </td>
                            {isVisible("customer") && <td style={td}>{d.customer_name || "—"}</td>}
                            {isVisible("tier") && <td style={td}><span title={tier === 9 ? "Factored SO not approved — cannot allocate" : ""} style={{ fontSize: 11, fontWeight: 600, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 4, padding: "1px 6px" }}>{badge.label}</span></td>}
                            {isVisible("start_ship") && <td style={td}>{d.requested_ship_date || "—"}</td>}
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
                  ))}
                </FragmentRows>
              );
            })}
          </tbody>
        </table>
      </div>

      {previewOpen && (
        <div onClick={() => !previewBusy && setPreviewOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(980px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 18 }}>⚡ Auto-allocate — {previewScopeLabel}</h3>

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
                  <select value={capBasis} onChange={(e) => setCapBasis(e.target.value as "sku" | "style_color")} style={{ ...inputStyle, padding: "5px 8px", fontSize: 12 }}>
                    <option value="sku">each SKU line</option>
                    <option value="style_color">each style/color</option>
                  </select>
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
                      <td style={{ ...td, textAlign: "right", fontWeight: 700, color: p.grant > 0 ? C.success : C.textMuted }}>{p.blocked_reason ? <span style={{ color: C.warn, fontSize: 11 }} title={p.blocked_reason}>⚠ {p.blocked_reason}</span> : `+${p.grant}`}</td>
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
            <h3 style={{ margin: "0 0 6px", fontSize: 18 }}>⚙ Allocation priority rules</h3>
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
              <select value={rulesDraft.tie_break} onChange={(e) => setRulesDraft((p) => ({ ...p, tie_break: e.target.value }))} style={{ ...inputStyle, padding: "5px 8px", fontSize: 12 }}>
                <option value="order_date">earliest order date</option>
                <option value="ship_date">earliest requested ship date</option>
              </select>
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
            <h3 style={{ margin: "0 0 10px", fontSize: 18 }}>✅ Allocation complete</h3>
            <div style={{ display: "flex", gap: 20, marginBottom: 12, flexWrap: "wrap" }}>
              <div><div style={{ fontSize: 22, fontWeight: 700, color: C.success, fontVariantNumeric: "tabular-nums" }}>{summary.count}</div><div style={{ fontSize: 11, color: C.textMuted }}>lines allocated</div></div>
              <div><div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{summary.units.toLocaleString()}</div><div style={{ fontSize: 11, color: C.textMuted }}>units granted</div></div>
              <div><div style={{ fontSize: 22, fontWeight: 700, color: summary.pctFilled >= 100 ? C.success : C.warn, fontVariantNumeric: "tabular-nums" }}>{summary.pctFilled}%</div><div style={{ fontSize: 11, color: C.textMuted }}>of open demand filled</div></div>
            </div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{summary.label}. Use <b>↩ Undo last</b> to revert. Next → ship the order(s) in <b>🛒 Sales Orders → 🚚 Ship</b>, then <b>🧾 Create AR invoice</b>.</div>
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
    </div>
  );
}

// Group multiple <tr> without an extra DOM node.
function FragmentRows({ children }: { children: React.ReactNode }) { return <>{children}</>; }
