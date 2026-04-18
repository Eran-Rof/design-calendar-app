import { useEffect, useMemo, useState } from "react";
import { TH } from "../utils/theme";
import { SB_URL, SB_HEADERS } from "../utils/supabase";
import { S } from "../utils/styles";

// Internal-only cross-vendor 3-way match view. Reads the
// three_way_match_summary + three_way_match_view SQL views via the
// anon key (RLS anon-permissive).

interface SummaryRow {
  po_id: string;
  po_number: string;
  vendor_id: string | null;
  line_count: number;
  matched_lines: number;
  discrepancy_lines: number;
  pending_lines: number;
  total_ordered: number | null;
  total_shipped: number | null;
  total_received: number | null;
  total_invoiced: number | null;
  po_status: "matched" | "discrepancy" | "pending" | "no_data";
}

interface LineRow {
  po_line_item_id: string;
  po_id: string;
  po_number: string;
  line_index: number;
  item_number: string | null;
  description: string | null;
  qty_ordered: number;
  po_unit_price: number | null;
  qty_shipped: number;
  qty_received: number;
  qty_invoiced: number;
  invoiced_unit_price: number | null;
  under_received: boolean;
  over_received: boolean;
  shipped_not_received: boolean;
  invoiced_more_than_received: boolean;
  price_variance: boolean;
  line_status: "matched" | "discrepancy" | "pending" | "in_transit" | "awaiting_invoice" | "invoiced_before_receipt" | "no_data";
}

interface VendorLookup {
  id: string;
  name: string;
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  matched:                  { bg: "#D1FAE5", fg: "#065F46" },
  discrepancy:              { bg: "#FECACA", fg: "#991B1B" },
  pending:                  { bg: "#E5E7EB", fg: "#374151" },
  in_transit:               { bg: "#DBEAFE", fg: "#1E40AF" },
  awaiting_invoice:         { bg: "#FEF3C7", fg: "#92400E" },
  invoiced_before_receipt:  { bg: "#FED7AA", fg: "#9A3412" },
  no_data:                  { bg: "#F3F4F6", fg: "#9CA3AF" },
};

function fmtNum(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString();
}

