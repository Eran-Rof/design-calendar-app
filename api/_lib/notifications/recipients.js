// api/_lib/notifications/recipients.js
//
// resolveRecipients(supabase, { entity_id, explicit, roles })  →  string[]
//
// Returns a unique list of auth.user uuids drawn from:
//   - the explicit list (verbatim)
//   - every entity_users row in entity_id whose .role is in `roles`
//
// Used by notificationsAPI.enqueue to fan out a single event to multiple
// recipients without the caller having to pre-resolve role memberships.

export async function resolveRecipients(supabase, { entity_id, explicit = [], roles = [] }) {
  const seen = new Set();
  const out = [];

  for (const uid of explicit) {
    if (typeof uid === "string" && uid && !seen.has(uid)) {
      seen.add(uid);
      out.push(uid);
    }
  }

  if (roles && roles.length > 0) {
    const { data, error } = await supabase
      .from("entity_users")
      .select("auth_id, role")
      .eq("entity_id", entity_id)
      .in("role", roles);
    if (error) {
      throw new Error(`entity_users query failed: ${error.message}`);
    }
    for (const row of data || []) {
      if (!seen.has(row.auth_id)) {
        seen.add(row.auth_id);
        out.push(row.auth_id);
      }
    }
  }

  return out;
}
