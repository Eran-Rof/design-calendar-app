import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";
import { fmtMoney, todayLocalIso } from "../utils";
import { isValidContainerNumber } from "./shipmentUtils";
import SearchableSelect from "../../tanda/components/SearchableSelect";

type SubmitMode = "asn_only" | "asn_and_invoice";

type TrackingType = "" | "CT" | "BL" | "BK";

const CARRIER_GROUPS: { label: string; carriers: string[] }[] = [
  { label: "Parcel / courier", carriers: ["UPS", "FedEx", "USPS", "DHL"] },
  { label: "Ocean", carriers: [
    "MSC",
    "Maersk",
    "CMA CGM",
    "COSCO Shipping Lines",
    "Hapag-Lloyd",
    "Ocean Network Express (ONE)",
    "Evergreen Line",
    "HMM",
    "Yang Ming",
    "ZIM",
    "Wan Hai Lines",
    "PIL",
    "X-Press Feeders",
    "SITC",
    "UniFeeder",
    "KMTC",
  ]},
  { label: "Air", carriers: ["Air Freight"] },
  { label: "Road", carriers: ["Truck"] },
  { label: "Other", carriers: ["Other"] },
];

interface POOption {
  uuid_id: string;
  po_number: string;
  data: { BuyerName?: string; TotalAmount?: number } | null;
  /** "xoro" = tanda_pos; "tangerine" = purchase_orders (new ERP). */
  source?: "xoro" | "tangerine";
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

export default function ShipmentSubmit() {
  const nav = useNavigate();
  const [pos, setPOs] = useState<POOption[]>([]);
  const [selectedPoId, setSelectedPoId] = useState<string>("");
  const [poLines, setPoLines] = useState<LineItem[]>([]);
  const [lineInputs, setLineInputs] = useState<LineInput[]>([]);

  const [asnNumber, setAsnNumber] = useState("");
  const [carrier, setCarrier] = useState<string>("MSC");
  const [shipVia, setShipVia] = useState<string>("Ocean");
  const [trackingType, setTrackingType] = useState<TrackingType>("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shipDate, setShipDate] = useState(todayLocalIso());
  const [estimatedPortDate, setEstimatedPortDate] = useState("");
  const [estimatedDelivery, setEstimatedDelivery] = useState("");
  const [notes, setNotes] = useState("");
  const [packingListFile, setPackingListFile] = useState<File | null>(null);
  const [blFile, setBlFile] = useState<File | null>(null);
  const [extractStatus, setExtractStatus] = useState<string | null>(null);

  const [vendorUserId, setVendorUserId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");
        const { data: vu } = await supabaseVendor
          .from("vendor_users").select("id, vendor_id").eq("auth_id", uid).maybeSingle();
        if (vu) {
          setVendorUserId(vu.id as string);
          setVendorId((vu as { vendor_id: string }).vendor_id);
        }

        const vendorIdLocal = (vu as { vendor_id?: string } | null)?.vendor_id || null;
        const { data, error } = await supabaseVendor
          .from("tanda_pos")
          .select("uuid_id, po_number, data")
          .order("date_order", { ascending: false });
        if (error) throw error;
        const xoro = (data ?? [])
          .filter((r: { data: { _archived?: boolean } | null }) => !r.data?._archived)
          .map((r) => ({ ...(r as POOption), source: "xoro" as const }));

        // Tangerine-native POs (purchase_orders) — union them so the vendor can
        // submit an ASN against either source. Additive + fail-safe.
        let tangerine: POOption[] = [];
        try {
          if (vendorIdLocal) {
            const { data: tpos } = await supabaseVendor
              .from("purchase_orders")
              .select("id, po_number, total_cents")
              .eq("vendor_id", vendorIdLocal)
              .in("status", ["issued", "in_transit", "received"])
              .order("order_date", { ascending: false });
            tangerine = (tpos ?? []).map((p: { id: string; po_number: string; total_cents: number | null }) => ({
              uuid_id: p.id,
              po_number: p.po_number,
              data: { TotalAmount: typeof p.total_cents === "number" ? p.total_cents / 100 : undefined },
              source: "tangerine" as const,
            }));
          }
        } catch { /* additive — ignore so the Xoro list still works */ }

        setPOs([...xoro, ...tangerine]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedPoId) { setPoLines([]); setLineInputs([]); return; }
    const isTangerine = pos.find((p) => p.uuid_id === selectedPoId)?.source === "tangerine";
    (async () => {
      let lines: LineItem[] = [];
      if (isTangerine) {
        // Tangerine PO lines live in purchase_order_lines (cents → dollars).
        const { data, error } = await supabaseVendor
          .from("purchase_order_lines")
          .select("id, line_number, description, qty_ordered, qty_received, unit_cost_cents")
          .eq("purchase_order_id", selectedPoId)
          .order("line_number");
        if (error) { setErr(error.message); return; }
        lines = ((data ?? []) as Array<Record<string, unknown>>).map((l) => ({
          id: l.id as string,
          line_index: (l.line_number as number) ?? 0,
          item_number: null,
          description: (l.description as string | null) ?? null,
          qty_ordered: (l.qty_ordered as number | null) ?? null,
          qty_received: (l.qty_received as number | null) ?? null,
          unit_price: typeof l.unit_cost_cents === "number" ? (l.unit_cost_cents as number) / 100 : null,
        }));
      } else {
        const { data, error } = await supabaseVendor
          .from("po_line_items")
          .select("id, line_index, item_number, description, qty_ordered, qty_received, unit_price")
          .eq("po_id", selectedPoId)
          .order("line_index");
        if (error) { setErr(error.message); return; }
        lines = (data ?? []) as LineItem[];
      }
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
  }, [selectedPoId, pos]);

  const totalLines = useMemo(() => lineInputs.filter((l) => l.include && (Number(l.qty_shipped) || 0) > 0).length, [lineInputs]);

  function updateLine(idx: number, patch: Partial<LineInput>) {
    setLineInputs((xs) => xs.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function submit(e: FormEvent, mode: SubmitMode = "asn_only") {
    e.preventDefault();
    setErr(null);
    setExtractStatus(null);

    if (!asnNumber.trim()) { setErr("ASN reference number is required."); return; }
    if (!selectedPoId) { setErr("Select a PO."); return; }
    const includedLines = lineInputs.filter((l) => l.include && (Number(l.qty_shipped) || 0) > 0);
    if (includedLines.length === 0) { setErr("Add at least one line with quantity > 0."); return; }
    if (mode === "asn_and_invoice" && !packingListFile) {
      setErr("Attach a packing list (PDF or Excel) to use the combined ASN + Invoice flow — the AI reads it to draft the invoice.");
      return;
    }

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

    setBusy(true);
    try {
      const { data: session } = await supabaseVendor.auth.getSession();
      const accessToken = session?.session?.access_token;
      if (!accessToken) { setErr("Not signed in."); setBusy(false); return; }

      async function uploadDoc(f: File | null, subdir: string): Promise<string | null> {
        if (!f) return null;
        if (!vendorId) throw new Error("Vendor not resolved yet.");
        const MAX = 10 * 1024 * 1024;
        if (f.size > MAX) throw new Error(`${subdir} exceeds 10 MB limit.`);
        const ext = f.name.split(".").pop()?.toLowerCase();
        const allowed = ["pdf", "xls", "xlsx"];
        if (!ext || !allowed.includes(ext)) throw new Error(`${subdir} must be PDF or Excel.`);
        const path = `${vendorId}/shipments/${Date.now()}_${subdir}_${f.name.replace(/\s+/g, "_")}`;
        const { error: upErr } = await supabaseVendor.storage.from("vendor-docs").upload(path, f, { upsert: false });
        if (upErr) throw upErr;
        return path;
      }
      const packingListUrl = await uploadDoc(packingListFile, "packing_list");
      const blUrl = await uploadDoc(blFile, "bl");

      const lineItems = includedLines.map((l) => ({
        po_line_item_id: l.line_id,
        quantity_shipped: Number(l.qty_shipped) || 0,
      }));

      const r = await fetch("/api/vendor/shipments", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          po_id: selectedPoId,
          asn_number: asnNumber.trim(),
          carrier,
          ship_via: shipVia,
          ship_date: shipDate || null,
          estimated_port_date: estimatedPortDate || null,
          estimated_delivery: estimatedDelivery || null,
          number: trackingNumber.trim() || undefined,
          number_type: trackingNumber.trim() && trackingType ? trackingType : undefined,
          notes: notes.trim() || null,
          packing_list_url: packingListUrl,
          bl_document_url: blUrl,
          line_items: lineItems,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);

      if (mode === "asn_and_invoice" && packingListUrl) {
        setExtractStatus("Reading packing list with AI to draft the invoice…");
        const extractRes = await fetch("/api/vendor/ai-extract-invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ file_url: packingListUrl, po_id: selectedPoId }),
        });
        const extractBody = await extractRes.json().catch(() => ({}));
        if (!extractRes.ok) {
          throw new Error(`ASN was submitted, but AI extraction failed: ${extractBody?.error || extractRes.status}`);
        }
        // Hand the extracted payload off to InvoiceSubmit for user review.
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(extractBody.extracted || {}))));
        nav(`/vendor/invoices/new?po=${selectedPoId}&asn=${body.id}&file=${encodeURIComponent(packingListUrl)}&extracted=${encoded}`, { replace: true });
        return;
      }

      nav(`/vendor/shipments/${body.id}`, { replace: true });
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

      <form onSubmit={(e) => void submit(e, "asn_only")} style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: 24, boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>Submit shipment (ASN)</h1>
        <p style={{ margin: 0, marginBottom: 20, color: TH.textMuted, fontSize: 13 }}>
          Tell us what's shipping, against which PO lines. Tracking number is optional — you can add it later once you have the BL or container.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Purchase Order</label>
            <SearchableSelect
              value={selectedPoId || null}
              onChange={(v) => setSelectedPoId(v)}
              required
              placeholder="— Select PO —"
              options={[
                { value: "", label: "— Select PO —" },
                ...pos.map((p) => ({
                  value: p.uuid_id,
                  label: `${p.po_number}${p.data?.BuyerName ? ` · ${p.data.BuyerName}` : ""}${p.data?.TotalAmount ? ` · ${fmtMoney(p.data.TotalAmount)}` : ""}`,
                })),
              ]}
              inputStyle={inputStyle}
            />
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

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Carrier</label>
            <SearchableSelect
              value={carrier || null}
              onChange={(v) => setCarrier(v)}
              options={CARRIER_GROUPS.flatMap((g) => g.carriers.map((c) => ({ value: c, label: c, group: g.label })))}
              inputStyle={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Ship via</label>
            <SearchableSelect
              value={shipVia || null}
              onChange={(v) => setShipVia(v)}
              options={[
                { value: "Ocean", label: "Ocean" },
                { value: "Air", label: "Air" },
                { value: "Truck", label: "Truck" },
                { value: "Rail", label: "Rail" },
                { value: "Ocean/Rail", label: "Ocean/Rail" },
                { value: "Ocean/Air", label: "Ocean/Air" },
              ]}
              inputStyle={inputStyle}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Ship date</label>
            <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Estimated port date</label>
            <input type="date" value={estimatedPortDate} onChange={(e) => setEstimatedPortDate(e.target.value)} style={inputStyle} />
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
            <SearchableSelect
              value={trackingType}
              onChange={(v) => setTrackingType(v as TrackingType)}
              placeholder="— Type —"
              options={[
                { value: "", label: "— Type —" },
                { value: "CT", label: "Container (ISO 6346)" },
                { value: "BL", label: "Bill of Lading" },
                { value: "BK", label: "Booking" },
              ]}
              inputStyle={inputStyle}
            />
            <input
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
              placeholder="Tracking number (leave blank to add later)"
              style={{ ...inputStyle, fontFamily: "Menlo, monospace", textTransform: "uppercase" }}
            />
          </div>
        </div>

        <div style={{ padding: 14, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 8 }}>
            Documents (PDF or Excel, 10 MB max each)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>
                Packing list
                <span style={{ fontSize: 10, color: TH.textMuted, fontWeight: 400, marginLeft: 6 }}>
                  (also the source for "Submit ASN + Invoice")
                </span>
              </label>
              <input
                type="file"
                accept="application/pdf,.pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xls,.xlsx"
                onChange={(e) => setPackingListFile(e.target.files?.[0] || null)}
              />
              {packingListFile && <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>{packingListFile.name} · {(packingListFile.size / 1024).toFixed(0)} KB</div>}
            </div>
            <div>
              <label style={labelStyle}>Bill of Lading</label>
              <input
                type="file"
                accept="application/pdf,.pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xls,.xlsx"
                onChange={(e) => setBlFile(e.target.files?.[0] || null)}
              />
              {blFile && <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>{blFile.name} · {(blFile.size / 1024).toFixed(0)} KB</div>}
            </div>
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
        {extractStatus && (
          <div style={{ color: TH.textSub2, padding: "10px 12px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, marginBottom: 14, fontSize: 13 }}>
            {extractStatus}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={() => nav("/vendor/shipments")} style={{ padding: "9px 16px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !selectedPoId} style={{ padding: "9px 20px", borderRadius: 7, border: "none", background: busy || !selectedPoId ? TH.textMuted : TH.primary, color: "#FFFFFF", cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
            {busy ? "Submitting…" : "Submit ASN"}
          </button>
          <button
            type="button"
            onClick={(e) => void submit(e as unknown as FormEvent, "asn_and_invoice")}
            disabled={busy || !selectedPoId || !packingListFile}
            title={!packingListFile ? "Attach a packing list above to enable this button — the AI reads it to draft the invoice." : undefined}
            style={{
              padding: "9px 20px", borderRadius: 7, border: "none",
              background: busy || !selectedPoId || !packingListFile ? TH.textMuted : "#047857",
              color: "#FFFFFF",
              cursor: busy || !packingListFile ? "not-allowed" : "pointer",
              fontFamily: "inherit", fontSize: 13, fontWeight: 600,
            }}
          >
            {busy ? "Submitting…" : "Submit ASN + Invoice"}
          </button>
        </div>
      </form>
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 6 };
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 14, boxSizing: "border-box" as const, fontFamily: "inherit", marginBottom: 0 };
