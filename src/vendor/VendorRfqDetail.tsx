import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import StatusBadge from "./StatusBadge";
import { fmtDate, fmtMoney } from "./utils";

interface RfqDetail {
  rfq: { id: string; title: string; description: string | null; category: string | null; status: string; submission_deadline: string | null; delivery_required_by: string | null; estimated_quantity: number | null; estimated_budget: number | null; currency: string };
  line_items: { id: string; line_index: number; description: string; quantity: number; unit_of_measure: string | null; specifications: string | null }[];
  invitation: { id: string; status: string; invited_at: string; viewed_at: string | null; declined_at: string | null };
  quote: { id: string; status: string; total_price: number | null; lead_time_days: number | null; valid_until: string | null; notes: string | null; lines: { id: string; rfq_line_item_id: string; unit_price: number | null; quantity: number | null; notes: string | null }[] } | null;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

export default function VendorRfqDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [data, setData] = useState<RfqDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Quote builder state
  const [linePrices, setLinePrices] = useState<Record<string, string>>({});
  const [lineQtys, setLineQtys] = useState<Record<string, string>>({});
  const [lineNotes, setLineNotes] = useState<Record<string, string>>({});
  const [leadTime, setLeadTime] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [totalPrice, setTotalPrice] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/rfqs/${id}`, { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as RfqDetail;
      setData(d);

      // Seed form from existing quote if any
      if (d.quote) {
        setLeadTime(d.quote.lead_time_days?.toString() || "");
        setValidUntil(d.quote.valid_until || "");
        setNotes(d.quote.notes || "");
        setTotalPrice(d.quote.total_price?.toString() || "");
        const p: Record<string, string> = {};
        const q: Record<string, string> = {};
        const n: Record<string, string> = {};
        for (const l of d.quote.lines || []) {
          p[l.rfq_line_item_id] = l.unit_price?.toString() || "";
          q[l.rfq_line_item_id] = l.quantity?.toString() || "";
          n[l.rfq_line_item_id] = l.notes || "";
        }
        setLinePrices(p); setLineQtys(q); setLineNotes(n);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [id]);

  async function saveDraft() {
    if (!data) return;
    setSaving(true);
    try {
      const t = await token();
      const lines = data.line_items.map((li) => ({
        rfq_line_item_id: li.id,
        unit_price: linePrices[li.id] ? Number(linePrices[li.id]) : null,
        quantity: lineQtys[li.id] ? parseInt(lineQtys[li.id], 10) : li.quantity,
        notes: lineNotes[li.id] || null,
      }));
      const r = await fetch(`/api/vendor/rfqs/${id}/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          total_price: totalPrice ? Number(totalPrice) : null,
          lead_time_days: leadTime ? parseInt(leadTime, 10) : null,
          valid_until: validUntil || null,
          notes: notes || null,
          lines,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
      alert("Draft saved.");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  async function submitQuote() {
    if (!confirm("Submit this quote? You can't edit it after submission.")) return;
    setSaving(true);
    try {
      await saveDraft();
      const t = await token();
      const r = await fetch(`/api/vendor/rfqs/${id}/quotes/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
      alert("Quote submitted.");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  async function decline() {
    const reason = prompt("Why are you declining? (optional)");
    if (reason === null) return;
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/rfqs/${id}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ reason }),
      });
      if (!r.ok) throw new Error(await r.text());
      nav("/vendor/rfqs");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) return <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!data) return null;

  const { rfq, line_items: lines, invitation, quote } = data;
  const canEdit = invitation.status !== "declined" && (!quote || quote.status === "draft") && (rfq.status === "published" || rfq.status === "draft");
  const deadlinePassed = rfq.submission_deadline && new Date(rfq.submission_deadline) < new Date();

  return (
    <div>
      <Link to="/vendor/rfqs" style={{ color: "rgba(255,255,255,0.8)", fontSize: 13, textDecoration: "none" }}>← All RFQs</Link>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "20px 22px", marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 700 }}>{rfq.category || "RFQ"}</div>
            <h2 style={{ margin: "4px 0 10px", color: TH.text, fontSize: 22 }}>{rfq.title}</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <StatusBadge label={invitation.status[0].toUpperCase() + invitation.status.slice(1)} tone="info" />
              {quote && <StatusBadge label={`Quote ${quote.status}`} tone={quote.status === "awarded" ? "ok" : quote.status === "rejected" ? "danger" : "info"} />}
            </div>
          </div>
          <div style={{ textAlign: "right", fontSize: 12, color: TH.textSub2 }}>
            {rfq.submission_deadline && <div>Deadline: <b>{fmtDate(rfq.submission_deadline)}</b>{deadlinePassed && <span style={{ color: TH.primary }}> (passed)</span>}</div>}
            {rfq.delivery_required_by && <div>Delivery by: {fmtDate(rfq.delivery_required_by)}</div>}
            {rfq.estimated_budget != null && <div>Est. budget: {fmtMoney(rfq.estimated_budget)}</div>}
          </div>
        </div>
        {rfq.description && <div style={{ marginTop: 12, color: TH.textSub2, fontSize: 13, lineHeight: 1.5 }}>{rfq.description}</div>}
      </div>

      <h3 style={{ color: "#FFFFFF", marginTop: 20, marginBottom: 10, fontSize: 15 }}>Line items</h3>
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "50px 1.6fr 100px 90px 130px 130px 1fr", padding: "8px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
          <div>#</div>
          <div>Description</div>
          <div style={{ textAlign: "right" }}>Req qty</div>
          <div>UoM</div>
          <div style={{ textAlign: "right" }}>Your unit price</div>
          <div style={{ textAlign: "right" }}>Your qty</div>
          <div>Notes</div>
        </div>
        {lines.map((li) => (
          <div key={li.id} style={{ display: "grid", gridTemplateColumns: "50px 1.6fr 100px 90px 130px 130px 1fr", padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 12, alignItems: "center" }}>
            <div style={{ color: TH.textSub2 }}>{li.line_index}</div>
            <div style={{ color: TH.text }}>
              <div style={{ fontWeight: 500 }}>{li.description}</div>
              {li.specifications && <div style={{ color: TH.textMuted, fontSize: 11 }}>{li.specifications}</div>}
            </div>
            <div style={{ textAlign: "right", color: TH.textSub2 }}>{li.quantity}</div>
            <div style={{ color: TH.textSub2 }}>{li.unit_of_measure || "—"}</div>
            <div><input disabled={!canEdit} value={linePrices[li.id] || ""} onChange={(e) => setLinePrices({ ...linePrices, [li.id]: e.target.value })} type="number" step="0.01" style={{ ...inp, textAlign: "right" }} /></div>
            <div><input disabled={!canEdit} value={lineQtys[li.id] || ""} onChange={(e) => setLineQtys({ ...lineQtys, [li.id]: e.target.value })} type="number" style={{ ...inp, textAlign: "right" }} placeholder={String(li.quantity)} /></div>
            <div><input disabled={!canEdit} value={lineNotes[li.id] || ""} onChange={(e) => setLineNotes({ ...lineNotes, [li.id]: e.target.value })} style={inp} /></div>
          </div>
        ))}
      </div>

      {canEdit && !deadlinePassed && (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "18px 22px", marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Total price"><input value={totalPrice} onChange={(e) => setTotalPrice(e.target.value)} type="number" step="0.01" style={inp} /></Field>
            <Field label="Lead time (days)"><input value={leadTime} onChange={(e) => setLeadTime(e.target.value)} type="number" style={inp} /></Field>
            <Field label="Valid until"><input value={validUntil} onChange={(e) => setValidUntil(e.target.value)} type="date" style={inp} /></Field>
          </div>
          <div style={{ marginTop: 10 }}>
            <Field label="Notes (optional)"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...inp, resize: "vertical" }} /></Field>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button onClick={() => void decline()} style={btnSecondary}>Decline</button>
            <button onClick={() => void saveDraft()} disabled={saving} style={btnSecondary}>{saving ? "Saving…" : "Save draft"}</button>
            <button onClick={() => void submitQuote()} disabled={saving} style={btnPrimary}>{saving ? "Submitting…" : "Submit quote"}</button>
          </div>
        </div>
      )}

      {quote && !canEdit && (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "18px 22px", marginTop: 16 }}>
          <div style={{ fontSize: 13, color: TH.textSub2 }}>
            <b>Your submitted quote</b> — Total: {quote.total_price != null ? fmtMoney(quote.total_price) : "—"} · Lead time: {quote.lead_time_days ?? "—"}d · Status: {quote.status}
          </div>
          {quote.notes && <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 6 }}>{quote.notes}</div>}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "6px 8px", borderRadius: 4, border: `1px solid ${TH.border}`, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 16px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
