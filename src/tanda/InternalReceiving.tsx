// src/tanda/InternalReceiving.tsx
//
// P13-C1 — Receiving vertical. Goods-receipt sessions against a NATIVE purchase
// order (purchase_orders). List + create/edit modal. Records received/accepted/
// rejected qty per PO line plus optional landed-cost rollups (freight/duty/
// broker). Posting (FIFO inventory layer + AP) is a separate server action.
//
// Mirrors InternalSalesOrders.tsx conventions (C palette, th/td/input/button
// styles, SearchableSelect, notify, Field helper, mandatory ExportButton).

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import { notify } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const numInputStyle: React.CSSProperties = { ...inputStyle, width: "8ch", textAlign: "right" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" };

type Receipt = {
  id: string; purchase_order_id: string | null; tanda_po_id: string | null;
  receipt_date: string; received_by_employee_id: string | null; status: string;
  landed_cost_cents: number | string; notes: string | null; je_id: string | null;
  purchase_order?: { po_number: string | null; vendor_id: string | null } | null;
  line_count?: number; total_received?: number; total_accepted?: number;
};
type PO = { id: string; po_number: string | null; vendor_id: string | null; status: string };
type POLine = { id: string; line_number: number; description: string | null; inventory_item_id: string | null; qty_ordered: number | string; unit_cost_cents: number | string };
type GLAccount = { id: string; code: string; name: string; account_type?: string };
type Vendor = { id: string; name: string; code?: string };

// A single editable receiving line in the modal.
type RLine = { key: number; purchase_order_line_id: string; label: string; qty_ordered: number; unit_cost_cents: number; qty_received: string; qty_accepted: string; qty_rejected: string };
// A single landed-cost rollup row.
type Rollup = { key: number; expense_gl_account_id: string; amount_dollars: string; vendor_id: string; description: string; capitalized_to_inventory: boolean };

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
const STATUS_COLORS: Record<string, string> = {
  draft: C.textMuted, pending_approval: C.warn, approved: C.primary, posted: C.success,
};

const EXPORT_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: "po_number", header: "PO #" },
  { key: "receipt_date", header: "Receipt date", format: "date" },
  { key: "status", header: "Status" },
  { key: "line_count", header: "Lines", format: "number" },
  { key: "total_received", header: "Received qty", format: "number" },
  { key: "total_accepted", header: "Accepted qty", format: "number" },
  { key: "landed_cost_cents", header: "Landed $", format: "currency_cents" },
];

