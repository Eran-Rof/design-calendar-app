// src/tanda/InternalBrokerInvoices.tsx
//
// P13-C3 — Trade Compliance vertical. Customs-broker invoices (freight,
// brokerage, duty advance, other) optionally tied to a customs entry, with an
// allocation method for the eventual landed-cost spread. List + create/edit
// modal.
//
// Data-only / draft. NO AP invoice is created and NO allocation JE is posted
// here — the landed-cost allocation onto FIFO inventory layers posts in a LATER
// chunk.
//
// Mirrors InternalReceiving.tsx conventions (C palette, th/td/input/button
// styles, SearchableSelect, notify/confirmDialog, Field helper, ExportButton).

import { useEffect, useMemo, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import SearchableSelect from "./components/SearchableSelect";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

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
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" };

type BrokerInvoice = {
  id: string; customs_entry_id: string | null; vendor_id: string;
  broker_invoice_number: string; invoice_date: string;
  freight_cents: number | string; brokerage_fee_cents: number | string;
  duty_advance_cents: number | string; other_cents: number | string;
  total_cents: number | string; allocation_method: string;
  ap_invoice_id: string | null; allocation_je_id: string | null;
  tanda_po_receipt_id?: string | null;
  vendor_name?: string | null; customs_entry_number?: string | null;
};
type Vendor = { id: string; name: string; code?: string };
type CustomsEntryOpt = { id: string; entry_number: string; entry_date?: string };

const ALLOCATION_METHODS = ["value", "weight", "cbm", "manual"];

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
function dollarsToCents(s: string): number { return Math.round((Number(s) || 0) * 100); }
function centsToDollars(c: number | string | null | undefined): string {
  return c == null || c === "" ? "" : (Number(c) / 100).toFixed(2);
}

const EXPORT_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: "broker_invoice_number", header: "Broker invoice #" },
  { key: "vendor_name", header: "Vendor" },
  { key: "invoice_date", header: "Date", format: "date" },
  { key: "customs_entry_number", header: "Customs entry #" },
  { key: "freight_cents", header: "Freight", format: "currency_cents" },
  { key: "brokerage_fee_cents", header: "Brokerage", format: "currency_cents" },
  { key: "duty_advance_cents", header: "Duty advance", format: "currency_cents" },
  { key: "other_cents", header: "Other", format: "currency_cents" },
  { key: "total_cents", header: "Total", format: "currency_cents" },
  { key: "allocation_method", header: "Allocation" },
];

export default function InternalBrokerInvoices() {
  const [rows, setRows] = useState<BrokerInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BrokerInvoice | null>(null);
  const [postFor, setPostFor] = useState<BrokerInvoice | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/broker-invoices?limit=500`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as BrokerInvoice[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.broker_invoice_number} ${r.vendor_name || ""} ${r.customs_entry_number || ""}`.toLowerCase().includes(q));
  }, [rows, search]);

  const exportRows = useMemo(() => filtered.map((r) => ({
    broker_invoice_number: r.broker_invoice_number,
    vendor_name: r.vendor_name || "",
    invoice_date: r.invoice_date,
    customs_entry_number: r.customs_entry_number || "",
    freight_cents: r.freight_cents,
    brokerage_fee_cents: r.brokerage_fee_cents,
    duty_advance_cents: r.duty_advance_cents,
    other_cents: r.other_cents,
    total_cents: r.total_cents,
    allocation_method: r.allocation_method,
  })), [filtered]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Broker Invoices</h2>
        <button style={btnPrimary} onClick={() => { setEditing(null); setModalOpen(true); }}>+ New broker invoice</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search invoice # / vendor / entry…" style={{ ...inputStyle, width: 280 }} />
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <ExportButton rows={exportRows} columns={EXPORT_COLUMNS} filename="broker-invoices" sheetName="Broker Invoices" />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Broker invoice #</th><th style={th}>Vendor</th><th style={th}>Date</th>
            <th style={{ ...th, textAlign: "right" }}>Freight</th><th style={{ ...th, textAlign: "right" }}>Brokerage</th>
            <th style={{ ...th, textAlign: "right" }}>Duty advance</th><th style={{ ...th, textAlign: "right" }}>Other</th>
            <th style={{ ...th, textAlign: "right" }}>Total</th>
            <th style={th}>Landed cost</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={9}>Loading…</td></tr>}
            {!loading && filtered.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={9}>No broker invoices.</td></tr>}
            {filtered.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => { setEditing(r); setModalOpen(true); }}>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.broker_invoice_number}</td>
                <td style={td}>{r.vendor_name || <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={td}>{fmtDateDisplay(r.invoice_date)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.freight_cents)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.brokerage_fee_cents)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.duty_advance_cents)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.other_cents)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{fmtCents(r.total_cents)}</td>
                <td style={td} onClick={(e) => e.stopPropagation()}>
                  {r.allocation_je_id
                    ? <span style={{ color: C.success, fontSize: 12 }}>✓ Posted</span>
                    : <button style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }} onClick={() => setPostFor(r)}>Post landed cost</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <BrokerInvoiceModal
          invoice={editing}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSaved={() => { setModalOpen(false); setEditing(null); void load(); }}
        />
      )}
      {postFor && (
        <PostLandedCostModal
          invoice={postFor}
          onClose={() => setPostFor(null)}
          onPosted={() => { setPostFor(null); void load(); }}
        />
      )}
    </div>
  );
}

