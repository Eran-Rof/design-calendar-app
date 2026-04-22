import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate } from "./utils";

const CARRIER_GROUPS: { label: string; carriers: string[] }[] = [
  { label: "Parcel / courier", carriers: ["UPS", "FedEx", "USPS", "DHL"] },
  { label: "Ocean", carriers: [
    "MSC", "Maersk", "CMA CGM", "COSCO Shipping Lines", "Hapag-Lloyd",
    "Ocean Network Express (ONE)", "Evergreen Line", "HMM", "Yang Ming",
    "ZIM", "Wan Hai Lines", "PIL", "X-Press Feeders", "SITC", "UniFeeder", "KMTC",
  ]},
  { label: "Air", carriers: ["Air Freight"] },
  { label: "Road", carriers: ["Truck"] },
  { label: "Other", carriers: ["Other"] },
];
const SHIP_VIA_OPTIONS = ["Ocean", "Air", "Truck", "Rail", "Ocean/Rail", "Ocean/Air"];

interface Shipment {
  id: string;
  number: string;
  number_type: string;
  sealine_scac: string | null;
  sealine_name: string | null;
  pol_locode: string | null;
  pod_locode: string | null;
  pol_date: string | null;
  pod_date: string | null;
  eta: string | null;
  ata: string | null;
  current_status: string | null;
  last_tracked_at: string | null;
  po_number: string | null;
  // Vendor-supplied fields
  asn_number: string | null;
  carrier: string | null;
  ship_via: string | null;
  ship_date: string | null;
  estimated_delivery: string | null;
  workflow_status: string | null;
  notes: string | null;
  packing_list_url: string | null;
  bl_document_url: string | null;
}

interface EventRow {
  id: string;
  container_number: string | null;
  order_id: number | null;
  event_code: string | null;
  event_type: string | null;
  status: string | null;
  description: string | null;
  location_locode: string | null;
  facility_name: string | null;
  event_date: string | null;
  is_actual: boolean;
}

