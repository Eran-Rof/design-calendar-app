// api/cron/compliance-automation
//
// Daily compliance automation driven by ComplianceAutomationRule rows.
// Replaces the old one-size-fits-all expiry checker for rule-driven behavior
// (auto_request, escalation). compliance-daily still handles unconditional
// expiry transitions and newly-expired notifications.
//
// For each active rule with trigger_type='expiry_approaching':
//   • find approved docs of this type expiring within days_before_expiry
//   • if auto_request=true: send compliance_renewal_requested notification
//     (deduped by vendor+doc+expiry_date) and write 'requested' audit row
//   • check escalations: for docs that were 'requested' more than
//     escalation_after_days ago AND still have no newer audit row,
//     fire compliance_escalated to INTERNAL_COMPLIANCE_EMAILS and write
//     'requested' audit row again with notes='escalated'
//
// Scheduled at 13:00 UTC daily.

import { createClient } from "@supabase/supabase-js";
import { writeAudit } from "../../_lib/compliance-audit.js";

export const config = { maxDuration: 120 };

function daysFromNow(dateString) {
  if (!dateString) return null;
  return Math.ceil((new Date(dateString).getTime() - Date.now()) / 86400000);
}

async function sendNotification(origin, payload) {
  if (!origin) return;
  try {
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* non-blocking */ }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const got = req.headers.authorization || "";
    if (got !== `Bearer ${expectedSecret}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const origin = req.headers.host ? `https://${req.headers.host}` : null;
  const result = { started_at: new Date().toISOString(), rules_evaluated: 0, requests_sent: 0, escalations_sent: 0, errors: [] };

  const { data: rules } = await admin
    .from("compliance_automation_rules")
    .select("*, document_type:compliance_document_types(id, name, code)")
    .eq("is_active", true).eq("trigger_type", "expiry_approaching");

  for (const rule of rules || []) {
    result.rules_evaluated += 1;
    try {
      const windowDays = rule.days_before_expiry ?? 30;
      const now = new Date();
      const until = new Date(now.getTime() + windowDays * 86400000).toISOString().slice(0, 10);

      const { data: docs } = await admin
        .from("compliance_documents")
        .select("id, vendor_id, document_type_id, expiry_date, status, file_name, document_type:compliance_document_types(name)")
        .eq("document_type_id", rule.document_type_id)
        .eq("status", "approved")
        .not("expiry_date", "is", null)
        .lte("expiry_date", until)
        .gte("expiry_date", now.toISOString().slice(0, 10));

      if (rule.auto_request) {
        for (const d of docs || []) {
          // Dedup: has a 'requested' audit row been written for this doc's current expiry_date?
          const { data: recentRequests } = await admin
            .from("compliance_audit_trail")
            .select("id, created_at, notes")
            .eq("document_id", d.id).eq("action", "requested")
            .order("created_at", { ascending: false }).limit(1);
          const lastRequest = recentRequests?.[0];
          const lastRequestedForThisExpiry = lastRequest?.notes === `expiry=${d.expiry_date}`;
          if (lastRequestedForThisExpiry) continue;

          await sendNotification(origin, {
            event_type: "compliance_renewal_requested",
            title: `Action needed: renew ${d.document_type?.name || "document"} — expires ${d.expiry_date}`,
            body: `Your ${d.document_type?.name || "document"} expires ${d.expiry_date} (${daysFromNow(d.expiry_date)} days). Please upload a renewed copy.`,
            link: "/vendor/compliance",
            metadata: { document_id: d.id, rule_id: rule.id, expiry_date: d.expiry_date },
            recipient: { vendor_id: d.vendor_id },
            dedupe_key: `compliance_renewal_requested_${d.id}_${d.expiry_date}`,
            email: true,
          });
          await writeAudit(admin, {
            vendor_id: d.vendor_id, document_id: d.id, action: "requested",
            performed_by_type: "system", notes: `expiry=${d.expiry_date}`,
          });
          result.requests_sent += 1;
        }
      }

      // Escalation check: docs with an open 'requested' audit row older than escalation_after_days
      if (rule.escalation_after_days && rule.escalation_after_days > 0) {
        const cutoff = new Date(now.getTime() - rule.escalation_after_days * 86400000).toISOString();
        const { data: requestsNeedingEscalation } = await admin
          .from("compliance_audit_trail")
          .select("id, vendor_id, document_id, created_at, notes")
          .eq("action", "requested")
          .lt("created_at", cutoff);

        for (const r of requestsNeedingEscalation || []) {
          if (!r.document_id) continue;
          // Has a newer audit row (uploaded / approved / renewed) landed since?
          const { data: newer } = await admin
            .from("compliance_audit_trail")
            .select("id, action").eq("document_id", r.document_id)
            .gt("created_at", r.created_at)
            .in("action", ["uploaded", "approved", "renewed"]);
          if ((newer || []).length > 0) continue;

          // Has an escalation notification already fired for this requested row?
          const { data: escRow } = await admin
            .from("compliance_audit_trail")
            .select("id").eq("document_id", r.document_id).eq("action", "requested")
            .eq("performed_by_type", "system").eq("notes", `escalated_from=${r.id}`).limit(1);
          if ((escRow || []).length > 0) continue;

          // Resolve vendor name + doc type for the subject line
          const [{ data: vendor }, { data: docRow }] = await Promise.all([
            admin.from("vendors").select("name").eq("id", r.vendor_id).maybeSingle(),
            admin.from("compliance_documents")
              .select("document_type:compliance_document_types(name)")
              .eq("id", r.document_id).maybeSingle(),
          ]);
          const vendorName = vendor?.name || `Vendor ${r.vendor_id.slice(0, 8)}`;
          const typeName = docRow?.document_type?.name || "compliance document";

          // INTERNAL_COMPLIANCE_EMAILS is a comma-separated env var — fan
          // out one notification per email so each recipient receives a
          // valid send-notification payload (passing the whole list as a
          // single `email` field would either fail validation or send to a
          // malformed address).
          const escEmails = (process.env.INTERNAL_COMPLIANCE_EMAILS || "")
            .split(",").map((e) => e.trim()).filter(Boolean);
          for (const email of escEmails) {
            await sendNotification(origin, {
              event_type: "compliance_escalated",
              title: `Escalation: ${vendorName} has not renewed ${typeName}`,
              body: `A renewal request was sent ${rule.escalation_after_days}+ days ago but no document has been uploaded since.`,
              link: "/",
              metadata: { document_id: r.document_id, original_request_id: r.id, rule_id: rule.id },
              recipient: { internal_id: "compliance-escalations", email },
              dedupe_key: `compliance_escalated_${r.id}_${email}`,
              email: true,
            });
          }
          await writeAudit(admin, {
            vendor_id: r.vendor_id, document_id: r.document_id, action: "requested",
            performed_by_type: "system", notes: `escalated_from=${r.id}`,
          });
          result.escalations_sent += 1;
        }
      }
    } catch (err) {
      result.errors.push({ rule_id: rule.id, error: err?.message || String(err) });
    }
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}
