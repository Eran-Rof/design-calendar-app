import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate } from "./utils";
import ShipmentAddForm from "./ShipmentAddForm";

export interface ShipmentRow {
  id: string;
  number: string;
  number_type: string;
  sealine_scac: string | null;
  sealine_name: string | null;
  pol_locode: string | null;
  pod_locode: string | null;
  eta: string | null;
  ata: string | null;
  current_status: string | null;
  last_tracked_at: string | null;
  po_number: string | null;
  updated_at: string;
}

export default function ShipmentsList() {
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const { data, error } = await supabaseVendor
        .from("shipments")
        .select("id, number, number_type, sealine_scac, sealine_name, pol_locode, pod_locode, eta, ata, current_status, last_tracked_at, po_number, updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      setRows((data ?? []) as ShipmentRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (r) =>
        r.number.toLowerCase().includes(s) ||
        (r.po_number ?? "").toLowerCase().includes(s) ||
        (r.sealine_scac ?? "").toLowerCase().includes(s) ||
        (r.pol_locode ?? "").toLowerCase().includes(s) ||
        (r.pod_locode ?? "").toLowerCase().includes(s)
    );
  }, [rows, search]);

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading shipments…</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
        <input
          placeholder="Search by container / PO / POL / POD…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 14, fontFamily: "inherit", background: TH.surface, color: TH.text }}
        />
        <button
          onClick={() => setShowAdd(true)}
          style={{ padding: "8px 14px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "inherit", whiteSpace: "nowrap" }}
        >
          + Add shipment
        </button>
      </div>

      {err && (
        <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "60px 160px 90px 180px 140px 140px 1fr", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
          <div>Type</div>
          <div>Number</div>
          <div>Carrier</div>
          <div>Route</div>
          <div>ETA / ATA</div>
          <div>Status</div>
          <div style={{ textAlign: "right" }}>Last tracked</div>
        </div>

        {visible.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
            {rows.length === 0 ? "No shipments yet. Click '+ Add shipment' to track one." : "No shipments match that search."}
          </div>
        ) : (
          visible.map((r) => (
            <Link
              key={r.id}
              to={`/vendor/shipments/${r.id}`}
              style={{ display: "grid", gridTemplateColumns: "60px 160px 90px 180px 140px 140px 1fr", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", color: "inherit", textDecoration: "none", background: TH.surface }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary }}>{r.number_type}</div>
              <div style={{ fontWeight: 600, color: TH.text, fontFamily: "Menlo, monospace" }}>{r.number}</div>
              <div style={{ color: TH.textSub2 }}>{r.sealine_scac || "—"}</div>
              <div style={{ color: TH.textSub2, fontFamily: "Menlo, monospace", fontSize: 12 }}>
                {r.pol_locode || "—"} → {r.pod_locode || "—"}
              </div>
              <div style={{ color: TH.textSub2 }}>
                {r.ata ? (
                  <><span style={{ color: "#047857", fontWeight: 600, fontSize: 11 }}>ATA</span> {fmtDate(r.ata)}</>
                ) : r.eta ? (
                  <><span style={{ color: TH.textMuted, fontSize: 11 }}>ETA</span> {fmtDate(r.eta)}</>
                ) : "—"}
              </div>
              <div>
                {r.current_status ? (
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: TH.surfaceHi, border: `1px solid ${TH.border}`, color: TH.textSub }}>
                    {r.current_status}
                  </span>
                ) : "—"}
              </div>
              <div style={{ textAlign: "right", color: TH.textMuted, fontSize: 12 }}>
                {r.last_tracked_at ? new Date(r.last_tracked_at).toLocaleString() : "—"}
              </div>
            </Link>
          ))
        )}
      </div>

      {showAdd && (
        <ShipmentAddForm
          onClose={() => setShowAdd(false)}
          onCreated={(shipmentId) => {
            setShowAdd(false);
            // Soft refresh the list so the new row appears.
            void load();
            // Don't navigate — let user see the new row in context.
            // They can click through to the timeline.
            void shipmentId;
          }}
        />
      )}
    </div>
  );
}
