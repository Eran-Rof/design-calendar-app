// api/vendor/onboarding
//
// GET — current workflow + per-step data for the caller's vendor.
// POST — ensure a workflow exists (idempotent). Returns the workflow.
//
// Shape:
//   { workflow: { id, status, current_step, completed_steps, ... },
//     steps: [ { step_name, status, data, completed_at } ] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const ALL_STEPS = ["company_info", "banking", "tax", "compliance_docs", "portal_tour", "agreement"];

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin
      .from("vendor_users").select("id, vendor_id, display_name, role").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

async function ensureWorkflow(admin, vendorId) {
  const { data: existing } = await admin.from("onboarding_workflows").select("*").eq("vendor_id", vendorId).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await admin.from("onboarding_workflows").insert({
    vendor_id: vendorId,
    status: "not_started",
    current_step: 0,
    completed_steps: [],
  }).select("*").single();
  if (error) throw error;
  return created;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  if (req.method === "GET" || req.method === "POST") {
    let workflow;
    try { workflow = await ensureWorkflow(admin, caller.vendor_id); }
    catch (e) { return res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }

    const { data: steps } = await admin
      .from("onboarding_steps").select("*").eq("workflow_id", workflow.id);
    const byName = new Map((steps || []).map((s) => [s.step_name, s]));
    const orderedSteps = ALL_STEPS.map((name) => byName.get(name) || {
      workflow_id: workflow.id, step_name: name, status: "pending", data: null, completed_at: null,
    });

    return res.status(200).json({ workflow, steps: orderedSteps, step_order: ALL_STEPS });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