export default function ShipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editSave, setEditSave] = useState({
    asn_number: "", carrier: "", ship_via: "",
    ship_date: "", estimated_port_date: "", estimated_delivery: "",
    number: "", number_type: "",
    notes: "",
  });
  const [replacePackingList, setReplacePackingList] = useState<File | null>(null);
  const [replaceBl, setReplaceBl] = useState<File | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setErr(null);
    try {
      const [{ data: s, error: sErr }, { data: ev, error: evErr }] = await Promise.all([
        supabaseVendor.from("shipments").select("*").eq("id", id).maybeSingle(),
        supabaseVendor
          .from("shipment_events")
          .select("id, container_number, order_id, event_code, event_type, status, description, location_locode, facility_name, event_date, is_actual")
          .eq("shipment_id", id)
          .order("event_date", { ascending: true }),
      ]);
      if (sErr) throw sErr;
      if (evErr) throw evErr;
      if (!s) throw new Error("Shipment not found.");
      setShipment(s as Shipment);
      setEvents((ev ?? []) as EventRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [id]);

  async function refresh(forceUpdate: boolean) {
    if (!shipment) return;
    if (forceUpdate) {
      const ok = window.confirm("Live refresh pulls directly from the carrier and uses 1 billable API call. Proceed?");
      if (!ok) return;
    }
    setRefreshMsg(null);
    setRefreshing(true);
    try {
      const { data: sessionRes } = await supabaseVendor.auth.getSession();
      const accessToken = sessionRes?.session?.access_token;
      if (!accessToken) { setRefreshMsg("Not signed in."); return; }

      const q = new URLSearchParams();
      q.set("number", shipment.number);
      q.set("type", shipment.number_type);
      if (shipment.sealine_scac) q.set("sealine", shipment.sealine_scac);
      q.set("force_update", forceUpdate ? "true" : "false");

      const res = await fetch(`/api/searates-proxy?${q.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.error) {
        setRefreshMsg(body?.error || `Refresh failed (${res.status})`);
        return;
      }
      setRefreshMsg(forceUpdate ? "Live refresh complete." : "Refreshed from cache.");
      await load();
    } catch (e: unknown) {
      setRefreshMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function openDoc(path: string | null) {
    if (!path) return;
    const { data, error } = await supabaseVendor.storage.from("vendor-docs").createSignedUrl(path, 60);
    if (error || !data?.signedUrl) { alert("Unable to open: " + (error?.message || "unknown")); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  function startEdit() {
    if (!shipment) return;
    setEditSave({
      asn_number: shipment.asn_number || "",
      carrier: shipment.carrier || "",
      ship_via: shipment.ship_via || "",
      ship_date: shipment.ship_date || "",
      estimated_port_date: shipment.eta || "",
      estimated_delivery: shipment.estimated_delivery || "",
      number: shipment.number || "",
      number_type: shipment.number_type || "",
      notes: shipment.notes || "",
    });
    setReplacePackingList(null);
    setReplaceBl(null);
    setEditing(true);
  }

  async function saveEdit() {
    if (!shipment) return;
    setSaving(true);
    setErr(null);
    try {
      const { data: sessionRes } = await supabaseVendor.auth.getSession();
      const accessToken = sessionRes?.session?.access_token;
      if (!accessToken) throw new Error("Not signed in.");

      async function uploadDoc(f: File | null, subdir: string): Promise<string | undefined> {
        if (!f) return undefined;
        const MAX = 10 * 1024 * 1024;
        if (f.size > MAX) throw new Error(`${subdir} exceeds 10 MB limit.`);
        const ext = f.name.split(".").pop()?.toLowerCase();
        if (!ext || !["pdf", "xls", "xlsx"].includes(ext)) throw new Error(`${subdir} must be PDF or Excel.`);
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");
        const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", uid).maybeSingle();
        const vid = (vu as { vendor_id: string } | null)?.vendor_id;
        if (!vid) throw new Error("Not linked to a vendor.");
        const path = `${vid}/shipments/${Date.now()}_${subdir}_${f.name.replace(/\s+/g, "_")}`;
        const { error: upErr } = await supabaseVendor.storage.from("vendor-docs").upload(path, f, { upsert: false });
        if (upErr) throw upErr;
        return path;
      }

      const packingListUrl = await uploadDoc(replacePackingList, "packing_list");
      const blUrl = await uploadDoc(replaceBl, "bl");

      const payload: Record<string, unknown> = {
        asn_number: editSave.asn_number || null,
        carrier: editSave.carrier || null,
        ship_via: editSave.ship_via || null,
        ship_date: editSave.ship_date || null,
        estimated_port_date: editSave.estimated_port_date || null,
        estimated_delivery: editSave.estimated_delivery || null,
        number: editSave.number || null,
        number_type: editSave.number_type || null,
        notes: editSave.notes || null,
      };
      if (packingListUrl) payload.packing_list_url = packingListUrl;
      if (blUrl) payload.bl_document_url = blUrl;

      const r = await fetch(`/api/vendor/shipments/${shipment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
      });
      const resBody = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(resBody?.error || `Request failed (${r.status})`);
      setShipment(resBody as Shipment);
      setEditing(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading shipment…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!shipment) return null;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link to="/vendor/shipments" style={{ color: "#FFFFFF", fontSize: 13, textDecoration: "none" }}>← Back to shipments</Link>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 16, boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 4 }}>{shipment.number_type}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: TH.text, fontFamily: "Menlo, monospace", letterSpacing: 0.2 }}>{shipment.number}</div>
            <div style={{ fontSize: 13, color: TH.textSub2, marginTop: 4 }}>
              {shipment.sealine_name || shipment.sealine_scac || "Carrier unknown"}
              {shipment.po_number && <> · PO <strong>{shipment.po_number}</strong></>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {shipment.workflow_status === "submitted" && !editing && (
              <button onClick={startEdit} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "none", color: TH.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
                Edit
              </button>
            )}
            {shipment.current_status && (
              <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 12px", borderRadius: 999, background: TH.surfaceHi, border: `1px solid ${TH.border}`, color: TH.text }}>
                {shipment.current_status}
              </span>
            )}
          </div>
        </div>

        {editing ? (
          <div style={{ marginTop: 18, padding: 14, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: TH.textSub, textTransform: "uppercase", marginBottom: 10 }}>Shipment details</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Labelled label="ASN number">
                <input value={editSave.asn_number} onChange={(e) => setEditSave((s) => ({ ...s, asn_number: e.target.value }))} style={editInp} />
              </Labelled>
              <Labelled label="Carrier">
                <select value={editSave.carrier} onChange={(e) => setEditSave((s) => ({ ...s, carrier: e.target.value }))} style={editInp}>
                  <option value="">—</option>
                  {CARRIER_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.carriers.map((c) => <option key={c} value={c}>{c}</option>)}
                    </optgroup>
                  ))}
                </select>
              </Labelled>
              <Labelled label="Ship via">
                <select value={editSave.ship_via} onChange={(e) => setEditSave((s) => ({ ...s, ship_via: e.target.value }))} style={editInp}>
                  <option value="">—</option>
                  {SHIP_VIA_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Labelled>
              <Labelled label="Tracking type">
                <select value={editSave.number_type} onChange={(e) => setEditSave((s) => ({ ...s, number_type: e.target.value }))} style={editInp}>
                  <option value="">—</option>
                  <option value="CT">Container</option>
                  <option value="BL">Bill of Lading</option>
                  <option value="BK">Booking</option>
                </select>
              </Labelled>
              <Labelled label="Tracking number">
                <input value={editSave.number} onChange={(e) => setEditSave((s) => ({ ...s, number: e.target.value }))} style={{ ...editInp, fontFamily: "Menlo, monospace", textTransform: "uppercase" }} />
              </Labelled>
              <Labelled label="Ship date">
                <input type="date" value={editSave.ship_date} onChange={(e) => setEditSave((s) => ({ ...s, ship_date: e.target.value }))} style={editInp} />
              </Labelled>
              <Labelled label="Estimated port date">
                <input type="date" value={editSave.estimated_port_date} onChange={(e) => setEditSave((s) => ({ ...s, estimated_port_date: e.target.value }))} style={editInp} />
              </Labelled>
              <Labelled label="Estimated delivery">
                <input type="date" value={editSave.estimated_delivery} onChange={(e) => setEditSave((s) => ({ ...s, estimated_delivery: e.target.value }))} style={editInp} />
              </Labelled>
              <Labelled label="Replace packing list (optional)">
                <input type="file" accept="application/pdf,.pdf,.xls,.xlsx" onChange={(e) => setReplacePackingList(e.target.files?.[0] || null)} />
              </Labelled>
              <Labelled label="Replace BL document (optional)">
                <input type="file" accept="application/pdf,.pdf,.xls,.xlsx" onChange={(e) => setReplaceBl(e.target.files?.[0] || null)} />
              </Labelled>
              <div style={{ gridColumn: "1 / -1" }}>
                <Labelled label="Notes">
                  <textarea rows={2} value={editSave.notes} onChange={(e) => setEditSave((s) => ({ ...s, notes: e.target.value }))} style={{ ...editInp, fontFamily: "inherit", resize: "vertical" }} />
                </Labelled>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { setEditing(false); setErr(null); }} disabled={saving} style={{ padding: "8px 16px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "none", color: TH.text, cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>Cancel</button>
              <button onClick={() => void saveEdit()} disabled={saving} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: saving ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 18, padding: 14, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: TH.textSub, textTransform: "uppercase", marginBottom: 10 }}>Shipment details</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 10 }}>
              <InfoCell label="ASN #" value={shipment.asn_number || "—"} />
              <InfoCell label="Carrier" value={shipment.carrier || "—"} />
              <InfoCell label="Ship via" value={shipment.ship_via || "—"} />
              <InfoCell label="Ship date" value={fmtDate(shipment.ship_date) || "—"} />
              <InfoCell label="Est. port date" value={fmtDate(shipment.eta) || "—"} />
              <InfoCell label="Est. delivery" value={fmtDate(shipment.estimated_delivery) || "—"} />
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
              {shipment.packing_list_url && (
                <button onClick={() => void openDoc(shipment.packing_list_url)} style={docBtn}>
                  📄 Packing list
                </button>
              )}
              {shipment.bl_document_url && (
                <button onClick={() => void openDoc(shipment.bl_document_url)} style={docBtn}>
                  📄 Bill of Lading
                </button>
              )}
            </div>
            {shipment.notes && (
              <div style={{ marginTop: 10, fontSize: 13, color: TH.textSub2 }}>
                <strong style={{ color: TH.text }}>Notes:</strong> {shipment.notes}
              </div>
            )}
          </div>
        )}

        {err && (
          <div style={{ marginTop: 12, color: TH.primary, padding: "8px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, fontSize: 13 }}>{err}</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginTop: 18 }}>
          <InfoCell label="POL" value={shipment.pol_locode || "—"} sub={shipment.pol_date ? fmtDate(shipment.pol_date) : undefined} />
          <InfoCell label="POD" value={shipment.pod_locode || "—"} sub={shipment.pod_date ? fmtDate(shipment.pod_date) : undefined} />
          <InfoCell
            label={shipment.ata ? "Arrived" : "ETA"}
            value={fmtDate(shipment.ata || shipment.eta)}
            tone={shipment.ata ? "ok" : undefined}
          />
          <InfoCell
            label="Last tracked"
            value={shipment.last_tracked_at ? new Date(shipment.last_tracked_at).toLocaleString() : "—"}
          />
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          <button
            onClick={() => refresh(false)}
            disabled={refreshing}
            style={{ padding: "8px 14px", borderRadius: 7, border: `1px solid ${TH.border}`, background: TH.surface, color: TH.textSub, cursor: refreshing ? "not-allowed" : "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600 }}
          >
            {refreshing ? "Refreshing…" : "Refresh (cached)"}
          </button>
          <button
            onClick={() => refresh(true)}
            disabled={refreshing}
            style={{ padding: "8px 14px", borderRadius: 7, border: "none", background: refreshing ? TH.textMuted : TH.primary, color: "#FFFFFF", cursor: refreshing ? "not-allowed" : "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600 }}
          >
            Live refresh
          </button>
          {refreshMsg && <span style={{ alignSelf: "center", fontSize: 12, color: TH.textSub2 }}>{refreshMsg}</span>}
        </div>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 20px", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: TH.text, marginBottom: 10 }}>Event timeline</div>
        {events.length === 0 ? (
          <div style={{ color: TH.textMuted, fontSize: 13, padding: "12px 0" }}>No events yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {events.map((e, idx) => (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "28px 1fr 160px", gap: 10, alignItems: "center", padding: "10px 0", borderTop: idx === 0 ? "none" : `1px solid ${TH.border}` }}>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <span style={{
                    width: 12, height: 12, borderRadius: 999,
                    background: e.is_actual ? TH.primary : "transparent",
                    border: e.is_actual ? "none" : `2px dashed ${TH.textMuted}`,
                  }} />
                </div>
                <div>
                  <div style={{ fontSize: 13, color: TH.text, fontWeight: 600 }}>
                    {e.description || e.event_code || "—"}
                  </div>
                  <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 2 }}>
                    {[e.event_code, e.status, e.container_number, e.location_locode, e.facility_name].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div style={{ textAlign: "right", fontSize: 12, color: TH.textSub2 }}>
                  {e.event_date ? new Date(e.event_date).toLocaleString() : "—"}
                  {!e.is_actual && <div style={{ fontSize: 10, color: TH.textMuted, marginTop: 2 }}>(estimated)</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: tone === "ok" ? "#047857" : TH.text, fontFamily: label === "POL" || label === "POD" ? "Menlo, monospace" : "inherit" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const editInp: React.CSSProperties = { width: "100%", padding: "6px 8px", borderRadius: 5, border: `1px solid ${TH.border}`, fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" };
const docBtn: React.CSSProperties = { padding: "4px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surface, color: TH.textSub, cursor: "pointer", fontFamily: "inherit" };
