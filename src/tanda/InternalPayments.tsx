import { useEffect, useState } from "react";

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

  async function transition(id: string, action: "processing" | "completed" | "failed" | "cancelled") {
    if (!confirm(`Mark payment ${action}?`)) return;
    const r = await fetch(`/api/internal/payments/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!r.ok) { alert(await r.text()); return; }
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
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={selectSt}>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectSt}>
            <option value="">All</option>
            <option value="initiated">Initiated</option>
            <option value="processing">Processing</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button onClick={() => setCreateOpen(true)} style={btnPrimary}>+ New payment</button>
        </div>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No payments.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 120px 100px 120px 120px 1fr", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Vendor / Invoice</div><div>Amount</div><div>Method</div><div>Status</div><div>Initiated</div><div>Completed</div><div style={{ textAlign: "right" }}>Action</div>
          </div>
          {rows.map((p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 120px 100px 120px 120px 1fr", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{p.vendor?.name || p.vendor_id}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{p.invoice?.invoice_number ? `Inv ${p.invoice.invoice_number}` : (p.reference || "—")}</div>
              </div>
              <div><strong>{p.currency} {Number(p.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
              <div style={{ color: C.textSub, fontSize: 11, textTransform: "uppercase" }}>{p.method}</div>
              <div><StatusChip status={p.status} /></div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{new Date(p.initiated_at).toLocaleDateString()}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{p.completed_at ? new Date(p.completed_at).toLocaleDateString() : "—"}</div>
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

  async function save() {
    if (!vendorId || !amount) { alert("Vendor and amount are required."); return; }
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
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 500 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>New payment</h3>
        <Row label="Vendor">
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} style={inp}>
            <option value="">Select…</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Row>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <Row label="Amount"><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} style={inp} /></Row>
          <Row label="Currency"><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} style={inp} /></Row>
        </div>
        <Row label="Method">
          <select value={method} onChange={(e) => setMethod(e.target.value)} style={inp}>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Row>
        <Row label="Invoice ID (optional)"><input value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} placeholder="UUID" style={inp} /></Row>
        <Row label="Reference (optional)"><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ACH batch ref, check #, etc." style={inp} /></Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Creating…" : "Create"}</button>
        </div>
      </div>
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

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box" } as const;
const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const btnMini = { padding: "3px 10px", borderRadius: 4, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const, color: C.text };
