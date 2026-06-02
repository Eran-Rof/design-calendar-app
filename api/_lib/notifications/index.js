// api/_lib/notifications/index.js
//
// Tangerine M28 Notifications - public entrypoint.
//
//   notificationsAPI.enqueue(supabase, {...}) - downstream call site:
//     records one notification_events row and fans out one
//     notification_dispatches row per (recipient × enabled channel).
//     in_app rows are marked sent synchronously; email rows are pending
//     for the cron worker to drain.
//
//   notificationsAPI.markRead(supabase, { dispatch_id, user_id }) - flips
//     an in_app dispatch's status to 'read' and stamps read_at.
//
//   notificationsAPI.drainPendingEmails(supabase, { limit, send }) - cron
//     worker entry. Fetches pending email dispatches, calls `send(...)` for
//     each, and updates status. `send` is injected so tests / dev can stub
//     it; the production caller wires in a real Resend / SMTP client.

import { resolveRecipients } from "./recipients.js";

export class NotificationsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const VALID_SEVERITIES = new Set(["info", "warn", "error"]);
const VALID_CHANNELS = ["in_app", "email"];

/**
 * Enqueue an event + fan-out dispatches.
 *
 * @param {Object} supabase                    Service-role client.
 * @param {Object} ctx
 * @param {string} ctx.entity_id
 * @param {string} ctx.kind                    Free-form discriminator (je_posted, ...)
 * @param {string} [ctx.severity]              info | warn | error (default info)
 * @param {string} ctx.subject
 * @param {string} ctx.body
 * @param {string} [ctx.context_table]
 * @param {string} [ctx.context_id]
 * @param {Object} [ctx.payload]
 * @param {string[]} [ctx.recipients]          Explicit user_id list
 * @param {string[]} [ctx.recipient_roles]     Fan-out via entity_users
 * @param {string[]} [ctx.channels]            Default: ["in_app","email"]
 * @param {string}   [ctx.created_by_user_id]
 * @returns {Promise<{event_id:string, dispatch_count:number}>}
 */
export async function enqueue(supabase, ctx) {
  if (!supabase) throw new NotificationsError("missing_client", "supabase client required");
  if (!ctx || typeof ctx !== "object") {
    throw new NotificationsError("invalid_ctx", "ctx must be an object");
  }
  if (!ctx.entity_id) throw new NotificationsError("missing_entity_id", "entity_id required");
  if (!ctx.kind) throw new NotificationsError("missing_kind", "kind required");
  if (!ctx.subject) throw new NotificationsError("missing_subject", "subject required");
  if (!ctx.body) throw new NotificationsError("missing_body", "body required");
  const severity = ctx.severity || "info";
  if (!VALID_SEVERITIES.has(severity)) {
    throw new NotificationsError("invalid_severity", `severity must be one of: ${[...VALID_SEVERITIES].join(", ")}`);
  }

  const channels = ctx.channels && ctx.channels.length > 0
    ? ctx.channels.filter((c) => VALID_CHANNELS.includes(c))
    : VALID_CHANNELS.slice();

  // 1. Resolve recipients (explicit list ∪ entity_users for role list)
  const recipients = await resolveRecipients(supabase, {
    entity_id: ctx.entity_id,
    explicit: ctx.recipients || [],
    roles: ctx.recipient_roles || [],
  });
  if (recipients.length === 0) {
    // Still record the event for audit, but no dispatches.
    const { data: ev, error: evErr } = await supabase
      .from("notification_events")
      .insert({
        entity_id: ctx.entity_id, kind: ctx.kind, severity,
        subject: ctx.subject, body: ctx.body,
        context_table: ctx.context_table || null,
        context_id: ctx.context_id || null,
        payload: ctx.payload || {},
        created_by_user_id: ctx.created_by_user_id || null,
      })
      .select("id")
      .single();
    if (evErr) throw new NotificationsError("event_insert_failed", evErr.message);
    return { event_id: ev.id, dispatch_count: 0 };
  }

  // 2. Pull all relevant notification_preferences rows in one shot to filter
  //    out opted-out (recipient, channel) pairs.
  const { data: prefs, error: prefErr } = await supabase
    .from("notification_preferences")
    .select("user_id, kind, channel, enabled")
    .in("user_id", recipients)
    .eq("kind", ctx.kind);
  if (prefErr) throw new NotificationsError("prefs_query_failed", prefErr.message);
  const optedOut = new Set();
  for (const p of prefs || []) {
    if (!p.enabled) optedOut.add(`${p.user_id}|${p.channel}`);
  }

  // 3. Insert event
  const { data: ev, error: evErr } = await supabase
    .from("notification_events")
    .insert({
      entity_id: ctx.entity_id, kind: ctx.kind, severity,
      subject: ctx.subject, body: ctx.body,
      context_table: ctx.context_table || null,
      context_id: ctx.context_id || null,
      payload: ctx.payload || {},
      created_by_user_id: ctx.created_by_user_id || null,
    })
    .select("id")
    .single();
  if (evErr) throw new NotificationsError("event_insert_failed", evErr.message);

  // 4. Build dispatch rows. in_app: status='sent' synchronously; email: 'pending'.
  const nowIso = new Date().toISOString();
  const dispatches = [];
  for (const uid of recipients) {
    for (const ch of channels) {
      if (optedOut.has(`${uid}|${ch}`)) continue;
      dispatches.push({
        event_id: ev.id,
        recipient_user_id: uid,
        channel: ch,
        status: ch === "in_app" ? "sent" : "pending",
        sent_at: ch === "in_app" ? nowIso : null,
      });
    }
  }

  if (dispatches.length === 0) {
    return { event_id: ev.id, dispatch_count: 0 };
  }

  const { error: dErr } = await supabase
    .from("notification_dispatches")
    .insert(dispatches);
  if (dErr) throw new NotificationsError("dispatches_insert_failed", dErr.message);

  return { event_id: ev.id, dispatch_count: dispatches.length };
}