function PostLandedCostModal({ invoice, onClose, onPosted }: { invoice: BrokerInvoice; onClose: () => void; onPosted: () => void }) {
  const [receipts, setReceipts] = useState<Array<{ id: string; receipt_date: string; landed_cost_cents: number | null }>>([]);
  const [receiptId, setReceiptId] = useState(invoice.tanda_po_receipt_id || "");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/procurement/receipts?status=posted")
      .then((r) => (r.ok ? r.json() : []))
      .then((a) => setReceipts(Array.isArray(a) ? a : []))
      .catch(() => setReceipts([]));
  }, []);

  async function doPost() {
    if (!receiptId) { setErr("Pick a posted receipt to allocate onto."); return; }
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/broker-invoices/${invoice.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "post", tanda_po_receipt_id: receiptId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Landed cost posted.", "success");
      onPosted();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>Post landed cost — {invoice.broker_invoice_number}</h3>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
          Allocates <b>{fmtCents(invoice.total_cents)}</b> across the chosen posted receipt&apos;s accepted units (by value):
          in-stock units have their FIFO layer cost revalued up; the share on units already sold is expensed to Landed Cost Variance (5150). Books the broker AP bill. This cannot be undone here.
        </div>
        <Field label="Posted receipt to allocate onto">
          <SearchableSelect
            value={receiptId || null}
            onChange={(v) => setReceiptId(v)}
            options={[
              { value: "", label: "— pick a posted receipt —" },
              ...receipts.map((rc) => ({ value: rc.id, label: `${rc.receipt_date} · landed ${fmtCents(rc.landed_cost_cents)}` })),
            ]}
            placeholder="— pick a posted receipt —"
            inputStyle={inputStyle}
          />
        </Field>
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, margin: "12px 0", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void doPost()} style={btnPrimary} disabled={submitting || !receiptId}>{submitting ? "Posting…" : "Post landed cost"}</button>
        </div>
      </div>
    </div>
  );
}

