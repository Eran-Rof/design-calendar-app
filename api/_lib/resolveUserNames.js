// Resolve a set of auth.users ids → a human display label (metadata name, else
// email, else a short id). Best-effort: returns {} (or partial) on any failure so
// list endpoints that only want a "created by" label never break on this nicety.
// Mirrors the auth.admin.listUsers pattern used by users-access.

export async function resolveUserLabels(admin, ids) {
  const want = new Set((ids || []).filter(Boolean));
  const out = {};
  if (!want.size) return out;
  try {
    let page = 1;
    // listUsers is paginated; walk pages until we've seen everyone or run dry.
    for (;;) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) break;
      const users = data?.users || [];
      for (const u of users) {
        if (!want.has(u.id)) continue;
        const meta = u.user_metadata || {};
        out[u.id] = meta.name || meta.full_name || u.email || String(u.id).slice(0, 8);
      }
      if (users.length < 200 || Object.keys(out).length >= want.size) break;
      page += 1;
      if (page > 25) break; // hard safety stop
    }
  } catch { /* best-effort — label is a nicety */ }
  return out;
}
