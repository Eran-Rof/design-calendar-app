// src/tanda/InternalSalesOrders.tsx
//
// P16 / M10-B — native Sales Order entry. List + create/edit modal. Mirrors the
// AR-invoice modal patterns (customer/ship-to/brand/channel pickers, item
// SearchableSelect, supporting docs). SO number is system-assigned on Confirm.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import StagedDocsPicker from "../shared/documents/StagedDocsPicker";
import { uploadStagedDocs } from "../shared/documents/uploadDocument";
import { notify } from "../shared/ui/warn";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" };

type SO = {
  id: string; so_number: string | null; customer_id: string; ship_to_location_id: string | null;
  brand_id: string | null; channel_id: string | null; order_date: string; requested_ship_date: string | null;
  cancel_date: string | null; status: string; payment_terms_id: string | null; ar_account_id: string | null;
  revenue_account_id: string | null; notes: string | null; total_cents: number | string;
};
type SOLine = { key: number; inventory_item_id: string; description: string; qty_ordered: string; unit_price_dollars: string; revenue_account_id: string };
type Customer = { id: string; name: string; customer_code?: string };
type Item = { id: string; sku_code: string; style_code?: string; description?: string; color?: string; size?: string };
type Account = { id: string; code: string; name: string; is_postable: boolean; status: string };
type Lookup = { id: string; code?: string; name: string };
type ShipTo = { id: string; name: string; code?: string | null };

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
const STATUS_COLORS: Record<string, string> = {
  draft: C.textMuted, confirmed: C.primary, allocated: "#8B5CF6", fulfilling: C.warn,
  shipped: "#06B6D4", invoiced: C.success, closed: C.textSub, cancelled: C.danger,
};

