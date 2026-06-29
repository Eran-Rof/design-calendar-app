import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";
import StatusBadge, { disputeTone } from "../StatusBadge";
import { fmtDate } from "../utils";
import { showAlert } from "../ui/AppDialog";

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
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(k: string) {
    setSortKey((prev) => (prev === k ? (sortDir === "asc" ? k : null) : k));
    setSortDir((prev) => (sortKey === k && prev === "asc" ? "desc" : "asc"));
  }

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

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
    const scalar = (d: Dispute): string | number | null => {
      switch (sortKey) {
        case "subject": return d.subject || null;
        case "type": return d.type || null;
        case "priority": return PRIORITY_RANK[d.priority] ?? null;
        case "opened": return d.created_at || null;
        case "last_activity": return d.last_message_at || null;
        case "status": return statusLabel(d.status) || null;
        default: return null;
      }
    };
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = scalar(a);
      const vb = scalar(b);
      const aEmpty = va == null || va === "";
      const bEmpty = vb == null || vb === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    return arr;
  }, [rows, sortKey, sortDir]);

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
          <div onClick={() => toggleSort("subject")} style={{ cursor: "pointer", userSelect: "none" }}>Subject{sortKey === "subject" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("type")} style={{ cursor: "pointer", userSelect: "none" }}>Type{sortKey === "type" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("priority")} style={{ cursor: "pointer", userSelect: "none" }}>Priority{sortKey === "priority" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("opened")} style={{ cursor: "pointer", userSelect: "none" }}>Opened{sortKey === "opened" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("last_activity")} style={{ cursor: "pointer", userSelect: "none" }}>Last activity{sortKey === "last_activity" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("status")} style={{ textAlign: "center", cursor: "pointer", userSelect: "none" }}>Status{sortKey === "status" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
        </div>
        {sorted.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No disputes yet.</div>
        ) : sorted.map((d) => (
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: TH.surface, borderRadius: 10, padding: 22, width: "min(560px, 95vw)", boxSizing: "border-box", boxShadow: "0 10px 40px rgba(0,0,0,0.3)", maxHeight: "90vh", overflowY: "auto" }}>
        <h3 style={{ margin: "0 0 14px", color: TH.text, fontSize: 16 }}>Open a new dispute</h3>
        <Row label="Type">
          <SearchableSelect
            value={type}
            onChange={(v) => setType(v)}
            options={TYPES.map((t) => ({ value: t.value, label: t.label }))}
            inputStyle={inp}
          />
        </Row>
        <Row label="Priority">
          <SearchableSelect
            value={priority}
            onChange={(v) => setPriority(v)}
            options={PRIORITIES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))}
            inputStyle={inp}
          />
        </Row>
        <Row label="Subject">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Brief summary" style={inp} />
        </Row>
        <Row label="Details">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} style={{ ...inp, resize: "vertical" }} />
        </Row>
        <Row label="Related PO (optional)">
          <SearchableSelect
            value={poId || null}
            onChange={(v) => {
              const newPo = v;
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
            options={[
              { value: "", label: "— None —" },
              ...pos.map((p) => ({ value: p.uuid_id, label: p.po_number })),
            ]}
            inputStyle={inp}
          />
        </Row>
        <Row label="Related invoice (optional)">
          <SearchableSelect
            value={invoiceId || null}
            onChange={(v) => {
              const newInv = v;
              setInvoiceId(newInv);
              if (!newInv) return;
              // Auto-fill the PO to match the invoice's po_id.
              const inv = invoices.find((i) => i.id === newInv);
              if (inv?.po_id && inv.po_id !== poId) setPoId(inv.po_id);
            }}
            options={[
              { value: "", label: "— None —" },
              ...invoiceOptions.map((i) => ({ value: i.id, label: i.invoice_number })),
            ]}
            inputStyle={inp}
          />
          {poId && invoiceOptions.length === 0 && (
            <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>No invoices on that PO yet.</div>
          )}
        </Row>
        {mismatch && (
          <div style={{ marginTop: 4, marginBottom: 10, padding: "8px 12px", background: "#78350F33", border: "1px solid #F59E0B", borderRadius: 6, fontSize: 12, color: "#FBBF24" }}>
            The selected invoice belongs to a different PO. Clear one before opening the dispute.
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
