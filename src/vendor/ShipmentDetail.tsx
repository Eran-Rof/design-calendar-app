import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate } from "./utils";

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
          {shipment.current_status && (
            <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 12px", borderRadius: 999, background: TH.surfaceHi, border: `1px solid ${TH.border}`, color: TH.text }}>
              {shipment.current_status}
            </span>
          )}
        </div>

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
