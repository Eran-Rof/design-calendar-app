// GET /api/external/v1/styles
//
// READ-ONLY list of styles from style_master, scoped to the API key's entity.
// Returns human labels (style_code, style_name) — no raw uuids in the payload.
//
// Query: ?limit=&offset=  (limit cap 200)

import { withApiKey, pageEnvelope } from "../../../_lib/external/handlerKit.js";

export const config = { maxDuration: 15 };

export default withApiKey(async ({ res, admin, auth, limit, offset }) => {
  const { data, error } = await admin
    .from("style_master")
    .select("style_code, style_name, description, group_name, category_name, sub_category_name, gender_code, lifecycle_status")
    .eq("entity_id", auth.entity_id)
    .is("deleted_at", null)
    .order("style_code", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: "query_failed", message: error.message });

  const rows = (data || []).map((s) => ({
    style_code: s.style_code,
    style_name: s.style_name || s.description || null,
    group: s.group_name || null,
    category: s.category_name || null,
    sub_category: s.sub_category_name || null,
    gender: s.gender_code || null,
    status: s.lifecycle_status || null,
  }));
  return pageEnvelope(res, { data: rows, limit, offset });
});
