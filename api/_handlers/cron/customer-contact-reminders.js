// api/cron/customer-contact-reminders
//
// Operator #12 — fire in-app notifications for due customer-contact note
// reminders. Finds customer_contact_notes with remind_at <= now() and
// reminder_sent = false; for each, creates an internal notification_event +
// a notification_dispatch (in_app) for the user who set the reminder
// (created_by_user_id), then marks reminder_sent = true. The notification
// deep-links to the customer (context_table='customers', context_id=customer_id;
// payload carries note_id + contact_id) so the bell click opens that contact.
//
// Scheduled hourly via vercel.json. Idempotent (reminder_sent guard).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  const result = { started_at: new Date().toISOString(), due: 0, notified: 0, skipped_no_user: 0, errors: [] };
  try {
    const { data: ent } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    const entityId = ent?.id || null;

    const nowIso = new Date().toISOString();
    const { data: due, error } = await admin
      .from("customer_contact_notes")
      .select("id, customer_id, contact_id, body, created_by_user_id, created_by_name, remind_at")
      .lte("remind_at", nowIso)
      .eq("reminder_sent", false)
      .order("remind_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    result.due = (due || []).length;

    // Resolve customer names for the subject line.
    const custIds = [...new Set((due || []).map((n) => n.customer_id))];
    const nameById = new Map();
    if (custIds.length) {
      const { data: cs } = await admin.from("customers").select("id, name").in("id", custIds);
      for (const c of cs || []) nameById.set(c.id, c.name);
    }

    for (const n of due || []) {
      try {
        if (!n.created_by_user_id) {
          // No owner to notify — still mark sent so it doesn't recur forever.
          await admin.from("customer_contact_notes").update({ reminder_sent: true }).eq("id", n.id);
          result.skipped_no_user++;
          continue;
        }
        const custName = nameById.get(n.customer_id) || "customer";
        const { data: ev, error: evErr } = await admin.from("notification_events").insert({
          entity_id: entityId,
          kind: "contact_reminder",
          severity: "info",
          subject: `Reminder — ${custName} contact`,
          body: n.body,
          context_table: "customers",
          context_id: n.customer_id,
          payload: { note_id: n.id, contact_id: n.contact_id, customer_id: n.customer_id, remind_at: n.remind_at },
          created_by_user_id: n.created_by_user_id,
        }).select("id").single();
        if (evErr) throw new Error(evErr.message);

        const { error: dErr } = await admin.from("notification_dispatches").insert({
          event_id: ev.id,
          recipient_user_id: n.created_by_user_id,
          channel: "in_app",
          status: "sent",
          sent_at: new Date().toISOString(),
        });
        if (dErr) throw new Error(dErr.message);

        await admin.from("customer_contact_notes").update({ reminder_sent: true }).eq("id", n.id);
        result.notified++;
      } catch (e) {
        result.errors.push({ note_id: n.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    result.errors.push({ pass: "main", error: e instanceof Error ? e.message : String(e) });
  }
  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}
