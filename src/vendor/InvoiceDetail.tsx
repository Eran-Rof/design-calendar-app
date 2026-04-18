import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate, fmtMoney } from "./utils";

interface Invoice {
  id: string;
  invoice_number: string;
  po_id: string | null;
  invoice_date: string | null;
  due_date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  currency: string;
  status: string;
  submitted_at: string;
  approved_at: string | null;
  paid_at: string | null;
  payment_reference: string | null;
  payment_method: string | null;
  rejection_reason: string | null;
  notes: string | null;
}

interface LineRow {
  id: string;
  line_index: number;
  description: string | null;
  quantity_invoiced: number | null;
  unit_price: number | null;
  line_total: number | null;
  po_line_item_id: string | null;
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  submitted:    { bg: "#FEF3C7", fg: "#92400E" },
  under_review: { bg: "#DBEAFE", fg: "#1E40AF" },
  approved:     { bg: "#D1FAE5", fg: "#065F46" },
  paid:         { bg: "#A7F3D0", fg: "#064E3B" },
  rejected:     { bg: "#FECACA", fg: "#991B1B" },
  disputed:     { bg: "#FED7AA", fg: "#9A3412" },
};

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [poNumber, setPoNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [{ data: inv, error: iErr }, { data: lineData, error: lErr }] = await Promise.all([
          supabaseVendor.from("invoices").select("*").eq("id", id).maybeSingle(),
          supabaseVendor
            .from("invoice_line_items")
            .select("id, line_index, description, quantity_invoiced, unit_price, line_total, po_line_item_id")
            .eq("invoice_id", id)
            .order("line_index"),
        ]);
        if (iErr) throw iErr;
        if (lErr) throw lErr;
        if (!inv) throw new Error("Invoice not found.");
        setInvoice(inv as Invoice);
        setLines((lineData ?? []) as LineRow[]);

        if (inv.po_id) {
          const { data: po } = await supabaseVendor
            .from("tanda_pos").select("po_number").eq("uuid_id", inv.po_id).maybeSingle();
          if (po) setPoNumber(po.po_number);
        }
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading invoice…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!invoice) return null;

  const c = STATUS_COLORS[invoice.status] ?? { bg: TH.surfaceHi, fg: TH.text };

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link to="/vendor/invoices" style={{ color: "#FFFFFF", fontSize: 13, textDecoration: "none" }}>← Back to invoices</Link>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 16, boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 4 }}>INVOICE</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: TH.text, fontFamily: "Menlo, monospace" }}>{invoice.invoice_number}</div>
            <div style={{ fontSize: 13, color: TH.textSub2, marginTop: 4 }}>
              {poNumber && <>PO <strong>{poNumber}</strong> · </>}
              Submitted {fmtDate(invoice.submitted_at)}
            </div>
          </div>
          <span style={{ fontSize: 13, padding: "6px 14px", borderRadius: 999, background: c.bg, color: c.fg, fontWeight: 700, textTransform: "capitalize" }}>
            {invoice.status.replace("_", " ")}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginTop: 18 }}>
          <InfoCell label="Invoice date" value={fmtDate(invoice.invoice_date)} />
          <InfoCell label="Due date" value={fmtDate(invoice.due_date)} />
          <InfoCell label="Currency" value={invoice.currency} />
          {invoice.approved_at && <InfoCell label="Approved" value={fmtDate(invoice.approved_at)} tone="ok" />}
          {invoice.paid_at && <InfoCell label="Paid" value={fmtDate(invoice.paid_at)} tone="ok" />}
        </div>

        {invoice.payment_reference && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13 }}>
            <strong style={{ color: TH.text }}>Payment:</strong>{" "}
            <span style={{ color: TH.textSub2 }}>{invoice.payment_method || "—"} · Ref {invoice.payment_reference}</span>
          </div>
        )}
        {invoice.rejection_reason && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, fontSize: 13, color: TH.primary }}>
            <strong>Rejection reason:</strong> {invoice.rejection_reason}
          </div>
        )}
        {invoice.notes && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, color: TH.textSub2 }}>
            <strong style={{ color: TH.text }}>Notes:</strong> {invoice.notes}
          </div>
        )}
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ padding: "12px 20px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 14, fontWeight: 700, color: TH.text }}>
          Line items
        </div>
        {lines.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No line items on this invoice.</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 100px 140px 140px", padding: "10px 20px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
              <div>#</div>
              <div>Description</div>
              <div>Qty</div>
              <div>Unit price</div>
              <div style={{ textAlign: "right" }}>Line total</div>
            </div>
            {lines.map((l) => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "60px 1fr 100px 140px 140px", padding: "10px 20px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                <div style={{ color: TH.textMuted }}>{l.line_index}</div>
                <div style={{ color: TH.text }}>{l.description ?? "—"}</div>
                <div style={{ color: TH.textSub2 }}>{l.quantity_invoiced ?? "—"}</div>
                <div style={{ color: TH.textSub2 }}>{fmtMoney(l.unit_price ?? undefined)}</div>
                <div style={{ textAlign: "right", fontWeight: 600, color: TH.text }}>{fmtMoney(l.line_total ?? undefined)}</div>
              </div>
            ))}
            <div style={{ padding: "14px 20px", display: "flex", justifyContent: "flex-end" }}>
              <div style={{ minWidth: 280 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: TH.textSub2, marginBottom: 6 }}>
                  <span>Subtotal</span><strong style={{ color: TH.text }}>{fmtMoney(invoice.subtotal ?? undefined)}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: TH.textSub2, marginBottom: 6 }}>
                  <span>Tax</span><strong style={{ color: TH.text }}>{fmtMoney(invoice.tax ?? undefined)}</strong>
                </div>
                <div style={{ borderTop: `1px solid ${TH.border}`, paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 16 }}>
                  <strong>Total</strong><strong style={{ color: TH.primary }}>{fmtMoney(invoice.total ?? undefined)}</strong>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InfoCell({ label, value, tone }: { label: string; value: string; tone?: "ok" }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: tone === "ok" ? "#047857" : TH.text }}>{value}</div>
    </div>
  );
}
