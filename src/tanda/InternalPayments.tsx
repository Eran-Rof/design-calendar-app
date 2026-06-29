import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { useSort, type SortDir } from "./hooks/useSort";

interface Payment {
  id: string;
  entity_id: string;
  invoice_id: string | null;
  vendor_id: string;
  amount: number;
  currency: string;
  method: string;
  status: "initiated" | "processing" | "completed" | "failed" | "cancelled";
  reference: string | null;
  initiated_at: string;
  completed_at: string | null;
  vendor?: { id: string; name: string } | null;
  invoice?: { id: string; invoice_number: string; total: number } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const METHODS = ["ach", "wire", "virtual_card", "check", "paypal", "wise", "manual"];

export default function InternalPayments() {
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([]);
  const [entityId, setEntityId] = useState("");
  const [rows, setRows] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/internal/entities?flat=true");
      if (r.ok) {
        const e = await r.json() as { id: string; name: string }[];
        setEntities(e);
        if (e.length && !entityId) setEntityId(e[0].id);
      }
    })();
  }, []);

  async function load() {
    if (!entityId) return;
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams({ entity_id: entityId });
      if (status) params.set("status", status);
      const r = await fetch(`/api/internal/payments?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Payment[] };
      setRows(d.rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [entityId, status]);

  // #5 Sortable columns — div-grid "table", so the useSort hook drives the
  // order and a small clickable header cell renders the ▲▼ affordance.
  const { sorted: sortedRows, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:payments:sort",
    accessors: {
      vendor: (p) => p.vendor?.name || p.vendor_id,
      amount: (p) => Number(p.amount),
      method: (p) => p.method,
      status: (p) => p.status,
      initiated: (p) => p.initiated_at,
      completed: (p) => p.completed_at,
    },
  });

  async function transition(id: string, action: "processing" | "completed" | "failed" | "cancelled") {
    if (!(await confirmDialog(`Mark payment ${action}?`))) return;
    const r = await fetch(`/api/internal/payments/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Payments</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Outbound payments register. Create, track, and transition through the status machine.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ minWidth: 180 }}>
            <SearchableSelect value={entityId || null} onChange={(v) => setEntityId(v)}
              options={entities.map((e) => ({ value: e.id, label: e.name }))} inputStyle={selectSt} />
          </div>
          <div style={{ minWidth: 140 }}>
            <SearchableSelect value={status || null} onChange={(v) => setStatus(v)}
              options={[
                { value: "", label: "All" },
                { value: "initiated", label: "Initiated" },
                { value: "processing", label: "Processing" },
                { value: "completed", label: "Completed" },
                { value: "failed", label: "Failed" },
                { value: "cancelled", label: "Cancelled" },
              ]} placeholder="All" inputStyle={selectSt} />
          </div>
          <button onClick={() => setCreateOpen(true)} style={btnPrimary}>+ New payment</button>
          <ExportButton
            rows={rows.map((p) => ({
              ...p,
              vendor_name: p.vendor?.name || p.vendor_id,
              invoice_number: p.invoice?.invoice_number || null,
            })) as unknown as Array<Record<string, unknown>>}
            filename="payments"
            sheetName="Payments"
            columns={[
              { key: "vendor_name",      header: "Vendor" },
              { key: "invoice_number",   header: "Invoice #" },
              { key: "amount",           header: "Amount",      format: "number" },
              { key: "currency",         header: "Currency" },
              { key: "method",           header: "Method" },
              { key: "status",           header: "Status" },
              { key: "reference",        header: "Reference" },
              { key: "initiated_at",     header: "Initiated",   format: "datetime" },
              { key: "completed_at",     header: "Completed",   format: "datetime" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No payments.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 120px 100px 120px 120px 1fr", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <SortHeader label="Vendor / Invoice" k="vendor" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Amount" k="amount" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Method" k="method" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Status" k="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Initiated" k="initiated" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Completed" k="completed" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <div style={{ textAlign: "right" }}>Action</div>
          </div>
          {sortedRows.map((p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 120px 100px 120px 120px 1fr", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{p.vendor?.name || p.vendor_id}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{p.invoice?.invoice_number ? `Inv ${p.invoice.invoice_number}` : (p.reference || "—")}</div>
              </div>
              <div><strong>{p.currency} {Number(p.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
              <div style={{ color: C.textSub, fontSize: 11, textTransform: "uppercase" }}>{p.method}</div>
              <div><StatusChip status={p.status} /></div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{fmtDateDisplay(p.initiated_at)}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{p.completed_at ? fmtDateDisplay(p.completed_at) : "—"}</div>
              <div style={{ textAlign: "right", display: "flex", gap: 4, justifyContent: "flex-end" }}>
                {p.status === "initiated" && <>
                  <button onClick={() => void transition(p.id, "cancelled")} style={{ ...btnMini, color: C.danger }}>Cancel</button>
                  <button onClick={() => void transition(p.id, "processing")} style={btnMini}>Start</button>
                </>}
                {p.status === "processing" && <>
                  <button onClick={() => void transition(p.id, "failed")} style={{ ...btnMini, color: C.danger }}>Fail</button>
                  <button onClick={() => void transition(p.id, "completed")} style={{ ...btnMini, color: C.success }}>Complete</button>
                </>}
              </div>
            </div>
          ))}
        </div>
      )}

      {createOpen && entityId && <CreatePaymentModal entityId={entityId} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void load(); }} />}
    </div>
  );
}

