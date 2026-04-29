import { useEffect, useState } from "react";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate } from "./utils";

interface ScorecardRow {
  period_start: string;
  period_end: string;
  on_time_delivery_pct: number | null;
  invoice_accuracy_pct: number | null;
  avg_acknowledgment_hours: number | null;
  po_count: number;
  invoice_count: number;
  discrepancy_count: number;
  composite_score: number | null;
}

const ON_TIME_THRESHOLD = 80;
const ACCURACY_THRESHOLD = 85;

function thresholdColor(pct: number | null, threshold: number): string {
  if (pct == null) return TH.textMuted;
  if (pct >= threshold + 10) return "#047857";
  if (pct >= threshold) return "#B45309";
  return TH.primary;
}

async function authedFetch(path: string) {
  const { data } = await supabaseVendor.auth.getSession();
  const token = data?.session?.access_token;
  return fetch(path, { headers: { Authorization: `Bearer ${token}` } });
}

export default function VendorScorecard() {
  const [periods, setPeriods] = useState<ScorecardRow[]>([]);
  const [live, setLive] = useState<ScorecardRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        // Last 4 snapshotted periods via the API
        const r = await authedFetch("/api/vendor/scorecard");
        if (!r.ok) throw new Error(`scorecard: ${r.status}`);
        const data = await r.json() as ScorecardRow[];
        setPeriods(data || []);

        // Rolling live KPI — direct query (no matching API yet, vendor_kpi_live
        // is RLS-scoped so the authed client works)
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (uid) {
          const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", uid).maybeSingle();
          if (vu) {
            const { data: k } = await supabaseVendor.from("vendor_kpi_live").select("*").eq("vendor_id", vu.vendor_id).maybeSingle();
            if (k) setLive({
              period_start: k.period_start, period_end: k.period_end,
              on_time_delivery_pct: k.on_time_delivery_pct,
              invoice_accuracy_pct: k.invoice_accuracy_pct,
              avg_acknowledgment_hours: k.avg_acknowledgment_hours,
              po_count: k.po_count, invoice_count: k.invoice_count,
              discrepancy_count: k.discrepancy_count,
              composite_score: null,
            });
          }
        }
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading scorecard…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  const cards: (ScorecardRow | null)[] = periods.slice(0, 4);
  while (cards.length < 4) cards.push(null);

  return (
    <div>
      <div style={{ color: "#FFFFFF", fontSize: 14, marginBottom: 14 }}>
        Your performance over the last 4 periods. Thresholds: on-time ≥ {ON_TIME_THRESHOLD}%, accuracy ≥ {ACCURACY_THRESHOLD}%.
      </div>

      {live && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ color: "rgba(255,255,255,0.8)", fontSize: 12, fontWeight: 700, textTransform: "uppercase", marginBottom: 8, letterSpacing: 0.3 }}>
            Rolling 180 days (live)
          </div>
          <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "18px 20px", boxShadow: `0 1px 2px ${TH.shadow}` }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
              <MiniMetric label="On-time delivery" value={live.on_time_delivery_pct != null ? `${live.on_time_delivery_pct}%` : "—"} color={thresholdColor(live.on_time_delivery_pct, ON_TIME_THRESHOLD)} />
              <MiniMetric label="Invoice accuracy" value={live.invoice_count === 0 ? "No invoices" : (live.invoice_accuracy_pct != null ? `${live.invoice_accuracy_pct}%` : "—")} color={live.invoice_count === 0 ? TH.textMuted : thresholdColor(live.invoice_accuracy_pct, ACCURACY_THRESHOLD)} />
              <MiniMetric label="Avg ack time" value={live.avg_acknowledgment_hours != null ? (live.avg_acknowledgment_hours < 24 ? `${live.avg_acknowledgment_hours}h` : `${(live.avg_acknowledgment_hours / 24).toFixed(1)}d`) : "—"} color={live.avg_acknowledgment_hours == null || live.avg_acknowledgment_hours > 48 ? TH.primary : "#047857"} />
            </div>
          </div>
        </div>
      )}

      <div style={{ color: "rgba(255,255,255,0.8)", fontSize: 12, fontWeight: 700, textTransform: "uppercase", marginBottom: 8, letterSpacing: 0.3 }}>
        Snapshotted periods
      </div>
      {periods.length === 0 ? (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: 24, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
          No snapshots yet. Scorecards are generated monthly on the 1st.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {cards.map((r, idx) => r ? (
            <PeriodCard key={`${r.period_start}_${r.period_end}`} row={r} />
          ) : (
            <div key={`empty_${idx}`} style={{ background: "rgba(255,255,255,0.04)", border: `1px dashed rgba(255,255,255,0.2)`, borderRadius: 10, padding: 20, color: "rgba(255,255,255,0.4)", fontSize: 13, textAlign: "center", minHeight: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
              Prior period<br/>(not yet generated)
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PeriodCard({ row }: { row: ScorecardRow }) {
  const ot = Number(row.on_time_delivery_pct ?? 0);
  const acc = Number(row.invoice_accuracy_pct ?? 0);
  const ack = Number(row.avg_acknowledgment_hours ?? 0);
  const ackDisplay = row.avg_acknowledgment_hours == null
    ? "—"
    : ack < 24 ? `${ack.toFixed(1)}h` : `${(ack / 24).toFixed(1)}d`;
  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: 18, boxShadow: `0 1px 2px ${TH.shadow}` }}>
      <div style={{ fontSize: 11, color: TH.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Period</div>
      <div style={{ fontSize: 13, color: TH.text, fontWeight: 700, marginBottom: 14 }}>
        {fmtDate(row.period_start)} – {fmtDate(row.period_end)}
      </div>

      <Row label="On-time delivery" value={row.on_time_delivery_pct != null ? `${row.on_time_delivery_pct}%` : "—"} color={thresholdColor(row.on_time_delivery_pct, ON_TIME_THRESHOLD)} />
      <Row label="Invoice accuracy" value={row.invoice_count === 0 ? "No invoices" : (row.invoice_accuracy_pct != null ? `${row.invoice_accuracy_pct}%` : "—")} color={row.invoice_count === 0 ? TH.textMuted : thresholdColor(row.invoice_accuracy_pct, ACCURACY_THRESHOLD)} />
      <Row label="Avg ack time" value={ackDisplay} color={row.avg_acknowledgment_hours == null || row.avg_acknowledgment_hours > 48 ? TH.primary : "#047857"} />

      <div style={{ borderTop: `1px solid ${TH.border}`, marginTop: 10, paddingTop: 10, fontSize: 11, color: TH.textMuted }}>
        {row.po_count} PO{row.po_count === 1 ? "" : "s"} · {row.invoice_count} inv · {row.discrepancy_count} disc.
      </div>
      {row.composite_score != null && (
        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 11, color: TH.textMuted, fontWeight: 700, textTransform: "uppercase" }}>Score</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: Number(row.composite_score) >= 85 ? "#047857" : Number(row.composite_score) >= 70 ? "#B45309" : TH.primary }}>
            {Math.round(Number(row.composite_score))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 13, marginBottom: 8 }}>
      <span style={{ color: TH.textMuted }}>{label}</span>
      <span style={{ fontWeight: 700, color, fontSize: 15 }}>{value}</span>
    </div>
  );
}

function MiniMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
