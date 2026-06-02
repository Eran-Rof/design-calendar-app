// api/cron/crm-tasks-due-tomorrow
//
// Tangerine P8-9 — Daily reminder cron for CRM tasks due tomorrow.
//
// Schedule: 13:00 UTC every day (vercel.json crons[]).
//
// Walks all crm_tasks where status IN ('open','in_progress') AND
// due_date = current_date + 1 day. Emits ONE notification_event per
// task (the P2-3 dispatch cron handles the actual email send via
// notification_preferences lookup).
//
// Idempotency: keyed on (kind, context_id, payload->'due_date') so
// re-runs in the same UTC day don't double-emit. The
// notification_events table doesn't have a uniqueness constraint, so
// we apply a "skip if same row already exists for today" guard
// inline.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const out = await runDueTomorrow(admin);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

export async function runDueTomorrow(supabase) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(today.getUTCDate() + 1);
  const tomorrowISO = tomorrow.toISOString().slice(0, 10);

  const { data: tasks, error } = await supabase
    .from("crm_tasks")
    .select("id, entity_id, title, due_date, priority, assignee_user_id, customer_id, opportunity_id")
    .in("status", ["open", "in_progress"])
    .eq("due_date", tomorrowISO)
    .not("assignee_user_id", "is", null);
  if (error) throw new Error(`crm_tasks query failed: ${error.message}`);

  const summary = {
    scanned: tasks?.length ?? 0,
    emitted: 0,
    skipped_already_notified: 0,
    errors: [],
    tomorrow: tomorrowISO,
  };

  for (const t of tasks || []) {
    // Skip if a notification_event already exists today for this task
    // with kind crm_task_due_tomorrow. Cheap probe, idempotent across reruns.
    const { data: existing, error: probeErr } = await supabase
      .from("notification_events")
      .select("id")
      .eq("kind", "crm_task_due_tomorrow")
      .eq("context_id", t.id)
      .gte("created_at", today.toISOString().slice(0, 10))
      .limit(1);
    if (probeErr) {
      summary.errors.push(`probe ${t.id}: ${probeErr.message}`);
      continue;
    }
    if (existing && existing.length > 0) {
      summary.skipped_already_notified += 1;
      continue;
    }

    const { error: insErr } = await supabase
      .from("notification_events")
      .insert({
        entity_id: t.entity_id,
        kind: "crm_task_due_tomorrow",
        severity:
          t.priority === "urgent" ? "critical" :
          t.priority === "high"   ? "warning"  :
          "info",
        subject: `Task due tomorrow: ${t.title}`,
        body: `Your task "${t.title}" is due ${tomorrowISO}. Priority: ${t.priority}. Open: https://tangerine.ringoffireclothing.com/?view=crm_tasks&id=${t.id}`,
        context_table: "crm_tasks",
        context_id: t.id,
        payload: {
          task_id: t.id,
          title: t.title,
          due_date: t.due_date,
          priority: t.priority,
          assignee_user_id: t.assignee_user_id,
          customer_id: t.customer_id,
          opportunity_id: t.opportunity_id,
        },
      });
    if (insErr) {
      summary.errors.push(`insert ${t.id}: ${insErr.message}`);
      continue;
    }
    summary.emitted += 1;
  }

  return summary;
}
