// src/tanda/components/AgingDrillModal.tsx
//
// Drill-through Phase 2 — the invoice list behind one AR/AP aging bucket cell.
//
// Opened from InternalARAging / InternalAPAging when the operator clicks a
// bucket cell (customer × bucket, vendor × bucket, or a column total). Fetches
// /api/internal/{ar|ap}-aging/detail — the SAME bucket math as the report SQL —
// so the modal footer always ties to the clicked cell.
//
// Onward links (Phase 1 chain):
//   • JE badge  → JEDetailModal (accrual_je_id), which itself reaches the
//     source document / related entries.
//   • ↗ open    → the AR/AP Invoices module filtered to that invoice number
//     (drillToModule seeds ?q, which those panels consume on mount).

import { useEffect, useState } from "react";
import { fmtDateDisplay } from "../../utils/tandaTypes";
import ExportButton from "../exports/ExportButton";
import type { ExportColumn } from "../exports/useTableExport";
import JEDetailModal, { type JEDetailSeed } from "./JEDetailModal";
import { drillToModule } from "../scorecardDrill";

export type AgingDrillTarget = {
  kind: "ar" | "ap";
  bucket: string;                 // "current" | "1-30" | ... | "total"
  bucketLabel: string;            // header text, e.g. "61-90 days"
  asOf: string | null;            // null = current mode (today)
  partyId: string | null;         // null = whole column
  partyLabel: string | null;      // customer/vendor display name
};

type DetailRow = {
  id: string;
  invoice_number: string | null;
  invoice_kind?: string;
  customer_name?: string | null;
  customer_code?: string | null;
  vendor_name?: string | null;
  vendor_code?: string | null;
  invoice_date?: string | null;
  posting_date: string | null;
  due_date: string | null;
  days_past_due: number | null;
  bucket: string;
  gl_status: string;
  source: string | null;
  total_amount_cents: number;
  paid_amount_cents: number;
  open_cents: number;
  accrual_je_id: string | null;
};

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6",
};

const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function fmtCents(c: number | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n) || n === 0) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

