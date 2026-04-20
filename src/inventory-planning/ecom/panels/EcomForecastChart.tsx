// Time-series chart for one (channel, sku) pair. Uses Recharts — already
// a dep for the rest of the app. Shows historical net sales, system
// forecast, and final forecast as three lines; the history/forecast
// boundary is visible because historical points carry nulls for forecast
// and vice-versa (Recharts happily renders gaps).

import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from "recharts";
import type { IpPlanningRun } from "../../types/wholesale";
import type { IpEcomGridRow } from "../types/ecom";
import { loadEcomChartSeries, type EcomChartPoint } from "../services/ecomForecastService";
import { S, PAL, formatQty } from "../../components/styles";

export interface EcomForecastChartProps {
  run: IpPlanningRun | null;
  row: IpEcomGridRow | null;
}

export default function EcomForecastChart({ run, row }: EcomForecastChartProps) {
  const [points, setPoints] = useState<EcomChartPoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!run || !row) { setPoints([]); return; }
    let cancelled = false;
    setLoading(true);
    loadEcomChartSeries(run, row.channel_id, row.sku_id)
      .then((p) => { if (!cancelled) setPoints(p); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [run?.id, row?.channel_id, row?.sku_id]);

  const boundaryCode = useMemo(() => {
    // First week where we have forecast instead of history.
    const firstForecast = points.find((p) => p.historical_qty == null);
    return firstForecast?.period_code ?? null;
  }, [points]);

  if (!run || !row) {
    return (
      <div style={{ ...S.card, padding: 32, textAlign: "center", color: PAL.textMuted }}>
        Select a grid row to see its historical sales + forecast.
      </div>
    );
  }

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, color: PAL.textMuted }}>{row.channel_name}</div>
          <div style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: PAL.accent }}>
            {row.sku_code}
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: PAL.textMuted }}>
          <span>Method: <span style={{ color: PAL.text }}>{row.forecast_method}</span></span>
          <span>Return rate: <span style={{ color: PAL.text }}>
            {row.return_rate == null ? "–" : `${(row.return_rate * 100).toFixed(1)}%`}
          </span></span>
        </div>
      </div>

      <div style={{ width: "100%", height: 320 }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: PAL.textMuted }}>Loading…</div>
        ) : points.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: PAL.textMuted }}>No history or forecast for this pair.</div>
        ) : (
          <ResponsiveContainer>
            <LineChart data={points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke={PAL.borderFaint} strokeDasharray="3 3" />
              <XAxis dataKey="period_code" stroke={PAL.textMuted} tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis stroke={PAL.textMuted} tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: PAL.textDim }}
                formatter={(v) => (typeof v === "number" ? formatQty(v) : v)}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: PAL.textDim }} />
              {boundaryCode && (
                <ReferenceLine x={boundaryCode} stroke={PAL.textMuted} strokeDasharray="4 4" label={{ value: "forecast →", fill: PAL.textDim, fontSize: 11, position: "top" }} />
              )}
              <Line type="monotone" dataKey="historical_qty" name="Historical net"
                    stroke={PAL.textDim} strokeWidth={2} dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="system_forecast_qty" name="System forecast"
                    stroke={PAL.accent} strokeWidth={2} dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="final_forecast_qty" name="Final forecast"
                    stroke={PAL.green} strokeWidth={2} strokeDasharray="4 4" dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
