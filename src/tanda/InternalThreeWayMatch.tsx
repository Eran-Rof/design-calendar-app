// src/tanda/InternalThreeWayMatch.tsx
//
// P13-C4 — Vendor-Invoice 3-Way Match vertical. Stages a vendor's invoice and
// matches it against the NATIVE purchase_orders + posted tanda_po_receipts
// before it becomes an AP invoice. DRAFT-ONLY: "Approve" creates an AP invoice
// DRAFT (gl_status='draft') — the existing AP panel posts the JE later.
//
// List vendor-invoice drafts → detail modal with the match breakdown + the
// Re-match / Approve / Reject actions (gated by status). Tolerance (D4): a total
// is "matched" within $5 OR 2%, whichever is greater.
//
// Mirrors InternalReceiving.tsx conventions (C palette, th/td/input/button
// styles, SearchableSelect, notify/confirmDialog, mandatory ExportButton, Field).

import { useEffect, useMemo, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import SearchableSelect from "./components/SearchableSelect";
import { notify, confirmDialog, promptDialog } from "../shared/ui/warn";
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
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnSuccess: React.CSSProperties = { ...btnPrimary, background: C.success };
const btnDangerSolid: React.CSSProperties = { ...btnPrimary, background: C.danger };

type Draft = {
  id: string; vendor_id: string; vendor_invoice_number: string; invoice_date: string;
  due_date: string | null; currency: string; total_cents: number | string;
  source_kind: string; three_way_match_status: string;
  matched_po_ids: string[]; matched_receipt_ids: string[];
  variance_cents: number | string; variance_reason: string | null;
  ap_invoice_id: string | null; rejected_reason: string | null;
  vendor_name?: string | null;
};
type MatchLine = {
  purchase_order_line_id: string; line_number: number | null; description: string | null;
  qty_ordered: number | null; qty_accepted: number; unit_cost_cents: number; line_received_value_cents: number;
};
type MatchBreakdown = {
  purchase_order_id: string | null; po_number: string | null; po_total_cents: number | null;
  received_value_cents: number; invoice_total_cents: number; variance_cents: number;
  tolerance_cents: number; within_tolerance: boolean; lines: MatchLine[];
};
type DraftDetail = Draft & { match?: MatchBreakdown };
type PO = { id: string; po_number: string | null; vendor_id: string | null; status: string; total_cents?: number | string };
type Vendor = { id: string; name: string; code?: string };

function fmtCents(c: number | string | null | undefined): string {
  if (c === null || c === undefined) return "—";
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
const STATUS_COLORS: Record<string, string> = {
  pending: C.textMuted, matched: C.success, variance: C.warn, exception: C.danger,
  posted: C.primary, rejected: C.textMuted,
};

const EXPORT_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: "vendor_name", header: "Vendor" },
  { key: "vendor_invoice_number", header: "Invoice #" },
  { key: "invoice_date", header: "Invoice date", format: "date" },
  { key: "total_cents", header: "Total $", format: "currency_cents" },
  { key: "three_way_match_status", header: "Match status" },
  { key: "variance_cents", header: "Variance $", format: "currency_cents" },
];

