// Shared helpers to fan-out phase-change-request notifications.
//
// - notifyVendor: one notification per vendor_user in the given vendor_id
// - notifyInternal: one notification per internal user in app_data['users']
//
// Both insert directly into the notifications table (RLS anon-permissive
// for service role). Email delivery via Resend is best-effort and runs
// inside send-notification.js — we skip that path for now and just ensure
// the in-app bell lights up. Wire send-notification later if email is
// desired for every phase transition.

/**
 * @param admin Supabase service-role client.
 * @param vendorId UUID
 * @param row { event_type, title, body, link, metadata }
 */
export async function notifyVendor(admin, vendorId, row) {
  if (!vendorId) return 0;
  const { data: users, error } = await admin
    .from("vendor_users").select("auth_id").eq("vendor_id", vendorId);
  if (error || !users) return 0;
  const unique = new Set(users.map((u) => u.auth_id).filter(Boolean));
  if (unique.size === 0) return 0;
  const rows = Array.from(unique).map((auth_id) => ({
    recipient_auth_id: auth_id,
    event_type: row.event_type,
    title: row.title,
    body: row.body || null,
    link: row.link || null,
    metadata: row.metadata || null,
    email_status: "skipped",
  }));
  const { error: insErr } = await admin.from("notifications").insert(rows);
  return insErr ? 0 : rows.length;
}

/**
 * Fan out to every internal user in app_data['users']. For now every
 * internal user sees every phase-change notification; refine later
 * (e.g. only users with TandA access) once we have a role table.
 * @param row { event_type, title, body, link, metadata }
 */
export async function notifyInternal(admin, row) {
  const { data, error } = await admin
    .from("app_data").select("value").eq("key", "users").maybeSingle();
  if (error || !data?.value) return 0;
  let users = [];
  try { users = JSON.parse(data.value); } catch { return 0; }
  const ids = users
    .filter((u) => u && typeof u === "object" && u.id)
    .map((u) => String(u.id));
  if (ids.length === 0) return 0;
  const rows = ids.map((id) => ({
    recipient_internal_id: id,
    event_type: row.event_type,
    title: row.title,
    body: row.body || null,
    link: row.link || null,
    metadata: row.metadata || null,
    email_status: "skipped",
  }));
  const { error: insErr } = await admin.from("notifications").insert(rows);
  return insErr ? 0 : rows.length;
}
