// api/internal/inventory-cycle-counts
//
// GET  — list cycle counts for the default entity (ROF), ordered by count_date
//        DESC then created_at DESC. Optional filters:
//          ?status=in_progress|completed|cancelled
//          ?from=YYYY-MM-DD   inclusive lower bound on count_date
//          ?to=YYYY-MM-DD     inclusive upper bound on count_date
//          ?limit=N           default 100, max 500
//
// POST — start a new cycle count. Body:
//          {
//            count_date?: "YYYY-MM-DD"  (default: today),
//            location?: string          (default: 'main'),
//            notes?: string,
//            scope_filter?: {
//              item_ids?: uuid[]              (optional: snapshot only these items)
//            }
//          }
//
//        Snapshot algorithm:
//          1. Pull open inventory_layers (remaining_qty > 0) for this entity.
//          2. Group by item_id, sum remaining_qty → system_qty.
//          3. Optionally restrict to scope_filter.item_ids.
//          4. Insert cycle_count row + bulk insert one line per item with
//             counted_qty = NULL.
//
//        Returns: { cycle_count: row, line_count: N }
//
// Tangerine P3 Chunk 6.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (error || !data) return null;
  return data.id;
}

// Strict UUID format: 8-4-4-4-12 hex chars with dashes at exact positions.
export function isUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

const VALID_STATUSES = new Set(["in_progress", "completed", "cancelled"]);

// Parse + validate list query. Pure for testability.
export function parseListQuery(searchParams) {
  const out = { error: null, filters: {}, limit: 100 };

  const status = (searchParams.get("status") || "").trim();
  if (status) {
    if (!VALID_STATUSES.has(status)) {
      return { error: "status must be one of: in_progress, completed, cancelled" };
    }
    out.filters.status = status;
  }

  const from = (searchParams.get("from") || "").trim();
  if (from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return { error: "from must be YYYY-MM-DD" };
    out.filters.from = from;
  }

  const to = (searchParams.get("to") || "").trim();
  if (to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: "to must be YYYY-MM-DD" };
    out.filters.to = to;
  }

  const limitRaw = searchParams.get("limit");
  if (limitRaw != null && limitRaw !== "") {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n <= 0) return { error: "limit must be a positive integer" };
    out.limit = Math.min(n, 500);
  }

  return out;
}

// Validate POST body. Pure for testability.
export function validateStartBody(body) {
  const b = body || {};
  const out = {};

  if (b.count_date != null && b.count_date !== "") {
    const s = String(b.count_date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return { error: "count_date must be YYYY-MM-DD" };
    }
    out.count_date = s;
  }

  if (b.location != null && String(b.location).trim() !== "") {
    out.location = String(b.location).trim();
  } else {
    out.location = "main";
  }

  if (b.notes != null && b.notes !== "") {
    out.notes = String(b.notes).trim();
  }

  if (b.scope_filter != null) {
    if (typeof b.scope_filter !== "object" || Array.isArray(b.scope_filter)) {
      return { error: "scope_filter must be an object" };
    }
    const sf = {};
    if (b.scope_filter.item_ids != null) {
      if (!Array.isArray(b.scope_filter.item_ids)) {
        return { error: "scope_filter.item_ids must be an array of uuids" };
      }
      for (const id of b.scope_filter.item_ids) {
        if (!isUuid(id)) {
          return { error: "scope_filter.item_ids contains a non-uuid value" };
        }
      }
      sf.item_ids = b.scope_filter.item_ids;
    }
    out.scope_filter = sf;
  }

  return { data: out };
}

// Aggregate inventory_layers rows into system_qty per item_id.
// Pure helper for testability.
export function aggregateSystemQty(layers) {
  const map = new Map();
  for (const l of layers || []) {
    if (!l || !l.item_id) continue;
    const qty = Number(l.remaining_qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    map.set(l.item_id, (map.get(l.item_id) || 0) + qty);
  }
  return map;
}

// Paginate inventory_layers — table can grow large; PostgREST 1000-row cap
// applies server-side regardless of .limit(). Use .range() pagination.
async function fetchAllOpenLayers(admin, entityId) {
  const PAGE_SIZE = 1000;
  let from = 0;
  const out = [];
  // Safety upper bound — at 1000/page × 200 pages = 200k rows.
  for (let page = 0; page < 200; page++) {
    const { data, error } = await admin
      .from("inventory_layers")
      .select("item_id, remaining_qty")
      .eq("entity_id", entityId)
      .gt("remaining_qty", 0)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const parsed = parseListQuery(url.searchParams);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let query = admin
      .from("inventory_cycle_counts")
      .select("*")
      .eq("entity_id", entityId)
      .order("count_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(parsed.limit);

    if (parsed.filters.status) query = query.eq("status", parsed.filters.status);
    if (parsed.filters.from)   query = query.gte("count_date", parsed.filters.from);
    if (parsed.filters.to)     query = query.lte("count_date", parsed.filters.to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateStartBody(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Snapshot open layers + aggregate to system_qty per item.
    let layers;
    try {
      layers = await fetchAllOpenLayers(admin, entityId);
    } catch (e) {
      return res.status(500).json({ error: `Failed to read inventory_layers: ${e.message}` });
    }
    let systemQtyByItem = aggregateSystemQty(layers);

    // Scope filter
    if (v.data.scope_filter && Array.isArray(v.data.scope_filter.item_ids)) {
      const wanted = new Set(v.data.scope_filter.item_ids);
      const filtered = new Map();
      for (const id of wanted) {
        // Items with no open layer get 0 — counting "should-be-zero" items
        // is a valid scenario. Include them in the snapshot.
        filtered.set(id, systemQtyByItem.get(id) || 0);
      }
      systemQtyByItem = filtered;
    }

    if (systemQtyByItem.size === 0) {
      return res.status(400).json({
        error: "No items to count — no open FIFO layers in this entity (and no scope_filter.item_ids supplied).",
      });
    }

    // Insert header
    const headerRow = {
      entity_id: entityId,
      location: v.data.location,
      ...(v.data.count_date ? { count_date: v.data.count_date } : {}),
      ...(v.data.notes ? { notes: v.data.notes } : {}),
    };

    const { data: header, error: hErr } = await admin
      .from("inventory_cycle_counts")
      .insert(headerRow)
      .select()
      .single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    // Bulk insert lines
    const lineRows = [];
    for (const [itemId, qty] of systemQtyByItem.entries()) {
      lineRows.push({
        cycle_count_id: header.id,
        item_id: itemId,
        system_qty: qty,
      });
    }
    const { error: lErr } = await admin
      .from("inventory_cycle_count_lines")
      .insert(lineRows);
    if (lErr) {
      // Best-effort cleanup so we don't leave an orphan header.
      await admin.from("inventory_cycle_counts").delete().eq("id", header.id);
      return res.status(500).json({ error: lErr.message });
    }

    return res.status(201).json({ cycle_count: header, line_count: lineRows.length });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
