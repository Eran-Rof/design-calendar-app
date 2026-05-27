// api/internal/style-fabric-codes
//
// GET  — list junction rows. One of ?style_id=<uuid> or ?fabric_code_id=<uuid>
//        is REQUIRED to scope the result; otherwise returns 400.
// POST — create a junction row. Body: {
//          style_id, fabric_code_id, role, yardage_per_unit?, notes?
//        }
//
// Tangerine P3 Chunk 11.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_VALUES = ["primary", "lining", "trim", "interlining", "accent", "other"];

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
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
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
    const styleId = url.searchParams.get("style_id");
    const fabricCodeId = url.searchParams.get("fabric_code_id");

    if (!styleId && !fabricCodeId) {
      return res.status(400).json({ error: "One of style_id or fabric_code_id query param is required" });
    }
    if (styleId && !UUID_RE.test(styleId)) {
      return res.status(400).json({ error: "style_id must be a uuid" });
    }
    if (fabricCodeId && !UUID_RE.test(fabricCodeId)) {
      return res.status(400).json({ error: "fabric_code_id must be a uuid" });
    }

    let query = admin
      .from("style_fabric_codes")
      .select("id, style_id, fabric_code_id, role, yardage_per_unit, notes, created_at, updated_at, fabric:fabric_codes!style_fabric_codes_fabric_code_id_fkey (id, code, name, composition_text, fabric_weight_gsm)")
      .eq("entity_id", entityId)
      .order("role", { ascending: true });

    if (styleId)      query = query.eq("style_id", styleId);
    if (fabricCodeId) query = query.eq("fabric_code_id", fabricCodeId);

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
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const row = {
      entity_id: entityId,
      style_id: v.data.style_id,
      fabric_code_id: v.data.fabric_code_id,
      role: v.data.role,
      yardage_per_unit: v.data.yardage_per_unit ?? null,
      notes: v.data.notes ?? null,
    };

    const { data, error } = await admin
      .from("style_fabric_codes")
      .insert(row)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `This fabric is already attached to this style as '${row.role}'` });
      }
      if (error.code === "23503") {
        return res.status(400).json({ error: "Referenced style_id or fabric_code_id does not exist" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (!body.style_id || !UUID_RE.test(String(body.style_id))) {
    return { error: "style_id must be a uuid" };
  }
  if (!body.fabric_code_id || !UUID_RE.test(String(body.fabric_code_id))) {
    return { error: "fabric_code_id must be a uuid" };
  }
  if (!body.role || !ROLE_VALUES.includes(body.role)) {
    return { error: `role must be one of ${ROLE_VALUES.join(", ")}` };
  }

  const out = {
    style_id: String(body.style_id),
    fabric_code_id: String(body.fabric_code_id),
    role: body.role,
  };

  if (body.yardage_per_unit != null && body.yardage_per_unit !== "") {
    const y = Number(body.yardage_per_unit);
    if (!Number.isFinite(y) || y < 0) {
      return { error: "yardage_per_unit must be a non-negative number" };
    }
    out.yardage_per_unit = y;
  }
  if (body.notes != null && body.notes !== "") {
    out.notes = String(body.notes).trim();
  }

  return { data: out };
}
