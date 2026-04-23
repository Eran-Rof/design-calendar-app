import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import StatusBadge, { disputeTone } from "./StatusBadge";
import { fmtDate } from "./utils";
import { showAlert } from "./ui/AppDialog";

interface POOption { uuid_id: string; po_number: string }
interface InvoiceOption { id: string; invoice_number: string; po_id: string | null }

interface Dispute {
  id: string;
  subject: string;
  type: string;
  status: string;
  priority: string;
  created_at: string;
  last_message_at: string;
  unread_count: number;
  po_id: string | null;
  invoice_id: string | null;
}

const TYPES = [
  { value: "invoice_discrepancy", label: "Invoice discrepancy" },
  { value: "payment_delay",       label: "Payment delay" },
  { value: "damaged_goods",       label: "Damaged goods" },
  { value: "other",               label: "Other" },
];

const PRIORITIES = ["low", "medium", "high"];

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

function statusLabel(s: string) {
  if (s === "under_review") return "Under review";
  return s[0].toUpperCase() + s.slice(1);
}

export default function VendorDisputes() {
  const [rows, setRows] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/disputes", { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json() as Dispute[];
      setRows(data);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  if (loading) return <div style={{ color: TH.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#FFFFFF", fontSize: 20 }}>Disputes</h2>
        <button onClick={() => setCreateOpen(true)} style={btnPrimary}>+ Open dispute</button>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.8fr 150px 100px 130px 130px 60px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
          <div>Subject</div>
          <div>Type</div>
          <div>Priority</div>
          <div>Opened</div>
          <div>Last activity</div>
          <div style={{ textAlign: "center" }}>Status</div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No disputes yet.</div>
        ) : rows.map((d) => (
          <Link key={d.id} to={`/vendor/disputes/${d.id}`} style={{ display: "grid", gridTemplateColumns: "1.8fr 150px 100px 130px 130px 60px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", textDecoration: "none", color: "inherit" }}>
            <div>
              <div style={{ fontWeight: 600, color: TH.text, display: "flex", alignItems: "center", gap: 8 }}>
                {d.subject}
                {d.unread_count > 0 && (
                  <span style={{ background: TH.primary, color: "#FFFFFF", fontSize: 10, borderRadius: 8, padding: "1px 6px", fontWeight: 700 }}>{d.unread_count}</span>
                )}
              </div>
            </div>
            <div style={{ color: TH.textSub2, textTransform: "capitalize" }}>{d.type.replace(/_/g, " ")}</div>
            <div style={{ color: d.priority === "high" ? TH.primary : TH.textSub2, textTransform: "capitalize", fontWeight: d.priority === "high" ? 600 : 400 }}>{d.priority}</div>
            <div style={{ color: TH.textSub2 }}>{fmtDate(d.created_at)}</div>
            <div style={{ color: TH.textSub2 }}>{fmtDate(d.last_message_at)}</div>
            <div style={{ textAlign: "center" }}><StatusBadge label={statusLabel(d.status)} tone={disputeTone(d.status)} /></div>
          </Link>
        ))}
      </div>

      {createOpen && (
        <DisputeCreateModal onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void load(); }} />
      )}
    </div>
  );
}

function DisputeCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [type, setType] = useState("invoice_discrepancy");
  const [priority, setPriority] = useState("medium");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [poId, setPoId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [pos, setPos] = useState<POOption[]>([]);
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const [{ data: poRows }, { data: invRows }] = await Promise.all([
        supabaseVendor.from("tanda_pos").select("uuid_id, po_number, data").order("date_order", { ascending: false }),
        supabaseVendor.from("invoices").select("id, invoice_number, po_id, submitted_at").order("submitted_at", { ascending: false }),
      ]);
      const activePos = ((poRows ?? []) as (POOption & { data: { _archived?: boolean } | null })[])
        .filter((r) => !r.data?._archived)
        .map((r) => ({ uuid_id: r.uuid_id, po_number: r.po_number }));
      setPos(activePos);
      setInvoices((invRows ?? []) as InvoiceOption[]);
    })();
  }, []);

  // When a PO is picked, narrow the invoice list so the user only sees invoices on that PO.
  const invoiceOptions = poId ? invoices.filter((i) => i.po_id === poId) : invoices;

  // Cross-validate the current selection. If the user manages to pair a
  // PO with an invoice from a different PO, surface it clearly.
  const selectedInvoice = invoiceId ? invoices.find((i) => i.id === invoiceId) : null;
  const mismatch = Boolean(poId && selectedInvoice && selectedInvoice.po_id && selectedInvoice.po_id !== poId);

  async function submit() {
    if (!subject.trim() || !body.trim()) { await showAlert({ title: "Missing fields", message: "Subject and details are required.", tone: "warn" }); return; }
    if (mismatch) {
      await showAlert({
        title: "PO / Invoice don't match",
        message: "The selected invoice belongs to a different PO than the one you picked. Clear one of them or pick a matching pair before opening the dispute.",
        tone: "warn",
      });
      return;
    }
    setSubmitting(true);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          type, priority, subject: subject.trim(), body: body.trim(),
          po_id: poId || undefined, invoice_id: invoiceId || undefined,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onCreated();
    } catch (e: unknown) {
      await showAlert({ title: "Failed", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: TH.surface, borderRadius: 10, padding: 22, width: 560, maxWidth: "92vw", boxShadow: "0 10px 40px rgba(0,0,0,0.3)", maxHeight: "90vh", overflowY: "auto" }}>
        <h3 style={{ margin: "0 0 14px", color: TH.text, fontSize: 16 }}>Open a new dispute</h3>
        <Row label="Type">
          <select value={type} onChange={(e) => setType(e.target.value)} style={inp}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Row>
        <Row label="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inp}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
          </select>
        </Row>
        <Row label="Subject">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Brief summary" style={inp} />
        </Row>
        <Row label="Details">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} style={{ ...inp, resize: "vertical" }} />
        </Row>
        <Row label="Related PO (optional)">
          <select
            value={poId}
            onChange={(e) => {
              const newPo = e.target.value;
              setPoId(newPo);
              if (!newPo) return; // cleared — leave invoice alone
              const currentInv = invoiceId ? invoices.find((i) => i.id === invoiceId) : null;
              // If no invoice yet, auto-pick the newest one on this PO.
              if (!currentInv) {
                const firstOnPo = invoices.find((i) => i.po_id === newPo);
                if (firstOnPo) setInvoiceId(firstOnPo.id);
                return;
              }
              // If selected invoice belongs to a different PO, swap it for
              // the first invoice on the new PO (or clear if none exist).
              if (currentInv.po_id && currentInv.po_id !== newPo) {
                const firstOnPo = invoices.find((i) => i.po_id === newPo);
                setInvoiceId(firstOnPo ? firstOnPo.id : "");
              }
            }}
            style={inp}
          >
            <option value="">— None —</option>
            {pos.map((p) => <option key={p.uuid_id} value={p.uuid_id}>{p.po_number}</option>)}
          </select>
        </Row>
        <Row label="Related invoice (optional)">
          <select
            value={invoiceId}
            onChange={(e) => {
              const newInv = e.target.value;
              setInvoiceId(newInv);
              if (!newInv) return;
              // Auto-fill the PO to match the invoice's po_id.
              const inv = invoices.find((i) => i.id === newInv);
              if (inv?.po_id && inv.po_id !== poId) setPoId(inv.po_id);
            }}
            style={inp}
          >
            <option value="">— None —</option>
            {invoiceOptions.map((i) => (
              <option key={i.id} value={i.id}>{i.invoice_number}</option>
            ))}
          </select>
          {poId && invoiceOptions.length === 0 && (
            <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>No invoices on that PO yet.</div>
          )}
        </Row>
        {mismatch && (
          <div style={{ marginTop: 4, marginBottom: 10, padding: "8px 12px", background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 6, fontSize: 12, color: "#92400E" }}>
            ⚠ The selected invoice belongs to a different PO. Clear one before opening the dispute.
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void submit()} disabled={submitting} style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }}>{submitting ? "Opening…" : "Open dispute"}</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 16px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
