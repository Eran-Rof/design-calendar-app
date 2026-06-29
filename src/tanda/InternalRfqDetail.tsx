import { useEffect, useRef, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import { RfqQuotesPanel, RfqVendorThreadPanel, type RfqTheme, type QuoteSortKey } from "./rfq/RfqQuotesAndMessages";

interface RofRevision {
  id: string;
  rfq_line_item_id: string;
  revised_at: string;
  changed_fields: string[];
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  revised_by: string | null;
}
interface RfqDetail {
  rfq: { id: string; title: string; description: string | null; category: string | null; status: string; submission_deadline: string | null; awarded_to_vendor_id: string | null };
  line_items: { id: string; line_index: number; description: string; quantity: number; unit_of_measure: string | null }[];
  invitations: { id: string; vendor_id: string; status: string; vendor: { name: string } }[];
  quotes: { id: string; status: string }[];
  rof_revisions?: RofRevision[];
}

// Friendly labels for vendor-visible revision fields.
const REV_FIELD_LABELS: Record<string, string> = {
  target_price: "Target cost", quantity: "Quantity", fabric_code: "Fabric",
  fit: "Fit", bottom_closure: "Closure", size_scale_label: "Size scale",
  waist_type: "Waist", style_code: "Style", color: "Color",
  documents: "Documents",
};
function fmtRevVal(v: unknown): string {
  if (v == null || v === "") return "—";
  return String(v);
}

const C: RfqTheme = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalRfqDetail({ rfqId, onClose, onChanged }: { rfqId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<RfqDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<QuoteSortKey>("price");
  // Bumped after publish/close/award to force the shared quotes panel to refetch.
  const [reloadKey, setReloadKey] = useState(0);

  // "Vendor revised their quote" alert — surfaced when the RFQ is opened.
  // The in-app bell does NOT fire for these (internal RFQ notifications are
  // email-only), so we alert right here on the screen. A localStorage ack per
  // RFQ means we re-alert only when a NEWER revision arrives.
  const [revised, setRevised] = useState<{ revisedVendors: { vendor_name: string; revision: number }[]; maxRevision: number } | null>(null);
  const toastedRef = useRef(false);
  useEffect(() => { toastedRef.current = false; }, [rfqId]);

  function handleRevisions(info: { revisedVendors: { vendor_name: string; revision: number }[]; maxRevision: number }) {
    if (!info || info.revisedVendors.length === 0) { setRevised(null); return; }
    let acked = 0;
    try { acked = Number(localStorage.getItem(`rfq_rev_ack_${rfqId}`) || 0); } catch { /* noop */ }
    if (info.maxRevision <= acked) { setRevised(null); return; }
    setRevised(info);
    if (!toastedRef.current) {
      toastedRef.current = true;
      const names = info.revisedVendors.map((v) => v.vendor_name).join(", ");
      const plural = info.revisedVendors.length > 1;
      notify(`${names} revised ${plural ? "their quotes" : "their quote"} — review the highlighted rows below.`, "info");
    }
  }
  function dismissRevised() {
    if (revised) { try { localStorage.setItem(`rfq_rev_ack_${rfqId}`, String(revised.maxRevision)); } catch { /* noop */ } }
    setRevised(null);
  }

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const dRes = await fetch(`/api/internal/rfqs/${rfqId}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText)));
      setDetail(dRes as RfqDetail);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [rfqId]);

  async function publish() {
    const r = await fetch(`/api/internal/rfqs/${rfqId}/publish`, { method: "POST" });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load(); setReloadKey((k) => k + 1); onChanged();
  }
  async function closeRfq() {
    if (!(await confirmDialog("Close this RFQ? No more quotes can be submitted."))) return;
    const r = await fetch(`/api/internal/rfqs/${rfqId}/close`, { method: "POST" });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load(); setReloadKey((k) => k + 1); onChanged();
  }
  async function award(vendorId: string, vendorName: string) {
    if (!(await confirmDialog(`Award this RFQ to ${vendorName}? All other quotes will be rejected.`))) return;
    const r = await fetch(`/api/internal/rfqs/${rfqId}/award/${vendorId}`, { method: "POST" });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load(); setReloadKey((k) => k + 1); onChanged();
  }

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;
  if (!detail) return null;

  const { rfq } = detail;
  const isAwarded = rfq.status === "awarded";

  return (
    <div style={{ color: C.text }}>
      <div onClick={onClose} style={{ color: C.textMuted, fontSize: 13, cursor: "pointer", marginBottom: 10 }}>← All RFQs</div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "18px 22px", marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700 }}>{rfq.category || "RFQ"}</div>
            <h2 style={{ margin: "4px 0 8px", fontSize: 22 }}>{rfq.title}</h2>
            <div style={{ color: C.textSub, fontSize: 13 }}>{rfq.description}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>
              Status: <b style={{ textTransform: "capitalize" }}>{rfq.status}</b>
              {rfq.submission_deadline && <> · Deadline: {rfq.submission_deadline.slice(0, 10)}</>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {rfq.status === "draft" && <button onClick={() => void publish()} style={btnPrimary}>Publish</button>}
            {rfq.status === "published" && <button onClick={() => void closeRfq()} style={btnSecondary}>Close</button>}
          </div>
        </div>
      </div>

      {revised && (
        <div style={{ background: "#422006", border: `1px solid ${C.warn}`, borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, fontSize: 13, color: C.text }}>
            <b>{revised.revisedVendors.map((v) => `${v.vendor_name} (v${v.revision})`).join(", ")}</b>{" "}
            {revised.revisedVendors.length > 1 ? "have revised their quotes" : "has revised their quote"} since first submission.
            Review the updated figures — the <b>Revised</b> rows below expand to show current vs. prior.
          </div>
          <button onClick={dismissRevised} style={btnSecondary}>Got it</button>
        </div>
      )}

      <RfqQuotesPanel
        rfqId={rfqId}
        theme={C}
        sort={sort}
        onSortChange={setSort}
        onAward={(vendorId, vendorName) => void award(vendorId, vendorName)}
        isAwarded={isAwarded}
        lineLabel={(lineItemId) => {
          const li = detail.line_items.find((x) => x.id === lineItemId);
          return li ? `#${li.line_index} ${li.description}` : "Line";
        }}
        reloadKey={reloadKey}
        onRevisionsDetected={handleRevisions}
      />

      <RfqVendorThreadPanel
        rfqId={rfqId}
        theme={C}
        vendors={(detail.invitations || []).map((i) => ({ vendor_id: i.vendor_id, vendor_name: i.vendor?.name || i.vendor_id }))}
      />

      <RofRevisionHistory
        revisions={detail.rof_revisions || []}
        lineLabel={(lineItemId) => {
          const li = detail.line_items.find((x) => x.id === lineItemId);
          return li ? `#${li.line_index} ${li.description}` : "Line";
        }}
      />
    </div>
  );
}

