import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface EsgScore {
  id: string;
  period_start: string;
  period_end: string;
  environmental_score: number;
  social_score: number;
  governance_score: number;
  overall_score: number;
  score_breakdown: Record<string, unknown>;
  generated_at: string;
}
interface DiversityProfile {
  business_type: string[];
  certifying_body: string | null;
  certification_number: string | null;
  verified: boolean;
  verified_at: string | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const BUSINESS_LABELS: Record<string, string> = {
  minority_owned: "Minority-owned",
  women_owned: "Women-owned",
  veteran_owned: "Veteran-owned",
  lgbtq_owned: "LGBTQ+-owned",
  disability_owned: "Disability-owned",
  small_business: "Small business",
  hub_zone: "HUB-Zone",
};

const TIPS_BY_DIMENSION: Record<"environmental" | "social" | "governance", string[]> = {
  environmental: [
    "Reduce Scope 1 + 2 emissions year-over-year — even a 5% drop adds 10 points to the sub-score.",
    "Increase renewable energy share: every 10% takes ~1.5 points toward the environmental max.",
    "Divert more waste (e.g. recycling, reuse programs) — 100% diverted is worth 15 points.",
  ],
  social: [
    "Complete your diversity profile and have it verified — that's worth 30 points of the social score.",
    "Add recognized certifications (ISO14001, B-Corp, SA8000, FSC) — up to 20 points for having 4+.",
  ],
  governance: [
    "Submit required compliance documents on time — the share of approved required docs drives 20 points.",
    "Resolve disputes quickly — no open disputes during the reporting period is worth the full 20 points.",
  ],
};

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}
async function api(path: string) {
  const t = await token();
  return fetch(path, { headers: { Authorization: `Bearer ${t}` } });
}

export default function VendorEsg() {
  const [score, setScore] = useState<EsgScore | null>(null);
  const [history, setHistory] = useState<EsgScore[]>([]);
  const [diversity, setDiversity] = useState<DiversityProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true); setErr(null);
      try {
        const [rE, rD] = await Promise.all([api("/api/vendor/esg-score"), api("/api/vendor/diversity-profile")]);
        if (!rE.ok) throw new Error(await rE.text());
        const e = await rE.json() as { latest: EsgScore | null; history: EsgScore[] };
        setScore(e.latest); setHistory(e.history || []);
        if (rD.ok) setDiversity(await rD.json() as DiversityProfile | null);
      } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  const weakest: "environmental" | "social" | "governance" | null = score
    ? (["environmental", "social", "governance"] as const).reduce<"environmental" | "social" | "governance" | null>((acc, dim) => {
        if (!acc) return dim;
        return score[`${dim}_score`] < score[`${acc}_score`] ? dim : acc;
      }, null)
    : null;

  if (loading) return <div style={{ color: C.textMuted, padding: 20 }}>Loading…</div>;

  return (
    <div style={{ color: C.text, padding: 20, maxWidth: 960 }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>ESG</h2>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, marginBottom: 16 }}>Your environmental, social, and governance score. Generated when sustainability reports are approved.</div>

      {err && <div style={{ color: C.danger, marginBottom: 10 }}>{err}</div>}

      {!score ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          No ESG score yet. Submit a sustainability report to get scored.
        </div>
      ) : (
        <>
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 18, marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
              Score for {score.period_start} → {score.period_end}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: 14, alignItems: "end", marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 52, fontWeight: 800 }}>{Number(score.overall_score).toFixed(0)}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>OVERALL (40/30/30 weighted)</div>
              </div>
              <Dim label="Environmental" value={score.environmental_score} color={C.success} weakest={weakest === "environmental"} />
              <Dim label="Social"        value={score.social_score}         color={C.primary} weakest={weakest === "social"} />
              <Dim label="Governance"   value={score.governance_score}     color={C.warn}    weakest={weakest === "governance"} />
            </div>
          </div>

          {weakest && (
            <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderLeft: `4px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.primary, textTransform: "uppercase" }}>Improvement tips ({weakest})</div>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, color: C.textSub, lineHeight: 1.6 }}>
                {TIPS_BY_DIMENSION[weakest].map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          )}

          {history.length > 1 && (
            <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", marginBottom: 8 }}>Trend</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 100px 100px 100px", gap: 6, fontSize: 12 }}>
                <div style={{ color: C.textMuted }}>Period</div>
                <div style={{ color: C.textMuted }}>Env</div>
                <div style={{ color: C.textMuted }}>Social</div>
                <div style={{ color: C.textMuted }}>Gov</div>
                <div style={{ color: C.textMuted }}>Overall</div>
                {history.slice(0, 6).map((h) => (
                  <div key={h.id} style={{ display: "contents" }}>
                    <div style={{ color: C.textSub }}>{h.period_start} → {h.period_end}</div>
                    <div>{Number(h.environmental_score).toFixed(0)}</div>
                    <div>{Number(h.social_score).toFixed(0)}</div>
                    <div>{Number(h.governance_score).toFixed(0)}</div>
                    <div style={{ fontWeight: 700 }}>{Number(h.overall_score).toFixed(0)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>Diversity profile</div>
          <a href="/vendor/diversity" style={{ fontSize: 11, color: C.primary, textDecoration: "none" }}>Edit →</a>
        </div>
        {!diversity ? (
          <div style={{ color: C.textMuted, fontSize: 13, marginTop: 8 }}>No diversity profile yet. <a href="/vendor/diversity" style={{ color: C.primary }}>Add one</a> to boost your social score.</div>
        ) : (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {(diversity.business_type || []).length === 0 && <span style={{ fontSize: 11, color: C.textMuted }}>No business types selected.</span>}
              {(diversity.business_type || []).map((t) => (
                <span key={t} style={{ fontSize: 11, background: C.bg, border: `1px solid ${C.cardBdr}`, padding: "3px 8px", borderRadius: 10 }}>{BUSINESS_LABELS[t] || t}</span>
              ))}
            </div>
            <div style={{ fontSize: 12, color: C.textSub }}>
              {diversity.certifying_body ? <>Certified by <strong>{diversity.certifying_body}</strong>{diversity.certification_number ? ` · #${diversity.certification_number}` : ""}</> : "No certifying body on file."}
            </div>
            <div style={{ fontSize: 11, color: diversity.verified ? C.success : C.textMuted, marginTop: 6, fontWeight: 700 }}>
              {diversity.verified ? `✓ Verified ${diversity.verified_at ? "on " + new Date(diversity.verified_at).toLocaleDateString() : ""}` : "Pending verification by buyer team"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Dim({ label, value, color, weakest }: { label: string; value: number; color: string; weakest: boolean }) {
  return (
    <div style={{ padding: 10, background: C.bg, border: `1px solid ${weakest ? C.warn : C.cardBdr}`, borderRadius: 6 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{Number(value).toFixed(0)}</div>
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase" }}>{label}</div>
      {weakest && <div style={{ fontSize: 9, color: C.warn, fontWeight: 700, marginTop: 4 }}>NEEDS WORK</div>}
    </div>
  );
}
