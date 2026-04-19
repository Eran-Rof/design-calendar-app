// api/_lib/entity.js
//
// Entity resolution middleware. Callers tell the helper which
// "side" they're on (vendor or internal) and whether they want a
// single active entity or the full accessible list.
//
// Internal:
//   - Read entity_id from the X-Entity-ID header
//   - OR derive from the subdomain (entities.slug)
//   - If neither is provided, fall back to the default (oldest) entity
// Vendor:
//   - Query entity_vendors for all active links of the caller's vendor
//   - No spoofing via header (ignored)
//
// Returned shape:
//   { entity_ids: [uuid...], primary_entity_id: uuid | null,
//     default_entity_id: uuid | null }
//
// primary_entity_id is the one the caller explicitly selected
// (X-Entity-ID for internal, the first active link for vendor).

const SUBDOMAIN_CACHE = new Map(); // slug → entity_id (in-memory, short TTL would need Redis)

async function getDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
  return data?.id || null;
}

async function resolveInternalEntity(admin, req) {
  const hdr = (req.headers?.["x-entity-id"] || req.headers?.["X-Entity-ID"] || "").toString().trim();
  if (hdr) {
    const { data } = await admin.from("entities").select("id").eq("id", hdr).maybeSingle();
    if (data) return data.id;
  }

  const host = req.headers?.host || "";
  // Match <slug>.<domain.tld> — only if there are at least 3 parts (i.e. has a subdomain)
  const parts = host.split(".");
  if (parts.length >= 3) {
    const slug = parts[0].toLowerCase();
    if (SUBDOMAIN_CACHE.has(slug)) return SUBDOMAIN_CACHE.get(slug);
    const { data } = await admin.from("entities").select("id").eq("slug", slug).maybeSingle();
    if (data) { SUBDOMAIN_CACHE.set(slug, data.id); return data.id; }
  }

  return await getDefaultEntityId(admin);
}

export async function resolveEntityContext(admin, req, { kind, vendor_id = null } = {}) {
  const defaultId = await getDefaultEntityId(admin);
  if (kind === "vendor") {
    if (!vendor_id) return { entity_ids: [], primary_entity_id: null, default_entity_id: defaultId };
    const { data } = await admin
      .from("entity_vendors")
      .select("entity_id, relationship_status, created_at")
      .eq("vendor_id", vendor_id)
      .eq("relationship_status", "active")
      .order("created_at", { ascending: true });
    const ids = (data || []).map((r) => r.entity_id);
    const headerHint = (req.headers?.["x-entity-id"] || "").toString().trim();
    const primary = headerHint && ids.includes(headerHint)
      ? headerHint
      : (ids[0] || defaultId);
    return { entity_ids: ids.length > 0 ? ids : [defaultId].filter(Boolean), primary_entity_id: primary, default_entity_id: defaultId };
  }

  // internal
  const primary = await resolveInternalEntity(admin, req);
  return { entity_ids: primary ? [primary] : [], primary_entity_id: primary, default_entity_id: defaultId };
}

// Helper for building a Supabase query that restricts to a list of
// entity_ids. Usage:
//   let q = admin.from("tanda_pos").select("...");
//   q = scopeEntities(q, ctx.entity_ids, "entity_id");
export function scopeEntities(query, entityIds, column = "entity_id") {
  if (!entityIds || entityIds.length === 0) return query;
  if (entityIds.length === 1) return query.eq(column, entityIds[0]);
  return query.in(column, entityIds);
}
