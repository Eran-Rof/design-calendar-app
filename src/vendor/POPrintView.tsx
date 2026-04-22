// Printable PO view — mirrors the ROF paper PO layout. Renders at
// /vendor/pos/:id/view. Uses @media print CSS so the page prints
// (or saves to PDF) without the portal chrome. Adapts to whatever
// the Xoro payload in tanda_pos.data happens to carry (sizes,
// colors, pack grids, etc.).

import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate, fmtMoney } from "./utils";
import { ROFLogoFull } from "../utils/styles";

interface PORow {
  uuid_id: string;
  po_number: string;
  data: Record<string, unknown> | null;
  buyer_name: string | null;
  date_expected_delivery: string | null;
}

interface POLine {
  id: string;
  line_index: number;
  item_number: string | null;
  description: string | null;
  qty_ordered: number | null;
  unit_price: number | null;
  line_total: number | null;
}

interface XoroLine {
  Style?: string;
  Description?: string;
  ItemNumber?: string;
  Color?: string;
  ColorName?: string;
  Size?: string;
  Pack?: string;
  QtyOrder?: number;
  QtyOrdered?: number;
  UnitPrice?: number;
  LineTotal?: number;
}

function get(data: Record<string, unknown> | null | undefined, ...keys: string[]): string {
  if (!data) return "";
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

export default function POPrintView() {
  const { id } = useParams<{ id: string }>();
  const [po, setPO] = useState<PORow | null>(null);
  const [lines, setLines] = useState<POLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [{ data: p, error: pErr }, { data: ls, error: lErr }] = await Promise.all([
          supabaseVendor.from("tanda_pos").select("uuid_id, po_number, data, buyer_name, date_expected_delivery").eq("uuid_id", id).maybeSingle(),
          supabaseVendor.from("po_line_items").select("id, line_index, item_number, description, qty_ordered, unit_price, line_total").eq("po_id", id).order("line_index"),
        ]);
        if (pErr) throw pErr;
        if (lErr) throw lErr;
        if (!p) throw new Error("PO not found.");
        setPO(p as PORow);
        setLines((ls ?? []) as POLine[]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // Prefer Xoro items array when present — it carries color/size breakdown.
  // Fall back to the flat po_line_items.
  const styleGroups = useMemo(() => {
    if (!po) return [];
    const xoroItems = ((po.data?.Items || po.data?.PoLineArr) as XoroLine[] | undefined) || [];
    if (xoroItems.length > 0) {
      const byStyle = new Map<string, { style: string; description: string; rows: { color: string; cost: number; pack: string; qty: number }[] }>();
      for (const it of xoroItems) {
        const style = it.Style || it.ItemNumber || "—";
        const bucket = byStyle.get(style) || {
          style,
          description: it.Description || "",
          rows: [],
        };
        bucket.rows.push({
          color: it.ColorName || it.Color || "—",
          cost: Number(it.UnitPrice ?? 0),
          pack: it.Pack || it.Size || "",
          qty: Number(it.QtyOrder ?? it.QtyOrdered ?? 0),
        });
        byStyle.set(style, bucket);
      }
      return Array.from(byStyle.values());
    }
    // Fallback: each po_line_item becomes its own single-row style block.
    return lines.map((l) => ({
      style: l.item_number || "—",
      description: l.description || "",
      rows: [{
        color: "—",
        cost: Number(l.unit_price ?? 0),
        pack: "",
        qty: Number(l.qty_ordered ?? 0),
      }],
    }));
  }, [po, lines]);

  const totals = useMemo(() => {
    let qty = 0, amount = 0;
    for (const g of styleGroups) {
      for (const r of g.rows) {
        qty += r.qty;
        amount += r.qty * r.cost;
      }
    }
    return { qty, amount };
  }, [styleGroups]);

  if (loading) return <div style={{ padding: 40, color: "#0f172a" }}>Loading PO…</div>;
  if (err) return <div style={{ padding: 40, color: "#b91c1c" }}>Error: {err}</div>;
  if (!po) return null;

  const d = po.data || {};
  const currency = get(d, "Currency", "CurrencyCode") || "USD";
  const poNumber = po.po_number || get(d, "PONumber", "PoNumber");
  const exchangeRate = get(d, "ExchangeRate") || "1.00";

  // Header — action bar (hidden on print)
  return (
    <>
      <style>{printCss}</style>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 24px", background: "#0f172a", position: "sticky", top: 0, zIndex: 10 }}>
        <Link to={`/vendor/pos/${id}`} style={{ color: "#fff", fontSize: 13, textDecoration: "none" }}>← Back to PO</Link>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => window.print()} style={toolBtn}>🖨 Print</button>
          <button onClick={() => window.print()} style={toolBtnPrimary}>⬇ Download PDF</button>
        </div>
      </div>

      <div className="po-page">
        {/* Print date + page number */}
        <div className="print-header">
          <span>Print Date: {new Date().toLocaleString()}</span>
          <span>1 of 1</span>
        </div>

        {/* Company + title */}
        <div className="po-top-row">
          <div className="company-block">
            <div className="logo-wrap"><ROFLogoFull height={64} /></div>
            <div className="company-info">
              <div className="bold">ROF, LLC</div>
              <div>6320 Canoga ave, Suite 750</div>
              <div>Woodland Hills, CA 91367</div>
              <div>United States</div>
              <div>(818) 933-4000, (213)622-7011</div>
              <div>info@ringoffireclothing.com</div>
              <div>www.ringoffireclothing.com</div>
              <div>26-3592357</div>
            </div>
          </div>
          <div className="title-block">
            <div className="title">Purchase Order</div>
            <div className="po-number">{poNumber}</div>
            <div className="barcode">|| || || | |||| || ||| |||| |||</div>
          </div>
        </div>

        {/* Vendor + Ship To */}
        <div className="two-col">
          <div className="panel">
            <div className="panel-head">Vendor Details</div>
            <div className="panel-body">
              <div className="bold">{get(d, "VendorName", "Vendor")}</div>
              <div>{get(d, "VendorAddress1", "VendorAddress")}</div>
              <div>
                {[get(d, "VendorCity"), get(d, "VendorState"), get(d, "VendorZip")].filter(Boolean).join(", ")}
              </div>
              <div>{get(d, "VendorCountry")}</div>
              {(get(d, "VendorEmail") || get(d, "VendorPhone")) && (
                <div>
                  {get(d, "VendorEmail") && <>Email: {get(d, "VendorEmail")}</>}
                  {get(d, "VendorEmail") && get(d, "VendorPhone") && ", "}
                  {get(d, "VendorPhone") && <>Ph: {get(d, "VendorPhone")}</>}
                </div>
              )}
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">Ship To</div>
            <div className="panel-body">
              <div className="bold">{get(d, "ShipToName", "ShipTo", "ShipToContact")}</div>
              <div>{get(d, "ShipToAddress1", "ShipToAddress")}</div>
              <div>
                {[get(d, "ShipToCity"), get(d, "ShipToState"), get(d, "ShipToZip")].filter(Boolean).join(", ")}
              </div>
              <div>{get(d, "ShipToCountry")}</div>
              {get(d, "ShipToPhone") && <div>Ph: {get(d, "ShipToPhone")}</div>}
            </div>
          </div>
        </div>

        {/* Shipping Terms grid */}
        <table className="grid-table">
          <thead>
            <tr>
              <th>Shipping Terms</th><th>Request Date</th><th>Reference No</th><th>Shipping #</th>
              <th>Carrier</th><th>Expected Ship Date</th><th>Ship Method</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{get(d, "ShippingTerms")}</td>
              <td>{fmtDate(get(d, "RequestDate", "DateRequest")) || "—"}</td>
              <td>{get(d, "ReferenceNo", "RefNo")}</td>
              <td>{get(d, "ShippingNumber", "ShippingNo")}</td>
              <td>{get(d, "Carrier")}</td>
              <td>{fmtDate(get(d, "ExpectedShipDate", "DateExpectedShip")) || "—"}</td>
              <td>{get(d, "ShipMethod")}</td>
            </tr>
          </tbody>
        </table>

        {/* Buyer / Order grid */}
        <table className="grid-table">
          <thead>
            <tr>
              <th>Buyer Name</th><th>Order Date</th><th>Vendor</th><th>Payment Terms</th>
              <th>Vendor Contact</th><th>Expected Delivery</th><th>FOB</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{po.buyer_name || get(d, "BuyerName")}</td>
              <td>{fmtDate(get(d, "DateOrdered", "DateOrder", "OrderDate")) || "—"}</td>
              <td>{get(d, "VendorName")}</td>
              <td>{get(d, "PaymentTerms", "VendorPaymentTerms")}</td>
              <td>{get(d, "VendorContact")}</td>
              <td>{fmtDate(po.date_expected_delivery || get(d, "DateExpectedDelivery")) || "—"}</td>
              <td>{get(d, "FOB")}</td>
            </tr>
          </tbody>
        </table>

        {/* Line items */}
        <table className="items-table">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Style</th>
              <th>Description</th>
              <th style={{ width: 180 }}>Color</th>
              <th style={{ width: 90 }}>Cost/U</th>
              <th style={{ width: 90 }}>Qty</th>
              <th style={{ width: 80 }}>T.Units</th>
              <th style={{ width: 110, textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {styleGroups.map((g, gi) => {
              const styleTotalQty = g.rows.reduce((a, r) => a + r.qty, 0);
              const styleTotalAmt = g.rows.reduce((a, r) => a + r.qty * r.cost, 0);
              return g.rows.map((r, ri) => (
                <tr key={`${gi}-${ri}`}>
                  {ri === 0 ? <td rowSpan={g.rows.length} className="bold">{g.style}</td> : null}
                  {ri === 0 ? <td rowSpan={g.rows.length}>{g.description}</td> : null}
                  <td>{r.color}{r.pack ? ` (${r.pack})` : ""}</td>
                  <td>{r.cost ? r.cost.toFixed(2) : "—"}</td>
                  <td>{r.qty}</td>
                  {ri === 0 ? <td rowSpan={g.rows.length} className="bold">{styleTotalQty}</td> : null}
                  {ri === 0 ? <td rowSpan={g.rows.length} className="bold" style={{ textAlign: "right" }}>{fmtMoney(styleTotalAmt)}</td> : null}
                </tr>
              ));
            })}
            <tr className="totals-row">
              <td colSpan={5} style={{ textAlign: "right" }}><span className="bold">Total Qty</span></td>
              <td className="bold">{totals.qty}</td>
              <td></td>
            </tr>
          </tbody>
        </table>

        {/* Totals + Memo */}
        <div className="footer-row">
          <div className="footer-left">
            <div><span className="label">Created by</span> {get(d, "CreatedBy")}</div>
            <div><span className="label">Memo</span> {get(d, "Memo")}</div>
            <div><span className="label">Shipping Notes</span> {get(d, "ShippingNotes")}</div>
            <div><span className="label">Exchange Rate</span> <em>{exchangeRate}</em></div>
            <div><span className="label">Vendor Msg</span> {get(d, "VendorMsg")}</div>
          </div>
          <div className="footer-right">
            <div className="totals-line">
              <span className="bold">Sub Total</span>
              <span>{currency}</span>
              <span className="bold money">{fmtMoney(totals.amount)}</span>
            </div>
            <div className="totals-line grand">
              <span className="bold">TOTAL</span>
              <span>{currency}</span>
              <span className="bold money">{fmtMoney(totals.amount)}</span>
            </div>
          </div>
        </div>

        {/* Vendor terms / disclaimers */}
        <div className="disclaimer">
          <div>ALL GOODS MUST BE IN OUR ROF WAREHOUSE NO LATER THAN.</div>
          <div>1. PI to be submitted 2 days after received of official ROF PO.</div>
          <div>2. PP 1 sample to be submitted 7 days of acceptance of official ROF PO.</div>
          <div>3. PP2 / PP3 samples, if needed must be submitted 7 days after receiving comments of PP1 corrections.</div>
          <div>4. Size set (if applicable) to be submitted 4 days after FINAL pp approval. <strong>***MUST NOT CUT BEFORE SIZE SET IS APPROVE BY THE ROF DESIGNED TEAM***</strong></div>
          <div>5. TOP sample to be submitted 4 days after size set approval date.</div>
          <div>6. QC report (Vendor in house report) must be submitted to proceed with shipment approval.</div>
          <div>7. FACTORY MUST ADVISE/CONFIRM PRODUCTION LEAD TIME UPON ACCEPTANCE OF PO. Complete WIP chart (Chart provided by ROF).</div>
          <div>8. If factory does not adhere to the schedule herewith, they are to be held liable for any production delays that may result in a discount/chargeback on said PO and/or they may need to expedite shipment via air, etc, at their own expense, in order to meet agreed upon delivery date.</div>
          <div>9. THE STYLES LISTED ON PO MUST BE TESTED FOR PROP 65 AND THE TEST RESULT MUST PASS FOR DURATION OF 6 MONTHS.</div>
          <div style={{ marginTop: 8 }}><strong>Fabric information:</strong> ***we do not accept Cotton from Xinjiang. It's the supplier's responsibility to provide documents proving it's non-Xinjiang cotton. <strong>Packing Requirements:</strong> BULK BY STYLE/COLOR/SIZE</div>
        </div>
      </div>
    </>
  );
}

const toolBtn: React.CSSProperties = {
  padding: "8px 16px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.3)",
  background: "transparent", color: "#fff", cursor: "pointer",
  fontSize: 13, fontWeight: 600, fontFamily: "inherit",
};
const toolBtnPrimary: React.CSSProperties = {
  ...toolBtn, background: "#3B82F6", borderColor: "#3B82F6",
};

const printCss = `
  .po-page {
    background: #fff;
    color: #0f172a;
    padding: 24px 32px 40px;
    margin: 0 auto;
    max-width: 960px;
    font-family: Helvetica, Arial, sans-serif;
    font-size: 11px;
    line-height: 1.35;
  }
  .print-header { display: flex; justify-content: space-between; font-size: 9px; color: #444; margin-bottom: 4px; }
  .po-top-row { display: flex; justify-content: space-between; margin-bottom: 14px; }
  .company-block { display: flex; gap: 14px; align-items: flex-start; }
  .logo-wrap { flex-shrink: 0; }
  .company-info { font-size: 10px; line-height: 1.45; }
  .company-info .bold { font-weight: 700; }
  .title-block { text-align: right; }
  .title { font-size: 28px; font-weight: 700; }
  .po-number { font-size: 12px; margin-top: 4px; }
  .barcode { font-family: "Libre Barcode 39", "Code 39 Barcode", monospace; font-size: 20px; margin-top: 6px; letter-spacing: 1px; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
  .panel { border: 1px solid #cbd5e1; }
  .panel-head { background: #e2e8f0; padding: 4px 8px; font-weight: 700; font-size: 11px; border-bottom: 1px solid #cbd5e1; }
  .panel-body { padding: 6px 8px; }
  .panel-body .bold { font-weight: 700; }

  .grid-table { width: 100%; border-collapse: collapse; margin-bottom: 6px; font-size: 10px; }
  .grid-table th { background: #e2e8f0; border: 1px solid #cbd5e1; padding: 4px 6px; font-weight: 700; text-align: left; }
  .grid-table td { border: 1px solid #cbd5e1; padding: 4px 6px; }

  .items-table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 11px; }
  .items-table th { background: #cbd5e1; border: 1px solid #94a3b8; padding: 6px; font-weight: 700; text-align: left; }
  .items-table td { border: 1px solid #94a3b8; padding: 6px; vertical-align: top; }
  .items-table .bold { font-weight: 700; }
  .items-table .totals-row td { background: #f1f5f9; font-weight: 700; }

  .footer-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
  .footer-left div { margin-bottom: 3px; font-size: 10px; }
  .footer-left .label { font-weight: 700; display: inline-block; min-width: 110px; }
  .footer-right { background: #cbd5e1; padding: 10px 14px; }
  .totals-line { display: grid; grid-template-columns: 1fr auto 120px; gap: 10px; align-items: baseline; font-size: 12px; margin-bottom: 4px; }
  .totals-line .money { text-align: right; }
  .totals-line.grand { font-size: 16px; background: #94a3b8; margin: 6px -14px -10px; padding: 8px 14px; }

  .disclaimer { margin-top: 16px; font-size: 9px; color: #334155; line-height: 1.45; text-align: center; }
  .disclaimer div { margin-bottom: 2px; }

  .no-print {}

  @media print {
    @page { size: letter; margin: 0.4in; }
    html, body { background: #fff !important; }
    .no-print { display: none !important; }
    .po-page { padding: 0; max-width: none; }
  }
`;
