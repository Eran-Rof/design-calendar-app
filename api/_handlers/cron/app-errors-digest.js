// api/_handlers/cron/app-errors-digest.js
//
// Daily (13:05 UTC ≈ 09:05 ET, right after the Xoro feed-health alert): group
// the last 24h of app_errors by fingerprint and send ONE bell+email digest to
// admins — top groups with count, source, route, and latest message. Silent
// when there were no errors. Also prunes rows older than 30 days so the table
// never needs babysitting.
//
// This closes the "prod exceptions live only in Vercel logs" gap from the
// 2026-07-07 audit — the dispatcher catch-all, the browser reporter, and any
// cron using captureError all land here.

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../../_lib/notifications/index.js";

export const config = { maxDuration: 30 };

const TOP_GROUPS = 12;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: rows, error } = await admin
    .from("app_errors")
    .select("fingerprint, source, route, message, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) return res.status(500).json({ error: `app_errors read failed: ${error.message}` });

  // Prune >30d (best-effort, independent of whether we alert today).
  const pruneBefore = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  await admin.from("app_errors").delete().lt("created_at", pruneBefore);

  const out = { window_from: since, errors: (rows || []).length, groups: 0, alerted: false };
  if (!rows || rows.length === 0) return res.status(200).json(out);

  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.fingerprint);
    if (!g) { g = { count: 0, source: r.source, route: r.route, latest: r.message, latest_at: r.created_at }; groups.set(r.fingerprint, g); }
    g.count++;
  }
  out.groups = groups.size;
  const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, TOP_GROUPS);

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ ...out, error: "Default entity (ROF) not found" });

  const lines = top.map((g) =>
    `• ×${g.count} [${g.source}] ${g.route || "(no route)"}\n    ${String(g.latest).slice(0, 180)}`);
  const body =
    `${rows.length} error(s) in ${groups.size} group(s) over the last 24h:\n\n` +
    lines.join("\n") +
    (groups.size > TOP_GROUPS ? `\n\n…and ${groups.size - TOP_GROUPS} more group(s).` : "") +
    `\n\nSource 'api' = a request 500'd; 'client' = a user's browser hit an uncaught error; 'cron' = a scheduled job failed.`;

  try {
    const ev = await enqueueNotification(admin, {
      entity_id: entity.id,
      kind: "app_errors_digest",
      severity: "warn",
      subject: `App errors: ${rows.length} in 24h (${groups.size} distinct)`,
      body,
      context_table: "app_errors",
      context_id: null,
      payload: { total: rows.length, groups: top },
      recipient_roles: ["admin"],
    });
    out.alerted = true;
    out.notification_event_id = ev?.event_id || null;
  } catch (e) {
    out.error = `notification enqueue failed: ${String(e?.message || e)}`;
  }
  return res.status(200).json(out);
}
