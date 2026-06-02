// api/internal/pim/categories/:id
//
// GET    — return one product_categories row.
// PATCH  — update mutable fields. Body: any subset of
//          { code, name, parent_category_id, sort_order, is_active }.
// DELETE — soft-delete (is_active = false). Rejected with 409 if any
//          child rows exist (active or not) — operator must reparent
//          first. Hard delete is intentionally not exposed.
//
// Tangerine P8-6 (M42 PIM).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be an object" };
  }
  const out = {};

  if (Object.prototype.hasOwnProperty.call(body, "code")) {
    const s = String(body.code ?? "").trim();
    if (!s) return { error: "code cannot be empty" };
    if (s.length > 64) return { error: "code must be <= 64 chars" };
    out.code = s;
  }
  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const s = String(body.name ?? "").trim();
    if (!s) return { error: "name cannot be empty" };
    if (s.length > 120) return { error: "name must be <= 120 chars" };
    out.name = s;
  }
  if (Object.prototype.hasOwnProperty.call(body, "parent_category_id")) {
    const p = body.parent_category_id;
    if (p == null || p === "") out.parent_category_id = null;
    else if (typeof p !== "string" || !UUID_RE.test(p)) {
      return { error: "parent_category_id must be a UUID" };
    } else out.parent_category_id = p;
  }
  if (Object.prototype.hasOwnProperty.call(body, "sort_order")) {
    const n = Number(body.sort_order);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: "sort_order must be an integer" };
    }
    out.sort_order = n;
  }
  if (Object.prototype.hasOwnProperty.call(body, "is_active")) {
    if (typeof body.is_active !== "boolean") return { error: "is_active must be boolean" };
    out.is_active = body.is_active;
  }

  if (Object.keys(out).length === 0) return { error: "No fields to update" };
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("product_categories")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Category not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Defensive: prevent setting parent_category_id = self.
    if (v.data.parent_category_id && v.data.parent_category_id === id) {
      return res.status(400).json({ error: "Category cannot be its own parent" });
    }

    const { data, error } = await admin
      .from("product_categories")
      .update({ ...v.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "A category with this code already exists" });
      }
      return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: "Category not found" });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Reject if any child rows exist (active or inactive). Operator must
    // reparent or hard-cleanup the subtree first.
    const { count, error: childErr } = await admin
      .from("product_categories")
      .select("id", { count: "exact", head: true })
      .eq("parent_category_id", id);
    if (childErr) return res.status(500).json({ error: childErr.message });
    if ((count || 0) > 0) {
      return res.status(409).json({
        error: "Category has child categories; reparent them before deleting",
        child_count: count,
      });
    }

    const { data, error } = await admin
      .from("product_categories")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Category not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
