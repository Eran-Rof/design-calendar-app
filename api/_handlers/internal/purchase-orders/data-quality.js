// api/internal/purchase-orders/data-quality
//
// GET  [?po_number=ROF-P001157]
//   → catalog/link data-quality findings on ACTIVE native POs, from the
//     v_po_data_quality view. Optional po_number narrows to one PO (used by the
//     grid's per-PO ⚠ badge). Returns a summary + the detail findings so the
//     operator SEES the issues instead of being silently misled.
//
// Anon-read (service-role client; the view is read-only over PO/catalog tables).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Brand-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const poNumber = typeof req.query?.po_number === "string" ? req.query.po_number.trim() : "";
  let query = admin
    .from("v_po_data_quality")
    .select("po_id, po_number, defect_class, severity, style_code, color, detail, suggested_fix, item_count")
    .order("severity", { ascending: true }) // 'error' < 'warn'
    .order("po_number", { ascending: true })
    .limit(2000);
  if (poNumber) query = query.eq("po_number", poNumber);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const findings = data || [];
  const byClass = {};
  const byPo = {};
  let errors = 0;
  for (const f of findings) {
    byClass[f.defect_class] = (byClass[f.defect_class] || 0) + 1;
    byPo[f.po_number] = (byPo[f.po_number] || 0) + 1;
    if (f.severity === "error") errors += 1;
  }

  return res.status(200).json({
    summary: {
      total: findings.length,
      errors,
      warnings: findings.length - errors,
      affected_pos: Object.keys(byPo).length,
      by_class: byClass,
      by_po: byPo,
    },
    findings,
  });
}
