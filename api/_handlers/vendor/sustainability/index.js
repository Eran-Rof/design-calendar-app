// api/vendor/sustainability
//
// GET  — list sustainability reports for authenticated vendor + latest ESG scores.
// POST — submit a new report. Client uploads the PDF to 'vendor-docs' storage
//        first, then POSTs the metadata here.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const vendorId = authRes.auth.vendor_id;

  if (req.method === "GET") {
    const [{ data: reports }, { data: scores }] = await Promise.all([
      admin.from("sustainability_reports").select("*")
        .eq("vendor_id", vendorId).order("reporting_period_end", { ascending: false }),
      admin.from("esg_scores").select("*")
        .eq("vendor_id", vendorId).order("period_end", { ascending: false }),
    ]);
    const scoreByPeriod = {};
    for (const s of scores || []) scoreByPeriod[`${s.period_start}_${s.period_end}`] = s;
    const out = (reports || []).map((r) => ({
      ...r,
      esg_score: scoreByPeriod[`${r.reporting_period_start}_${r.reporting_period_end}`] || null,
    }));
    return res.status(200).json({ rows: out });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const errs = validateReport(body);
    if (errs.length) return res.status(400).json({ error: errs.join("; ") });

    // Path-injection guard — file_url must live under the caller's folder.
    const fileUrl = body?.report_file_url;
    if (fileUrl && (typeof fileUrl !== "string" || !fileUrl.startsWith(`${vendorId}/`))) {
      return res.status(403).json({ error: "report_file_url must be under the caller's vendor folder" });
    }

    const { data: report, error } = await admin.from("sustainability_reports").insert({
      vendor_id: vendorId,
      reporting_period_start: body.reporting_period_start,
      reporting_period_end: body.reporting_period_end,
      scope1_emissions: numOrNull(body.scope1_emissions),
      scope2_emissions: numOrNull(body.scope2_emissions),
      scope3_emissions: numOrNull(body.scope3_emissions),
      renewable_energy_pct: numOrNull(body.renewable_energy_pct),
      waste_diverted_pct: numOrNull(body.waste_diverted_pct),
      water_usage_liters: numOrNull(body.water_usage_liters),
      certifications: Array.isArray(body.certifications) ? body.certifications : [],
      report_file_url: body.report_file_url || null,
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });

    // Notify internal reviewers (resolve vendor name for subject)
    const { data: vendorRow } = await admin.from("vendors").select("name").eq("id", vendorId).maybeSingle();
    const vendorName = vendorRow?.name || `Vendor ${vendorId.slice(0, 8)}`;
    try {
      // INTERNAL_COMPLIANCE_EMAILS is comma-separated — fan out one
      // notification per email so each recipient gets a valid payload.
      const emails = (process.env.INTERNAL_COMPLIANCE_EMAILS || "")
        .split(",").map((e) => e.trim()).filter(Boolean);
      const origin = `https://${req.headers.host}`;
      for (const email of emails) {
        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "sustainability_report_submitted",
            title: `${vendorName} submitted sustainability report for ${body.reporting_period_start} → ${body.reporting_period_end}`,
            body: `${vendorName} submitted a sustainability report for ${body.reporting_period_start} → ${body.reporting_period_end}.`,
            link: "/",
            metadata: { report_id: report.id, vendor_id: vendorId },
            recipient: { internal_id: "sustainability-reviewers", email },
            dedupe_key: `sustainability_submitted_${report.id}_${email}`,
            email: true,
          }),
        }).catch(() => {});
      }
    } catch { /* non-blocking */ }

    return res.status(201).json(report);
  }

  return res.status(405).json({ error: "Method not allowed" });
}

function numOrNull(v) { return v === null || v === undefined || v === "" ? null : Number(v); }
function validateReport(body) {
  const errs = [];
  if (!body?.reporting_period_start || isNaN(Date.parse(body.reporting_period_start))) errs.push("reporting_period_start required");
  if (!body?.reporting_period_end || isNaN(Date.parse(body.reporting_period_end))) errs.push("reporting_period_end required");
  if (body?.reporting_period_start && body?.reporting_period_end
    && Date.parse(body.reporting_period_end) < Date.parse(body.reporting_period_start)) {
    errs.push("reporting_period_end must be >= reporting_period_start");
  }
  for (const f of ["renewable_energy_pct", "waste_diverted_pct"]) {
    if (body?.[f] !== undefined && body[f] !== null && body[f] !== "") {
      const n = Number(body[f]);
      if (!Number.isFinite(n) || n < 0 || n > 100) errs.push(`${f} must be 0..100`);
    }
  }
  return errs;
}
