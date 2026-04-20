// api/vendor/onboarding/submit
//
// POST — explicitly move workflow to pending_review (if all steps are
// complete). No-op if already pending_review or approved. Fires
// onboarding_submitted notification to INTERNAL_ONBOARDING_EMAILS
// (falls back to INTERNAL_COMPLIANCE_EMAILS).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const ALL_STEPS = ["company_info", "banking", "tax", "compliance_docs", "portal_tour", "agreement"];

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const { data: workflow } = await admin.from("onboarding_workflows").select("*").eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!workflow) return res.status(404).json({ error: "Onboarding not started" });
  if (workflow.status === "approved") return res.status(200).json({ ok: true, status: "approved" });
  const completed = new Set(workflow.completed_steps || []);
  const missing = ALL_STEPS.filter((s) => !completed.has(s));
  if (missing.length > 0) return res.status(400).json({ error: `Cannot submit — missing steps: ${missing.join(", ")}` });

  await admin.from("onboarding_workflows").update({
    status: "pending_review",
    updated_at: new Date().toISOString(),
  }).eq("id", workflow.id);

  // Notify internal review team
  try {
    const emails = (process.env.INTERNAL_ONBOARDING_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
      .split(",").map((e) => e.trim()).filter(Boolean);
    if (emails.length > 0) {
      const { data: vendor } = await admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle();
      const vendorName = vendor?.name || "A vendor";
      const origin = `https://${req.headers.host}`;
      await Promise.all(emails.map((email) =>
        fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "onboarding_submitted",
            title: `${vendorName} submitted onboarding for review`,
            body: "All 6 onboarding steps are complete and awaiting internal approval.",
            link: "/",
            metadata: { workflow_id: workflow.id, vendor_id: caller.vendor_id },
            recipient: { internal_id: "onboarding_team", email },
            dedupe_key: `onboarding_submitted_${workflow.id}_${email}`,
            email: true,
          }),
        }).catch(() => {})
      ));
    }
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, status: "pending_review" });
}
