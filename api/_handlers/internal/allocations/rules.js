// api/internal/allocations/rules  (h602)
//
// Configurable allocation PRIORITY rules (singleton per entity) for the
// auto-allocate engine. The order of the three criteria + the within-tier
// tie-break are operator-set here and read by allocations/preview.js.
//
// GET → { priority_order: string[], tie_break } (the historical default when no
//        row exists: factor → card → oldest, by order date).
// PUT { priority_order, tie_break } → validate (priority_order must be a
//        permutation of the 3 criteria) + upsert.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

export const CRITERIA = ["factor_approved", "credit_card", "oldest"];
export const TIE_BREAKS = ["order_date", "ship_date"];
const DEFAULT = { priority_order: [...CRITERIA], tie_break: "order_date" };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Email");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function entityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data ? data.id : null;
}

// Read the saved rules (or the default). Shared with preview.js.
export async function getAllocationRules(admin, eid) {
  try {
    const { data } = await admin.from("allocation_priority_rules").select("priority_order, tie_break").eq("entity_id", eid).maybeSingle();
    if (!data) return { ...DEFAULT };
    const order = Array.isArray(data.priority_order) && CRITERIA.every((c) => data.priority_order.includes(c)) && data.priority_order.length === CRITERIA.length
      ? data.priority_order : [...CRITERIA];
    const tie = TIE_BREAKS.includes(data.tie_break) ? data.tie_break : "order_date";
    return { priority_order: order, tie_break: tie };
  } catch { return { ...DEFAULT }; }
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    return res.status(200).json(await getAllocationRules(admin, eid));
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    const order = Array.isArray(body.priority_order) ? body.priority_order.map(String) : null;
    if (!order || order.length !== CRITERIA.length || !CRITERIA.every((c) => order.includes(c)) || new Set(order).size !== order.length) {
      return res.status(400).json({ error: `priority_order must be a permutation of ${CRITERIA.join(", ")}` });
    }
    const tie = body.tie_break;
    if (!TIE_BREAKS.includes(tie)) return res.status(400).json({ error: `tie_break must be one of ${TIE_BREAKS.join(", ")}` });
    const updatedBy = (req.headers?.["x-user-email"] || "").toString().trim().toLowerCase() || null;

    const { error } = await admin.from("allocation_priority_rules")
      .upsert({ entity_id: eid, priority_order: order, tie_break: tie, updated_at: new Date().toISOString(), updated_by: updatedBy }, { onConflict: "entity_id" });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ priority_order: order, tie_break: tie });
  }

  res.setHeader("Allow", "GET, PUT");
  return res.status(405).json({ error: "Method not allowed" });
}