function BrokerInvoiceModal({ invoice, onClose, onSaved }: { invoice: BrokerInvoice | null; onClose: () => void; onSaved: () => void }) {
  const isNew = invoice === null;

  const [savedId, setSavedId] = useState<string | null>(invoice?.id || null);
  const [vendorId, setVendorId] = useState(invoice?.vendor_id || "");
  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.broker_invoice_number || "");
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoice_date || new Date().toISOString().slice(0, 10));
  const [customsEntryId, setCustomsEntryId] = useState(invoice?.customs_entry_id || "");
  const [freightDollars, setFreightDollars] = useState(centsToDollars(invoice?.freight_cents));
  const [brokerageDollars, setBrokerageDollars] = useState(centsToDollars(invoice?.brokerage_fee_cents));
  const [dutyAdvanceDollars, setDutyAdvanceDollars] = useState(centsToDollars(invoice?.duty_advance_cents));
  const [otherDollars, setOtherDollars] = useState(centsToDollars(invoice?.other_cents));
  const [allocationMethod, setAllocationMethod] = useState(invoice?.allocation_method || "value");

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [customsEntries, setCustomsEntries] = useState<CustomsEntryOpt[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/vendor-master?limit=1000").then((r) => r.ok ? r.json() : []).then((a) => {
      setVendors(Array.isArray(a) ? a as Vendor[] : []);
    }).catch(() => {});
    fetch("/api/internal/procurement/customs-entries?limit=500").then((r) => r.ok ? r.json() : []).then((a) => {
      setCustomsEntries(Array.isArray(a) ? a as CustomsEntryOpt[] : []);
    }).catch(() => {});
  }, []);

  // Computed component sum — the total must be >= this (server enforces too).
  const componentSum = useMemo(
    () => dollarsToCents(freightDollars) + dollarsToCents(brokerageDollars) + dollarsToCents(dutyAdvanceDollars) + dollarsToCents(otherDollars),
    [freightDollars, brokerageDollars, dutyAdvanceDollars, otherDollars],
  );

  async function save(): Promise<string | null> {
    setErr(null);
    if (!vendorId) { setErr("Pick a vendor."); return null; }
    if (!invoiceNumber.trim()) { setErr("Broker invoice number is required."); return null; }
    setSubmitting(true);
    try {
      const body = {
        vendor_id: vendorId,
        broker_invoice_number: invoiceNumber.trim(),
        invoice_date: invoiceDate,
        customs_entry_id: customsEntryId || null,
        freight_cents: dollarsToCents(freightDollars),
        brokerage_fee_cents: dollarsToCents(brokerageDollars),
        duty_advance_cents: dollarsToCents(dutyAdvanceDollars),
        other_cents: dollarsToCents(otherDollars),
        // total_cents omitted — server computes it from the components.
        allocation_method: allocationMethod,
      };
      let id = savedId;
      if (!id) {
        const r = await fetch("/api/internal/procurement/broker-invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        id = j?.id || null;
        setSavedId(id);
      } else {
        const r = await fetch(`/api/internal/procurement/broker-invoices/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      return id;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
    finally { setSubmitting(false); }
  }

  async function saveDraft() {
    const id = await save();
    if (id) { notify("Broker invoice saved.", "success"); onSaved(); }
  }

  async function del() {
    if (!savedId) return;
    if (!(await confirmDialog(`Delete broker invoice ${invoiceNumber}?`))) return;
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/broker-invoices/${savedId}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Broker invoice deleted.", "success");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(980px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New broker invoice" : `Broker invoice — ${invoice?.broker_invoice_number}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Vendor (customs broker)">
            <SearchableSelect value={vendorId || null} onChange={(v) => setVendorId(v)}
              options={[{ value: "", label: "(pick a vendor…)" }, ...vendors.map((vd) => ({ value: vd.id, label: vd.code ? `${vd.code} — ${vd.name}` : vd.name, searchHaystack: `${vd.code || ""} ${vd.name}` }))]}
              placeholder="(pick a vendor…)" />
          </Field>
          <Field label="Invoice date"><input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} style={inputStyle} /></Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
          <Field label="Broker invoice number"><input type="text" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} style={inputStyle} placeholder="e.g. BRK-10042" /></Field>
          <Field label="Linked customs entry (optional)">
            <SearchableSelect value={customsEntryId || null} onChange={(v) => setCustomsEntryId(v)}
              options={[{ value: "", label: "(no linked entry)" }, ...customsEntries.map((ce) => ({ value: ce.id, label: ce.entry_number, searchHaystack: ce.entry_number }))]}
              placeholder="(no linked entry)" />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Freight $"><input type="text" inputMode="decimal" value={freightDollars} onChange={(e) => setFreightDollars(e.target.value)} style={inputStyle} placeholder="0.00" /></Field>
          <Field label="Brokerage fee $"><input type="text" inputMode="decimal" value={brokerageDollars} onChange={(e) => setBrokerageDollars(e.target.value)} style={inputStyle} placeholder="0.00" /></Field>
          <Field label="Duty advance $"><input type="text" inputMode="decimal" value={dutyAdvanceDollars} onChange={(e) => setDutyAdvanceDollars(e.target.value)} style={inputStyle} placeholder="0.00" /></Field>
          <Field label="Other $"><input type="text" inputMode="decimal" value={otherDollars} onChange={(e) => setOtherDollars(e.target.value)} style={inputStyle} placeholder="0.00" /></Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12, alignItems: "end" }}>
          <Field label="Allocation method">
            <SearchableSelect
              value={allocationMethod || null}
              onChange={(v) => setAllocationMethod(v)}
              options={ALLOCATION_METHODS.map((m) => ({ value: m, label: m }))}
              inputStyle={inputStyle}
            />
          </Field>
          <div style={{ textAlign: "right", fontSize: 13, color: C.textSub }}>
            Total (computed): <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmtCents(componentSum)}</b>
          </div>
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
          Save the charges here, then use <b>Post landed cost</b> in the list to allocate them onto a posted receipt&apos;s FIFO layers (in-stock units revalued up, sold-units&apos; share expensed to Landed Cost Variance) and book the broker AP bill.
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <div>{savedId && <button onClick={() => void del()} style={btnDanger} disabled={submitting}>Delete</button>}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
            <button onClick={() => void saveDraft()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Save"}</button>
          </div>
        </div>
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
