import { useEffect, useState } from "react";

interface Score {
  id: string;
  vendor_id: string;
  vendor?: { id: string; name: string } | null;
  period_start: string;
  period_end: string;
  environmental_score: number;
  social_score: number;
  governance_score: number;
  overall_score: number;
  generated_at: string;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalEsgScores() {
  const [rows, setRows] = useState<Score[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [minScore, setMinScore] = useState("");

  async function load() {
    setLoading(true); setErr(null);
    try {
      const q = minScore ? `?min_score=${minScore}` : "";
      const r = await fetch(`/api/internal/esg-scores${q}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Score[] };
      setRows(d.rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [minScore]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>ESG scores</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Latest scored period per vendor. Sorted by overall score.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Min overall score" value={minScore} onChange={(e) => setMinScore(e.target.value)} type="number" style={{ ...selectSt, width: 140 }} />
        </div>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No scored vendors yet.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 100px 100px 100px 100px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Vendor</div><div>Period</div><div>Env</div><div>Social</div><div>Gov</div><div>Overall</div>
          </div>
          {rows.map((s) => (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 100px 100px 100px 100px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{s.vendor?.name || s.vendor_id}</div>
              <div style={{ color: C.textSub, fontSize: 11 }}>{s.period_start} → {s.period_end}</div>
              <div style={{ color: C.success, fontWeight: 700 }}>{Number(s.environmental_score).toFixed(0)}</div>
              <div style={{ color: C.primary, fontWeight: 700 }}>{Number(s.social_score).toFixed(0)}</div>
              <div style={{ color: C.warn, fontWeight: 700 }}>{Number(s.governance_score).toFixed(0)}</div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{Number(s.overall_score).toFixed(0)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
