import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import * as XLSX from "xlsx";
import { newWorkbook, addAoaSheet, downloadExcelWorkbook } from "../../shared/excelLogo";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";
import StatusBadge from "../StatusBadge";
import { fmtDate, fmtMoney } from "../utils";
import { showAlert, showConfirm } from "../ui/AppDialog";

// Green used to flag a buyer-revised value on a line (user request).
const REVISED_GREEN = "#4ADE80";

interface RfqDetail {
  rfq: { id: string; title: string; description: string | null; category: string | null; status: string; submission_deadline: string | null; delivery_required_by: string | null; estimated_quantity: number | null; estimated_budget: number | null; currency: string };
  line_items: {
    id: string; line_index: number; description: string; quantity: number;
    unit_of_measure: string | null; specifications: string | null; target_price: number | null;
    // Costing-derived attributes, surfaced as their own columns.
    style_code: string | null; color: string | null; size_scale_label: string | null;
    fabric_code: string | null; fabric_name: string | null; fit: string | null;
    // Buyer-revision flags: when ROF edits this line after sending, revised_at is
    // stamped and revised_fields lists the changed columns (green-highlighted).
    revised_at?: string | null; revised_fields?: string[] | null;
  }[];
  invitation: { id: string; status: string; invited_at: string; viewed_at: string | null; declined_at: string | null };
  quote: { id: string; status: string; revision?: number | null; total_price: number | null; lead_time_days: number | null; valid_until: string | null; notes: string | null; lines: { id: string; rfq_line_item_id: string; unit_price: number | null; quantity: number | null; notes: string | null }[]; revisions?: QuoteRevisionSnapshot[] } | null;
  // Documents attached to the source costing lines (tech packs, spec sheets,
  // reference images), each with a short-lived signed URL. Images render as a
  // product-image strip; other kinds as a downloadable list.
  documents?: { id: string; title: string; kind: string; mime: string; is_image: boolean; byte_size: number | null; line_index: number | null; url: string }[];
}

// A snapshot of one prior version of THIS vendor's quote (read-only history).
interface QuoteRevisionSnapshot {
  id: string;
  revision: number;
  submitted_at: string | null;
  created_at: string;
  snapshot: {
    total_price: number | null;
    lead_time_days: number | null;
    valid_until: string | null;
    notes: string | null;
    lines: { rfq_line_item_id: string; unit_price: number | null; quantity: number | null; notes: string | null }[];
  };
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
// Human-readable byte size (e.g. 1536 → "1.5 KB").
const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  const [showHistory, setShowHistory] = useState(false);

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

