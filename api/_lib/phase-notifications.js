// Shared helpers to fan-out phase-change-request notifications.
//
// - notifyVendor: one notification per vendor_user in the given vendor_id
// - notifyInternal: one notification per internal user in app_data['users']
//
// Both write directly into the notifications table. Optionally, callers
// can pass { email: true, origin } to also fire the Resend pipeline by
// POSTing per-user to /api/send-notification. The default is in-app only
// because phase changes can fan out broadly (every internal user, every
// vendor_user) — opt-in email avoids accidental inbox spam.

async function fireEmail(origin, payload) {
  if (!origin) return;
  try {
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* non-blocking */ }
}

/**
 * @param admin Supabase service-role client.
 * @param vendorId UUID
 * @param row { event_type, title, body, link, metadata }
 * @param options { email?: boolean, origin?: string }
 */
export async function notifyVendor(admin, vendorId, row, options = {}) {
  if (!vendorId) return 0;
  const { email = false, origin = null } = options;
  const { data: users, error } = await admin
    .from("vendor_users").select("auth_id").eq("vendor_id", vendorId);
  if (error || !users) return 0;
  const unique = new Set(users.map((u) => u.auth_id).filter(Boolean));
  if (unique.size === 0) return 0;
  const authIds = Array.from(unique);
  const rows = authIds.map((auth_id) => ({
    recipient_auth_id: auth_id,
    event_type: row.event_type,
    title: row.title,
    body: row.body || null,
    link: row.link || null,
    metadata: row.metadata || null,
    email_status: email ? "pending" : "skipped",
  }));
  const { error: insErr } = await admin.from("notifications").insert(rows);
  if (insErr) return 0;
  if (email && origin) {
    await Promise.all(authIds.map((auth_id) => fireEmail(origin, {
      event_type: row.event_type,
      title: row.title,
      body: row.body || null,
      link: row.link || null,
      metadata: row.metadata || null,
      recipient: { auth_id },
      dedupe_key: `phase_${row.event_type}_${auth_id}_${row.metadata?.request_id || row.metadata?.po_id || Date.now()}`,
      email: true,
    })));
  }
  return rows.length;
}

/**
 * Fan out to every internal user in app_data['users'].
 * @param row { event_type, title, body, link, metadata }
 * @param options { email?: boolean, origin?: string }
 */
export async function notifyInternal(admin, row, options = {}) {
  const { email = false, origin = null } = options;
  const { data, error } = await admin
    .from("app_data").select("value").eq("key", "users").maybeSingle();
  if (error || !data?.value) return 0;
  let users = [];
  try { users = JSON.parse(data.value); } catch { return 0; }
  const internalUsers = users.filter((u) => u && typeof u === "object" && u.id);
  const ids = internalUsers.map((u) => String(u.id));
  if (ids.length === 0) return 0;
  const rows = ids.map((id) => ({
    recipient_internal_id: id,
    event_type: row.event_type,
    title: row.title,
    body: row.body || null,
    link: row.link || null,
    metadata: row.metadata || null,
    email_status: email ? "pending" : "skipped",
  }));
  const { error: insErr } = await admin.from("notifications").insert(rows);
  if (insErr) return 0;
  if (email && origin) {
    const emailedUsers = internalUsers.filter((u) => u.email && typeof u.email === "string");
    await Promise.all(emailedUsers.map((u) => fireEmail(origin, {
      event_type: row.event_type,
      title: row.title,
      body: row.body || null,
      link: row.link || null,
      metadata: row.metadata || null,
      recipient: { internal_id: String(u.id), email: u.email },
      dedupe_key: `phase_${row.event_type}_${u.id}_${row.metadata?.request_id || row.metadata?.po_id || Date.now()}`,
      email: true,
    })));
  }
  return rows.length;
}