export default function AgingDrillModal({
  target,
  onClose,
}: {
  target: AgingDrillTarget;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<DetailRow[]>([]);
  const [totalOpen, setTotalOpen] = useState(0);
  const [count, setCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [jeSeed, setJeSeed] = useState<JEDetailSeed | null>(null);

  const isAr = target.kind === "ar";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const params = new URLSearchParams();
        params.set("bucket", target.bucket);
        if (target.asOf) params.set("as_of", target.asOf);
        if (target.partyId) params.set(isAr ? "customer_id" : "vendor_id", target.partyId);
        const r = await fetch(`/api/internal/${isAr ? "ar" : "ap"}-aging/detail?${params.toString()}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        setRows((data.rows || []) as DetailRow[]);
        setTotalOpen(Number(data.total_open_cents || 0));
        setCount(Number(data.count || (data.rows || []).length));
        setTruncated(!!data.truncated);
      } catch (e: unknown) {
        if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setRows([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [target.kind, target.bucket, target.asOf, target.partyId, isAr]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const docLabel = isAr ? "invoice" : "bill";
  const partyHeader = isAr ? "Customer" : "Vendor";

  const exportColumns: ExportColumn<Record<string, unknown>>[] = [
    { key: "invoice_number",     header: isAr ? "Invoice #" : "Bill #" },
    { key: "party",              header: partyHeader },
    { key: "doc_date",           header: isAr ? "Invoice Date" : "Posting Date", format: "date" },
    { key: "due_date",           header: "Due Date", format: "date" },
    { key: "days_past_due",      header: "Days Past Due", format: "number" },
    { key: "total_amount_cents", header: "Total", format: "currency_cents" },
    { key: "paid_amount_cents",  header: "Paid", format: "currency_cents" },
    { key: "open_cents",         header: "Open", format: "currency_cents" },
    { key: "gl_status",          header: "Status" },
  ];
  const exportRows = rows.map((r) => ({
    invoice_number: r.invoice_number,
    party: isAr ? (r.customer_name || r.customer_code) : (r.vendor_name || r.vendor_code),
    doc_date: isAr ? r.invoice_date : r.posting_date,
    due_date: r.due_date,
    days_past_due: r.days_past_due,
    total_amount_cents: r.total_amount_cents,
    paid_amount_cents: r.paid_amount_cents,
    open_cents: r.open_cents,
    gl_status: r.gl_status,
  }));

  return (
    <>
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1000px, 95vw)", maxHeight: "90vh", overflowY: "auto",
          boxSizing: "border-box",
          background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12,
          padding: 20, color: C.text,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18 }}>
              {isAr ? "AR" : "AP"} Aging — {target.bucketLabel}
              {target.partyLabel ? ` · ${target.partyLabel}` : " · all"}
            </h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
              as of <strong style={{ color: C.textSub }}>{fmtDateDisplay(target.asOf || new Date().toISOString().slice(0, 10))}</strong>
              <span style={{ marginLeft: 10 }}>
                open {docLabel}s in this bucket — double-click a row (or use ↗) to open the {docLabel}; JE opens the posted entry.
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", color: C.textMuted, border: `1px solid ${C.cardBdr}`,
              borderRadius: 6, cursor: "pointer", fontSize: 14, padding: "4px 10px",
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <ExportButton
            rows={exportRows as unknown as Array<Record<string, unknown>>}
            filename={`${target.kind}-aging-${target.bucket.replace(/[^A-Za-z0-9-]/g, "_")}${target.partyLabel ? `-${target.partyLabel.replace(/[^A-Za-z0-9-]/g, "_")}` : ""}`}
            sheetName={`${isAr ? "AR" : "AP"} Aging Detail`}
            columns={exportColumns}
          />
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
            Error: {err}
          </div>
        )}

        {truncated && (
          <div style={{ background: "#1c1917", border: `1px solid #78350f`, color: "#FCD34D", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
            Showing the first {rows.length.toLocaleString()} of {count.toLocaleString()} open {docLabel}s
            (earliest due first). The TOTAL below covers all {count.toLocaleString()} — it ties to the report cell.
            Narrow by customer/vendor for a complete list.
          </div>
        )}

        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
              No open {docLabel}s in this bucket.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>{isAr ? "Invoice #" : "Bill #"}</th>
                  {!target.partyId && <th style={th}>{partyHeader}</th>}
                  <th style={th}>{isAr ? "Invoice Date" : "Posting Date"}</th>
                  <th style={th}>Due Date</th>
                  <th style={{ ...th, textAlign: "right" }}>Days Past Due</th>
                  <th style={{ ...th, textAlign: "right" }}>Total</th>
                  <th style={{ ...th, textAlign: "right" }}>Paid</th>
                  <th style={{ ...th, textAlign: "right" }}>Open</th>
                  <th style={{ ...th, width: 70, textAlign: "center" }}>Links</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const party = isAr ? (r.customer_name || r.customer_code || "—") : (r.vendor_name || r.vendor_code || "—");
                  const openDoc = () => drillToModule(isAr ? "ar_invoices" : "ap_invoices", { q: r.invoice_number || "" });
                  return (
                    <tr
                      key={r.id}
                      onDoubleClick={openDoc}
                      style={{ cursor: "pointer" }}
                      title={`Double-click to open this ${docLabel} in the ${isAr ? "AR" : "AP"} Invoices module`}
                    >
                      <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", whiteSpace: "nowrap" }}>{r.invoice_number || "—"}</td>
                      {!target.partyId && <td style={td}>{party}</td>}
                      <td style={td}>{fmtDateDisplay((isAr ? r.invoice_date : r.posting_date) || null)}</td>
                      <td style={td}>{fmtDateDisplay(r.due_date)}</td>
                      <td style={{ ...tdNum, color: (r.days_past_due ?? 0) > 0 ? "#F87171" : C.textMuted }}>
                        {r.days_past_due == null ? "—" : r.days_past_due}
                      </td>
                      <td style={tdNum}>{fmtCents(r.total_amount_cents)}</td>
                      <td style={tdNum}>{fmtCents(r.paid_amount_cents)}</td>
                      <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(r.open_cents)}</td>
                      <td style={{ ...td, textAlign: "center", padding: "4px 6px", whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openDoc(); }}
                          title={`Open this ${docLabel} in the ${isAr ? "AR" : "AP"} Invoices module`}
                          aria-label={`Open ${docLabel}`}
                          style={{
                            background: "transparent", color: C.primary, border: `1px solid ${C.cardBdr}`,
                            borderRadius: 6, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 6px",
                          }}
                        >
                          ↗
                        </button>
                        {r.accrual_je_id && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setJeSeed({ id: r.accrual_je_id as string }); }}
                            title="Open the posted journal entry"
                            aria-label="Open journal entry"
                            style={{
                              background: "transparent", color: C.primary, border: `1px solid ${C.cardBdr}`,
                              borderRadius: 6, cursor: "pointer", fontSize: 11, lineHeight: 1, padding: "3px 5px", marginLeft: 4,
                            }}
                          >
                            JE
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: "#111827" }}>
                  <td style={{ ...td, fontWeight: 700, color: C.textSub }} colSpan={target.partyId ? 4 : 5}>
                    TOTAL ({count.toLocaleString()})
                  </td>
                  <td style={td}></td>
                  <td style={td}></td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totalOpen)}</td>
                  <td style={td}></td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>

    {jeSeed && (
      <JEDetailModal
        je={jeSeed}
        onClose={() => setJeSeed(null)}
        onReversed={() => setJeSeed(null)}
      />
    )}
    </>
  );
}
