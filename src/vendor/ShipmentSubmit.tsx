import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtMoney } from "./utils";
import { isValidContainerNumber } from "./shipmentUtils";

type Carrier = "UPS" | "FedEx" | "USPS" | "DHL" | "Ocean Freight" | "Air Freight" | "Truck" | "Other";
type TrackingType = "" | "CT" | "BL" | "BK";

interface POOption {
  uuid_id: string;
  po_number: string;
  data: { BuyerName?: string; TotalAmount?: number } | null;
}

interface LineItem {
  id: string;
  line_index: number;
  item_number: string | null;
  description: string | null;
  qty_ordered: number | null;
  qty_received: number | null;
  unit_price: number | null;
}

interface LineInput {
  line_id: string;
  item_number: string | null;
  description: string;
  qty_shipped: string;
  include: boolean;
  qty_ordered: number;
  qty_remaining: number;
}

const CARRIERS: Carrier[] = ["UPS", "FedEx", "USPS", "DHL", "Ocean Freight", "Air Freight", "Truck", "Other"];

export default function ShipmentSubmit() {
  const nav = useNavigate();
  const [pos, setPOs] = useState<POOption[]>([]);
  const [selectedPoId, setSelectedPoId] = useState<string>("");
  const [poLines, setPoLines] = useState<LineItem[]>([]);
  const [lineInputs, setLineInputs] = useState<LineInput[]>([]);

  const [asnNumber, setAsnNumber] = useState("");
  const [carrier, setCarrier] = useState<Carrier>("Ocean Freight");
  const [trackingType, setTrackingType] = useState<TrackingType>("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shipDate, setShipDate] = useState(new Date().toISOString().slice(0, 10));
  const [estimatedDelivery, setEstimatedDelivery] = useState("");
  const [notes, setNotes] = useState("");

  const [vendorUserId, setVendorUserId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");
        const { data: vu } = await supabaseVendor
          .from("vendor_users").select("id").eq("auth_id", uid).maybeSingle();
        if (vu) setVendorUserId(vu.id as string);

        const { data, error } = await supabaseVendor
          .from("tanda_pos")
          .select("uuid_id, po_number, data")
          .order("date_order", { ascending: false });
        if (error) throw error;
        const active = (data ?? []).filter((r: { data: { _archived?: boolean } | null }) => !r.data?._archived);
        setPOs(active as POOption[]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedPoId) { setPoLines([]); setLineInputs([]); return; }
    (async () => {
      const { data, error } = await supabaseVendor
        .from("po_line_items")
        .select("id, line_index, item_number, description, qty_ordered, qty_received, unit_price")
        .eq("po_id", selectedPoId)
        .order("line_index");
      if (error) { setErr(error.message); return; }
      const lines = (data ?? []) as LineItem[];
      setPoLines(lines);
      setLineInputs(
        lines.map((l) => {
          const ord = Number(l.qty_ordered) || 0;
          const rcv = Number(l.qty_received) || 0;
          const remaining = Math.max(0, ord - rcv);
          return {
            line_id: l.id,
            item_number: l.item_number,
            description: l.description ?? "",
            qty_shipped: remaining > 0 ? String(remaining) : "",
            include: remaining > 0,
            qty_ordered: ord,
            qty_remaining: remaining,
          };
        })
      );
    })();
  }, [selectedPoId]);

  const totalLines = useMemo(() => lineInputs.filter((l) => l.include && (Number(l.qty_shipped) || 0) > 0).length, [lineInputs]);

  function updateLine(idx: number, patch: Partial<LineInput>) {
    setLineInputs((xs) => xs.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);

    if (!asnNumber.trim()) { setErr("ASN reference number is required."); return; }
    if (!selectedPoId) { setErr("Select a PO."); return; }
    const includedLines = lineInputs.filter((l) => l.include && (Number(l.qty_shipped) || 0) > 0);
    if (includedLines.length === 0) { setErr("Add at least one line with quantity > 0."); return; }

    if (trackingNumber.trim() && trackingType === "CT") {
      if (!isValidContainerNumber(trackingNumber)) {
        setErr("Container number doesn't pass ISO 6346 checksum.");
        return;
      }
    }
    if (trackingNumber.trim() && !trackingType) {
      setErr("Pick a tracking type (Container / BL / Booking) for the tracking number.");
      return;
    }

    const vendorIdRes = await supabaseVendor.from("vendor_users")
      .select("vendor_id").eq("id", vendorUserId!).maybeSingle();
    const vendor_id = vendorIdRes.data?.vendor_id;
    if (!vendor_id) { setErr("Could not resolve vendor id."); return; }

    const selectedPO = pos.find((p) => p.uuid_id === selectedPoId);

    setBusy(true);
    try {
      const { data: sh, error: shErr } = await supabaseVendor
        .from("shipments")
        .insert({
          vendor_id,
          vendor_user_id: vendorUserId,
          po_id: selectedPoId,
          po_number: selectedPO?.po_number ?? null,
          asn_number: asnNumber.trim(),
          number: trackingNumber.trim() ? trackingNumber.trim().toUpperCase() : null,
          number_type: trackingNumber.trim() && trackingType ? trackingType : null,
          carrier,
          ship_date: shipDate || null,
          estimated_delivery: estimatedDelivery || null,
          workflow_status: "submitted",
          notes: notes.trim() || null,
        })
        .select("id")
        .single();
      if (shErr) throw shErr;

      const lineRows = includedLines.map((l) => ({
        shipment_id: sh!.id,
        po_line_item_id: l.line_id,
        quantity_shipped: Number(l.qty_shipped) || 0,
        notes: null,
      }));
      const { error: lineErr } = await supabaseVendor.from("shipment_lines").insert(lineRows);
      if (lineErr) throw lineErr;

      nav(`/vendor/shipments/${sh!.id}`, { replace: true });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 12 }}>
        <a href="/vendor/shipments" style={{ color: "#FFFFFF", fontSize: 13, textDecoration: "none" }}>← Back to shipments</a>
      </div>

      <form onSubmit={submit} style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: 24, boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>Submit shipment (ASN)</h1>
        <p style={{ margin: 0, marginBottom: 20, color: TH.textMuted, fontSize: 13 }}>
          Tell us what's shipping, against which PO lines. Tracking number is optional — you can add it later once you have the BL or container.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Purchase Order</label>
            <select value={selectedPoId} onChange={(e) => setSelectedPoId(e.target.value)} style={inputStyle} required>
              <option value="">— Select PO —</option>
              {pos.map((p) => (
                <option key={p.uuid_id} value={p.uuid_id}>
                  {p.po_number}{p.data?.BuyerName ? ` · ${p.data.BuyerName}` : ""}{p.data?.TotalAmount ? ` · ${fmtMoney(p.data.TotalAmount)}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>ASN reference number</label>
            <input
              value={asnNumber}
              onChange={(e) => setAsnNumber(e.target.value)}
              placeholder="your internal ref, e.g. ASN-2026-0042"
              style={inputStyle}
              required
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Carrier</label>
            <select value={carrier} onChange={(e) => setCarrier(e.target.value as Carrier)} style={inputStyle}>
              {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Ship date</label>
            <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Estimated delivery</label>
            <input type="date" value={estimatedDelivery} onChange={(e) => setEstimatedDelivery(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ padding: 14, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 8 }}>
            Tracking (optional — add later if not known yet)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 12 }}>
            <select value={trackingType} onChange={(e) => setTrackingType(e.target.value as TrackingType)} style={inputStyle}>
              <option value="">— Type —</option>
              <option value="CT">Container (ISO 6346)</option>
              <option value="BL">Bill of Lading</option>
              <option value="BK">Booking</option>
            </select>
            <input
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
              placeholder="Tracking number (leave blank to add later)"
              style={{ ...inputStyle, fontFamily: "Menlo, monospace", textTransform: "uppercase" }}
            />
          </div>
        </div>

        {selectedPoId && (
          <>
            <div style={{ fontSize: 14, fontWeight: 700, color: TH.text, marginBottom: 8 }}>
              Shipment lines ({totalLines} included)
            </div>
            {poLines.length === 0 ? (
              <div style={{ padding: 16, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, color: TH.textMuted, marginBottom: 14 }}>
                This PO has no materialized line items. Ask your Ring of Fire contact to sync the PO.
              </div>
            ) : (
              <div style={{ border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "32px 100px 1fr 100px 100px", padding: "8px 12px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
                  <div></div>
                  <div>Item</div>
                  <div>Description</div>
                  <div>Remaining</div>
                  <div>Qty shipping</div>
                </div>
                {lineInputs.map((l, idx) => (
                  <div key={l.line_id} style={{ display: "grid", gridTemplateColumns: "32px 100px 1fr 100px 100px", padding: "8px 12px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", gap: 6, opacity: l.include ? 1 : 0.5 }}>
                    <input type="checkbox" checked={l.include} onChange={(e) => updateLine(idx, { include: e.target.checked })} />
                    <div style={{ fontFamily: "Menlo, monospace", fontSize: 12, color: TH.textSub2 }}>{l.item_number ?? "—"}</div>
                    <div style={{ color: TH.text }}>{l.description || "—"}</div>
                    <div style={{ color: TH.textMuted, fontSize: 12 }}>
                      {l.qty_remaining} <span style={{ color: TH.textMuted, fontSize: 11 }}>/ {l.qty_ordered} ordered</span>
                    </div>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      max={l.qty_remaining || undefined}
                      value={l.qty_shipped}
                      onChange={(e) => updateLine(idx, { qty_shipped: e.target.value })}
                      style={{ ...inputStyle, marginBottom: 0, fontSize: 12, padding: "5px 8px" }}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <label style={labelStyle}>Notes (optional)</label>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical", marginBottom: 14 }} />

        {err && (
          <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, marginBottom: 14, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={() => nav("/vendor/shipments")} style={{ padding: "9px 16px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !selectedPoId} style={{ padding: "9px 20px", borderRadius: 7, border: "none", background: busy || !selectedPoId ? TH.textMuted : TH.primary, color: "#FFFFFF", cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
            {busy ? "Submitting…" : "Submit ASN"}
          </button>
        </div>
      </form>
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 6 };
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 14, boxSizing: "border-box" as const, fontFamily: "inherit", marginBottom: 0 };