export default function InternalSalesOrders() {
  const [rows, setRows] = useState<SO[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SO | null>(null);

  const customerName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of customers) m[c.id] = c.name;
    return m;
  }, [customers]);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("q", search.trim());
      const r = await fetch(`/api/internal/sales-orders?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as SO[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter]);
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=1000").then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setCustomers(a as Customer[]); }).catch(() => {});
  }, []);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>🛒 Sales Orders</h2>
        <button style={btnPrimary} onClick={() => { setEditing(null); setModalOpen(true); }}>+ New sales order</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...inputStyle, width: 180 }}>
          <option value="">All statuses</option>
          {["draft", "confirmed", "allocated", "fulfilling", "shipped", "invoiced", "closed", "cancelled"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} placeholder="Search SO #…" style={{ ...inputStyle, width: 200 }} />
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>SO #</th><th style={th}>Customer</th><th style={th}>Order date</th>
            <th style={th}>Req. ship</th><th style={th}>Status</th><th style={{ ...th, textAlign: "right" }}>Total</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={6}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={6}>No sales orders.</td></tr>}
            {rows.map((so) => (
              <tr key={so.id} style={{ cursor: "pointer" }} onClick={() => { setEditing(so); setModalOpen(true); }}>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{so.so_number || <span style={{ color: C.textMuted }}>(draft)</span>}</td>
                <td style={td}>{customerName[so.customer_id] || so.customer_id.slice(0, 8)}</td>
                <td style={td}>{so.order_date}</td>
                <td style={td}>{so.requested_ship_date || "—"}</td>
                <td style={td}><span style={{ color: STATUS_COLORS[so.status] || C.text, fontWeight: 600 }}>● {so.status}</span></td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(so.total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <SOModal
          so={editing}
          customers={customers}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSaved={() => { setModalOpen(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function SOModal({ so, customers, onClose, onSaved }: { so: SO | null; customers: Customer[]; onClose: () => void; onSaved: () => void }) {
  const isNew = so === null;
  const editable = isNew || so?.status === "draft";

  const [customerId, setCustomerId] = useState(so?.customer_id || "");
  const [shipToLocationId, setShipToLocationId] = useState(so?.ship_to_location_id || "");
  const [brandId, setBrandId] = useState(so?.brand_id || "");
  const [channelId, setChannelId] = useState(so?.channel_id || "");
  const [orderDate, setOrderDate] = useState(so?.order_date || new Date().toISOString().slice(0, 10));
  const [reqShip, setReqShip] = useState(so?.requested_ship_date || "");
  const [cancelDate, setCancelDate] = useState(so?.cancel_date || "");
  const [paymentTermsId, setPaymentTermsId] = useState(so?.payment_terms_id || "");
  const [notes, setNotes] = useState(so?.notes || "");
  const [lines, setLines] = useState<SOLine[]>([{ key: 1, inventory_item_id: "", description: "", qty_ordered: "", unit_price_dollars: "", revenue_account_id: "" }]);
  const [stagedDocs, setStagedDocs] = useState<File[]>([]);

  const [items, setItems] = useState<Item[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [brands, setBrands] = useState<Lookup[]>([]);
  const [channels, setChannels] = useState<Lookup[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<Lookup[]>([]);
  const [shipTos, setShipTos] = useState<ShipTo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/items?limit=500").then((r) => r.ok ? r.json() : []).then((a) => setItems(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/gl-accounts?limit=1000").then((r) => r.json()).then((a: Account[]) => setAccounts(Array.isArray(a) ? a.filter((x) => x.status === "active") : [])).catch(() => {});
    fetch("/api/internal/brands").then((r) => r.json()).then((d) => setBrands(Array.isArray(d.brands) ? d.brands : [])).catch(() => {});
    fetch("/api/internal/channels").then((r) => r.json()).then((d) => setChannels(Array.isArray(d.channels) ? d.channels : [])).catch(() => {});
    fetch("/api/internal/payment-terms?limit=200").then((r) => r.json()).then((a) => setPaymentTerms(Array.isArray(a) ? a : [])).catch(() => {});
  }, []);

  // Load existing SO lines when editing.
  useEffect(() => {
    if (isNew || !so) return;
    fetch(`/api/internal/sales-orders/${so.id}`).then((r) => r.ok ? r.json() : null).then((full) => {
      if (!full?.lines) return;
      setLines(full.lines.map((l: { inventory_item_id: string | null; description: string | null; qty_ordered: number; unit_price_cents: number; revenue_account_id: string | null }, i: number) => ({
        key: i + 1, inventory_item_id: l.inventory_item_id || "", description: l.description || "",
        qty_ordered: String(l.qty_ordered ?? ""), unit_price_dollars: l.unit_price_cents != null ? (l.unit_price_cents / 100).toFixed(2) : "",
        revenue_account_id: l.revenue_account_id || "",
      })));
    }).catch(() => {});
  }, [isNew, so]);

  // The customer's ship-to locations.
  useEffect(() => {
    if (!customerId) { setShipTos([]); return; }
    let cancel = false;
    fetch(`/api/internal/customer-locations?customer_id=${encodeURIComponent(customerId)}`).then((r) => r.ok ? r.json() : []).then((a) => { if (!cancel) setShipTos(Array.isArray(a) ? a : []); }).catch(() => {});
    return () => { cancel = true; };
  }, [customerId]);

  function updateLine(idx: number, patch: Partial<SOLine>) { setLines((p) => p.map((l, i) => i === idx ? { ...l, ...patch } : l)); }
  function addLine() { setLines((p) => [...p, { key: (p[p.length - 1]?.key ?? 0) + 1, inventory_item_id: "", description: "", qty_ordered: "", unit_price_dollars: "", revenue_account_id: "" }]); }
  function removeLine(idx: number) { setLines((p) => p.filter((_, i) => i !== idx)); }

  const totalCents = useMemo(() => lines.reduce((s, l) => {
    const qty = Number(l.qty_ordered) || 0; const unit = Math.round((Number(l.unit_price_dollars) || 0) * 100);
    return s + Math.round(qty * unit);
  }, 0), [lines]);

  function apiLines() {
    return lines
      .filter((l) => Number(l.qty_ordered) > 0)
      .map((l) => ({
        inventory_item_id: l.inventory_item_id || null,
        description: l.description.trim() || null,
        qty_ordered: Number(l.qty_ordered),
        unit_price_cents: Math.round((Number(l.unit_price_dollars) || 0) * 100),
        revenue_account_id: l.revenue_account_id || null,
      }));
  }

  async function save(confirm: boolean) {
    setErr(null);
    if (!customerId) { setErr("Pick a customer."); return; }
    if (apiLines().length === 0) { setErr("Add at least one line with a quantity."); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        customer_id: customerId, ship_to_location_id: shipToLocationId || null,
        brand_id: brandId || null, channel_id: channelId || null,
        order_date: orderDate, requested_ship_date: reqShip || null, cancel_date: cancelDate || null,
        payment_terms_id: paymentTermsId || null, notes: notes.trim() || null, lines: apiLines(),
      };

      let soId = so?.id || null;
      if (isNew) {
        const r = await fetch("/api/internal/sales-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const created = await r.json();
        soId = created?.id || null;
        if (soId && stagedDocs.length > 0) {
          try { await uploadStagedDocs("sales_orders", soId, stagedDocs); }
          catch (e) { notify(`SO saved, but a document upload failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
        }
      } else {
        const r = await fetch(`/api/internal/sales-orders/${so!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }

      if (confirm && soId) {
        const r = await fetch(`/api/internal/sales-orders/${soId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });
        if (!r.ok) throw new Error(`Saved, but confirm failed: ${(await r.json().catch(() => ({}))).error || `HTTP ${r.status}`}`);
        notify("Sales order confirmed — SO number assigned.", "success");
      }
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  const acctOpts = [{ value: "", label: "(header default)" }, ...accounts.filter((a) => a.is_postable).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))];

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 980, maxWidth: 1180, maxHeight: "90vh", overflowY: "auto", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New sales order" : `Sales order ${so?.so_number || "(draft)"} — ${so?.status}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Customer">
            <SearchableSelect value={customerId || null} onChange={(v) => { setCustomerId(v); setShipToLocationId(""); }}
              options={customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))}
              placeholder="(pick customer…)" disabled={!editable} />
          </Field>
          <Field label="Ship-to location">
            <SearchableSelect value={shipToLocationId || null} onChange={(v) => setShipToLocationId(v)}
              options={[{ value: "", label: "(none — default)" }, ...shipTos.map((s) => ({ value: s.id, label: s.code ? `${s.code} — ${s.name}` : s.name }))]}
              placeholder={customerId ? "(none — default)" : "(pick customer first)"} disabled={!editable || !customerId} />
          </Field>
          <Field label="SO number"><input type="text" value={so?.so_number || ""} readOnly disabled placeholder="(assigned on confirm)" style={{ ...inputStyle, opacity: 0.6 }} /></Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Order date"><input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Requested ship"><input type="date" value={reqShip} onChange={(e) => setReqShip(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Cancel date"><input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Payment terms">
            <SearchableSelect value={paymentTermsId || null} onChange={(v) => setPaymentTermsId(v)}
              options={[{ value: "", label: "(none)" }, ...paymentTerms.map((t) => ({ value: t.id, label: t.code ? `${t.code} — ${t.name}` : t.name }))]} placeholder="(none)" disabled={!editable} />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Brand">
            <SearchableSelect value={brandId || null} onChange={(v) => setBrandId(v)}
              options={[{ value: "", label: "(entity default)" }, ...brands.map((b) => ({ value: b.id, label: b.code ? `${b.code} — ${b.name}` : b.name }))]} placeholder="(entity default)" disabled={!editable} />
          </Field>
          <Field label="Channel">
            <SearchableSelect value={channelId || null} onChange={(v) => setChannelId(v)}
              options={[{ value: "", label: "(none)" }, ...channels.map((c) => ({ value: c.id, label: c.code ? `${c.code} — ${c.name}` : c.name }))]} placeholder="(none)" disabled={!editable} />
          </Field>
        </div>

        <Field label="Notes"><input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} style={inputStyle} placeholder="optional" /></Field>

        <div style={{ marginTop: 16, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines</div>
          {editable && <button onClick={addLine} style={btnSecondary}>+ Add line</button>}
        </div>
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup><col style={{ width: 36 }} /><col /><col style={{ width: 240 }} /><col style={{ width: 80 }} /><col style={{ width: 110 }} /><col style={{ width: 240 }} /><col style={{ width: 36 }} /></colgroup>
            <thead><tr>
              <th style={th}>#</th><th style={th}>Description</th><th style={th}>Item (optional)</th><th style={th}>Qty</th><th style={th}>Unit $</th><th style={th}>Revenue / offset acct</th><th style={th}></th>
            </tr></thead>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={l.key}>
                  <td style={td}>{idx + 1}</td>
                  <td style={td}><input type="text" value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} disabled={!editable} style={inputStyle} /></td>
                  <td style={td}>
                    <SearchableSelect value={l.inventory_item_id || null} onChange={(v) => updateLine(idx, { inventory_item_id: v })}
                      options={[{ value: "", label: "(none)" }, ...items.map((it) => ({ value: it.id, label: `${it.sku_code}${it.description ? ` — ${it.description}` : ""}`, searchHaystack: `${it.sku_code} ${it.style_code || ""} ${it.description || ""}` }))]}
                      placeholder="(none)" disabled={!editable} />
                  </td>
                  <td style={td}><input type="number" min="0" step="0.0001" value={l.qty_ordered} onChange={(e) => updateLine(idx, { qty_ordered: e.target.value })} disabled={!editable} style={inputStyle} /></td>
                  <td style={td}><input type="text" value={l.unit_price_dollars} onChange={(e) => updateLine(idx, { unit_price_dollars: e.target.value })} disabled={!editable} placeholder="0.00" style={inputStyle} /></td>
                  <td style={td}><SearchableSelect value={l.revenue_account_id || null} onChange={(v) => updateLine(idx, { revenue_account_id: v })} options={acctOpts} placeholder="(header default)" disabled={!editable} /></td>
                  <td style={td}>{editable && lines.length > 1 && <button type="button" onClick={() => removeLine(idx)} style={btnDanger}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td style={td} colSpan={4}><span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase" }}>Total</span></td><td style={{ ...td, fontWeight: 700 }} colSpan={3}>{fmtCents(totalCents)}</td></tr></tfoot>
          </table>
        </div>

        {/* Supporting documents — staged on new, in-place on existing. */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Supporting documents</div>
          {isNew
            ? <StagedDocsPicker files={stagedDocs} onChange={setStagedDocs} hint="attach the PO / order confirmation; uploaded when you save." />
            : so && <DocumentAttachmentList contextTable="sales_orders" contextId={so.id} kinds={["customer_po", "order_confirmation", "other"]} />}
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
          {editable && <button onClick={() => void save(false)} style={btnSecondary} disabled={submitting}>{submitting ? "Saving…" : isNew ? "Create draft" : "Save draft"}</button>}
          {editable && <button onClick={() => void save(true)} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Save & Confirm"}</button>}
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
