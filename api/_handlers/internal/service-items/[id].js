// api/internal/service-items/[id]
//
// GET    — fetch a single service_item_master row.
// PATCH  — update mutable fields. `code` and `entity_id` are LOCKED.
//          Mutable: name, service_kind, is_labor, default_vendor_id,
//          default_charge_cents, default_expense_account_id, applied_to_wip,
//          notes, sort_order, is_active.
// DELETE — hard-delete (toggle is_active=false to retire instead).
//
// Tangerine — Manufacturing Service Item Master.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_KINDS = new Set(["print", "sew", "pack", "wash", "conversion", "other"]);

const MUTABLE_FIELDS = new Set([
  "name", "service_kind", "is_labor", "default_vendor_id", "default_charge_cents",
  "default_expense_account_id", "applied_to_wip", "notes", "sort_order", "is_active",
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

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("service_item_master")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Service item not found" });
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
    v.data.updated_at = new Date().toISOString();
    const { data, error } = await admin
      .from("service_item_master")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Service item not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("service_item_master")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Service item not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
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

  if ("service_kind" in out) {
    out.service_kind = String(out.service_kind).trim();
    if (!SERVICE_KINDS.has(out.service_kind)) {
      return { error: `service_kind must be one of: ${[...SERVICE_KINDS].join(", ")}` };
    }
  }

  if ("notes" in out) out.notes = out.notes ? String(out.notes).trim() || null : null;

  for (const fk of ["default_vendor_id", "default_expense_account_id"]) {
    if (fk in out) {
      if (out[fk] == null || out[fk] === "") { out[fk] = null; }
      else if (!UUID_RE.test(String(out[fk]))) { return { error: `${fk} must be a uuid` }; }
    }
  }

  if ("default_charge_cents" in out) {
    if (out.default_charge_cents == null || out.default_charge_cents === "") {
      out.default_charge_cents = null;
    } else {
      const n = typeof out.default_charge_cents === "number"
        ? out.default_charge_cents : parseInt(out.default_charge_cents, 10);
      if (!Number.isInteger(n) || n < 0) {
        return { error: "default_charge_cents must be a non-negative integer (cents)" };
      }
      out.default_charge_cents = n;
    }
  }

  if ("sort_order" in out) {
    if (out.sort_order == null || out.sort_order === "") {
      out.sort_order = 0;
    } else {
      const n = typeof out.sort_order === "number" ? out.sort_order : parseInt(out.sort_order, 10);
      if (!Number.isInteger(n) || n < 0) {
        return { error: "sort_order must be a non-negative integer" };
      }
      out.sort_order = n;
    }
  }

  for (const b of ["is_active", "is_labor", "applied_to_wip"]) {
    if (b in out && typeof out[b] !== "boolean") {
      out[b] = out[b] === "true" || out[b] === 1;
    }
  }

  return { data: out };
}