/**
 * Mark an in_app dispatch as read.
 */
export async function markRead(supabase, { dispatch_id, user_id }) {
  if (!dispatch_id) throw new NotificationsError("missing_dispatch_id", "dispatch_id required");
  if (!user_id) throw new NotificationsError("missing_user_id", "user_id required");

  const { data, error } = await supabase
    .from("notification_dispatches")
    .update({ status: "read", read_at: new Date().toISOString() })
    .eq("id", dispatch_id)
    .eq("recipient_user_id", user_id)
    .eq("channel", "in_app")
    .select()
    .single();
  if (error) throw new NotificationsError("update_failed", error.message);
  if (!data) throw new NotificationsError("dispatch_not_found",
    `dispatch ${dispatch_id} not found for user ${user_id} (wrong owner or wrong channel)`);
  return { dispatch: data };
}

/**
 * Drain pending email dispatches. Caller injects `send(dispatchWithEvent)`
 * which resolves to a delivery outcome:
 *   resolve     → mark sent (sent_at = now())
 *   reject(err) → mark failed (error_message = err.message)
 *
 * @returns {Promise<{processed:number, sent:number, failed:number}>}
 */
export async function drainPendingEmails(supabase, { limit = 50, send } = {}) {
  if (typeof send !== "function") {
    throw new NotificationsError("missing_send", "send(dispatch) function required");
  }
  const { data: rows, error } = await supabase
    .from("notification_dispatches")
    .select("*, event:notification_events(*)")
    .eq("channel", "email")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new NotificationsError("query_failed", error.message);

  let sent = 0;
  let failed = 0;
  for (const row of rows || []) {
    try {
      await send(row);
      const { error: upErr } = await supabase
        .from("notification_dispatches")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", row.id);
      if (upErr) {
        failed++;
        continue;
      }
      sent++;
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      await supabase
        .from("notification_dispatches")
        .update({ status: "failed", error_message: msg.slice(0, 500) })
        .eq("id", row.id);
      failed++;
    }
  }

  return { processed: rows ? rows.length : 0, sent, failed };
}
