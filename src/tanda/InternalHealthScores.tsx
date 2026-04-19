import { useEffect, useState } from "react";

interface Row {
  vendor_id: string;
  name: string;
  overall_score: number;
  delivery_score: number;
  quality_score: number;
  compliance_score: number;
  financial_score: number;
  responsiveness_score: number;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

function scoreColor(s: number) {
  if (s >= 80) return C.success;
  if (s >= 60) return C.warn;
  return C.danger;
}

type SortKey = "overall" | "delivery" | "quality" | "compliance" | "financial" | "responsiveness";

export default function InternalHealthScores() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("overall");
  const [minScore, setMinScore] = useState("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ sort });
      if (minScore) params.set("min_score", minScore);
      const r = await fetch(`/api/internal/analytics/health-scores?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json() as { rows: Row[] };
      setRows(data.rows);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [sort, minScore]);

  async function flagForReview(vendorId: string, overall: number) {
    const reason = prompt(`Flag ${rows.find((r) => r.vendor_id === vendorId)?.name} for review?\n\nOptional reason:`) ?? null;
    if (reason === null) return;
    const raisedBy = prompt("Your name (for audit):") || "Internal";
    const r = await fetch(`/api/internal/vendors/${vendorId}/flags`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "performance",
        severity: overall < 40 ? "critical" : "high",
        reason: reason || `Manual review — health score ${overall}/100`,
        raised_by: raisedBy,
        source: "manual.health_scores",
      }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    alert("Flag raised.");
  }

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Vendor health scores</h2>
        <div style={{ display: "flex", gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>Min score</div>
            <input type="number" value={minScore} onChange={(e) => setMinScore(e.target.value)} placeholder="0" style={inp} />
          </div>
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 100px 100px 100px 110px 100px 140px 120px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Vendor</div>
          <SortHeader label="Overall" k="overall" sort={sort} setSort={setSort} />
          <SortHeader label="Delivery" k="delivery" sort={sort} setSort={setSort} />
          <SortHeader label="Quality" k="quality" sort={sort} setSort={setSort} />
          <SortHeader label="Compliance" k="compliance" sort={sort} setSort={setSort} />
          <SortHeader label="Financial" k="financial" sort={sort} setSort={setSort} />
          <SortHeader label="Responsive" k="responsiveness" sort={sort} setSort={setSort} />
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No vendors matching filters.</div>
        ) : rows.map((r) => (
          <div key={r.vendor_id} style={{ display: "grid", gridTemplateColumns: "1.5fr 100px 100px 100px 110px 100px 140px 120px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
            <div style={{ fontWeight: 600 }}>{r.name}</div>
            <ScoreCell v={r.overall_score} big />
            <ScoreCell v={r.delivery_score} />
            <ScoreCell v={r.quality_score} />
            <ScoreCell v={r.compliance_score} />
            <ScoreCell v={r.financial_score} />
            <ScoreCell v={r.responsiveness_score} />
            <div style={{ textAlign: "right" }}>
              <button onClick={() => void flagForReview(r.vendor_id, r.overall_score)} style={btnSecondary}>Flag for review</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SortHeader({ label, k, sort, setSort }: { label: string; k: SortKey; sort: SortKey; setSort: (k: SortKey) => void }) {
  const active = sort === k;
  return (
    <div onClick={() => setSort(k)} style={{ cursor: "pointer", color: active ? C.primary : C.textMuted }}>
      {label} {active ? "↓" : ""}
    </div>
  );
}

function ScoreCell({ v, big = false }: { v: number; big?: boolean }) {
  return (
    <div style={{ color: scoreColor(v), fontWeight: big ? 700 : 600, fontSize: big ? 18 : 14 }}>{v}</div>
  );
}

const inp = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13, width: 100 } as const;
const btnSecondary = { padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" } as const;