function fmtMoney(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export default function MatchView() {
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [vendors, setVendors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "discrepancy" | "pending" | "matched">("all");
  const [search, setSearch] = useState("");
  const [selectedPo, setSelectedPo] = useState<SummaryRow | null>(null);
  const [lines, setLines] = useState<LineRow[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [sRes, vRes] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/three_way_match_summary?select=*&order=po_number.asc`, { headers: SB_HEADERS }),
          fetch(`${SB_URL}/rest/v1/vendors?select=id,name`, { headers: SB_HEADERS }),
        ]);
        if (!sRes.ok) throw new Error(`match_summary: ${sRes.status}`);
        if (!vRes.ok) throw new Error(`vendors: ${vRes.status}`);
        const s: SummaryRow[] = await sRes.json();
        const vs: VendorLookup[] = await vRes.json();
        const vMap: Record<string, string> = {};
        for (const v of vs) vMap[v.id] = v.name;
        setRows(s);
        setVendors(vMap);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (vendorFilter && r.vendor_id !== vendorFilter) return false;
      if (statusFilter === "discrepancy" && r.po_status !== "discrepancy") return false;
      if (statusFilter === "matched" && r.po_status !== "matched") return false;
      if (statusFilter === "pending" && !["pending", "no_data"].includes(r.po_status)) return false;
      if (!q) return true;
      return r.po_number.toLowerCase().includes(q)
        || (vendors[r.vendor_id ?? ""] ?? "").toLowerCase().includes(q);
    });
  }, [rows, vendors, vendorFilter, statusFilter, search]);

  const stats = useMemo(() => {
    return {
      total:       rows.length,
      matched:     rows.filter((r) => r.po_status === "matched").length,
      discrepancy: rows.filter((r) => r.po_status === "discrepancy").length,
      pending:     rows.filter((r) => r.po_status === "pending" || r.po_status === "no_data").length,
    };
  }, [rows]);

  async function openPO(po: SummaryRow) {
    setSelectedPo(po);
    setLines([]);
    const q = new URLSearchParams({ select: "*", po_id: `eq.${po.po_id}`, order: "line_index.asc" });
    const r = await fetch(`${SB_URL}/rest/v1/three_way_match_view?${q}`, { headers: SB_HEADERS });
    if (r.ok) setLines(await r.json());
  }

  return (
    <div>
      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        <StatCard label="POs tracked"        value={String(stats.total)} />
        <StatCard label="Matched"            value={String(stats.matched)}     tone="ok" />
        <StatCard label="Discrepancies"      value={String(stats.discrepancy)} tone={stats.discrepancy > 0 ? "err" : "ok"} />
        <StatCard label="Pending / no data"  value={String(stats.pending)} />
      </div>

      {/* Toolbar */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            placeholder="Search PO # or vendor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...S.inp, marginBottom: 0, flex: "1 1 260px", minWidth: 240 }}
          />
          <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} style={{ ...S.inp, marginBottom: 0, flex: "0 1 220px", minWidth: 160 }}>
            <option value="">All vendors</option>
            {Object.entries(vendors).sort(([, a], [, b]) => a.localeCompare(b)).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} style={{ ...S.inp, marginBottom: 0, flex: "0 1 180px", minWidth: 140 }}>
            <option value="all">All statuses</option>
            <option value="discrepancy">Discrepancy only</option>
            <option value="pending">Pending only</option>
            <option value="matched">Matched only</option>
          </select>
          <div style={{ fontSize: 12, color: TH.textMuted, marginLeft: "auto" }}>{visible.length} of {rows.length}</div>
        </div>
      </div>

      {loading && <div style={{ color: TH.textMuted, padding: 20 }}>Loading…</div>}
      {err && <div style={{ color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "10px 14px", borderRadius: 8, marginBottom: 12 }}>Error: {err}</div>}

      {!loading && !err && (
        <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 90px 90px 90px 90px 110px 110px 110px 130px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
            <div>PO #</div><div>Vendor</div>
            <div>Lines</div><div>Match'd</div><div>Disc.</div><div>Pend.</div>
            <div>Ordered</div><div>Received</div><div>Invoiced</div>
            <div style={{ textAlign: "right" }}>Status</div>
          </div>
          {visible.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No POs match these filters.</div>
          ) : visible.map((r) => {
            const c = STATUS_COLORS[r.po_status] ?? STATUS_COLORS.pending;
            return (
              <div
                key={r.po_id}
                onClick={() => openPO(r)}
                style={{ display: "grid", gridTemplateColumns: "140px 1fr 90px 90px 90px 90px 110px 110px 110px 130px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", cursor: "pointer" }}
              >
                <div style={{ fontWeight: 600, color: TH.text, fontFamily: "Menlo, monospace" }}>{r.po_number}</div>
                <div style={{ color: TH.textSub2 }}>{vendors[r.vendor_id ?? ""] || "—"}</div>
                <div style={{ color: TH.textSub2 }}>{r.line_count}</div>
                <div style={{ color: "#047857" }}>{r.matched_lines}</div>
                <div style={{ color: r.discrepancy_lines > 0 ? "#B91C1C" : TH.textMuted, fontWeight: r.discrepancy_lines > 0 ? 700 : 400 }}>{r.discrepancy_lines}</div>
                <div style={{ color: TH.textMuted }}>{r.pending_lines}</div>
                <div style={{ color: TH.textSub2 }}>{fmtNum(r.total_ordered)}</div>
                <div style={{ color: TH.textSub2 }}>{fmtNum(r.total_received)}</div>
                <div style={{ color: TH.textSub2 }}>{fmtNum(r.total_invoiced)}</div>
                <div style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 700, textTransform: "capitalize" }}>
                    {r.po_status.replace(/_/g, " ")}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedPo && (
        <LineDetailModal po={selectedPo} lines={lines} vendorName={vendors[selectedPo.vendor_id ?? ""]} onClose={() => setSelectedPo(null)} />
      )}
    </div>
  );
}

function LineDetailModal({ po, lines, vendorName, onClose }: { po: SummaryRow; lines: LineRow[]; vendorName?: string; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, width: "min(1100px, 95vw)", maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 4 }}>3-WAY MATCH · {po.po_number}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: TH.text }}>{vendorName || "—"}</div>
          </div>
          <button onClick={onClose} style={{ padding: "6px 12px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Close</button>
        </div>

        <div style={{ border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "50px 120px 1fr 90px 90px 90px 90px 90px 90px 140px", padding: "10px 14px", background: TH.surfaceHi, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", borderBottom: `1px solid ${TH.border}` }}>
            <div>#</div><div>Item</div><div>Description</div>
            <div>Ord.</div><div>Ship.</div><div>Recv.</div><div>Inv.</div>
            <div>PO $</div><div>Inv $</div>
            <div style={{ textAlign: "right" }}>Status</div>
          </div>
          {lines.length === 0 ? (
            <div style={{ padding: 18, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No lines.</div>
          ) : lines.map((l) => {
            const c = STATUS_COLORS[l.line_status] ?? STATUS_COLORS.pending;
            return (
              <div key={l.po_line_item_id} style={{ display: "grid", gridTemplateColumns: "50px 120px 1fr 90px 90px 90px 90px 90px 90px 140px", padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                <div style={{ color: TH.textMuted }}>{l.line_index}</div>
                <div style={{ fontFamily: "Menlo, monospace", fontSize: 12, color: TH.textSub2 }}>{l.item_number ?? "—"}</div>
                <div style={{ color: TH.text, fontSize: 12 }}>{l.description ?? "—"}</div>
                <div style={{ color: TH.textSub2 }}>{fmtNum(l.qty_ordered)}</div>
                <div style={{ color: TH.textSub2 }}>{fmtNum(l.qty_shipped)}</div>
                <div style={{ color: l.under_received || l.over_received ? "#B91C1C" : TH.textSub2, fontWeight: l.under_received || l.over_received ? 700 : 400 }}>{fmtNum(l.qty_received)}</div>
                <div style={{ color: l.invoiced_more_than_received ? "#B91C1C" : TH.textSub2, fontWeight: l.invoiced_more_than_received ? 700 : 400 }}>{fmtNum(l.qty_invoiced)}</div>
                <div style={{ color: TH.textSub2, fontSize: 12 }}>{fmtMoney(l.po_unit_price)}</div>
                <div style={{ color: l.price_variance ? "#B91C1C" : TH.textSub2, fontWeight: l.price_variance ? 700 : 400, fontSize: 12 }}>{fmtMoney(l.invoiced_unit_price)}</div>
                <div style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 700, textTransform: "capitalize" }}>
                    {l.line_status.replace(/_/g, " ")}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "#047857" : tone === "err" ? "#B91C1C" : TH.text;
  return (
    <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
