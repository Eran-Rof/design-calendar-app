import { useEffect, useState } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate } from "./utils";

interface LiveKPI {
  vendor_id: string;
  vendor_name: string;
  period_start: string;
  period_end: string;
  po_count: number;
  invoice_count: number;
  discrepancy_count: number;
  avg_acknowledgment_hours: number | null;
  on_time_delivery_pct: number | null;
  invoice_accuracy_pct: number | null;
}

interface ScorecardRow {
  id: string;
  period_start: string;
  period_end: string;
  on_time_delivery_pct: number | null;
  invoice_accuracy_pct: number | null;
  avg_acknowledgment_hours: number | null;
  po_count: number;
  invoice_count: number;
  discrepancy_count: number;
  composite_score: number | null;
  generated_at: string;
}

function scoreColor(pct: number | null): string {
  if (pct == null) return TH.textMuted;
  if (pct >= 95) return "#047857";
  if (pct >= 80) return "#B45309";
  return TH.primary;
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

export default function VendorScorecard() {
  const [live, setLive] = useState<LiveKPI | null>(null);
  const [history, setHistory] = useState<ScorecardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");
        const { data: vu } = await supabaseVendor
          .from("vendor_users").select("vendor_id").eq("auth_id", uid).maybeSingle();
        if (!vu) throw new Error("Not linked to a vendor.");

        const [liveRes, histRes] = await Promise.all([
          supabaseVendor.from("vendor_kpi_live").select("*").eq("vendor_id", vu.vendor_id).maybeSingle(),
          supabaseVendor.from("vendor_scorecards")
            .select("id, period_start, period_end, on_time_delivery_pct, invoice_accuracy_pct, avg_acknowledgment_hours, po_count, invoice_count, discrepancy_count, composite_score, generated_at")
            .eq("vendor_id", vu.vendor_id)
            .order("period_start", { ascending: false })
            .limit(12),
        ]);
        if (liveRes.error) throw liveRes.error;
        if (histRes.error) throw histRes.error;
        setLive(liveRes.data as LiveKPI);
        setHistory((histRes.data ?? []) as ScorecardRow[]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading performance…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <div style={{ color: "#FFFFFF", fontSize: 14, marginBottom: 14 }}>
        Your rolling 180-day performance. Contact your Ring of Fire buyer if you see anything off.
      </div>

      {live && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 14 }}>
            <KPICard
              label="On-time delivery"
              value={fmtPct(live.on_time_delivery_pct)}
              color={scoreColor(live.on_time_delivery_pct)}
              sub={`${live.po_count} POs in period`}
            />
            <KPICard
              label="Invoice accuracy"
              value={fmtPct(live.invoice_accuracy_pct)}
              color={scoreColor(live.invoice_accuracy_pct)}
              sub={`${live.discrepancy_count} discrepancies flagged`}
            />
            <KPICard
              label="PO ack speed"
              value={fmtHours(live.avg_acknowledgment_hours)}
              color={live.avg_acknowledgment_hours == null || live.avg_acknowledgment_hours > 48 ? TH.primary : "#047857"}
              sub="Average time to acknowledge"
            />
          </div>
          <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 18px", marginBottom: 20, fontSize: 13, color: TH.textSub2 }}>
            Period: <strong>{fmtDate(live.period_start)}</strong> → <strong>{fmtDate(live.period_end)}</strong>
            &nbsp;·&nbsp; POs <strong>{live.po_count}</strong>
            &nbsp;·&nbsp; Invoices <strong>{live.invoice_count}</strong>
          </div>
        </>
      )}

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ padding: "12px 20px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 14, fontWeight: 700, color: TH.text }}>
          Historical scorecards
        </div>
        {history.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
            No snapshots yet. Scorecards are generated periodically (quarterly by Ring of Fire).
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "180px 110px 110px 110px 80px 80px 100px", padding: "10px 20px", background: TH.surfaceHi, borderTop: `1px solid ${TH.border}`, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
              <div>Period</div>
              <div>On-time</div>
              <div>Accuracy</div>
              <div>Ack speed</div>
              <div>POs</div>
              <div>Invs</div>
              <div style={{ textAlign: "right" }}>Score</div>
            </div>
            {history.map((r) => (
              <div key={r.id} style={{ display: "grid", gridTemplateColumns: "180px 110px 110px 110px 80px 80px 100px", padding: "10px 20px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                <div style={{ color: TH.text, fontWeight: 600 }}>
                  {fmtDate(r.period_start)} – {fmtDate(r.period_end)}
                </div>
                <div style={{ color: scoreColor(r.on_time_delivery_pct), fontWeight: 600 }}>{fmtPct(r.on_time_delivery_pct)}</div>
                <div style={{ color: scoreColor(r.invoice_accuracy_pct), fontWeight: 600 }}>{fmtPct(r.invoice_accuracy_pct)}</div>
                <div style={{ color: TH.textSub2 }}>{fmtHours(r.avg_acknowledgment_hours)}</div>
                <div style={{ color: TH.textSub2 }}>{r.po_count}</div>
                <div style={{ color: TH.textSub2 }}>{r.invoice_count}</div>
                <div style={{ textAlign: "right", fontSize: 16, fontWeight: 700, color: scoreColor(r.composite_score) }}>
                  {r.composite_score != null ? Number(r.composite_score).toFixed(0) : "—"}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function KPICard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "20px 20px", boxShadow: `0 1px 2px ${TH.shadow}` }}>
      <div style={{ fontSize: 12, color: TH.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 36, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
