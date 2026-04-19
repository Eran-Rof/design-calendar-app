import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";

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

const ON_TIME_THRESHOLD = 80;
const ACCURACY_THRESHOLD = 85;

function fmtPeriod(start: string, end: string): string {
  const s = new Date(start), e = new Date(end);
  if (Number.isNaN(s.getTime())) return start;
  const sameYear = s.getFullYear() === e.getFullYear();
  const opts: Intl.DateTimeFormatOptions = { month: "short", year: sameYear ? undefined : "2-digit" };
  return `${s.toLocaleDateString(undefined, opts)} '${String(s.getFullYear()).slice(-2)}`;
}

export default function VendorScorecardDetail({ vendorId, vendorName, onClose, onFlag }: {
  vendorId: string;
  vendorName: string;
  onClose: () => void;
  onFlag?: () => void;
}) {
  const [history, setHistory] = useState<ScorecardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [flagging, setFlagging] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await fetch(`/api/internal/scorecards/${vendorId}/history`);
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `history: ${r.status}`);
        setHistory((body?.history ?? []) as ScorecardRow[]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally { setLoading(false); }
    })();
  }, [vendorId]);

  const chartData = useMemo(() =>
    [...history].reverse().slice(-8).map((r) => ({
      label: fmtPeriod(r.period_start, r.period_end),
      on_time: r.on_time_delivery_pct != null ? Number(r.on_time_delivery_pct) : null,
      accuracy: r.invoice_accuracy_pct != null ? Number(r.invoice_accuracy_pct) : null,
      ack: r.avg_acknowledgment_hours != null ? Number(r.avg_acknowledgment_hours) : null,
      composite: r.composite_score != null ? Number(r.composite_score) : null,
    })),
  [history]);

  const latest = history[0];
  const isUnderperforming = latest && (
    (latest.on_time_delivery_pct != null && Number(latest.on_time_delivery_pct) < ON_TIME_THRESHOLD) ||
    (latest.invoice_accuracy_pct != null && Number(latest.invoice_accuracy_pct) < ACCURACY_THRESHOLD)
  );

  async function flagForReview() {
    if (!latest) return;
    setFlagging(true);
    try {
      await fetch("/api/send-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "vendor_flagged_scorecard",
          title: `${vendorName} flagged for review`,
          body: `Manual flag: on-time ${latest.on_time_delivery_pct ?? "—"}%, accuracy ${latest.invoice_accuracy_pct ?? "—"}%`,
          link: "/",
          metadata: { vendor_id: vendorId, period_start: latest.period_start, period_end: latest.period_end, manual: true },
          recipient: { internal_id: "scorecard_alerts" },
          email: false,
        }),
      });
      onFlag?.();
      alert("Vendor flagged for review.");
    } catch (e) {
      alert("Flag failed: " + (e instanceof Error ? e.message : String(e)));
    } finally { setFlagging(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, width: "min(960px, 95vw)", maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 4 }}>SCORECARD HISTORY</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: TH.text }}>{vendorName}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {isUnderperforming && (
              <button onClick={flagForReview} disabled={flagging} style={{ ...S.btn, background: TH.primary, borderColor: TH.primary, fontSize: 12 }}>
                {flagging ? "Flagging…" : "🚩 Flag for review"}
              </button>
            )}
            <button onClick={onClose} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Close</button>
          </div>
        </div>

        {loading && <div style={{ color: TH.textMuted, padding: 20 }}>Loading…</div>}
        {err && <div style={{ color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "10px 14px", borderRadius: 8 }}>Error: {err}</div>}

        {!loading && !err && history.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: TH.textMuted, fontSize: 13, background: TH.surfaceHi, borderRadius: 8 }}>
            No scorecard snapshots yet. Run the monthly cron or generate manually via /api/internal/scorecards/generate.
          </div>
        )}

        {!loading && !err && history.length > 0 && (
          <>
            <div style={{ height: 320, marginBottom: 20, background: "#FAFAFA", padding: "12px 8px 8px", borderRadius: 8, border: `1px solid ${TH.border}` }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                  <XAxis dataKey="label" stroke={TH.textMuted} fontSize={11} />
                  <YAxis stroke={TH.textMuted} fontSize={11} domain={[0, 100]} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="on_time" stroke="#047857" name="On-time %" strokeWidth={2} dot={{ r: 4 }} connectNulls />
                  <Line type="monotone" dataKey="accuracy" stroke={TH.primary} name="Accuracy %" strokeWidth={2} dot={{ r: 4 }} connectNulls />
                  <Line type="monotone" dataKey="composite" stroke="#2D3748" name="Composite" strokeWidth={2} strokeDasharray="4 4" dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "180px 100px 100px 100px 80px 80px 100px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
                <div>Period</div><div>On-time</div><div>Accuracy</div><div>Ack hrs</div><div>POs</div><div>Invs</div><div style={{ textAlign: "right" }}>Score</div>
              </div>
              {history.map((r) => (
                <div key={r.id} style={{ display: "grid", gridTemplateColumns: "180px 100px 100px 100px 80px 80px 100px", padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                  <div style={{ color: TH.text, fontWeight: 600 }}>{fmtPeriod(r.period_start, r.period_end)}</div>
                  <div style={{ color: r.on_time_delivery_pct != null && Number(r.on_time_delivery_pct) < ON_TIME_THRESHOLD ? "#B91C1C" : TH.textSub2, fontWeight: 600 }}>
                    {r.on_time_delivery_pct != null ? `${r.on_time_delivery_pct}%` : "—"}
                  </div>
                  <div style={{ color: r.invoice_accuracy_pct != null && Number(r.invoice_accuracy_pct) < ACCURACY_THRESHOLD ? "#B91C1C" : TH.textSub2, fontWeight: 600 }}>
                    {r.invoice_accuracy_pct != null ? `${r.invoice_accuracy_pct}%` : "—"}
                  </div>
                  <div style={{ color: TH.textSub2 }}>{r.avg_acknowledgment_hours != null ? `${r.avg_acknowledgment_hours}h` : "—"}</div>
                  <div style={{ color: TH.textSub2 }}>{r.po_count}</div>
                  <div style={{ color: TH.textSub2 }}>{r.invoice_count}</div>
                  <div style={{ textAlign: "right", fontSize: 15, fontWeight: 700, color: r.composite_score != null && Number(r.composite_score) >= 85 ? "#047857" : r.composite_score != null && Number(r.composite_score) >= 70 ? "#B45309" : TH.primary }}>
                    {r.composite_score != null ? Math.round(Number(r.composite_score)) : "—"}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
