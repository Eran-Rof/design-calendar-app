// api/vendor/onboarding/steps/:step_name
//
// PUT — mark a step complete and attach its data jsonb.
//   body: { data: {...}, skip?: boolean }
//
// Enforces the sequential rule: a step can only be completed if all
// prior steps (in ALL_STEPS order) are already complete or skipped.
// Updates the workflow's current_step and completed_steps array.
//
// Step-specific validations:
//   company_info  → legal_name, address, business_type, year_founded required (tax_id optional)
//   banking       → expects banking_detail_id to exist (client calls /api/vendor/banking first)
//   tax           → classification + document_url required
//   compliance_docs → every required compliance_document_type must be approved or submitted
//   portal_tour   → any data; marks complete
//   agreement     → accepted_at + ip required; also stamps workflow.status='pending_review'
//                   if this is the last step.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const ALL_STEPS = ["company_info", "banking", "tax", "compliance_docs", "portal_tour", "agreement"];

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id, role").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

function getStepName(req) {
  if (req.query && req.query.step_name) return req.query.step_name;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("steps");
  return idx >= 0 ? parts[idx + 1] : null;
}

async function validateStep(admin, vendorId, stepName, data) {
  if (stepName === "company_info") {
    const req = ["legal_name", "address", "business_type", "year_founded"];
    const missing = req.filter((k) => !data?.[k] || !String(data[k]).trim());
    if (missing.length) return `Missing: ${missing.join(", ")}`;
  } else if (stepName === "banking") {
    if (!data?.banking_detail_id) return "Submit banking details via /api/vendor/banking first";
    const { data: bd } = await admin.from("banking_details").select("id").eq("id", data.banking_detail_id).eq("vendor_id", vendorId).maybeSingle();
    if (!bd) return "Banking detail not found for this vendor";
  } else if (stepName === "tax") {
    // `collect_tax` gates whether the vendor is required to collect and
    // remit sales/VAT tax on their invoices. Only tax-collecting vendors
    // need to upload a W-9 / W-8BEN.
    if (data?.collect_tax === undefined || data?.collect_tax === null) {
      return "collect_tax is required (true or false)";
    }
    if (data.collect_tax === true) {
      if (!data?.classification) return "classification is required (W-9 or W-8BEN)";
      if (!data?.document_url) return "document_url is required (upload to compliance-docs bucket first)";
    }
  } else if (stepName === "compliance_docs") {
    const { data: types } = await admin.from("compliance_document_types").select("id").eq("required", true).eq("active", true);
    const { data: docs } = await admin
      .from("compliance_documents").select("document_type_id, status, uploaded_at")
      .eq("vendor_id", vendorId);
    const latestByType = new Map();
    for (const d of docs || []) {
      const p = latestByType.get(d.document_type_id);
      if (!p || new Date(d.uploaded_at) > new Date(p.uploaded_at)) latestByType.set(d.document_type_id, d);
    }
    const missing = (types || []).filter((t) => {
      const d = latestByType.get(t.id);
      return !d || (d.status !== "approved" && d.status !== "submitted");
    });
    if (missing.length > 0) return `${missing.length} required compliance document(s) still need to be uploaded`;
  } else if (stepName === "portal_tour") {
    // Any data is OK
  } else if (stepName === "agreement") {
    if (!data?.accepted_at) return "accepted_at is required (ISO timestamp)";
    if (!data?.ip)          return "ip is required";
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const stepName = getStepName(req);
  if (!stepName || !ALL_STEPS.includes(stepName)) return res.status(400).json({ error: `Unknown step: ${stepName}` });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { data: stepData, skip } = body || {};

  const { data: workflow } = await admin
    .from("onboarding_workflows").select("*").eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!workflow) return res.status(400).json({ error: "Onboarding workflow not initialized — call GET /api/vendor/onboarding first" });
  if (workflow.status === "approved") return res.status(409).json({ error: "Onboarding already approved" });

  // Sequential enforcement
  const stepIdx = ALL_STEPS.indexOf(stepName);
  const priorComplete = ALL_STEPS.slice(0, stepIdx).every((s) => (workflow.completed_steps || []).includes(s));
  if (!priorComplete) return res.status(400).json({ error: `Prior steps must be completed first: ${ALL_STEPS.slice(0, stepIdx).join(" → ")}` });

  // Per-step validation (unless skipping)
  if (!skip) {
    const err = await validateStep(admin, caller.vendor_id, stepName, stepData);
    if (err) return res.status(400).json({ error: err });
  }

  const nowIso = new Date().toISOString();
  await admin.from("onboarding_steps").upsert({
    workflow_id: workflow.id,
    step_name: stepName,
    status: skip ? "skipped" : "complete",
    data: stepData || null,
    completed_at: nowIso,
  }, { onConflict: "workflow_id,step_name" });

  // Mirror collect_tax into vendors.is_tax_vendor so the invoice form can
  // gate the Tax line without joining onboarding state. Bail out loudly
  // on failure: the step is already upserted, but leaving the flag stale
  // would silently break the invoice Tax gate.
  if (stepName === "tax" && !skip && stepData && typeof stepData.collect_tax === "boolean") {
    const { error: mirrorErr } = await admin.from("vendors")
      .update({ is_tax_vendor: stepData.collect_tax })
      .eq("id", caller.vendor_id);
    if (mirrorErr) {
      return res.status(500).json({
        error: `Tax step saved, but could not sync is_tax_vendor on your vendor record: ${mirrorErr.message}. Please re-submit the Tax step.`,
      });
    }
  }

  const completedSet = new Set(workflow.completed_steps || []);
  completedSet.add(stepName);
  const completedSteps = ALL_STEPS.filter((s) => completedSet.has(s));
  const nextIdx = Math.min(stepIdx + 1, ALL_STEPS.length);
  const allDone = completedSteps.length === ALL_STEPS.length;

  const updates = {
    current_step: nextIdx,
    completed_steps: completedSteps,
    updated_at: nowIso,
  };
  if (workflow.status === "not_started") updates.status = "in_progress";
  if (!workflow.started_at) updates.started_at = nowIso;
  if (allDone && workflow.status !== "approved" && workflow.status !== "pending_review") {
    updates.status = "pending_review";
  }

  await admin.from("onboarding_workflows").update(updates).eq("id", workflow.id);

  return res.status(200).json({ ok: true, step: stepName, workflow_status: updates.status || workflow.status, completed_steps: completedSteps });
}
