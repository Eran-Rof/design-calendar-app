import { useEffect, useState } from "react";

interface Row {
  id: string;
  category: string;
  metric: "unit_price" | "lead_time" | "payment_terms" | "on_time_pct";
  percentile_25: number | null;
  percentile_50: number | null;
  percentile_75: number | null;
  percentile_90: number | null;
  sample_size: number;
  period_start: string;
  period_end: string;
}

interface CatAvg {
  category: string;
  avg_unit_price: number | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const METRIC_LABEL: Record<string, string> = {
  unit_price: "Unit price",
  lead_time: "Lead time (days)",
  payment_terms: "Payment terms",
  on_time_pct: "On-time %",
};

export default function InternalBenchmark() {
  const [rows, setRows] = useState<Row[]>([]);
  const [ourAvg, setOurAvg] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<"unit_price" | "lead_time" | "on_time_pct">("unit_price");

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/marketplace/benchmark?metric=${metric}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Row[] };
      setRows(d.rows || []);

      // Entity's own average unit_price per category (simple cross-ref)
      if (metric === "unit_price") {
        const rc = await fetch("/api/internal/analytics/categories?from=&to=");
        if (rc.ok) {
          // analytics/categories returns spend + line_count. We don't have avg unit_price directly.
          // Best effort: use catalog avg from our side — skip if unavailable.
          // Leaving blank rather than mis-computing.
          setOurAvg({});
        } else { setOurAvg({}); }
      } else { setOurAvg({}); }
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [metric]);

  function overP75(r: Row) {
    const ours = ourAvg[r.category];
    if (ours == null || r.percentile_75 == null) return false;
    return ours > Number(r.percentile_75);
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Market benchmarks</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Percentiles across the vendor base. Computed monthly from ≥ 5 vendors per category to protect individual data.</div>
        </div>
        <select value={metric} onChange={(e) => setMetric(e.target.value as "unit_price" | "lead_time" | "on_time_pct")} style={selectSt}>
          <option value="unit_price">Unit price</option>
          <option value="lead_time">Lead time</option>
          <option value="on_time_pct">On-time %</option>
        </select>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          No benchmark data yet for {METRIC_LABEL[metric]}. The monthly compute job populates this — run <code style={{ background: C.bg, padding: "2px 4px", borderRadius: 3 }}>/api/cron/benchmark-compute</code> to backfill.
        </div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 100px 100px 100px 100px 100px 120px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Category</div><div>P25</div><div>P50</div><div>P75</div><div>P90</div><div>n</div><div>Period</div>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "2fr 100px 100px 100px 100px 100px 120px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center", background: overP75(r) ? "rgba(245,158,11,0.08)" : undefined }}>
              <div style={{ fontWeight: 600 }}>{r.category} {overP75(r) && <span style={{ color: C.warn, fontSize: 10, marginLeft: 6 }}>⚠ ABOVE P75</span>}</div>
              <div>{fmt(r.percentile_25)}</div>
              <div>{fmt(r.percentile_50)}</div>
              <div>{fmt(r.percentile_75)}</div>
              <div>{fmt(r.percentile_90)}</div>
              <div style={{ color: C.textMuted }}>{r.sample_size}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{r.period_start} → {r.period_end}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmt(v: number | null) {
  if (v == null) return "—";
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
