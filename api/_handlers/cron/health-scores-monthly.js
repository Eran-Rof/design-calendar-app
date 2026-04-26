// api/cron/health-scores-monthly
//
// Monthly cron (1st of month, 07:00 UTC via vercel.json). For each
// active vendor, computes the 5 sub-scores from the agreed formula,
// writes a row to vendor_health_scores for the prior month's window,
// and auto-flags any vendor whose overall_score < 60 so ops can review.
//
// Re-running on the same period updates the existing row (unique index
// on (vendor_id, period_start, period_end)).

import { createClient } from "@supabase/supabase-js";
import { composeHealth } from "../../_lib/analytics.js";

export const config = { maxDuration: 60 };

function priorMonthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end:   end.toISOString().slice(0, 10),
  };
}

export default async function handler(req, res) {
  // Match the auth pattern of every other cron — without this anyone
  // could hit this endpoint and trigger vendor_flag inserts + email
  // blasts to internal ops and vendor admins.
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && req.headers.authorization !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const now = new Date();
  const { period_start, period_end } = priorMonthBounds(now);

  const [vRes, kpiRes, docTypesRes, docsRes, invRes, openFlagsRes] = await Promise.all([
    admin.from("vendors").select("id, name, status, deleted_at"),
    admin.from("vendor_kpi_live").select("vendor_id, on_time_delivery_pct, invoice_count, discrepancy_count, avg_acknowledgment_hours"),
    admin.from("compliance_document_types").select("id").eq("active", true).eq("required", true),
    admin.from("compliance_documents").select("vendor_id, document_type_id, status, expiry_date, uploaded_at"),
    admin.from("invoices").select("vendor_id, status, due_date"),
    admin.from("vendor_flags").select("vendor_id, status, source").eq("status", "open").eq("source", "cron.health_score"),
  ]);
  const errs = [vRes, kpiRes, docTypesRes, docsRes, invRes, openFlagsRes].filter((r) => r.error);
  if (errs.length) return res.status(500).json({ error: errs[0].error.message });

  const vendors = (vRes.data || []).filter((v) => !v.deleted_at && (v.status || "active") === "active");
  const kpiByVendor = new Map((kpiRes.data || []).map((k) => [k.vendor_id, k]));
  const requiredIds = (docTypesRes.data || []).map((t) => t.id);

  const latestByVendor = new Map();
  for (const d of docsRes.data || []) {
    const key = `${d.vendor_id}|${d.document_type_id}`;
    const prev = latestByVendor.get(key);
    if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) latestByVendor.set(key, d);
  }

  const invByVendor = new Map();
  for (const i of invRes.data || []) {
    const arr = invByVendor.get(i.vendor_id) || [];
    arr.push(i);
    invByVendor.set(i.vendor_id, arr);
  }

  const openHealthFlags = new Set((openFlagsRes.data || []).map((f) => f.vendor_id));

  const scoresUpsert = [];
  let wrote = 0, flagged = 0, autoDismissed = 0;
  const origin = `https://${req.headers.host}`;
  const flaggedForAlert = [];
  const stillBelowThreshold = new Set();

  for (const v of vendors) {
    const kpi = kpiByVendor.get(v.id);
    let approvedDocs = 0;
    for (const tid of requiredIds) {
      const d = latestByVendor.get(`${v.id}|${tid}`);
      if (!d || d.status !== "approved") continue;
      if (d.expiry_date && new Date(d.expiry_date).getTime() < now.getTime()) continue;
      approvedDocs++;
    }
    const overdueInvoices = (invByVendor.get(v.id) || []).filter((i) =>
      i.status !== "paid" && i.status !== "rejected" &&
      i.due_date && new Date(i.due_date) < now
    ).length;

    const comp = composeHealth({
      on_time_delivery_pct: kpi?.on_time_delivery_pct,
      invoice_count: kpi?.invoice_count,
      discrepancy_count: kpi?.discrepancy_count,
      approved_docs: approvedDocs,
      required_docs: requiredIds.length,
      overdue_invoices: overdueInvoices,
      avg_acknowledgment_hours: kpi?.avg_acknowledgment_hours,
    });

    scoresUpsert.push({
      vendor_id: v.id,
      overall_score: comp.overall,
      delivery_score: comp.delivery,
      quality_score: comp.quality,
      compliance_score: comp.compliance,
      financial_score: comp.financial,
      responsiveness_score: comp.responsiveness,
      score_breakdown: comp.breakdown,
      period_start, period_end,
      generated_at: now.toISOString(),
    });
    wrote++;

    if (comp.overall < 60) {
      stillBelowThreshold.add(v.id);
      if (!openHealthFlags.has(v.id)) {
        flaggedForAlert.push({ vendor: v, score: comp.overall });
      }
    }
  }

  if (scoresUpsert.length > 0) {
    await admin.from("vendor_health_scores").upsert(scoresUpsert, { onConflict: "vendor_id,period_start,period_end" });
  }

  // Create a single vendor_flags row per newly below-threshold vendor
  for (const { vendor, score } of flaggedForAlert) {
    const { data: flag } = await admin.from("vendor_flags").insert({
      vendor_id: vendor.id,
      type: "performance",
      severity: score < 40 ? "critical" : "high",
      reason: `Health score ${score} is below the 60 threshold for period ${period_start}..${period_end}`,
      status: "open",
      source: "cron.health_score",
      metadata: { period_start, period_end, score },
    }).select("id, severity").single();
    if (!flag) continue;
    flagged++;

    // Dual fanout:
    //   - vendor_flagged to internal ops (alerts the flag was raised)
    //   - health_score_low to internal team + vendor admin users
    //     (explains *why* and gives the vendor visibility)
    try {
      const internalEmails = (process.env.INTERNAL_VENDOR_ALERT_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
        .split(",").map((e) => e.trim()).filter(Boolean);
      await Promise.all(internalEmails.map((email) =>
        fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "vendor_flagged",
            title: `Vendor flagged [${flag.severity}]: ${vendor.name} — health ${score}`,
            body: `Monthly health score snapshot placed ${vendor.name} at ${score}/100 for ${period_start} to ${period_end}. Review their scorecard detail.`,
            link: "/",
            metadata: { vendor_id: vendor.id, score, period_start, period_end },
            recipient: { internal_id: "vendor_ops", email },
            dedupe_key: `health_flag_${vendor.id}_${period_start}_${email}`,
            email: true,
          }),
        }).catch(() => {})
      ));

      // health_score_low → internal team (same pool) + vendor admins
      const lowTitle = `Vendor health score alert: ${vendor.name} scored ${score}/100`;
      const lowBody = `Health score for ${period_start}..${period_end} dropped below the 60 threshold. Sub-scores and breakdown are available on the vendor profile. Please review what's driving the drop and follow up.`;
      await Promise.all(internalEmails.map((email) =>
        fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "health_score_low",
            title: lowTitle,
            body: lowBody,
            link: "/",
            metadata: { vendor_id: vendor.id, score, period_start, period_end },
            recipient: { internal_id: "vendor_ops", email },
            dedupe_key: `health_score_low_${vendor.id}_${period_start}_${email}`,
            email: true,
          }),
        }).catch(() => {})
      ));
      // Vendor admins — routed by vendor_id, recipient resolution on the
      // send-notification side picks up the primary vendor_user.
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "health_score_low",
          title: lowTitle,
          body: `${lowBody}\n\nWe'll work with your account team on a path to recovery — please check the scorecard page for the sub-score breakdown.`,
          link: "/vendor/scorecard",
          metadata: { vendor_id: vendor.id, score, period_start, period_end },
          recipient: { vendor_id: vendor.id },
          dedupe_key: `health_score_low_${vendor.id}_${period_start}_vendor`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* non-blocking */ }
  }

  // Auto-dismiss existing cron.health_score open flags for vendors who
  // are back above 60 this period.
  for (const vid of openHealthFlags) {
    if (stillBelowThreshold.has(vid)) continue;
    await admin.from("vendor_flags")
      .update({
        status: "resolved",
        resolved_at: now.toISOString(),
        resolved_by: "cron.health_score",
        resolution_notes: `Health score recovered to >=60 for period ${period_start}..${period_end}`,
        updated_at: now.toISOString(),
      })
      .eq("vendor_id", vid)
      .eq("source", "cron.health_score")
      .eq("status", "open");
    autoDismissed++;
  }

  return res.status(200).json({
    period_start, period_end,
    vendors_scored: wrote,
    new_flags: flagged,
    flags_auto_dismissed: autoDismissed,
  });
}