export default function InternalReceiving() {
  const [rows, setRows] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Receipt | null>(null);
  // Deep-link from the PO modal's 📥 Receive button: ?po=<purchase_order_id>
  // auto-opens a new receipt for that PO. One-shot on mount.
  const [initialPoId, setInitialPoId] = useState<string | null>(null);
  useEffect(() => {
    try {
      const po = new URLSearchParams(window.location.search).get("po");
      if (po) { setInitialPoId(po); setEditing(null); setModalOpen(true); }
    } catch { /* noop */ }
  }, []);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetch(`/api/internal/procurement/receipts?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Receipt[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter]);

  // Per-column sort for the receipts list (tri-state ▲▼). Derived columns use
  // accessors so a header key need not map 1:1 to a Receipt field.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:receiving:sort",
    accessors: {
      po_number: (r) => r.purchase_order?.po_number || "",
      line_count: (r) => r.line_count ?? 0,
      total_received: (r) => r.total_received ?? 0,
      landed_cost_cents: (r) => Number(r.landed_cost_cents ?? 0),
    },
  });

  // Flatten for the WYSIWYG export, then append a numeric totals row.
  const exportRows = useMemo(() => {
    const flat = rows.map((r) => ({
      po_number: r.purchase_order?.po_number || "",
      receipt_date: r.receipt_date,
      status: r.status,
      line_count: r.line_count ?? 0,
      total_received: r.total_received ?? 0,
      total_accepted: r.total_accepted ?? 0,
      landed_cost_cents: Number(r.landed_cost_cents ?? 0),
    }));
    if (flat.length === 0) return flat;
    return [
      ...flat,
      {
        po_number: "TOTAL",
        receipt_date: "",
        status: "",
        line_count: flat.reduce((s, r) => s + (Number(r.line_count) || 0), 0),
        total_received: flat.reduce((s, r) => s + (Number(r.total_received) || 0), 0),
        total_accepted: flat.reduce((s, r) => s + (Number(r.total_accepted) || 0), 0),
        landed_cost_cents: flat.reduce((s, r) => s + (Number(r.landed_cost_cents) || 0), 0),
      },
    ];
  }, [rows]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Receiving</h2>
        <button style={btnPrimary} onClick={() => { setEditing(null); setModalOpen(true); }}>+ New receipt</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ width: 200 }}>
          <SearchableSelect value={statusFilter || null} onChange={(v) => setStatusFilter(v)} inputStyle={{ ...inputStyle, width: 200 }}
            options={[{ value: "", label: "All statuses" }, ...["draft", "pending_approval", "approved", "posted"].map((s) => ({ value: s, label: s }))]} />
        </div>
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <ExportButton rows={exportRows} columns={EXPORT_COLUMNS} filename="receiving" sheetName="Receiving" />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <SortableTh label="PO #" sortKey="po_number" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Receipt date" sortKey="receipt_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Lines" sortKey="line_count" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, textAlign: "right" }} />
            <SortableTh label="Received" sortKey="total_received" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, textAlign: "right" }} />
            <SortableTh label="Landed $" sortKey="landed_cost_cents" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, textAlign: "right" }} />
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={6}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={6}>No receipts.</td></tr>}
            {sorted.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => { setEditing(r); setModalOpen(true); }}>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.purchase_order?.po_number || <span style={{ color: C.textMuted }}>(no PO #)</span>}</td>
                <td style={td}>{r.receipt_date}</td>
                <td style={td}><span style={{ color: STATUS_COLORS[r.status] || C.text, fontWeight: 600 }}>● {r.status}</span></td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.line_count ?? 0}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{(r.total_received ?? 0).toLocaleString()}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.landed_cost_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <ReceiptModal
          receipt={editing}
          initialPoId={initialPoId}
          onClose={() => { setModalOpen(false); setEditing(null); setInitialPoId(null); }}
          onSaved={() => { setModalOpen(false); setEditing(null); setInitialPoId(null); void load(); }}
        />
      )}
    </div>
  );
}

function ReceiptModal({ receipt, initialPoId, onClose, onSaved }: { receipt: Receipt | null; initialPoId?: string | null; onClose: () => void; onSaved: () => void }) {
  const isNew = receipt === null;
  const editable = isNew || receipt?.status === "draft";

  const [savedId, setSavedId] = useState<string | null>(receipt?.id || null);
  const [poId, setPoId] = useState(receipt?.purchase_order_id || initialPoId || "");
  const [receiptDate, setReceiptDate] = useState(receipt?.receipt_date || new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState(receipt?.notes || "");
  const [lines, setLines] = useState<RLine[]>([]);
  const [rollups, setRollups] = useState<Rollup[]>([]);

  const [pos, setPos] = useState<PO[]>([]);
  const [glAccounts, setGlAccounts] = useState<GLAccount[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load issued + in-transit POs (merge), expense/asset GL accounts, vendors.
  useEffect(() => {
    Promise.all([
      fetch("/api/internal/purchase-orders?status=issued&limit=500").then((r) => r.ok ? r.json() : []),
      fetch("/api/internal/purchase-orders?status=in_transit&limit=500").then((r) => r.ok ? r.json() : []),
    ]).then(([a, b]) => {
      const merged = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])] as PO[];
      setPos(merged);
    }).catch(() => {});
    fetch("/api/internal/gl-accounts?limit=1000").then((r) => r.ok ? r.json() : []).then((a) => {
      const all = Array.isArray(a) ? a as GLAccount[] : [];
      // Landed-cost capitalizes into an inventory (asset) or expense account.
      setGlAccounts(all.filter((g) => !g.account_type || ["expense", "asset"].includes(g.account_type)));
    }).catch(() => {});
    fetch("/api/internal/vendor-master?limit=1000").then((r) => r.ok ? r.json() : []).then((a) => {
      setVendors(Array.isArray(a) ? a as Vendor[] : []);
    }).catch(() => {});
  }, []);

  // Load existing receipt's lines/rollups when editing.
  useEffect(() => {
    if (isNew || !receipt) return;
    fetch(`/api/internal/procurement/receipts/${receipt.id}`).then((r) => r.ok ? r.json() : null).then((full) => {
      if (!full) return;
      if (Array.isArray(full.lines)) {
        setLines(full.lines.map((l: { purchase_order_line_id: string; qty_received: number; qty_accepted: number; qty_rejected: number; unit_cost_cents: number; purchase_order_line?: POLine }, i: number) => {
          const pol = l.purchase_order_line;
          return {
            key: i + 1,
            purchase_order_line_id: l.purchase_order_line_id,
            label: pol ? `#${pol.line_number} ${pol.description || "(no desc)"}` : "(line)",
            qty_ordered: Number(pol?.qty_ordered) || 0,
            unit_cost_cents: Number(l.unit_cost_cents) || 0,
            qty_received: String(l.qty_received ?? ""),
            qty_accepted: String(l.qty_accepted ?? ""),
            qty_rejected: String(l.qty_rejected ?? 0),
          };
        }));
      }
      if (Array.isArray(full.rollups)) {
        setRollups(full.rollups.map((r: { expense_gl_account_id: string; amount_cents: number; vendor_id: string | null; description: string; capitalized_to_inventory: boolean }, i: number) => ({
          key: i + 1,
          expense_gl_account_id: r.expense_gl_account_id || "",
          amount_dollars: r.amount_cents != null ? (Number(r.amount_cents) / 100).toFixed(2) : "",
          vendor_id: r.vendor_id || "",
          description: r.description || "",
          capitalized_to_inventory: r.capitalized_to_inventory !== false,
        })));
      }
    }).catch(() => {});
  }, [isNew, receipt]);

  // When a PO is picked (new receipt), load its lines and seed one receiving
  // line per PO line, defaulting received = accepted = qty_ordered.
  function pickPO(v: string) {
    setPoId(v);
    if (!v) { setLines([]); return; }
    fetch(`/api/internal/purchase-orders/${v}`).then((r) => r.ok ? r.json() : null).then((full) => {
      const poLines: POLine[] = Array.isArray(full?.lines) ? full.lines : [];
      setLines(poLines.map((pl, i) => {
        const qty = Number(pl.qty_ordered) || 0;
        return {
          key: i + 1,
          purchase_order_line_id: pl.id,
          label: `#${pl.line_number} ${pl.description || "(no desc)"}`,
          qty_ordered: qty,
          unit_cost_cents: Number(pl.unit_cost_cents) || 0,
          qty_received: String(qty),
          qty_accepted: String(qty),
          qty_rejected: "0",
        };
      }));
    }).catch(() => {});
  }

  function updateLine(idx: number, patch: Partial<RLine>) { setLines((p) => p.map((l, i) => i === idx ? { ...l, ...patch } : l)); }

  function addRollup() { setRollups((p) => [...p, { key: (p[p.length - 1]?.key ?? 0) + 1, expense_gl_account_id: "", amount_dollars: "", vendor_id: "", description: "", capitalized_to_inventory: true }]); }
  function updateRollup(idx: number, patch: Partial<Rollup>) { setRollups((p) => p.map((r, i) => i === idx ? { ...r, ...patch } : r)); }
  function removeRollup(idx: number) { setRollups((p) => p.filter((_, i) => i !== idx)); }

  const totalReceived = useMemo(() => lines.reduce((s, l) => s + (Number(l.qty_received) || 0), 0), [lines]);
  const totalAccepted = useMemo(() => lines.reduce((s, l) => s + (Number(l.qty_accepted) || 0), 0), [lines]);
  const landedTotalCents = useMemo(() => rollups.reduce((s, r) => r.capitalized_to_inventory ? s + Math.round((Number(r.amount_dollars) || 0) * 100) : s, 0), [rollups]);

  function apiLines() {
    return lines
      .filter((l) => l.purchase_order_line_id && Number(l.qty_received) > 0)
      .map((l) => ({
        purchase_order_line_id: l.purchase_order_line_id,
        qty_received: Number(l.qty_received),
        qty_accepted: l.qty_accepted === "" ? Number(l.qty_received) : Number(l.qty_accepted),
        qty_rejected: l.qty_rejected === "" ? 0 : Number(l.qty_rejected),
        unit_cost_cents: l.unit_cost_cents,
      }));
  }
  function apiRollups() {
    return rollups
      .filter((r) => r.expense_gl_account_id && Number(r.amount_dollars) > 0)
      .map((r) => ({
        expense_gl_account_id: r.expense_gl_account_id,
        amount_cents: Math.round((Number(r.amount_dollars) || 0) * 100),
        vendor_id: r.vendor_id || null,
        description: r.description.trim() || "rollup",
        capitalized_to_inventory: r.capitalized_to_inventory,
      }));
  }

  async function save(): Promise<string | null> {
    setErr(null);
    if (!poId) { setErr("Pick a purchase order."); return null; }
    if (apiLines().length === 0) { setErr("Add at least one line with a received quantity."); return null; }
    setSubmitting(true);
    try {
      const body = {
        purchase_order_id: poId,
        receipt_date: receiptDate,
        notes: notes.trim() || null,
        lines: apiLines(),
        rollups: apiRollups(),
      };
      let id = savedId;
      if (!id) {
        const r = await fetch("/api/internal/procurement/receipts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        id = j?.id || null;
        setSavedId(id);
      } else {
        const r = await fetch(`/api/internal/procurement/receipts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ receipt_date: receiptDate, notes: notes.trim() || null, lines: apiLines(), rollups: apiRollups() }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      return id;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
    finally { setSubmitting(false); }
  }

  async function saveDraft() {
    const id = await save();
    if (id) { notify("Receipt draft saved.", "success"); onSaved(); }
  }

  // Post — server builds the FIFO inventory layer at landed cost + queues any
  // rollup AP invoices. That endpoint is owned elsewhere; we just call it.
  async function postReceipt() {
    let id = savedId;
    if (!id) { id = await save(); }
    if (!id) return;
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/receipts/${id}/post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Receipt posted — inventory layer created.", "success");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1180px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New receipt" : `Receipt — ${receipt?.purchase_order?.po_number || "(no PO #)"} — ${receipt?.status}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Purchase order (issued / in-transit)">
            <SearchableSelect value={poId || null} onChange={(v) => pickPO(v)}
              options={[{ value: "", label: "(pick a PO…)" }, ...pos.map((p) => ({ value: p.id, label: `${p.po_number || "(draft)"} — ${vendorName(vendors, p.vendor_id)}`, searchHaystack: `${p.po_number || ""} ${vendorName(vendors, p.vendor_id)}` }))]}
              placeholder="(pick a PO…)" disabled={!editable || (!isNew)} />
          </Field>
          <Field label="Receipt date"><input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
        </div>

        <Field label="Notes"><input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} style={inputStyle} placeholder="optional" /></Field>

        {/* Receiving lines — one per PO line. */}
        <div style={{ marginTop: 16, marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines</div>
        </div>
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup><col style={{ width: 36 }} /><col /><col style={{ width: 90 }} /><col style={{ width: 100 }} /><col style={{ width: 100 }} /><col style={{ width: 100 }} /><col style={{ width: 110 }} /></colgroup>
            <thead><tr>
              <th style={th}>#</th><th style={th}>Style / desc</th><th style={{ ...th, textAlign: "right" }}>Ordered</th><th style={{ ...th, textAlign: "right" }}>Received</th><th style={{ ...th, textAlign: "right" }}>Accepted</th><th style={{ ...th, textAlign: "right" }}>Rejected</th><th style={{ ...th, textAlign: "right" }}>Unit $</th>
            </tr></thead>
            <tbody>
              {lines.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={7}>{poId ? "No lines on this PO." : "Pick a purchase order to load its lines."}</td></tr>}
              {lines.map((l, idx) => (
                <tr key={l.key}>
                  <td style={td}>{idx + 1}</td>
                  <td style={td}>{l.label}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.qty_ordered.toLocaleString()}</td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.qty_received} onChange={(e) => updateLine(idx, { qty_received: e.target.value })} disabled={!editable} placeholder="0" style={numInputStyle} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.qty_accepted} onChange={(e) => updateLine(idx, { qty_accepted: e.target.value })} disabled={!editable} placeholder="0" style={numInputStyle} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.qty_rejected} onChange={(e) => updateLine(idx, { qty_rejected: e.target.value })} disabled={!editable} placeholder="0" style={numInputStyle} /></td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.textSub }}>{fmtCents(l.unit_cost_cents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr>
              <td style={{ ...td, textAlign: "right" }} colSpan={3}><span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Total</span></td>
              <td style={{ ...td, fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{totalReceived.toLocaleString()}</td>
              <td style={{ ...td, fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{totalAccepted.toLocaleString()}</td>
              <td style={td} colSpan={2}></td>
            </tr></tfoot>
          </table>
        </div>

        {/* Landed-cost rollups (freight / duty / broker). */}
        <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Landed-cost rollups (freight / duty / broker)</div>
            {editable && <button onClick={addRollup} style={btnSecondary}>+ Add rollup</button>}
          </div>
          {rollups.length === 0 && <div style={{ fontSize: 12, color: C.textMuted }}>No rollups. Add freight/duty/broker charges to capitalize them into landed cost.</div>}
          {rollups.map((r, idx) => (
            <div key={r.key} style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr 1.2fr 1.4fr auto auto", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <SearchableSelect value={r.expense_gl_account_id || null} onChange={(v) => updateRollup(idx, { expense_gl_account_id: v })}
                options={[{ value: "", label: "(GL account…)" }, ...glAccounts.map((g) => ({ value: g.id, label: `${g.code} — ${g.name}`, searchHaystack: `${g.code} ${g.name}` }))]}
                placeholder="(GL account…)" disabled={!editable} />
              <input type="text" inputMode="decimal" value={r.amount_dollars} onChange={(e) => updateRollup(idx, { amount_dollars: e.target.value })} disabled={!editable} placeholder="amount $" style={inputStyle} />
              <SearchableSelect value={r.vendor_id || null} onChange={(v) => updateRollup(idx, { vendor_id: v })}
                options={[{ value: "", label: "(vendor — optional)" }, ...vendors.map((vd) => ({ value: vd.id, label: vd.code ? `${vd.code} — ${vd.name}` : vd.name, searchHaystack: `${vd.code || ""} ${vd.name}` }))]}
                placeholder="(vendor — optional)" disabled={!editable} />
              <input type="text" value={r.description} onChange={(e) => updateRollup(idx, { description: e.target.value })} disabled={!editable} placeholder="description" style={inputStyle} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, whiteSpace: "nowrap" }} title="Capitalize this charge into the received inventory's landed cost">
                <input type="checkbox" checked={r.capitalized_to_inventory} onChange={(e) => updateRollup(idx, { capitalized_to_inventory: e.target.checked })} disabled={!editable} /> capitalize
              </label>
              {editable && <button type="button" onClick={() => removeRollup(idx)} style={btnDanger}>✕</button>}
            </div>
          ))}
          <div style={{ marginTop: 8, fontSize: 12, color: C.textSub, textAlign: "right" }}>
            Capitalized landed cost: <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmtCents(landedTotalCents)}</b>
          </div>
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
          Posting creates the inventory layer at landed cost and queues any rollup AP invoices for bookkeeper approval.
        </div>

        {/* Sticky action footer — pinned to the bottom of the scrolling modal so
            Post / Save / Close stay reachable as the receipt-line grid grows. */}
        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
          {editable && <button onClick={() => void saveDraft()} style={btnSecondary} disabled={submitting}>{submitting ? "Saving…" : "Save draft"}</button>}
          {editable && savedId && <button onClick={() => void postReceipt()} style={btnPrimary} disabled={submitting} title="Create the inventory layer at landed cost and queue rollup AP invoices">{submitting ? "…" : "Post receipt"}</button>}
        </div>
      </div>
    </div>
  );
}

function vendorName(vendors: Vendor[], vendorId: string | null | undefined): string {
  if (!vendorId) return "(no vendor)";
  const v = vendors.find((x) => x.id === vendorId);
  return v ? v.name : "(vendor)";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
