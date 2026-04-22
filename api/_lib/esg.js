// api/_lib/esg.js
//
// ESG score calculator.
//
//   computeEsgScore({ report, priorReport, diversity, compliance, disputes })
//     → { environmental, social, governance, overall, breakdown }
//
// Shapes:
//   report        = { scope1_emissions, scope2_emissions, scope3_emissions,
//                     renewable_energy_pct, waste_diverted_pct,
//                     certifications: string[] }
//   priorReport   = same shape, or null
//   diversity     = { business_type: string[], verified: boolean,
//                     certifying_body, certification_number } | null
//   compliance    = { required_count, approved_count } — for on-time submission pct
//   disputes      = number — count of non-resolved disputes in reporting period
//
// All sub-scores are clamped 0..100.

export function clamp(n, lo = 0, hi = 100) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function scopeTotal(r) {
  if (!r) return null;
  const s1 = Number(r.scope1_emissions) || 0;
  const s2 = Number(r.scope2_emissions) || 0;
  const s3 = Number(r.scope3_emissions) || 0;
  return s1 + s2 + s3;
}

// 0..20 points for YoY emissions reduction. No prior report → half credit.
export function scopeReductionPoints(report, priorReport) {
  const curr = scopeTotal(report);
  const prior = scopeTotal(priorReport);
  if (!prior || prior <= 0) return 10;
  if (curr === null) return 0;
  const reductionPct = ((prior - curr) / prior) * 100;
  if (reductionPct >= 20) return 20;
  if (reductionPct >= 10) return 15;
  if (reductionPct >= 5)  return 10;
  if (reductionPct >= 0)  return 5;
  return 0;
}

export function environmentalScore(report, priorReport) {
  const scope = scopeReductionPoints(report, priorReport);
  const renew = clamp(Number(report?.renewable_energy_pct) || 0, 0, 100) * 0.15;
  const waste = clamp(Number(report?.waste_diverted_pct) || 0, 0, 100) * 0.15;
  const total = 50 + scope + renew + waste;
  return {
    value: clamp(total),
    parts: {
      base: 50,
      scope_reduction: scope,
      renewable: Number(renew.toFixed(2)),
      waste_diverted: Number(waste.toFixed(2)),
    },
  };
}

export function diversityPoints(diversity) {
  if (!diversity) return 0;
  const hasTypes = Array.isArray(diversity.business_type) && diversity.business_type.length > 0;
  const hasCertInfo = !!(diversity.certifying_body && diversity.certification_number);
  if (diversity.verified && hasTypes && hasCertInfo) return 30;
  if (diversity.verified) return 20;
  if (hasTypes) return 10;
  return 0;
}

export function socialScore(report, diversity) {
  const diversityPts = diversityPoints(diversity);
  const certs = Array.isArray(report?.certifications) ? report.certifications.length : 0;
  const certPts = Math.min(certs, 4) * 5;
  const total = 50 + diversityPts + certPts;
  return {
    value: clamp(total),
    parts: { base: 50, diversity: diversityPts, certifications: certPts, certifications_counted: Math.min(certs, 4) },
  };
}

export function complianceOnTimePoints({ required_count, approved_count }) {
  if (!required_count || required_count <= 0) return 10; // no data — neutral
  const pct = Math.min(approved_count || 0, required_count) / required_count;
  return Math.round(pct * 20);
}

export function disputePoints(disputes) {
  const n = Number(disputes) || 0;
  if (n <= 0) return 20;
  return Math.max(0, 20 - n * 5);
}

export function governanceScore(compliance, disputes) {
  const compliancePts = complianceOnTimePoints(compliance || {});
  const disputePts = disputePoints(disputes);
  const total = 60 + compliancePts + disputePts;
  return {
    value: clamp(total),
    parts: { base: 60, compliance_on_time: compliancePts, low_dispute_rate: disputePts },
  };
}

export function computeEsgScore({ report, priorReport = null, diversity = null, compliance = null, disputes = 0 }) {
  const env = environmentalScore(report, priorReport);
  const soc = socialScore(report, diversity);
  const gov = governanceScore(compliance, disputes);
  const overall = clamp(env.value * 0.4 + soc.value * 0.3 + gov.value * 0.3);
  return {
    environmental: Number(env.value.toFixed(2)),
    social:        Number(soc.value.toFixed(2)),
    governance:    Number(gov.value.toFixed(2)),
    overall:       Number(overall.toFixed(2)),
    breakdown: {
      environmental: env.parts,
      social: soc.parts,
      governance: gov.parts,
      weights: { environmental: 0.4, social: 0.3, governance: 0.3 },
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Runner — gathers inputs and inserts esg_scores row
// ──────────────────────────────────────────────────────────────────────────

export async function generateEsgScoreForReport(admin, report) {
  const { vendor_id, reporting_period_start: period_start, reporting_period_end: period_end } = report;

  const [{ data: priorCandidates }, { data: diversity }, { data: requiredTypes }, { data: approvedDocs }, { data: disputes }] = await Promise.all([
    admin.from("sustainability_reports")
      .select("scope1_emissions, scope2_emissions, scope3_emissions, renewable_energy_pct, waste_diverted_pct, reporting_period_end")
      .eq("vendor_id", vendor_id).eq("status", "approved")
      .lt("reporting_period_end", period_end)
      .order("reporting_period_end", { ascending: false }),
    admin.from("diversity_profiles").select("*").eq("vendor_id", vendor_id).maybeSingle(),
    admin.from("compliance_document_types").select("id").eq("required", true).eq("active", true),
    admin.from("compliance_documents").select("id, document_type_id, status, uploaded_at")
      .eq("vendor_id", vendor_id).eq("status", "approved"),
    admin.from("disputes").select("id, status, created_at")
      .eq("vendor_id", vendor_id)
      .gte("created_at", String(period_start))
      .lte("created_at", String(period_end) + "T23:59:59.999Z"),
  ]);
  const priorReport = priorCandidates?.[0] || null;

  const approvedTypeIds = new Set((approvedDocs || []).map((d) => d.document_type_id));
  const approvedRequired = (requiredTypes || []).filter((t) => approvedTypeIds.has(t.id)).length;
  const compliance = {
    required_count: (requiredTypes || []).length,
    approved_count: approvedRequired,
  };
  const openDisputes = (disputes || []).filter((d) => d.status !== "resolved" && d.status !== "closed").length;

  const scored = computeEsgScore({ report, priorReport, diversity, compliance, disputes: openDisputes });

  // Upsert esg_scores row for this period
  const { data: existing } = await admin
    .from("esg_scores").select("id").eq("vendor_id", vendor_id)
    .eq("period_start", period_start).eq("period_end", period_end).maybeSingle();
  if (existing?.id) {
    await admin.from("esg_scores").update({
      environmental_score: scored.environmental,
      social_score: scored.social,
      governance_score: scored.governance,
      overall_score: scored.overall,
      score_breakdown: scored.breakdown,
      generated_at: new Date().toISOString(),
    }).eq("id", existing.id);
    return { ...scored, esg_score_id: existing.id, upserted: "updated" };
  }
  const { data: inserted } = await admin.from("esg_scores").insert({
    vendor_id, period_start, period_end,
    environmental_score: scored.environmental,
    social_score: scored.social,
    governance_score: scored.governance,
    overall_score: scored.overall,
    score_breakdown: scored.breakdown,
  }).select("id").single();
  return { ...scored, esg_score_id: inserted?.id, upserted: "inserted" };
}