// Caveat 2 — buyer/ROF revision history: what Ring of Fire changed on the
// vendor-visible RFQ fields, when, old → new. Mirrors the vendor quote-revision
// history but for the buyer side. Collapsed by default.
function RofRevisionHistory({
  revisions, lineLabel,
}: { revisions: RofRevision[]; lineLabel: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  if (!revisions || revisions.length === 0) return null;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 16px", marginTop: 14 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ background: "transparent", border: "none", color: C.text, cursor: "pointer", fontSize: 13, fontWeight: 700, padding: 0, display: "flex", alignItems: "center", gap: 8 }}
      >
        <span>{open ? "▾" : "▸"}</span>
        RFQ revision history (Ring of Fire) · {revisions.length}
      </button>
      {open && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          {revisions.map((rev) => (
            <div key={rev.id} style={{ borderLeft: `2px solid ${C.success}`, paddingLeft: 12 }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4 }}>
                {new Date(rev.revised_at).toLocaleString()} · {lineLabel(rev.rfq_line_item_id)}
                {rev.revised_by ? ` · ${rev.revised_by}` : ""}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
                {(rev.changed_fields || []).map((f) => (
                  <div key={f} style={{ fontSize: 12, color: C.textSub }}>
                    <span style={{ color: C.textMuted }}>{REV_FIELD_LABELS[f] || f}:</span>{" "}
                    <span style={{ textDecoration: "line-through", color: C.textMuted }}>{fmtRevVal(rev.old_values?.[f])}</span>
                    {" → "}
                    <span style={{ color: C.success, fontWeight: 600 }}>{fmtRevVal(rev.new_values?.[f])}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const btnPrimary = { padding: "6px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
