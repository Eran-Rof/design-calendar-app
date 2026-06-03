import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import * as XLSX from "xlsx";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";
import StatusBadge from "../StatusBadge";
import { fmtDate, fmtMoney } from "../utils";

interface RfqDetail {
  rfq: { id: string; title: string; description: string | null; category: string | null; status: string; submission_deadline: string | null; delivery_required_by: string | null; estimated_quantity: number | null; estimated_budget: number | null; currency: string };
  line_items: {
    id: string; line_index: number; description: string; quantity: number;
    unit_of_measure: string | null; specifications: string | null; target_price: number | null;
    // Costing-derived attributes, surfaced as their own columns.
    style_code: string | null; color: string | null; size_scale_label: string | null;
    fabric_code: string | null; fabric_name: string | null; fit: string | null;
  }[];
  invitation: { id: string; status: string; invited_at: string; viewed_at: string | null; declined_at: string | null };
  quote: { id: string; status: string; total_price: number | null; lead_time_days: number | null; valid_until: string | null; notes: string | null; lines: { id: string; rfq_line_item_id: string; unit_price: number | null; quantity: number | null; notes: string | null }[] } | null;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

// Thousands separator for quantities (10000 → "10,000").
const fmtQty = (n: number) => Number(n).toLocaleString("en-US");
// USD with 2 decimals (7 → "$7.00").
const fmtUsd = (n: number) => Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
// Parse a comma-formatted quantity input back to an integer.
const parseQty = (s: string) => parseInt((s || "").replace(/[^\d]/g, ""), 10);
// Format a free-typed quantity into a comma string (empty stays empty).
const qtyInput = (raw: string) => {
  const d = (raw || "").replace(/[^\d]/g, "");
  return d ? Number(d).toLocaleString("en-US") : "";
};
// The style name is the tail of the costing-built description after " — ".
const styleNameOf = (description: string) => {
  const i = (description || "").lastIndexOf(" — ");
  return i >= 0 ? description.slice(i + 3).trim() : "";
};

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
  const [saving, setSaving] = useState(false);

