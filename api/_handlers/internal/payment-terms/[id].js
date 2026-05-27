// api/internal/payment-terms/[id]
//
// GET    — fetch a single payment_terms row.
// PATCH  — update mutable fields. `code` and `entity_id` are LOCKED
//          post-creation. Mutable: name, due_days, discount_pct,
//          discount_days, is_active.
// DELETE — hard-delete. Rejected (409) with reference details if any
//          vendors / customers / invoices still reference it.
//
// Tangerine P3 Chunk 9 — Payment Terms Master.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set([
  "name", "due_days", "discount_pct", "discount_days", "is_active",
]);

const LOCKED_FIELDS = new Set(["code", "entity_id", "id"]);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Per feedback_dispatcher_query_not_params: always read path params from req.query.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("payment_terms")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Payment terms not found" });
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
    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "No mutable fields supplied" });
    }
    const { data, error } = await admin
      .from("payment_terms")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Payment terms not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Reject if any vendor / customer / invoice still references this term.
    const refCounts = await countReferences(admin, id);
    if (refCounts.error) return res.status(500).json({ error: refCounts.error });
    if (refCounts.total > 0) {
      return res.status(409).json({
        error: "Payment terms is still referenced. Reassign or clear those rows before deleting, or toggle is_active=false instead.",
        references: refCounts.detail,
      });
    }
    const { data, error } = await admin
      .from("payment_terms")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Payment terms not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

async function countReferences(admin, id) {
  const detail = { vendors: 0, customers: 0, invoices: 0 };
  for (const tbl of ["vendors", "customers", "invoices"]) {
    const { count, error } = await admin
      .from(tbl)
      .select("id", { count: "exact", head: true })
      .eq("payment_terms_id", id);
    if (error) return { error: `${tbl}: ${error.message}` };
    detail[tbl] = count || 0;
  }
  return { total: detail.vendors + detail.customers + detail.invoices, detail };
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  for (const f of Object.keys(body)) {
    if (LOCKED_FIELDS.has(f)) {
      return { error: `${f} is locked post-creation and cannot be updated` };
    }
  }

  const out = {};
  for (const [k, val] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = val;
  }

  if ("name" in out) {
    if (out.name == null || String(out.name).trim() === "") {
      return { error: "name cannot be empty" };
    }
    out.name = String(out.name).trim();
  }

  if ("due_days" in out) {
    if (out.due_days == null || out.due_days === "") {
      return { error: "due_days cannot be blanked" };
    }
    const n = typeof out.due_days === "number" ? out.due_days : parseInt(out.due_days, 10);
    if (!Number.isInteger(n) || n < 0) {
      return { error: "due_days must be a non-negative integer" };
    }
    out.due_days = n;
  }

  if ("discount_pct" in out) {
    if (out.discount_pct == null || out.discount_pct === "") {
      out.discount_pct = 0;
    } else {
      const n = typeof out.discount_pct === "number" ? out.discount_pct : parseFloat(out.discount_pct);
      if (!Number.isFinite(n) || n < 0 || n >= 1) {
        return { error: "discount_pct must be a number in [0, 1)" };
      }
      out.discount_pct = n;
    }
  }

  if ("discount_days" in out) {
    if (out.discount_days == null || out.discount_days === "") {
      out.discount_days = 0;
    } else {
      const n = typeof out.discount_days === "number" ? out.discount_days : parseInt(out.discount_days, 10);
      if (!Number.isInteger(n) || n < 0) {
        return { error: "discount_days must be a non-negative integer" };
      }
      out.discount_days = n;
    }
  }

  // Cross-field constraint: discount_pct > 0 requires discount_days > 0.
  if ("discount_pct" in out || "discount_days" in out) {
    const pct  = "discount_pct"  in out ? out.discount_pct  : null;
    const days = "discount_days" in out ? out.discount_days : null;
    // Only validate when BOTH are present in the patch (partial patches that
    // set only one are validated against the existing row by the DB CHECK).
    if (pct != null && days != null && pct > 0 && days <= 0) {
      return { error: "discount_days must be > 0 when discount_pct > 0" };
    }
  }

  if ("is_active" in out) {
    if (typeof out.is_active !== "boolean") {
      out.is_active = out.is_active === "true" || out.is_active === 1;
    }
  }

  return { data: out };
}
