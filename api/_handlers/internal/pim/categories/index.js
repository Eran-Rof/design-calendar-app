// api/internal/pim/categories
//
// GET  — return the full product_categories tree as a flat list with
//        depth + parent_id columns. The UI client reassembles the tree
//        from the flat list (spec: §6 — "Tree (parent_id-self join, depth-limited)").
//        Implemented as a single non-recursive fetch over all rows for the
//        default entity, then a JS depth pass. Self-referential FK already
//        guarantees acyclic structure; 3-level cap is policy not enforced
//        in DB.  Returns rows ordered by (depth, sort_order, name) so the
//        client can render top-to-bottom without re-sorting.
//
// POST — create a new category. Body:
//        { code, name, parent_category_id?, sort_order?, is_active? }
//
// Tangerine P8-6 (M42 PIM).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function parseListQuery(params) {
  const out = { is_active: null };
  const ia = params.get("is_active");
  if (ia != null && ia !== "") {
    if (ia === "true")  out.is_active = true;
    else if (ia === "false") out.is_active = false;
    else return { error: "is_active must be true|false" };
  }
  return { data: out };
}

export function validateCreate(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be an object" };
  }
  const out = {};

  const code = String(body.code ?? "").trim();
  if (!code) return { error: "code is required" };
  if (code.length > 64) return { error: "code must be <= 64 chars" };
  out.code = code;

  const name = String(body.name ?? "").trim();
  if (!name) return { error: "name is required" };
  if (name.length > 120) return { error: "name must be <= 120 chars" };
  out.name = name;

  if (Object.prototype.hasOwnProperty.call(body, "parent_category_id")) {
    const p = body.parent_category_id;
    if (p == null || p === "") {
      out.parent_category_id = null;
    } else if (typeof p !== "string" || !UUID_RE.test(p)) {
      return { error: "parent_category_id must be a UUID" };
    } else {
      out.parent_category_id = p;
    }
  } else {
    out.parent_category_id = null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "sort_order")) {
    const n = Number(body.sort_order);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: "sort_order must be an integer" };
    }
    out.sort_order = n;
  } else {
    out.sort_order = 0;
  }

  if (Object.prototype.hasOwnProperty.call(body, "is_active")) {
    if (typeof body.is_active !== "boolean") return { error: "is_active must be boolean" };
    out.is_active = body.is_active;
  } else {
    out.is_active = true;
  }

  return { data: out };
}

// Tag each row with depth = distance to root (parent_category_id == null).
// Done in JS over the prefetched flat list. O(N) with a memo cache.
export function annotateDepth(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memo = new Map();
  function depthOf(id) {
    if (memo.has(id)) return memo.get(id);
    const r = byId.get(id);
    if (!r || !r.parent_category_id) {
      memo.set(id, 0);
      return 0;
    }
    // Defensive: a parent referencing itself or forming a cycle would
    // loop forever; cap at 32 (way above the 3-level policy).
    const seen = new Set([id]);
    let cur = r;
    let d = 0;
    while (cur && cur.parent_category_id && d < 32) {
      if (seen.has(cur.parent_category_id)) break;
      seen.add(cur.parent_category_id);
      cur = byId.get(cur.parent_category_id);
      d += 1;
      if (!cur) break;
    }
    memo.set(id, d);
    return d;
  }
  return rows.map((r) => ({ ...r, depth: depthOf(r.id) }));
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entity } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const v = parseListQuery(url.searchParams);
    if (v.error) return res.status(400).json({ error: v.error });

    let q = admin
      .from("product_categories")
      .select("id, parent_category_id, code, name, sort_order, is_active, created_at, updated_at")
      .eq("entity_id", entity.id)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (v.data.is_active != null) q = q.eq("is_active", v.data.is_active);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const withDepth = annotateDepth(data || []);
    // Stable secondary sort by depth then sort_order then name
    withDepth.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.name.localeCompare(b.name);
    });
    return res.status(200).json(withDepth);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateCreate(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const row = { ...v.data, entity_id: entity.id };
    const { data, error } = await admin
      .from("product_categories")
      .insert(row)
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "A category with this code already exists" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