      // Popup-on-open: if Ring of Fire revised any line since the vendor last
      // acknowledged this RFQ, tell them. localStorage ack (per RFQ, keyed by
      // the latest revised_at) means it shows once per revision, not every open.
      try {
        const revisedAts = (d.line_items || []).map((li) => li.revised_at).filter(Boolean) as string[];
        if (revisedAts.length > 0) {
          const maxRev = revisedAts.slice().sort().slice(-1)[0];
          const ackKey = `rfq_vendor_rev_ack_${id}`;
          let ack = "";
          try { ack = localStorage.getItem(ackKey) || ""; } catch { /* noop */ }
          if (maxRev > ack) {
            try { localStorage.setItem(ackKey, maxRev); } catch { /* noop */ }
            void showAlert({ title: "One of your RFQs has been revised", message: "Ring of Fire updated this RFQ. The changed details are highlighted in green below.", tone: "warn" });
          }
        }
      } catch { /* noop */ }

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
      await showAlert({ title: "Saved", message: "Draft saved.", tone: "success" });
    } catch (e: unknown) {
      await showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally { setSaving(false); }
  }

  // How much the vendor's quote exceeds Ring of Fire's target, compared on an
  // apples-to-apples basis: only lines that have BOTH a typed unit price and a
  // target_price contribute, each weighted by the line's quantity. Returns null
  // when there is no target to beat or the quote is at/below target. firstOverId
  // is the first line whose unit price is above its own target (for focusing).
  function targetOverage(): { pct: number; firstOverId: string } | null {
    if (!data) return null;
    let quotedSum = 0, targetSum = 0, firstOverId = "";
    for (const li of data.line_items) {
      const up = parseFloat(linePrices[li.id] || "");
      if (!Number.isFinite(up)) continue;
      if (li.target_price == null || !Number.isFinite(li.target_price)) continue;
      const qtyStr = lineQtys[li.id];
      const qtyRaw = qtyStr ? parseQty(qtyStr) : li.quantity;
      const qty = Number.isFinite(qtyRaw) ? qtyRaw : 0;
      quotedSum += up * qty;
      targetSum += li.target_price * qty;
      if (!firstOverId && up > li.target_price) firstOverId = li.id;
    }
    if (targetSum <= 0 || quotedSum <= targetSum) return null;
    const pct = ((quotedSum - targetSum) / targetSum) * 100;
    return { pct, firstOverId: firstOverId || data.line_items[0]?.id || "" };
  }

  // Send the vendor back to sharpen a price: focus + select their unit-price
  // field and scroll it into view. Deferred a tick so it runs after the dialog
  // has closed and released focus.
  function focusPriceField(lineId: string) {
    setTimeout(() => {
      const el = document.getElementById(`vq-price-${lineId}`) as HTMLInputElement | null;
      if (el) { el.focus(); el.select(); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
    }, 60);
  }

  async function submitQuote() {
    // If the quote comes in above target, give the vendor a chance to be more
    // competitive before committing (after submission, edits go through Revise).
    const over = targetOverage();
    if (over) {
      const pctStr = over.pct >= 10 ? String(Math.round(over.pct)) : over.pct.toFixed(1);
      const submitAnyway = await showConfirm({
        // Headline + overage % rendered big and bright red inside the message
        // (the shared dialog's own title is fixed-size) so it really lands.
        message: (
          <div>
            <div style={{ fontSize: 30, fontWeight: 600, color: "#FF1A1A", lineHeight: 1.15, marginBottom: 14 }}>
              Your quote is above target
            </div>
            <div style={{ fontSize: 26, fontWeight: 600, color: "#FF1A1A", lineHeight: 1.25 }}>
              Your quoted price is {pctStr}% higher than Ring of Fire's target.
            </div>
            <div style={{ fontSize: 13, color: TH.textMuted, marginTop: 16 }}>
              You can submit it as-is, or sharpen your pricing to be more competitive. To update your quote after submission, use the Revise quote button.
            </div>
          </div>
        ),
        tone: "warn",
        confirmLabel: "Submit anyway",
        cancelLabel: "Be more competitive",
      });
      if (!submitAnyway) { focusPriceField(over.firstOverId); return; }
    } else {
      if (!await showConfirm({ title: "Submit quote?", message: "To update your quote after submission, use the Revise quote button.", tone: "warn", confirmLabel: "Submit" })) return;
    }
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
      await showAlert({ title: "Submitted", message: "Quote submitted.", tone: "success" });
    } catch (e: unknown) {
      await showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally { setSaving(false); }
  }

  // Revise an already-submitted quote: snapshots the current version, reopens
  // the quote as a draft (server-side), then reloads so the form is editable
  // again. The vendor then edits + re-submits as the next revision.
  async function reviseQuote() {
    if (!await showConfirm({ title: "Revise quote?", message: "Your current submission is saved as a prior revision, and you can edit and re-submit.", tone: "warn", confirmLabel: "Revise" })) return;
    setSaving(true);
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/rfqs/${id}/quote/revise`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
      await showAlert({ title: "Reopened", message: "Quote reopened for revision — edit your prices and re-submit.", tone: "success" });
    } catch (e: unknown) {
      await showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
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
      await showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
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
    const header = ["#", "Style", "Style Name", "Wash", "Size", "Fabric", "Target Unit Price", "Req Qty", "UoM", "Your Unit Price", "Your Qty", "Notes"];
    const body = line_items.map((li) => [
      li.line_index,
      li.style_code || "",
      styleNameOf(li.description),
      li.color || "",
      li.size_scale_label || "",
      li.fabric_name || li.fabric_code || "",
      li.target_price ?? "",
      li.quantity,
      li.unit_of_measure || "",
      linePrices[li.id] ? Number(linePrices[li.id]) : "",
      lineQtys[li.id] ? parseQty(lineQtys[li.id]) : "",
      lineNotes[li.id] || "",
    ]);
    const wb = newWorkbook();
    addAoaSheet(wb, "RFQ", [...meta, header, ...body], {
      title: `RFQ — ${rfq.title ?? ""}`.trim(),
      metaRows: meta.length,
      cols: [5, 12, 16, 22, 12, 16, 16, 9, 6, 15, 9, 24],
    });
    const safe = (rfq.title || "rfq").replace(/[^\w-]+/g, "_").slice(0, 40);
    void downloadExcelWorkbook(wb, `RFQ_${safe}.xlsx`);
  }

  if (loading) return <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!data) return null;

  const { rfq, line_items: lines, invitation, quote } = data;
  // Costing-line documents, split into product images vs. downloadable files.
  const docs = data.documents || [];
  const images = docs.filter((d) => d.is_image);
  const files = docs.filter((d) => !d.is_image);
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
            {(rfq.status === "closed" || rfq.status === "awarded") && (
              <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600, color: TH.textSub, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, padding: "8px 12px" }}>
                {rfq.status === "awarded"
                  ? "This RFQ has been awarded — it is now read-only."
                  : "This RFQ has been closed or superseded by a revised request — it is now read-only."}
              </div>
            )}
          </div>
          {/* Operator request: ~25% larger so the key dates/budget read clearly. */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12 }}>
            <div style={{ textAlign: "right", fontSize: 15, lineHeight: 1.5, color: TH.textSub, whiteSpace: "nowrap" }}>
              {rfq.submission_deadline && <div>Deadline: <b>{fmtDate(rfq.submission_deadline)}</b>{deadlinePassed && <span style={{ color: TH.primary }}> (passed)</span>}</div>}
              {rfq.delivery_required_by && <div>Delivery by: <b>{fmtDate(rfq.delivery_required_by)}</b></div>}
              {rfq.estimated_budget != null && <div>Est. budget: <b>{fmtMoney(rfq.estimated_budget)}</b></div>}
            </div>
            {/* Product images from the costing line(s) — multiple side by side,
                wrapping as needed. Click to open full-size. */}
            {images.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", maxWidth: 360 }}>
                {images.map((img) => (
                  <a key={img.id} href={img.url} target="_blank" rel="noreferrer" title={img.title} style={{ display: "block", lineHeight: 0 }}>
                    <img src={img.url} alt={img.title} style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8, border: `1px solid ${TH.border}`, background: "#0B1220" }} />
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {files.length > 0 && (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "14px 18px", marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: TH.text, marginBottom: 10 }}>Documents <span style={{ color: TH.textMuted, fontWeight: 400 }}>({files.length})</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {files.map((f) => (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <span style={{ color: TH.text, fontWeight: 500 }}>{f.title}</span>
                <span style={{ color: TH.textMuted, fontSize: 11 }}>{f.kind}{f.byte_size ? ` · ${fmtBytes(f.byte_size)}` : ""}</span>
                <a href={f.url} target="_blank" rel="noreferrer" style={{ ...btnSecondary, marginLeft: "auto", textDecoration: "none", display: "inline-block" }}>Download</a>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: 20, marginBottom: 10 }}>
        <button onClick={downloadExcel} style={btnSecondary}>Download Excel</button>
      </div>
      {/* Costing-derived attributes are split into their own columns. The table
          can get wide, so allow horizontal scroll on narrow screens. */}
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflowX: "auto" }}>
        <div style={{ minWidth: GRID_MIN }}>
          <div style={{ display: "grid", gridTemplateColumns: GRID_COLS, columnGap: 12, padding: "9px 16px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textSub2, textTransform: "uppercase", letterSpacing: 0.04 }}>
            <div>#</div>
            <div>Style</div>
            <div>Style name</div>
            <div>Wash</div>
            <div>Size</div>
            <div>Fabric</div>
            <div style={{ textAlign: "right" }}>Target unit price</div>
            <div style={{ textAlign: "right" }}>Req qty</div>
            <div>UoM</div>
            {/* Centered over its (half-width) input field. */}
            <div style={{ textAlign: "center" }}>Your unit price</div>
            <div style={{ textAlign: "right" }}>Your qty</div>
            <div>Notes</div>
          </div>
          {lines.map((li) => {
            const rev = new Set(li.revised_fields || []);
            const isRevised = !!li.revised_at && rev.size > 0;
            // Green-highlight the cells whose value the buyer changed.
            const g = (field: string) => rev.has(field) ? { color: REVISED_GREEN, fontWeight: 700 } : null;
            return (
            <div key={li.id} style={{ display: "grid", gridTemplateColumns: GRID_COLS, columnGap: 12, padding: "10px 16px", borderBottom: `1px solid ${TH.border}`, fontSize: 12, alignItems: "center" }}>
              <div style={{ color: TH.textSub2 }}>{li.line_index}</div>
              <div style={{ color: TH.text, fontWeight: 500, ...g("style_code") }}>
                <div>{li.style_code || "—"}</div>
                {isRevised && (
                  <span title={`Revised by Ring of Fire${li.revised_at ? ` on ${fmtDate(li.revised_at)}` : ""}`}
                    style={{ display: "inline-block", marginTop: 4, background: REVISED_GREEN, color: "#06240F", borderRadius: 4, padding: "1px 5px", fontSize: 9, fontWeight: 700, textTransform: "uppercase", whiteSpace: "nowrap" }}>
                    ✎ Revised{li.revised_at ? ` · ${fmtDate(li.revised_at)}` : ""}
                  </span>
                )}
              </div>
              <div style={{ color: TH.textSub }}>{styleNameOf(li.description) || "—"}</div>
              <div style={{ color: TH.textSub, ...g("color") }}>{li.color || "—"}</div>
              <div style={{ color: TH.textSub, ...g("size_scale_label") }}>{li.size_scale_label || "—"}</div>
              <div style={{ color: TH.textSub, ...g("fabric_code") }}>{li.fabric_name || li.fabric_code || "—"}</div>
              <div style={{ textAlign: "right", color: TH.textSub, ...g("target_price") }}>{li.target_price != null ? fmtUsd(li.target_price) : "—"}</div>
              <div style={{ textAlign: "right", color: TH.textSub2, ...g("quantity") }}>{fmtQty(li.quantity)}</div>
              <div style={{ color: TH.textSub2 }}>{li.unit_of_measure || "—"}</div>
              {/* Half-size input, centered under its header. */}
              <div style={{ textAlign: "center" }}><input id={`vq-price-${li.id}`} disabled={!canEdit} value={linePrices[li.id] || ""} onChange={(e) => setLinePrices({ ...linePrices, [li.id]: e.target.value })} type="number" step="0.01" style={{ ...inp, width: "calc(50% + 2ch)", textAlign: "right" }} /></div>
              <div><input disabled={!canEdit} value={lineQtys[li.id] || ""} onChange={(e) => setLineQtys({ ...lineQtys, [li.id]: qtyInput(e.target.value) })} inputMode="numeric" style={{ ...inp, textAlign: "right" }} placeholder={fmtQty(li.quantity)} /></div>
              <div><input disabled={!canEdit} value={lineNotes[li.id] || ""} onChange={(e) => setLineNotes({ ...lineNotes, [li.id]: e.target.value })} style={inp} /></div>
            </div>
            );
          })}
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 13, color: TH.textSub2 }}>
                <b>Your submitted quote</b>{quote.revision && quote.revision > 1 ? <span style={{ color: TH.textMuted }}> (revision v{quote.revision})</span> : null} — Total: {quote.total_price != null ? fmtMoney(quote.total_price) : "—"} · Lead time: {quote.lead_time_days ?? "—"}d · Status: {quote.status}
              </div>
              {quote.notes && <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 6 }}>{quote.notes}</div>}
            </div>
            {/* Revise affordance: only while the quote is still open (submitted /
                under_review) and the RFQ deadline hasn't passed. Clicking
                reopens the quote as a draft so the vendor can edit + re-submit. */}
            {(quote.status === "submitted" || quote.status === "under_review") && !deadlinePassed && rfq.status !== "closed" && rfq.status !== "awarded" && (
              <button onClick={() => void reviseQuote()} disabled={saving} style={btnPrimary}>{saving ? "Working…" : "Revise quote"}</button>
            )}
          </div>

          {/* Read-only history of THIS vendor's own prior versions. */}
          {quote.revisions && quote.revisions.length > 0 && (
            <div style={{ marginTop: 14, borderTop: `1px solid ${TH.border}`, paddingTop: 12 }}>
              <div
                onClick={() => setShowHistory((s) => !s)}
                style={{ cursor: "pointer", color: TH.textSub2, fontSize: 12, fontWeight: 600, userSelect: "none" }}
              >
                {showHistory ? "▾" : "▸"} Your revision history ({quote.revisions.length} prior {quote.revisions.length === 1 ? "version" : "versions"})
              </div>
              {showHistory && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                  {/* Current (live) values first, then prior snapshots newest-first. */}
                  <VendorRevisionCard
                    label={`v${quote.revision ?? 1} (current)`}
                    when={quote.valid_until}
                    totalPrice={quote.total_price}
                    leadTime={quote.lead_time_days}
                    notes={quote.notes}
                    lines={quote.lines.map((l) => ({ rfq_line_item_id: l.rfq_line_item_id, unit_price: l.unit_price, quantity: l.quantity, notes: l.notes }))}
                    lineLabel={(liId) => { const li = lines.find((x) => x.id === liId); return li ? `#${li.line_index} ${styleNameOf(li.description) || li.description}` : "Line"; }}
                    highlight
                  />
                  {quote.revisions.map((rev) => (
                    <VendorRevisionCard
                      key={rev.id}
                      label={`v${rev.revision}`}
                      when={rev.submitted_at || rev.created_at}
                      totalPrice={rev.snapshot?.total_price ?? null}
                      leadTime={rev.snapshot?.lead_time_days ?? null}
                      notes={rev.snapshot?.notes ?? null}
                      lines={rev.snapshot?.lines || []}
                      lineLabel={(liId) => { const li = lines.find((x) => x.id === liId); return li ? `#${li.line_index} ${styleNameOf(li.description) || li.description}` : "Line"; }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {id && <RfqMessageThread rfqId={id} />}
    </div>
  );
}

// One version's figures in the vendor's own revision history (read-only).
function VendorRevisionCard({
  label, when, totalPrice, leadTime, notes, lines, lineLabel, highlight,
}: {
  label: string;
  when: string | null;
  totalPrice: number | null;
  leadTime: number | null;
  notes: string | null;
  lines: { rfq_line_item_id: string; unit_price: number | null; quantity: number | null; notes: string | null }[];
  lineLabel: (lineItemId: string) => string;
  highlight?: boolean;
}) {
  return (
    <div style={{ border: `1px solid ${highlight ? TH.primary : TH.border}`, borderRadius: 8, padding: "10px 12px", background: TH.bg }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: highlight ? TH.primary : TH.textSub }}>{label}</div>
        <div style={{ fontSize: 11, color: TH.textMuted }}>{when ? fmtDate(when) : "—"}</div>
      </div>
      <div style={{ fontSize: 12, color: TH.textSub2, marginBottom: lines.length ? 8 : 0 }}>
        Total {totalPrice != null ? fmtUsd(totalPrice) : "—"} · Lead time {leadTime ?? "—"}d
        {notes ? <span style={{ color: TH.textMuted }}> · {notes}</span> : null}
      </div>
      {lines.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {lines.map((l, i) => (
            <div key={l.rfq_line_item_id || i} style={{ fontSize: 11, color: TH.textMuted, display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lineLabel(l.rfq_line_item_id)}</span>
              <span style={{ flexShrink: 0 }}>
                {l.unit_price != null ? fmtUsd(l.unit_price) : "—"}{l.quantity != null ? ` × ${fmtQty(l.quantity)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface RfqMessage {
  id: string;
  sender_type: string;
  sender_name: string;
  body: string;
  created_at: string;
}

// Vendor-side RFQ message thread. Lets the vendor message Ring of Fire about
// this RFQ before any PO exists. Talks to /api/vendor/rfqs/:id/messages (the
// rfq_messages table is service-role only, scoped to the vendor's invitation).
// Vendor messages right-aligned; Ring of Fire left.
function RfqMessageThread({ rfqId }: { rfqId: string }) {
  const [messages, setMessages] = useState<RfqMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/rfqs/${rfqId}/messages`, { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      setMessages((await r.json()) as RfqMessage[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [rfqId]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setErr(null);
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/rfqs/${rfqId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) throw new Error(await r.text());
      setDraft("");
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); }
  }

  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, marginTop: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 18px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 14, fontWeight: 700, color: TH.text }}>Messages</div>
      <div style={{ maxHeight: 320, overflowY: "auto", padding: "12px 16px", background: TH.surfaceHi }}>
        {loading ? (
          <div style={{ color: TH.textMuted, fontSize: 13 }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: TH.textMuted, fontSize: 13, textAlign: "center", padding: "30px 0" }}>No messages yet. Ask Ring of Fire a question about this RFQ below.</div>
        ) : messages.map((m) => {
          const mine = m.sender_type === "vendor";
          return (
            <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
              <div style={{ maxWidth: "78%", background: mine ? TH.primary : TH.bg, color: TH.text, border: `1px solid ${mine ? TH.primary : TH.border}`, borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>
                <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, opacity: 0.85, color: mine ? "rgba(255,255,255,0.9)" : TH.textMuted }}>
                  {m.sender_name} · {m.sender_type === "vendor" ? "You" : "Ring of Fire"}
                </div>
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{m.body}</div>
                <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>{new Date(m.created_at).toLocaleString()}</div>
              </div>
            </div>
          );
        })}
      </div>
      {err && <div style={{ padding: "6px 16px", color: TH.primary, fontSize: 12 }}>{err}</div>}
      <div style={{ padding: "10px 16px", borderTop: `1px solid ${TH.border}`, background: TH.surface, display: "flex", gap: 8 }}>
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          placeholder="Message Ring of Fire about this RFQ… (⌘/Ctrl+Enter to send)"
          style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
        />
        <button onClick={() => void send()} disabled={sending || !draft.trim()} style={{ ...btnPrimary, opacity: sending || !draft.trim() ? 0.5 : 1, cursor: sending || !draft.trim() ? "not-allowed" : "pointer" }}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
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
// #, Style, Style name, Wash, Size, Fabric, Target unit price, Req qty, UoM,
// Your unit price, Your qty, Notes. Wrapped in a min-width scroller (GRID_MIN).
// Style# widened by ~5 chars (100→135px) so Style name and every column after it
// shift right; Notes trimmed by the same ~5 chars (min 140→105px) to keep the row
// width balanced.
const GRID_COLS = "30px 135px 120px 150px 96px 120px 110px 88px 46px 120px 100px minmax(105px,1fr)";
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
