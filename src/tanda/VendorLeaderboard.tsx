import { useEffect, useMemo, useState } from "react";
import { TH } from "../utils/theme";
import { SB_URL, SB_HEADERS } from "../utils/supabase";
import { S } from "../utils/styles";

interface LiveKPI {
  vendor_id: string;
  vendor_name: string;
  po_count: number;
  invoice_count: number;
  discrepancy_count: number;
  avg_acknowledgment_hours: number | null;
  on_time_delivery_pct: number | null;
  invoice_accuracy_pct: number | null;
}

type SortKey = "score" | "on_time" | "accuracy" | "ack" | "discrepancies" | "po_count";

function scoreColor(pct: number | null): string {
  if (pct == null) return TH.textMuted;
  if (pct >= 95) return "#047857";
  if (pct >= 80) return "#B45309";
  return "#B91C1C";
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${Number(n).toFixed(1)}%`;
}

function fmtHours(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 24) return `${Number(n).toFixed(1)}h`;
  return `${(n / 24).toFixed(1)}d`;
}

function compositeOf(r: LiveKPI): number | null {
  const ot = r.on_time_delivery_pct;
  const acc = r.invoice_accuracy_pct;
  const ack = r.avg_acknowledgment_hours;
  if (ot == null && acc == null && ack == null) return null;
  // Mirror the SQL compute_vendor_scorecard weighting
  const ackScore = ack == null ? 50 : Math.max(0, Math.min(100, 100 - (ack - 24) * 100 / 48));
  return (ot ?? 0) * 0.5 + (acc ?? 0) * 0.4 + ackScore * 0.1;
}

export default function VendorLeaderboard() {
  const [rows, setRows] = useState<LiveKPI[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("score");
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await fetch(`${SB_URL}/rest/v1/vendor_kpi_live?select=*`, { headers: SB_HEADERS });
        if (!r.ok) throw new Error(`vendor_kpi_live: ${r.status}`);
        setRows(await r.json());
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => !q || (r.vendor_name ?? "").toLowerCase().includes(q));
    const sortedRows = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "score":         return (compositeOf(b) ?? -1) - (compositeOf(a) ?? -1);
        case "on_time":       return (b.on_time_delivery_pct ?? -1) - (a.on_time_delivery_pct ?? -1);
        case "accuracy":      return (b.invoice_accuracy_pct ?? -1) - (a.invoice_accuracy_pct ?? -1);
        case "ack":           return (a.avg_acknowledgment_hours ?? Infinity) - (b.avg_acknowledgment_hours ?? Infinity);
        case "discrepancies": return b.discrepancy_count - a.discrepancy_count;
        case "po_count":      return b.po_count - a.po_count;
      }
    });
    return sortedRows;
  }, [rows, sortBy, search]);

  const active = rows.filter((r) => r.po_count > 0 || r.invoice_count > 0);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
        <StatCard label="Vendors with activity (180d)" value={String(active.length)} />
        <StatCard
          label="Average on-time"
          value={fmtPct(active.length ? active.reduce((a, r) => a + (r.on_time_delivery_pct ?? 0), 0) / active.length : null)}
        />
        <StatCard
          label="Average accuracy"
          value={fmtPct(active.length ? active.reduce((a, r) => a + (r.invoice_accuracy_pct ?? 0), 0) / active.length : null)}
        />
      </div>

      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            placeholder="Search vendor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...S.inp, marginBottom: 0, flex: "1 1 260px", minWidth: 240 }}
          />
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)} style={{ ...S.inp, marginBottom: 0, flex: "0 1 220px", minWidth: 160 }}>
            <option value="score">Sort: composite score</option>
            <option value="on_time">Sort: on-time %</option>
            <option value="accuracy">Sort: invoice accuracy %</option>
            <option value="ack">Sort: ack speed (fastest first)</option>
            <option value="discrepancies">Sort: discrepancies (most first)</option>
            <option value="po_count">Sort: PO count</option>
          </select>
          <div style={{ fontSize: 12, color: TH.textMuted, marginLeft: "auto" }}>
            Rolling 180-day window · {sorted.length} vendors
          </div>
        </div>
      </div>

      {loading && <div style={{ color: TH.textMuted, padding: 20 }}>Loading…</div>}
      {err && <div style={{ color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "10px 14px", borderRadius: 8 }}>Error: {err}</div>}

      {!loading && !err && (
        <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 110px 110px 110px 90px 90px 100px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
            <div>Rank</div>
            <div>Vendor</div>
            <div>On-time</div>
            <div>Accuracy</div>
            <div>Ack speed</div>
            <div>POs</div>
            <div>Disc.</div>
            <div style={{ textAlign: "right" }}>Score</div>
          </div>
          {sorted.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No vendors match.</div>
          ) : sorted.map((r, idx) => {
            const score = compositeOf(r);
            return (
              <div key={r.vendor_id} style={{ display: "grid", gridTemplateColumns: "60px 1fr 110px 110px 110px 90px 90px 100px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                <div style={{ color: TH.textMuted, fontWeight: 600 }}>{idx + 1}</div>
                <div style={{ color: TH.text, fontWeight: 600 }}>{r.vendor_name}</div>
                <div style={{ color: scoreColor(r.on_time_delivery_pct), fontWeight: 600 }}>{fmtPct(r.on_time_delivery_pct)}</div>
                <div style={{ color: scoreColor(r.invoice_accuracy_pct), fontWeight: 600 }}>{fmtPct(r.invoice_accuracy_pct)}</div>
                <div style={{ color: TH.textSub2 }}>{fmtHours(r.avg_acknowledgment_hours)}</div>
                <div style={{ color: TH.textSub2 }}>{r.po_count}</div>
                <div style={{ color: r.discrepancy_count > 0 ? "#B91C1C" : TH.textMuted, fontWeight: r.discrepancy_count > 0 ? 700 : 400 }}>{r.discrepancy_count}</div>
                <div style={{ textAlign: "right", fontSize: 18, fontWeight: 700, color: scoreColor(score) }}>
                  {score != null ? score.toFixed(0) : "—"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: TH.text }}>{value}</div>
    </div>
  );
}