function CreatePaymentModal({ entityId, onClose, onCreated }: { entityId: string; onClose: () => void; onCreated: () => void }) {
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [method, setMethod] = useState("ach");
  const [reference, setReference] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [saving, setSaving] = useState(false);
  // AP invoices for the picker (scoped to the chosen vendor) — no raw UUID box.
  const [invoiceOpts, setInvoiceOpts] = useState<Array<{ id: string; invoice_number: string | null }>>([]);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/internal/vendors");
      if (r.ok) {
        const d = await r.json();
        const list = Array.isArray(d) ? d : (d.rows || []);
        setVendors(list);
      }
    })();
  }, []);

  // Reload invoice options whenever the vendor changes; clear any prior pick
  // that no longer belongs to the selected vendor.
  useEffect(() => {
    setInvoiceId("");
    void (async () => {
      try {
        const qs = vendorId ? `?vendor_id=${encodeURIComponent(vendorId)}` : "";
        const r = await fetch(`/api/internal/ap-invoices${qs}`);
        if (!r.ok) return;
        const data = await r.json();
        if (Array.isArray(data)) setInvoiceOpts(data);
      } catch { /* non-fatal */ }
    })();
  }, [vendorId]);

  async function save() {
    if (!vendorId || !amount) { notify("Vendor and amount are required.", "error"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/payments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId, vendor_id: vendorId,
          invoice_id: invoiceId.trim() || null,
          amount: Number(amount), currency, method,
          reference: reference.trim() || null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onCreated();
    } catch (e: unknown) { notify(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 500 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>New payment</h3>
        <Row label="Vendor">
          <SearchableSelect value={vendorId || null} onChange={(v) => setVendorId(v)}
            options={[{ value: "", label: "Select…" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]}
            placeholder="Select…" inputStyle={inp} />
        </Row>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <Row label="Amount"><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} style={inp} /></Row>
          <Row label="Currency"><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} style={inp} /></Row>
        </div>
        <Row label="Method">
          <SearchableSelect value={method || null} onChange={(v) => setMethod(v)}
            options={METHODS.map((m) => ({ value: m, label: m }))} inputStyle={inp} />
        </Row>
        <Row label="Invoice (optional)">
          <SearchableSelect
            value={invoiceId || null}
            onChange={(v) => setInvoiceId(v || "")}
            options={[
              { value: "", label: "None" },
              ...invoiceOpts.map((iv) => ({
                value: iv.id,
                label: iv.invoice_number || "(no number)",
                searchHaystack: `${iv.invoice_number || ""}`,
              })),
            ]}
            placeholder={vendorId ? "Search invoice by number…" : "Pick a vendor first"}
            emptyText={vendorId ? "No invoices for this vendor" : "Pick a vendor first"}
          />
        </Row>
        <Row label="Reference (optional)"><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ACH batch ref, check #, etc." style={inp} /></Row>
        <div style={{ position: "sticky", bottom: -22, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "16px -22px -22px", padding: "14px 22px", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Creating…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

// Clickable sortable header cell for the div-grid "table" (mirrors SortableTh's
// ▲▼ affordance without the <th> markup the grid layout can't use).
function SortHeader({ label, k, activeKey, dir, onSort, align }: {
  label: string; k: string; activeKey: string | null; dir: SortDir;
  onSort: (key: string) => void; align?: "right";
}) {
  const active = activeKey === k;
  const indicator = active ? (dir === "asc" ? " ▲" : " ▼") : " ▲";
  return (
    <div
      onClick={() => onSort(k)}
      title={`Sort by ${label}`}
      style={{ cursor: "pointer", userSelect: "none", textAlign: align, ...(active ? { color: C.text } : null) }}
    >
      {label}
      <span aria-hidden="true" style={{ opacity: active ? 1 : 0 }}>{indicator}</span>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = status === "completed" ? C.success
    : status === "failed" || status === "cancelled" ? C.danger
    : status === "processing" ? C.warn : C.primary;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" } as const;
const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13, colorScheme: "dark" } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const btnMini = { padding: "3px 10px", borderRadius: 4, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const, color: C.text };
