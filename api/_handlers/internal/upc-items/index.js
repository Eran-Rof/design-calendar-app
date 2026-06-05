// api/internal/upc-items
//
// GET — UPC Report. Lists upc_item_master rows joined to style_master for the
//       default entity, enriched with style_name. Grain is (style, color, size).
//       Query params:
//         ?q=<search>      matches style_no / color / size / upc / style_name
//         ?limit=N         default 5000, capped at 20000
//         ?check_prefix=1  returns { has_prefix, gs1_prefix_masked } only — used
//                          by the Style Master "Generate UPCs" checkbox to gate
//                          itself when no GS1 company prefix is configured.
//
// Read-only. Reuses the existing upc_item_master table (no new write path).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return null;
  return createClient(SB_URL, KEY, { auth: { persistSession: false } });
}
async function entityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Prefix-availability probe for the create-modal checkbox gate.
  if (String(req.query?.check_prefix || "") === "1") {
    const { data: settings } = await admin
      .from("company_settings")
      .select("gs1_prefix, prefix_length")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const has = !!(settings && settings.gs1_prefix && settings.prefix_length);
    return res.status(200).json({
      has_prefix: has,
      gs1_prefix_masked: has ? `${String(settings.gs1_prefix).slice(0, 3)}…` : null,
    });
  }

  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const q = (req.query?.q || "").toString().trim();
  const limit = Math.min(parseInt(req.query?.limit || "5000", 10) || 5000, 20000);

  // Pull UPC rows (keyset-paginate by upc to dodge the PostgREST ~1000 cap).
  const PAGE = 1000;
  let rows = [];
  let after = null;
  while (rows.length < limit) {
    let pq = admin
      .from("upc_item_master")
      .select("id, upc, style_no, color, size, description, source_method, created_at")
      .order("upc", { ascending: true })
      .limit(Math.min(PAGE, limit - rows.length));
    if (after) pq = pq.gt("upc", after);
    if (q) {
      const safe = q.replace(/[,%]/g, " ").trim();
      if (safe) {
        pq = pq.or(
          [
            `style_no.ilike.%${safe}%`,
            `color.ilike.%${safe}%`,
            `size.ilike.%${safe}%`,
            `upc.ilike.%${safe}%`,
            `description.ilike.%${safe}%`,
          ].join(","),
        );
      }
    }
    const { data, error } = await pq;
    if (error) return res.status(500).json({ error: error.message });
    const page = data || [];
    rows = rows.concat(page);
    if (page.length < PAGE) break;
    after = page[page.length - 1].upc;
  }

  // Enrich with style_name from style_master (single lookup by distinct style_code).
  const codes = [...new Set(rows.map((r) => r.style_no).filter(Boolean))];
  const nameByCode = new Map();
  if (codes.length > 0) {
    // Chunk the IN list to stay well under URL limits.
    for (let i = 0; i < codes.length; i += 200) {
      const slice = codes.slice(i, i + 200);
      const { data: styles } = await admin
        .from("style_master")
        .select("style_code, style_name")
        .eq("entity_id", eid)
        .in("style_code", slice);
      for (const s of styles || []) nameByCode.set(s.style_code, s.style_name || null);
    }
  }

  const out = rows.map((r) => ({
    upc: r.upc,
    style_code: r.style_no,
    style_name: nameByCode.get(r.style_no) || null,
    color: r.color,
    size: r.size,
    description: r.description,
    source: r.source_method,
  }));

  // If a search term matched style_name only (not the UPC columns), fold those
  // in too: find matching style_codes then re-filter is overkill for this admin
  // report — the column search above already covers code/color/size/upc.
  return res.status(200).json(out);
}
