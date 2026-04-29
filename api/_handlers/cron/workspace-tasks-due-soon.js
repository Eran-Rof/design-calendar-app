// api/cron/workspace-tasks-due-soon
//
// Daily cron. Looks for workspace_tasks with due_date within the next 2 days
// and status not complete/cancelled. Sends one task_due_soon per assignee per
// task (deduped by date).

import { createClient } from "@supabase/supabase-js";
import { dueSoonSubject, filterDueSoonTasks } from "../../_lib/notifications-phase9.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
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
  const today = new Date().toISOString().slice(0, 10);
  const result = { started_at: new Date().toISOString(), sent: 0, skipped_no_assignee: 0, errors: [] };

  const { data: tasks } = await admin.from("workspace_tasks")
    .select("id, workspace_id, title, due_date, status, assigned_to_type, assigned_to, workspace:collaboration_workspaces(id, vendor_id)");

  const dueSoon = filterDueSoonTasks(tasks || []);

  for (const t of dueSoon) {
    try {
      if (!t.assigned_to_type || !t.assigned_to) { result.skipped_no_assignee += 1; continue; }
      const payload = {
        event_type: "workspace_task_due_soon",
        title: dueSoonSubject(t),
        body: `Workspace task "${t.title}" is due ${t.due_date}. Status: ${t.status}.`,
        link: t.assigned_to_type === "vendor" ? "/vendor/workspaces" : "/",
        metadata: { task_id: t.id, workspace_id: t.workspace_id, due_date: t.due_date },
        dedupe_key: `workspace_task_due_soon_${t.id}_${today}`,
        email: true,
      };

      if (t.assigned_to_type === "vendor" && t.workspace?.vendor_id) {
        payload.recipient = { vendor_id: t.workspace.vendor_id };
      } else if (t.assigned_to_type === "internal") {
        const email = isEmail(t.assigned_to) ? t.assigned_to : (process.env.INTERNAL_COMPLIANCE_EMAILS || "").split(",")[0]?.trim();
        if (!email) { result.skipped_no_assignee += 1; continue; }
        payload.recipient = { internal_id: t.assigned_to, email };
      } else {
        result.skipped_no_assignee += 1; continue;
      }

      if (origin) {
        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).catch((e) => console.error("[cron] notify fanout failed", e?.message ?? e));
      }
      result.sent += 1;
    } catch (err) {
      result.errors.push({ task_id: t.id, error: err?.message || String(err) });
    }
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}

function isEmail(s) { return typeof s === "string" && /@/.test(s); }