export default function InternalThreeWayMatch() {
  const [rows, setRows] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetch(`/api/internal/procurement/vendor-invoice-drafts?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Draft[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter]);

  // #5 sortable columns — total/variance are number|string from the API, so
  // sort them numerically; vendor sorts on the resolved name.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:threewaymatch:sort",
    accessors: {
      vendor_name: (r) => r.vendor_name || "",
      total_cents: (r) => Number(r.total_cents ?? 0),
      variance_cents: (r) => Number(r.variance_cents ?? 0),
    },
  });

  const exportRows = useMemo(() => {
    const base = rows.map((r) => ({
      vendor_name: r.vendor_name || "",
      vendor_invoice_number: r.vendor_invoice_number,
      invoice_date: r.invoice_date,
      total_cents: r.total_cents,
      three_way_match_status: r.three_way_match_status,
      variance_cents: r.variance_cents,
    }));
    if (base.length === 0) return base;
    // #23 export totals — append a TOTAL row summing the numeric cents columns.
    const totalRow = {
      vendor_name: "TOTAL",
      vendor_invoice_number: "",
      invoice_date: "",
      total_cents: rows.reduce((s, r) => s + Number(r.total_cents ?? 0), 0),
      three_way_match_status: "",
      variance_cents: rows.reduce((s, r) => s + Number(r.variance_cents ?? 0), 0),
    };
    return [...base, totalRow];
  }, [rows]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>3-Way Match</h2>
        <button style={btnPrimary} onClick={() => { setCreating(true); setEditingId(null); setModalOpen(true); }}>+ New vendor invoice</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <SearchableSelect value={statusFilter || null} onChange={(v) => setStatusFilter(v)} inputStyle={{ ...inputStyle, width: 200 }}
          placeholder="All statuses"
          options={[
            { value: "", label: "All statuses" },
            ...["pending", "matched", "variance", "exception", "posted", "rejected"].map((s) => ({ value: s, label: s })),
          ]}
        />
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <ExportButton rows={exportRows} columns={EXPORT_COLUMNS} filename="three-way-match" sheetName="3-Way Match" />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <SortableTh label="Vendor" sortKey="vendor_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Invoice #" sortKey="vendor_invoice_number" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Date" sortKey="invoice_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Total" sortKey="total_cents" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, textAlign: "right" }} />
            <SortableTh label="Status" sortKey="three_way_match_status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Variance" sortKey="variance_cents" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, textAlign: "right" }} />
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={6}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={6}>No vendor invoice drafts.</td></tr>}
            {sorted.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => { setCreating(false); setEditingId(r.id); setModalOpen(true); }}>
                <td style={td}>{r.vendor_name || <span style={{ color: C.textMuted }}>(vendor)</span>}</td>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.vendor_invoice_number}</td>
                <td style={td}>{fmtDateDisplay(r.invoice_date)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.total_cents)}</td>
                <td style={td}><span style={{ color: STATUS_COLORS[r.three_way_match_status] || C.text, fontWeight: 600 }}>● {r.three_way_match_status}</span></td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: Number(r.variance_cents) !== 0 ? C.warn : C.textSub }}>{fmtCents(r.variance_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        creating
          ? <NewInvoiceModal onClose={() => setModalOpen(false)} onSaved={() => { setModalOpen(false); void load(); }} />
          : editingId && <DetailModal draftId={editingId} onClose={() => { setModalOpen(false); setEditingId(null); }} onChanged={() => { void load(); }} />
      )}
    </div>
  );
}

// ── New vendor invoice (create + auto-match) ──────────────────────────────
function NewInvoiceModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [vendorId, setVendorId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [totalDollars, setTotalDollars] = useState("");
  const [poId, setPoId] = useState("");

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [pos, setPos] = useState<PO[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load vendors + matchable POs (in_transit + received).
  useEffect(() => {
    fetch("/api/internal/vendor-master?limit=1000").then((r) => r.ok ? r.json() : []).then((a) => {
      setVendors(Array.isArray(a) ? a as Vendor[] : []);
    }).catch(() => {});
    Promise.all([
      fetch("/api/internal/purchase-orders?status=in_transit&limit=500").then((r) => r.ok ? r.json() : []),
      fetch("/api/internal/purchase-orders?status=received&limit=500").then((r) => r.ok ? r.json() : []),
    ]).then(([a, b]) => {
      const merged = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])] as PO[];
      setPos(merged);
    }).catch(() => {});
  }, []);

  // When a vendor is picked, narrow the PO picker to that vendor's POs.
  const visiblePos = useMemo(() => vendorId ? pos.filter((p) => p.vendor_id === vendorId) : pos, [pos, vendorId]);

  async function save() {
    setErr(null);
    if (!vendorId) { setErr("Pick a vendor."); return; }
    if (!invoiceNumber.trim()) { setErr("Enter the vendor invoice number."); return; }
    const cents = Math.round((Number(totalDollars) || 0) * 100);
    if (!Number.isFinite(cents) || cents < 0) { setErr("Enter a valid total."); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        vendor_id: vendorId,
        vendor_invoice_number: invoiceNumber.trim(),
        invoice_date: invoiceDate,
        due_date: dueDate || undefined,
        total_cents: cents,
        purchase_order_id: poId || undefined,
      };
      const r = await fetch("/api/internal/procurement/vendor-invoice-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const status = j?.three_way_match_status || "pending";
      notify(`Vendor invoice saved — match status: ${status}.`, status === "matched" ? "success" : status === "variance" || status === "exception" ? "error" : "info");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>New vendor invoice</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <Field label="Vendor">
          <SearchableSelect value={vendorId || null} onChange={(v) => setVendorId(v)}
            options={[{ value: "", label: "(pick a vendor…)" }, ...vendors.map((vd) => ({ value: vd.id, label: vd.code ? `${vd.code} — ${vd.name}` : vd.name, searchHaystack: `${vd.code || ""} ${vd.name}` }))]}
            placeholder="(pick a vendor…)" />
        </Field>
        <Field label="Vendor invoice #"><input type="text" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} style={inputStyle} placeholder="e.g. INV-10293" /></Field>
        <Field label="Invoice date"><input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} style={inputStyle} /></Field>
        <Field label="Due date (optional)"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={inputStyle} /></Field>
        <Field label="Invoice total $"><input type="text" inputMode="decimal" value={totalDollars} onChange={(e) => setTotalDollars(e.target.value)} style={inputStyle} placeholder="0.00" /></Field>
        <Field label="Purchase order (in-transit / received — optional)">
          <SearchableSelect value={poId || null} onChange={(v) => setPoId(v)}
            options={[{ value: "", label: "(no PO — match later)" }, ...visiblePos.map((p) => ({ value: p.id, label: `${p.po_number || "(draft)"} — ${p.status} — ${fmtCents(p.total_cents)}`, searchHaystack: `${p.po_number || ""} ${p.status}` }))]}
            placeholder="(no PO — match later)" />
        </Field>
      </div>

      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
        Linking a PO auto-matches the invoice against its posted receipts (matched within $5 or 2%, whichever is greater).
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
        <button onClick={() => void save()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Save + match"}</button>
      </div>
    </Overlay>
  );
}

// ── Detail / match breakdown + actions ────────────────────────────────────
function DetailModal({ draftId, onClose, onChanged }: { draftId: string; onClose: () => void; onChanged: () => void }) {
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/vendor-invoice-drafts/${draftId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setDraft(await r.json() as DraftDetail);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [draftId]);

  const status = draft?.three_way_match_status || "";
  const isOpen = ["pending", "matched", "variance", "exception"].includes(status);

  async function patch(body: Record<string, unknown>, okMsg: string, kind: "success" | "info" | "error" = "success") {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/vendor-invoice-drafts/${draftId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(okMsg, kind);
      setDraft(j as DraftDetail);
      onChanged();
      return true;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(false); }
  }

  async function rematch() {
    const ok = await patch({ action: "rematch" }, "Re-matched.", "info");
    if (ok) void load(); // reload to refresh the breakdown numbers
  }
  async function approve() {
    if (!(await confirmDialog("Approve this invoice and create an AP invoice draft? The AP panel will post it to the GL.", { confirmText: "Approve", title: "Approve invoice" }))) return;
    await patch({ action: "approve" }, "AP invoice draft created — post it from the AP panel.", "success");
  }
  async function reject() {
    const reason = await promptDialog("Reason for rejecting this vendor invoice?", { title: "Reject invoice", icon: "", multiline: true, required: true });
    if (reason === null) return;
    if (!reason.trim()) { notify("A reason is required to reject.", "error"); return; }
    if (!(await confirmDialog(`Reject this invoice?\n\n${reason.trim()}`, { confirmText: "Reject", title: "Reject invoice" }))) return;
    await patch({ action: "reject", reason: reason.trim() }, "Invoice rejected.", "info");
  }

  const m = draft?.match;

  return (
    <Overlay onClose={onClose}>
      <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>
        {draft ? `${draft.vendor_name || "(vendor)"} — ${draft.vendor_invoice_number}` : "Vendor invoice"}
      </h3>
      {draft && (
        <div style={{ marginBottom: 16, fontSize: 13, color: C.textSub }}>
          <span style={{ color: STATUS_COLORS[status] || C.text, fontWeight: 600 }}>● {status}</span>
          {" · "}{fmtDateDisplay(draft.invoice_date)}{draft.due_date ? ` · due ${fmtDateDisplay(draft.due_date)}` : ""}
        </div>
      )}

      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}

      {draft && !loading && (
        <>
          {/* Match summary */}
          <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14, marginBottom: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 10 }}>
              <Stat label="PO #" value={m?.po_number || "(none)"} mono />
              <Stat label="PO total" value={fmtCents(m?.po_total_cents)} />
              <Stat label="Invoice total" value={fmtCents(m?.invoice_total_cents ?? draft.total_cents)} />
              <Stat label="Received + accepted value" value={fmtCents(m?.received_value_cents ?? 0)} />
              <Stat label="Variance (invoice − received)" value={fmtCents(m?.variance_cents ?? draft.variance_cents)} color={Number(m?.variance_cents ?? draft.variance_cents) !== 0 ? C.warn : C.success} />
              <Stat label="Tolerance ($5 or 2%)" value={fmtCents(m?.tolerance_cents ?? 0)} />
            </div>
            <div style={{ fontSize: 13 }}>
              {m && m.purchase_order_id ? (
                m.received_value_cents === 0
                  ? <span style={{ color: C.danger, fontWeight: 600 }}>Exception — no posted receipt found for the linked PO.</span>
                  : m.within_tolerance
                    ? <span style={{ color: C.success, fontWeight: 600 }}>✓ Within tolerance — matched.</span>
                    : <span style={{ color: C.warn, fontWeight: 600 }}>Variance exceeds tolerance.</span>
              ) : <span style={{ color: C.textMuted }}>No PO linked — re-match is unavailable.</span>}
            </div>
            {draft.variance_reason && <div style={{ marginTop: 6, fontSize: 12, color: C.textMuted }}>{draft.variance_reason}</div>}
            {draft.rejected_reason && <div style={{ marginTop: 6, fontSize: 12, color: C.danger }}>Rejected: {draft.rejected_reason}</div>}
            {draft.ap_invoice_id && <div style={{ marginTop: 6, fontSize: 12, color: C.primary }}>AP invoice draft created — post it from the AP panel.</div>}
          </div>

          {/* Per-line breakdown */}
          {m && m.lines.length > 0 && (
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <th style={th}>Line</th><th style={th}>Description</th>
                  <th style={{ ...th, textAlign: "right" }}>Ordered</th><th style={{ ...th, textAlign: "right" }}>Accepted</th>
                  <th style={{ ...th, textAlign: "right" }}>Unit $</th><th style={{ ...th, textAlign: "right" }}>Received value</th>
                </tr></thead>
                <tbody>
                  {m.lines.map((l) => (
                    <tr key={l.purchase_order_line_id}>
                      <td style={td}>{l.line_number ?? "—"}</td>
                      <td style={td}>{l.description || <span style={{ color: C.textMuted }}>(no desc)</span>}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.qty_ordered != null ? l.qty_ordered.toLocaleString() : "—"}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.qty_accepted.toLocaleString()}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(l.unit_cost_cents)}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(l.line_received_value_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
            <button onClick={onClose} style={btnSecondary} disabled={busy}>Close</button>
            {isOpen && m && m.purchase_order_id && <button onClick={() => void rematch()} style={btnSecondary} disabled={busy}>{busy ? "…" : "Re-match"}</button>}
            {isOpen && <button onClick={() => void reject()} style={btnDangerSolid} disabled={busy}>Reject</button>}
            {isOpen && <button onClick={() => void approve()} style={btnSuccess} disabled={busy} title="Create an AP invoice draft (no JE posted here)">Approve → AP draft</button>}
          </div>
        </>
      )}
    </Overlay>
  );
}

function Stat({ label, value, color, mono }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: color || C.text, fontVariantNumeric: "tabular-nums", fontFamily: mono ? "SFMono-Regular, Menlo, monospace" : undefined }}>{value}</div>
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(920px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
