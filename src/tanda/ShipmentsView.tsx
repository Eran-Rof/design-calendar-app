import { useEffect, useMemo, useState } from "react";
import { TH } from "../utils/theme";
import { SB_URL, SB_HEADERS } from "../utils/supabase";
import { S } from "../utils/styles";

// Internal-only (TandA) cross-vendor shipments view. Uses the anon key
// directly (anon-permissive RLS policy lets us see everything — same
// pattern as tanda_pos). Read-only for now; the Searates refresh proxy is
// vendor-scoped (requires a Supabase Auth JWT), so internal refresh is a
// Phase 2 add when we wire an internal-refresh endpoint with service_role.

interface ShipmentRow {
  id: string;
  vendor_id: string;
  po_number: string | null;
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
  updated_at: string;
}

interface VendorLookup {
  id: string;
  name: string;
}

function fmtDateShort(d?: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return d;
  return t.toLocaleDateString();
}

export default function ShipmentsView() {
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [vendors, setVendors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [shipRes, vendorRes] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/shipments?select=*&order=updated_at.desc`, { headers: SB_HEADERS }),
          fetch(`${SB_URL}/rest/v1/vendors?select=id,name`, { headers: SB_HEADERS }),
        ]);
        if (!shipRes.ok) throw new Error(`shipments: ${shipRes.status}`);
        if (!vendorRes.ok) throw new Error(`vendors: ${vendorRes.status}`);
        const shipData: ShipmentRow[] = await shipRes.json();
        const vendorData: VendorLookup[] = await vendorRes.json();
        const vMap: Record<string, string> = {};
        for (const v of vendorData) vMap[v.id] = v.name;
        setRows(shipData);
        setVendors(vMap);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const statusOptions = useMemo(() => {
    return Array.from(new Set(rows.map((r) => r.current_status).filter((s): s is string => !!s))).sort();
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (vendorFilter && r.vendor_id !== vendorFilter) return false;
      if (statusFilter && r.current_status !== statusFilter) return false;
      if (!q) return true;
      return (
        r.number.toLowerCase().includes(q) ||
        (r.po_number ?? "").toLowerCase().includes(q) ||
        (r.sealine_scac ?? "").toLowerCase().includes(q) ||
        (vendors[r.vendor_id] ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, vendors, vendorFilter, statusFilter, search]);

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            placeholder="Search number / PO / carrier / vendor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...S.inp, marginBottom: 0, flex: "1 1 260px", minWidth: 240 }}
          />
          <select
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
            style={{ ...S.inp, marginBottom: 0, flex: "0 1 220px", minWidth: 160 }}
          >
            <option value="">All vendors</option>
            {Object.entries(vendors)
              .sort(([, a], [, b]) => a.localeCompare(b))
              .map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ ...S.inp, marginBottom: 0, flex: "0 1 180px", minWidth: 140 }}
          >
            <option value="">All statuses</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <div style={{ fontSize: 12, color: TH.textMuted, marginLeft: "auto" }}>
            {visible.length} of {rows.length}
          </div>
        </div>
        <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 10 }}>
          Read-only cross-vendor view. Vendors refresh their own tracking from <code>/vendor/shipments</code>.
          Internal bulk refresh lands in Phase 2.
        </div>
      </div>

      {loading && <div style={{ color: TH.textMuted, padding: 20 }}>Loading shipments…</div>}
      {err && <div style={{ color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "10px 14px", borderRadius: 8, marginBottom: 12 }}>Error: {err}</div>}

      {!loading && !err && (
        <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "50px 160px 1fr 90px 170px 130px 130px 130px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
            <div>Type</div>
            <div>Number</div>
            <div>Vendor</div>
            <div>Carrier</div>
            <div>Route</div>
            <div>ETA / ATA</div>
            <div>Status</div>
            <div style={{ textAlign: "right" }}>Updated</div>
          </div>
          {visible.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
              No shipments match these filters.
            </div>
          ) : (
            visible.map((r) => (
              <div key={r.id} style={{ display: "grid", gridTemplateColumns: "50px 160px 1fr 90px 170px 130px 130px 130px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary }}>{r.number_type}</div>
                <div style={{ fontWeight: 600, color: TH.text, fontFamily: "Menlo, monospace" }}>{r.number}</div>
                <div style={{ color: TH.textSub2 }}>{vendors[r.vendor_id] || "(unknown)"}</div>
                <div style={{ color: TH.textSub2, fontFamily: "Menlo, monospace" }}>{r.sealine_scac || "—"}</div>
                <div style={{ color: TH.textSub2, fontFamily: "Menlo, monospace", fontSize: 12 }}>
                  {r.pol_locode || "—"} → {r.pod_locode || "—"}
                </div>
                <div style={{ color: TH.textSub2 }}>
                  {r.ata ? (<><span style={{ color: "#047857", fontWeight: 600, fontSize: 11 }}>ATA</span> {fmtDateShort(r.ata)}</>) :
                   r.eta ? (<><span style={{ color: TH.textMuted, fontSize: 11 }}>ETA</span> {fmtDateShort(r.eta)}</>) : "—"}
                </div>
                <div>
                  {r.current_status ? (
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: TH.surfaceHi, border: `1px solid ${TH.border}`, color: TH.textSub }}>
                      {r.current_status}
                    </span>
                  ) : "—"}
                </div>
                <div style={{ textAlign: "right", color: TH.textMuted, fontSize: 12 }}>
                  {r.last_tracked_at ? new Date(r.last_tracked_at).toLocaleDateString() : "—"}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
