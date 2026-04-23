import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate, fmtMoney } from "./utils";
import POMessageThread, { type Sender } from "./POMessageThread";

interface PORow {
  uuid_id: string;
  po_number: string;
  data: Record<string, unknown> | null;
  buyer_name: string | null;
  date_expected_delivery: string | null;
  vendor_id: string | null;
}

interface POLineItem {
  id: string;
  line_index: number;
  item_number: string | null;
  description: string | null;
  qty_ordered: number | null;
  qty_received: number | null;
  unit_price: number | null;
  line_total: number | null;
}

interface ShipmentRow {
  id: string;
  number: string | null;
  number_type: string | null;
  asn_number: string | null;
  carrier: string | null;
  ship_date: string | null;
  estimated_delivery: string | null;
  current_status: string | null;
  workflow_status: string | null;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  total: number | null;
  status: string;
  submitted_at: string;
  paid_at: string | null;
}

type Tab = "overview" | "messages" | "shipments" | "invoices";

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  submitted:    { bg: "#FEF3C7", fg: "#92400E" },
  under_review: { bg: "#DBEAFE", fg: "#1E40AF" },
  approved:     { bg: "#D1FAE5", fg: "#065F46" },
  paid:         { bg: "#A7F3D0", fg: "#064E3B" },
  rejected:     { bg: "#FECACA", fg: "#991B1B" },
};