  // Total price is auto-calculated from each line's (your unit price × your qty)
  // — the vendor no longer types it. Falls back to the RFQ's req qty when the
  // vendor hasn't entered their own qty for a line.
  function computeTotal() {
    if (!data) return 0;
    return data.line_items.reduce((sum, li) => {
      const up = parseFloat(linePrices[li.id] || "");
      if (!Number.isFinite(up)) return sum;
      const qtyStr = lineQtys[li.id];
      const qty = qtyStr ? parseQty(qtyStr) : li.quantity;
      return sum + up * (Number.isFinite(qty) ? qty : 0);
    }, 0);
  }

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
        const p: Record<string, string> = {};
        const q: Record<string, string> = {};
        const n: Record<string, string> = {};
        for (const l of d.quote.lines || []) {
          p[l.rfq_line_item_id] = l.unit_price?.toString() || "";
          q[l.rfq_line_item_id] = l.quantity != null ? fmtQty(l.quantity) : "";
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
        quantity: lineQtys[li.id] ? parseQty(lineQtys[li.id]) : li.quantity,
        notes: lineNotes[li.id] || null,
      }));
      const total = computeTotal();
      const r = await fetch(`/api/vendor/rfqs/${id}/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          // Auto-calculated from the line entries; no longer typed by the vendor.
          total_price: total > 0 ? total : null,
          lead_time_days: leadTime ? parseInt(leadTime, 10) : null,
          valid_until: validUntil || null,
          // Quote-level notes removed as redundant with per-line Notes.
          notes: null,
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

  // Download the RFQ + the vendor's current entries as an .xlsx so they can
  // fill / review the quote offline. Mirrors exactly what's on screen.
  function downloadExcel() {
    if (!data) return;
    const { rfq, line_items } = data;
    const meta: (string | number)[][] = [
      ["RFQ", rfq.title],
      ["Status", rfq.status],
      ["Delivery by", rfq.delivery_required_by ? fmtDate(rfq.delivery_required_by) : ""],
      ["Submission deadline", rfq.submission_deadline ? fmtDate(rfq.submission_deadline) : ""],
      ["Est. budget", rfq.estimated_budget != null ? rfq.estimated_budget : ""],
      [],
    ];
    const header = ["#", "Style", "Wash", "Size", "Fabric", "Style Name", "Target Unit Price", "Req Qty", "UoM", "Your Unit Price", "Your Qty", "Notes"];
    const body = line_items.map((li) => [
      li.line_index,
      li.style_code || "",
      li.color || "",
      li.size_scale_label || "",
      li.fabric_name || li.fabric_code || "",
      styleNameOf(li.description),
      li.target_price ?? "",
      li.quantity,
      li.unit_of_measure || "",
      linePrices[li.id] ? Number(linePrices[li.id]) : "",
      lineQtys[li.id] ? parseQty(lineQtys[li.id]) : "",
      lineNotes[li.id] || "",
    ]);
    const ws = XLSX.utils.aoa_to_sheet([...meta, header, ...body]);
    ws["!cols"] = [{ wch: 5 }, { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 9 }, { wch: 6 }, { wch: 15 }, { wch: 9 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "RFQ");
    const safe = (rfq.title || "rfq").replace(/[^\w-]+/g, "_").slice(0, 40);
    XLSX.writeFile(wb, `RFQ_${safe}.xlsx`);
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
          {/* Operator request: ~25% larger so the key dates/budget read clearly. */}
          <div style={{ textAlign: "right", fontSize: 15, lineHeight: 1.5, color: TH.textSub, whiteSpace: "nowrap" }}>
            {rfq.submission_deadline && <div>Deadline: <b>{fmtDate(rfq.submission_deadline)}</b>{deadlinePassed && <span style={{ color: TH.primary }}> (passed)</span>}</div>}
            {rfq.delivery_required_by && <div>Delivery by: <b>{fmtDate(rfq.delivery_required_by)}</b></div>}
            {rfq.estimated_budget != null && <div>Est. budget: <b>{fmtMoney(rfq.estimated_budget)}</b></div>}
          </div>
        </div>
        {rfq.description && <div style={{ marginTop: 12, color: TH.textSub2, fontSize: 13, lineHeight: 1.5 }}>{rfq.description}</div>}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20, marginBottom: 10 }}>
        <h3 style={{ color: "#FFFFFF", margin: 0, fontSize: 15 }}>Line items</h3>
        <button onClick={downloadExcel} style={btnSecondary}>⬇ Download Excel</button>
      </div>
      {/* Costing-derived attributes are split into their own columns. The table
          can get wide, so allow horizontal scroll on narrow screens. */}
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflowX: "auto" }}>
        <div style={{ minWidth: GRID_MIN }}>
          <div style={{ display: "grid", gridTemplateColumns: GRID_COLS, columnGap: 12, padding: "9px 16px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textSub2, textTransform: "uppercase", letterSpacing: 0.04 }}>
            <div>#</div>
            <div>Style</div>
            <div>Wash</div>
            <div>Size</div>
            <div>Fabric</div>
            <div>Style name</div>
            <div style={{ textAlign: "right" }}>Target unit price</div>
            <div style={{ textAlign: "right" }}>Req qty</div>
            <div>UoM</div>
            {/* Centered over its (half-width) input field. */}
            <div style={{ textAlign: "center" }}>Your unit price</div>
            <div style={{ textAlign: "right" }}>Your qty</div>
            <div>Notes</div>
          </div>
          {lines.map((li) => (
            <div key={li.id} style={{ display: "grid", gridTemplateColumns: GRID_COLS, columnGap: 12, padding: "10px 16px", borderBottom: `1px solid ${TH.border}`, fontSize: 12, alignItems: "center" }}>
              <div style={{ color: TH.textSub2 }}>{li.line_index}</div>
              <div style={{ color: TH.text, fontWeight: 500 }}>{li.style_code || "—"}</div>
              <div style={{ color: TH.textSub }}>{li.color || "—"}</div>
              <div style={{ color: TH.textSub }}>{li.size_scale_label || "—"}</div>
              <div style={{ color: TH.textSub }}>{li.fabric_name || li.fabric_code || "—"}</div>
              <div style={{ color: TH.textSub }}>{styleNameOf(li.description) || "—"}</div>
              <div style={{ textAlign: "right", color: TH.textSub }}>{li.target_price != null ? fmtUsd(li.target_price) : "—"}</div>
              <div style={{ textAlign: "right", color: TH.textSub2 }}>{fmtQty(li.quantity)}</div>
              <div style={{ color: TH.textSub2 }}>{li.unit_of_measure || "—"}</div>
              {/* Half-size input, centered under its header. */}
              <div style={{ textAlign: "center" }}><input disabled={!canEdit} value={linePrices[li.id] || ""} onChange={(e) => setLinePrices({ ...linePrices, [li.id]: e.target.value })} type="number" step="0.01" style={{ ...inp, width: "50%", textAlign: "right" }} /></div>
              <div><input disabled={!canEdit} value={lineQtys[li.id] || ""} onChange={(e) => setLineQtys({ ...lineQtys, [li.id]: qtyInput(e.target.value) })} inputMode="numeric" style={{ ...inp, textAlign: "right" }} placeholder={fmtQty(li.quantity)} /></div>
              <div><input disabled={!canEdit} value={lineNotes[li.id] || ""} onChange={(e) => setLineNotes({ ...lineNotes, [li.id]: e.target.value })} style={inp} /></div>
            </div>
          ))}
        </div>
      </div>

      {canEdit && !deadlinePassed && (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "18px 22px", marginTop: 16 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
            {/* Compact fields. Total price is auto-calculated + read-only. */}
            <Field label="Total price (auto)">
              <div style={{ ...inp, width: 150, color: TH.text, fontWeight: 600, cursor: "default" }}>{fmtUsd(computeTotal())}</div>
            </Field>
            <Field label="Lead time (days)">
              <input value={leadTime} onChange={(e) => setLeadTime(e.target.value)} type="number" style={{ ...inp, width: 110 }} />
            </Field>
            <Field label="Valid until">
              <input value={validUntil} onChange={(e) => setValidUntil(e.target.value)} type="date" style={{ ...inp, width: 170 }} />
            </Field>
            {/* Reserved placeholder — product image will live here in a future pass. */}
            <div style={{ marginLeft: "auto", width: 200, height: 130, border: `1px dashed ${TH.border}`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: TH.textMuted, fontSize: 12, lineHeight: 1.4 }}>
              Product image<br />(coming soon)
            </div>
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

// Shared column template for the line-items header + rows so they stay aligned.
// #, Style, Wash, Size, Fabric, Style name, Target unit price, Req qty, UoM,
// Your unit price, Your qty, Notes. Wrapped in a min-width scroller (GRID_MIN).
const GRID_COLS = "30px 100px 150px 96px 120px 120px 110px 88px 46px 120px 100px minmax(140px,1fr)";
const GRID_MIN = 1180;

// Inputs were unstyled <input>s, so the browser rendered them with its default
// (brownish/gray, oversized) field chrome. Give them an explicit dark field bg,
// light text, and colorScheme:dark so number spinners / the date picker match.
const inp = {
  width: "100%", padding: "7px 9px", borderRadius: 5,
  border: "1px solid #475569", background: "#0B1220", color: TH.text,
  fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
  colorScheme: "dark", outline: "none",
} as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 16px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
