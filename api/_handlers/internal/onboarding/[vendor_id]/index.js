// api/internal/onboarding/:vendor_id
//
// GET — full onboarding review context for a vendor:
//   { vendor, workflow, steps, banking: [...with last4 only...],
//     compliance_summary: {...} }
//
// PUT — approve or reject.
//   body: { action: 'approve' | 'reject', reviewer_name,
//           rejection_reason?, failed_steps?: [step_name, ...] }
//
// On approve: status='approved', completed_at=now, approved_by=reviewer_name.
//            Fires onboarding_approved notification to vendor admin.
// On reject:  status='rejected', rejection_reason stored.
//            Resets the listed failed_steps to status='pending' and removes
//            them from completed_steps so vendor can redo just those.
//            Fires onboarding_rejected notification with the reason.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

function getVendorId(req) {
  if (req.query && req.query.vendor_id) return req.query.vendor_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("onboarding");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const vendorId = getVendorId(req);
  if (!vendorId) return res.status(400).json({ error: "Missing vendor id" });

  if (req.method === "GET") {
    const [vRes, wfRes, stepsRes, bankRes, docTypesRes, docsRes] = await Promise.all([
      admin.from("vendors").select("id, name, status").eq("id", vendorId).maybeSingle(),
      admin.from("onboarding_workflows").select("*").eq("vendor_id", vendorId).maybeSingle(),
      admin.rpc ? null : null,
      admin.from("banking_details").select("id, account_name, bank_name, account_number_last4, account_type, currency, verified, verified_at, verified_by, created_at").eq("vendor_id", vendorId).order("created_at", { ascending: false }),
      admin.from("compliance_document_types").select("id, name, required").eq("active", true),
      admin.from("compliance_documents").select("document_type_id, status, file_url, expiry_date, uploaded_at").eq("vendor_id", vendorId),
    ]);
    if (vRes.error) return res.status(500).json({ error: vRes.error.message });
    if (!vRes.data) return res.status(404).json({ error: "Vendor not found" });

    let steps = [];
    if (wfRes.data) {
      const { data: s } = await admin.from("onboarding_steps").select("*").eq("workflow_id", wfRes.data.id);
      steps = s || [];
    }

    // Sign each compliance file URL on read instead of returning the
    // raw Storage path. CLAUDE.md: "use signed URLs with short expiry,
    // never serve uploaded files directly". 5-minute expiry — enough
    // for the reviewer panel to render, short enough that a leaked
    // token is useless quickly.
    const bucket = process.env.COMPLIANCE_STORAGE_BUCKET || "compliance";
    const docs = docsRes.data || [];
    const signedDocs = await Promise.all(docs.map(async (d) => {
      if (!d.file_url) return d;
      try {
        const { data: sig } = await admin.storage.from(bucket).createSignedUrl(d.file_url, 300);
        return { ...d, file_url: sig?.signedUrl ?? d.file_url };
      } catch (err) {
        console.warn("[onboarding] sign URL failed", { vendor_id: vendorId, path: d.file_url, err: String(err) });
        return d; // fall back rather than fail the whole response
      }
    }));

    return res.status(200).json({
      vendor: vRes.data,
      workflow: wfRes.data || null,
      steps,
      banking: bankRes.data || [],
      compliance_document_types: docTypesRes.data || [],
      compliance_documents: signedDocs,
    });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { action, reviewer_name, rejection_reason, failed_steps } = body || {};
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "action must be approve or reject" });

    const { data: workflow } = await admin.from("onboarding_workflows").select("*").eq("vendor_id", vendorId).maybeSingle();
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    if (action === "approve") {
      const nowIso = new Date().toISOString();
      const { error } = await admin.from("onboarding_workflows").update({
        status: "approved",
        completed_at: nowIso,
        approved_by: reviewer_name || "Internal",
        rejection_reason: null,
        updated_at: nowIso,
      }).eq("id", workflow.id);
      if (error) return res.status(500).json({ error: error.message });

      // Notify vendor primary user
      try {
        const origin = `https://${req.headers.host}`;
        const { data: vendor } = await admin.from("vendors").select("name").eq("id", vendorId).maybeSingle();
        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "onboarding_approved",
            title: "Your vendor account is approved — you can now transact",
            body: `${vendor?.name || "Your account"} has been approved. You can now submit invoices and access all portal features.`,
            link: "/vendor",
            metadata: { workflow_id: workflow.id, vendor_id: vendorId },
            recipient: { vendor_id: vendorId },
            dedupe_key: `onboarding_approved_${workflow.id}`,
            email: true,
          }),
        }).catch(() => {});
      } catch { /* non-blocking */ }

      return res.status(200).json({ ok: true, status: "approved" });
    }

    // Reject
    if (!rejection_reason || !String(rejection_reason).trim())
      return res.status(400).json({ error: "rejection_reason is required for reject action" });
    const failed = Array.isArray(failed_steps) ? failed_steps : [];
    const VALID = ["company_info", "banking", "tax", "compliance_docs", "portal_tour", "agreement"];
    const bad = failed.filter((s) => !VALID.includes(s));
    if (bad.length > 0) return res.status(400).json({ error: `Invalid step names: ${bad.join(", ")}` });

    const completedSteps = (workflow.completed_steps || []).filter((s) => !failed.includes(s));
    const nowIso = new Date().toISOString();
    // Guard: Math.min(...[]) is Infinity, which Postgres rejects.
    // When neither failed nor completedSteps has anything to point at,
    // park current_step at 0 so the workflow resets to the first step.
    const candidatePositions = failed.map((s) => VALID.indexOf(s)).concat(completedSteps.length);
    const currentStep = candidatePositions.length > 0 ? Math.min(...candidatePositions) : 0;
    const { error: wErr } = await admin.from("onboarding_workflows").update({
      status: "rejected",
      rejection_reason: String(rejection_reason).trim(),
      completed_steps: completedSteps,
      current_step: currentStep,
      updated_at: nowIso,
    }).eq("id", workflow.id);
    if (wErr) return res.status(500).json({ error: wErr.message });

    if (failed.length > 0) {
      await admin.from("onboarding_steps")
        .update({ status: "pending", completed_at: null })
        .eq("workflow_id", workflow.id)
        .in("step_name", failed);
    }

    // Notify vendor
    try {
      const origin = `https://${req.headers.host}`;
      const { data: vendor } = await admin.from("vendors").select("name").eq("id", vendorId).maybeSingle();
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "onboarding_rejected",
          title: "Action needed: onboarding review requires updates",
          body: `${vendor?.name || "Your account"} onboarding was reviewed and needs updates.\n\nReason: ${rejection_reason}${failed.length > 0 ? `\n\nSteps to revisit: ${failed.join(", ")}` : ""}`,
          link: "/vendor/onboarding",
          metadata: { workflow_id: workflow.id, vendor_id: vendorId, failed_steps: failed },
          recipient: { vendor_id: vendorId },
          dedupe_key: `onboarding_rejected_${workflow.id}_${nowIso.slice(0, 19)}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* non-blocking */ }

    return res.status(200).json({ ok: true, status: "rejected", failed_steps: failed });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
