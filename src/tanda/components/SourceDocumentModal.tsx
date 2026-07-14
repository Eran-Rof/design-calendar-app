// src/tanda/components/SourceDocumentModal.tsx
//
// Tangerine — read-only SOURCE DOCUMENT viewer (QuickBooks-Desktop-style drill).
//
// From the income statement you drill: account → GL detail → a journal entry
// (JEDetailModal) → its "Source document". Previously that link only navigated
// to the AR/AP LIST filtered by number — you still had to hunt for the row and
// open an edit form. This modal instead opens the ACTUAL invoice / bill in
// place: header (party, dates, status) + the SKU line items + totals — the way
// double-clicking a number in a QuickBooks report opens the transaction.
//
// Read-only by design (it is reached from an immutable posted ledger); the
// "Open in AR/AP module" affordance is kept for anyone who needs the full
// editable panel. No raw UUIDs surface — lines resolve to SKU + style/color/size.

import React, { useEffect, useMemo, useState } from "react";
import { fmtDateDisplay } from "../../utils/tandaTypes";
import { drillToModule, type DrillModuleKey } from "../scorecardDrill";

// The doc reference the JE source-resolver hands us (source.js docs[]).
export type SourceDocOpen = {
  docType: "ar" | "ap";
  id: string;
  number: string | null;
  party?: string | null;
  module?: string | null; // ar_invoices | ap_invoices — for "open in module"
};

type DocLine = {
  id: string;
  line_number: number;
  description: string | null;
  inventory_item_id: string | null;
  quantity: string | null;
  unit_price_cents: string | number | null;
  line_total_cents: string | number | null;
  tax_amount_cents: string | number | null;
};

type DocHeader = {
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  gl_status: string | null;
  total_amount_cents: string | number | null;
  paid_amount_cents: string | number | null;
  description: string | null;
  notes: string | null;
  sales_order_id?: string | null;
  lines: DocLine[];
};

type ItemInfo = { id: string; sku_code: string | null; style_code: string | null; description: string | null; color: string | null; size: string | null; inseam?: string | null };

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", danger: "#EF4444",
  panel: "#0b1220",
};

const th: React.CSSProperties = {
  background: C.panel, color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13,
};
const tdNum: React.CSSProperties = { ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right", whiteSpace: "nowrap" };
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};

function centsToNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n / 100 : 0;
}
function money(v: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusColor(s: string | null): string {
  const v = (s || "").toLowerCase();
  if (v.includes("paid") && !v.includes("partial")) return C.success;
  if (v.includes("void") || v.includes("reversed")) return C.danger;
  if (v.includes("partial") || v.includes("sent") || v.includes("posted")) return C.primary;
  return C.textMuted;
}

// Build the human SKU label for a line from the resolved item master.
function skuLabel(it: ItemInfo | undefined, fallback: string | null): { code: string; desc: string } {
  if (!it) return { code: "—", desc: fallback && !/^Historical line/i.test(fallback) ? fallback : "" };
  const code = it.sku_code || it.style_code || "—";
  const bits = [it.description || it.style_code, [it.color, it.size, it.inseam].filter(Boolean).join(" / ")].filter(Boolean);
  return { code, desc: bits.join(" — ") };
}

export default function SourceDocumentModal({ doc, onClose }: { doc: SourceDocOpen; onClose: () => void }) {
  const [data, setData] = useState<DocHeader | null>(null);
  const [items, setItems] = useState<Record<string, ItemInfo>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const isAr = doc.docType === "ar";
  const title = isAr ? "Invoice" : "Bill";
  const partyLabel = isAr ? "Customer" : "Vendor";
  const endpoint = isAr ? "ar-invoices" : "ap-invoices";
  const moduleKey: DrillModuleKey = isAr ? "ar_invoices" : "ap_invoices";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await fetch(`/api/internal/${endpoint}/${doc.id}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const full = await r.json() as DocHeader;
        if (cancelled) return;
        setData(full);

        // Resolve the SKU / style / color / size for each inventory line.
        const ids = [...new Set((full.lines || []).map((l) => l.inventory_item_id).filter(Boolean) as string[])];
        if (ids.length > 0) {
          try {
            const ir = await fetch(`/api/internal/items?ids=${encodeURIComponent(ids.join(","))}`);
            if (ir.ok) {
              const list = await ir.json() as ItemInfo[];
              if (!cancelled) {
                const idx: Record<string, ItemInfo> = {};
                for (const it of list) idx[it.id] = it;
                setItems(idx);
              }
            }
          } catch { /* non-fatal — lines fall back to their stored description */ }
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [doc.id, endpoint]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totals = useMemo(() => {
    let sub = 0, tax = 0;
    for (const l of data?.lines || []) { sub += centsToNum(l.line_total_cents); tax += centsToNum(l.tax_amount_cents); }
    const total = centsToNum(data?.total_amount_cents) || (sub + tax);
    const paid = centsToNum(data?.paid_amount_cents);
    return { sub, tax, total, paid, balance: total - paid };
  }, [data]);

  const number = data?.invoice_number || doc.number || "—";

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1200, paddingTop: 40, paddingBottom: 40, overflowY: "auto" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, width: "min(780px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        {/* Document header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 20 }}>
            {title} <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{number}</span>
          </h3>
          {data?.gl_status && (
            <span style={{ color: statusColor(data.gl_status), fontWeight: 600, fontSize: 13 }}>● {data.gl_status}</span>
          )}
        </div>
        <div style={{ color: C.textSub, fontSize: 15, marginBottom: 16 }}>
          <span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginRight: 8 }}>{partyLabel}</span>
          {doc.party || "—"}
        </div>

        {loading && <div style={{ color: C.textMuted, fontSize: 13, padding: "12px 0" }}>Loading document…</div>}
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        {data && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 18, fontSize: 13 }}>
              <div>
                <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>{isAr ? "Invoice date" : "Bill date"}</div>
                <div>{data.invoice_date ? fmtDateDisplay(data.invoice_date) : "—"}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>Due date</div>
                <div>{data.due_date ? fmtDateDisplay(data.due_date) : "—"}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>Total</div>
                <div style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700 }}>${money(totals.total)}</div>
              </div>
            </div>

            {/* Line items */}
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Line items</div>
            <div style={{ background: C.panel, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, width: 36 }}>#</th>
                      <th style={th}>Item</th>
                      <th style={{ ...th, width: 70, textAlign: "right" }}>Qty</th>
                      <th style={{ ...th, width: 100, textAlign: "right" }}>Unit price</th>
                      <th style={{ ...th, width: 110, textAlign: "right" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.lines || []).length === 0 && (
                      <tr><td style={{ ...td, color: C.textMuted }} colSpan={5}>No line items on this document.</td></tr>
                    )}
                    {(data.lines || []).map((l) => {
                      const it = l.inventory_item_id ? items[l.inventory_item_id] : undefined;
                      const { code, desc } = skuLabel(it, l.description);
                      return (
                        <tr key={l.id}>
                          <td style={td}>{l.line_number}</td>
                          <td style={{ ...td, fontSize: 12 }}>
                            <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{code}</span>
                            {desc && <div style={{ color: C.textMuted, fontSize: 11 }}>{desc}</div>}
                          </td>
                          <td style={tdNum}>{l.quantity != null ? parseFloat(l.quantity).toLocaleString() : ""}</td>
                          <td style={tdNum}>{money(centsToNum(l.unit_price_cents))}</td>
                          <td style={{ ...tdNum, fontWeight: 600 }}>{money(centsToNum(l.line_total_cents))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ ...td, borderBottom: "none" }} colSpan={3}></td>
                      <td style={{ ...td, borderBottom: "none", color: C.textMuted, textTransform: "uppercase", fontSize: 11, letterSpacing: 0.5, textAlign: "right" }}>Subtotal</td>
                      <td style={{ ...tdNum, borderBottom: "none" }}>{money(totals.sub)}</td>
                    </tr>
                    {totals.tax > 0 && (
                      <tr>
                        <td style={{ ...td, borderBottom: "none" }} colSpan={3}></td>
                        <td style={{ ...td, borderBottom: "none", color: C.textMuted, textTransform: "uppercase", fontSize: 11, letterSpacing: 0.5, textAlign: "right" }}>Tax</td>
                        <td style={{ ...tdNum, borderBottom: "none" }}>{money(totals.tax)}</td>
                      </tr>
                    )}
                    <tr>
                      <td style={{ ...td, borderBottom: "none" }} colSpan={3}></td>
                      <td style={{ ...td, borderBottom: "none", color: C.textSub, textTransform: "uppercase", fontSize: 11, letterSpacing: 0.5, textAlign: "right", fontWeight: 700 }}>Total</td>
                      <td style={{ ...tdNum, borderBottom: "none", fontWeight: 700 }}>${money(totals.total)}</td>
                    </tr>
                    {isAr && totals.paid > 0 && (
                      <>
                        <tr>
                          <td style={{ ...td, borderBottom: "none" }} colSpan={3}></td>
                          <td style={{ ...td, borderBottom: "none", color: C.textMuted, textTransform: "uppercase", fontSize: 11, letterSpacing: 0.5, textAlign: "right" }}>Paid</td>
                          <td style={{ ...tdNum, borderBottom: "none" }}>{money(totals.paid)}</td>
                        </tr>
                        <tr>
                          <td style={{ ...td, borderBottom: "none" }} colSpan={3}></td>
                          <td style={{ ...td, borderBottom: "none", color: C.textSub, textTransform: "uppercase", fontSize: 11, letterSpacing: 0.5, textAlign: "right", fontWeight: 700 }}>Balance</td>
                          <td style={{ ...tdNum, borderBottom: "none", fontWeight: 700, color: totals.balance > 0 ? C.text : C.success }}>{money(totals.balance)}</td>
                        </tr>
                      </>
                    )}
                  </tfoot>
                </table>
              </div>
            </div>

            {(data.description || data.notes) && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Memo</div>
                <div style={{ fontSize: 13, color: C.textSub }}>{data.description || data.notes}</div>
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={() => { onClose(); if (doc.number) drillToModule(moduleKey, { q: doc.number }); }}
            title={`Open this ${title.toLowerCase()} in the ${isAr ? "AR" : "AP"} module`}
            style={btnSecondary}
          >
            Open in {isAr ? "AR" : "AP"} module
          </button>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </div>
  );
}