export default function VendorPODetail() {
  const { id } = useParams<{ id: string }>();
  const [po, setPO] = useState<PORow | null>(null);
  const [lines, setLines] = useState<POLineItem[]>([]);
  const [shipments, setShipments] = useState<ShipmentRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [acked, setAcked] = useState(false);
  const [vendorUserId, setVendorUserId] = useState<string | null>(null);
  const [sender, setSender] = useState<Sender | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");
        const { data: vu } = await supabaseVendor
          .from("vendor_users").select("id, display_name").eq("auth_id", uid).maybeSingle();
        if (vu) {
          setVendorUserId(vu.id as string);
          setSender({
            type: "vendor",
            auth_id: uid,
            name: vu.display_name || userRes.user?.email || "Vendor",
          });
        }

        const [poRes, lineRes, shipRes, invRes, ackRes, msgRes] = await Promise.all([
          supabaseVendor.from("tanda_pos").select("uuid_id, po_number, data, buyer_name, date_expected_delivery, vendor_id").eq("uuid_id", id).maybeSingle(),
          supabaseVendor.from("po_line_items").select("id, line_index, item_number, description, qty_ordered, qty_received, unit_price, line_total").eq("po_id", id).order("line_index"),
          supabaseVendor.from("shipments").select("id, number, number_type, asn_number, carrier, ship_date, estimated_delivery, current_status, workflow_status").eq("po_id", id).order("created_at", { ascending: false }),
          Promise.resolve(null),
          vu ? supabaseVendor.from("po_acknowledgments").select("id").eq("vendor_user_id", vu.id).maybeSingle() : Promise.resolve({ data: null, error: null }),
          supabaseVendor.from("po_messages").select("id, sender_type, read_by_vendor").eq("po_id", id),
        ]);

        if (poRes.error) throw poRes.error;
        if (lineRes.error) throw lineRes.error;
        if (shipRes.error) throw shipRes.error;
        if (msgRes.error) throw msgRes.error;

        setPO(poRes.data as PORow | null);
        setLines((lineRes.data ?? []) as POLineItem[]);
        setShipments((shipRes.data ?? []) as ShipmentRow[]);

        // Acknowledge check keyed by po_number
        if (vu && poRes.data) {
          const { data: ackRow } = await supabaseVendor
            .from("po_acknowledgments")
            .select("id")
            .eq("po_number", poRes.data.po_number)
            .eq("vendor_user_id", vu.id)
            .maybeSingle();
          setAcked(!!ackRow);
        }

        // Invoices linked to this PO
        const { data: invs } = await supabaseVendor
          .from("invoices")
          .select("id, invoice_number, total, status, submitted_at, paid_at")
          .eq("po_id", id)
          .order("submitted_at", { ascending: false });
        setInvoices((invs ?? []) as InvoiceRow[]);

        const unread = ((msgRes.data ?? []) as { sender_type: string; read_by_vendor: boolean }[])
          .filter((m) => m.sender_type === "internal" && !m.read_by_vendor).length;
        setUnreadCount(unread);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  async function acknowledge() {
    if (!po || !vendorUserId || acked) return;
    const { error } = await supabaseVendor
      .from("po_acknowledgments")
      .upsert({ po_number: po.po_number, vendor_user_id: vendorUserId }, { onConflict: "po_number,vendor_user_id" });
    if (error) { alert("Could not acknowledge: " + error.message); return; }
    setAcked(true);
  }

  const payload = (po?.data ?? {}) as {
    BuyerName?: string; StatusName?: string; DateOrder?: string;
    DateExpectedDelivery?: string; TotalAmount?: number; CurrencyCode?: string;
  };
  const lineTotal = useMemo(() => lines.reduce((a, l) => a + (Number(l.line_total) || (Number(l.qty_ordered) || 0) * (Number(l.unit_price) || 0)), 0), [lines]);

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading PO…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!po) return <div style={{ color: "#FFFFFF" }}>PO not found.</div>;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link to="/vendor" style={{ color: "#FFFFFF", fontSize: 13, textDecoration: "none" }}>← Back to POs</Link>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 16, boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 4 }}>PURCHASE ORDER</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: TH.text, fontFamily: "Menlo, monospace", letterSpacing: 0.2 }}>{po.po_number}</div>
            <div style={{ fontSize: 13, color: TH.textSub2, marginTop: 4 }}>
              {po.buyer_name || payload.BuyerName || "—"}
              {payload.StatusName && <> · {payload.StatusName}</>}
            </div>
          </div>
          {acked ? (
            <span style={{ fontSize: 12, padding: "6px 14px", borderRadius: 999, background: "#D1FAE5", color: "#065F46", fontWeight: 700 }}>✓ Acknowledged</span>
          ) : (
            <button onClick={acknowledge} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "inherit" }}>
              Acknowledge PO
            </button>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginTop: 16 }}>
          <InfoCell label="Issued" value={fmtDate(payload.DateOrder)} />
          <InfoCell label="Required by" value={fmtDate(po.date_expected_delivery || payload.DateExpectedDelivery)} />
          <InfoCell label="Total amount" value={fmtMoney(payload.TotalAmount)} />
          <InfoCell label="Line count" value={String(lines.length)} />
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, marginBottom: 14 }}>
        <TabBtn active={tab === "overview"} onClick={() => setTab("overview")}>Overview</TabBtn>
        <TabBtn active={tab === "messages"} onClick={() => setTab("messages")} badge={unreadCount}>Messages</TabBtn>
        <TabBtn active={tab === "shipments"} onClick={() => setTab("shipments")} badge={shipments.length || undefined}>Shipments</TabBtn>
        <TabBtn active={tab === "invoices"} onClick={() => setTab("invoices")} badge={invoices.length || undefined}>Invoices</TabBtn>
      </div>

      {tab === "overview" && (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "12px 20px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 14, fontWeight: 700, color: TH.text }}>Line items</div>
          {lines.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No line items materialized yet.</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "60px 160px 1fr 100px 100px 120px 120px", padding: "10px 20px", background: TH.surfaceHi, borderTop: `1px solid ${TH.border}`, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
                <div>#</div><div>Item</div><div>Description</div><div>Qty ord.</div><div>Qty rcv.</div><div>Unit price</div><div style={{ textAlign: "right" }}>Line total</div>
              </div>
              {lines.map((l) => (
                <div key={l.id} style={{ display: "grid", gridTemplateColumns: "60px 160px 1fr 100px 100px 120px 120px", padding: "10px 20px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                  <div style={{ color: TH.textMuted }}>{l.line_index}</div>
                  <div style={{ fontFamily: "Menlo, monospace", fontSize: 12, color: TH.textSub2 }}>{l.item_number ?? "—"}</div>
                  <div style={{ color: TH.text }}>{l.description ?? "—"}</div>
                  <div style={{ color: TH.textSub2 }}>{l.qty_ordered ?? "—"}</div>
                  <div style={{ color: TH.textSub2 }}>{l.qty_received ?? "—"}</div>
                  <div style={{ color: TH.textSub2 }}>{fmtMoney(l.unit_price ?? undefined)}</div>
                  <div style={{ textAlign: "right", fontWeight: 600, color: TH.text }}>{fmtMoney(l.line_total ?? (Number(l.qty_ordered) || 0) * (Number(l.unit_price) || 0))}</div>
                </div>
              ))}
              <div style={{ padding: "12px 20px", display: "flex", justifyContent: "flex-end", background: TH.surfaceHi, borderTop: `1px solid ${TH.border}` }}>
                <div style={{ fontSize: 14, color: TH.text }}>Lines total <strong style={{ color: TH.primary, marginLeft: 10, fontSize: 16 }}>{fmtMoney(lineTotal)}</strong></div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "messages" && id && sender && (
        <POMessageThread poId={id} poNumber={po.po_number} sender={sender} client={supabaseVendor} height={600} autoMarkRead />
      )}

      {tab === "shipments" && (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
          {shipments.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No shipments linked to this PO yet.</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "120px 160px 110px 160px 140px 130px", padding: "10px 20px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
                <div>Type</div><div>Number / ASN</div><div>Carrier</div><div>Ship date / ETA</div><div>Workflow</div><div style={{ textAlign: "right" }}>Tracking status</div>
              </div>
              {shipments.map((s) => (
                <div key={s.id} style={{ display: "grid", gridTemplateColumns: "120px 160px 110px 160px 140px 130px", padding: "10px 20px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary }}>{s.number_type || "ASN"}</div>
                  <Link to={`/vendor/shipments/${s.id}`} style={{ fontFamily: "Menlo, monospace", fontSize: 12, color: TH.primary, textDecoration: "none" }}>
                    {s.number || s.asn_number || "—"}
                  </Link>
                  <div style={{ color: TH.textSub2 }}>{s.carrier ?? "—"}</div>
                  <div style={{ color: TH.textSub2 }}>
                    {fmtDate(s.ship_date)} → {fmtDate(s.estimated_delivery)}
                  </div>
                  <div style={{ color: TH.textSub2 }}>{s.workflow_status ?? "—"}</div>
                  <div style={{ textAlign: "right", color: TH.textSub2 }}>{s.current_status ?? "—"}</div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab === "invoices" && (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
          {invoices.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No invoices submitted against this PO yet.</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 130px 130px 130px", padding: "10px 20px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
                <div>Invoice #</div><div>Submitted</div><div>Paid</div><div>Amount</div><div>Status</div>
              </div>
              {invoices.map((inv) => {
                const c = STATUS_COLORS[inv.status] ?? STATUS_COLORS.submitted;
                return (
                  <Link key={inv.id} to={`/vendor/invoices/${inv.id}`} style={{ display: "grid", gridTemplateColumns: "1fr 130px 130px 130px 130px", padding: "12px 20px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", color: "inherit", textDecoration: "none" }}>
                    <div style={{ fontFamily: "Menlo, monospace", fontWeight: 600, color: TH.text }}>{inv.invoice_number}</div>
                    <div style={{ color: TH.textSub2 }}>{fmtDate(inv.submitted_at)}</div>
                    <div style={{ color: TH.textSub2 }}>{fmtDate(inv.paid_at)}</div>
                    <div style={{ color: TH.text, fontWeight: 600 }}>{fmtMoney(inv.total ?? undefined)}</div>
                    <div>
                      <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 600, textTransform: "capitalize" }}>
                        {inv.status.replace("_", " ")}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children, badge }: { active: boolean; onClick: () => void; children: React.ReactNode; badge?: number }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 16px",
      background: active ? TH.surface : "transparent",
      color: active ? TH.text : "rgba(255,255,255,0.75)",
      border: `1px solid ${active ? TH.border : "transparent"}`,
      borderBottom: active ? "1px solid transparent" : `1px solid transparent`,
      borderTopLeftRadius: 8, borderTopRightRadius: 8,
      fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
      display: "flex", alignItems: "center", gap: 8,
    }}>
      {children}
      {badge != null && badge > 0 && (
        <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 10, background: TH.primary, color: "#FFFFFF", fontWeight: 700 }}>{badge}</span>
      )}
    </button>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: TH.text }}>{value}</div>
    </div>
  );
}
