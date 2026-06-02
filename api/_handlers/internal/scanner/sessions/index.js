// api/internal/scanner/sessions
//
// GET  — list scanner sessions. Filters: ?device_user_id=<uuid>, ?status=open,
//        ?mode=receive, ?target_kind=po, ?limit=N (default 100, max 500).
//        Service-role admin view: returns all sessions for the entity. Device
//        operators hit the same endpoint with an auth token; RLS clamps to
//        their own sessions via auth_own_scanner_sessions policy.
//
// POST — create a new session.
//        Body: { mode, target_kind, target_id?, device_user_id?, client_meta? }
//        device_user_id is required from the device path; the admin path may
//        pass an explicit device_user_id for testing. We never auto-derive
//        device_user_id from anon — this is a service-role tool path.
//
// Tangerine P3 Chunk 8 — M39 Mobile Scanner back-end.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const deviceUserId = url.searchParams.get("device_user_id");
    const status = url.searchParams.get("status");
    const mode = url.searchParams.get("mode");
    const targetKind = url.searchParams.get("target_kind");
    let limit = parseInt(url.searchParams.get("limit") || "100", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    if (limit > 500) limit = 500;

    let query = admin
      .from("scanner_sessions")
      .select("*")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (deviceUserId) {
      if (!isUuid(deviceUserId)) return res.status(400).json({ error: "device_user_id must be a uuid" });
      query = query.eq("device_user_id", deviceUserId);
    }
    if (status) {
      if (!["open","submitted","cancelled"].includes(status)) {
        return res.status(400).json({ error: "status must be open/submitted/cancelled" });
      }
      query = query.eq("status", status);
    }
    if (mode) {
      if (!["receive","pick","transfer","count"].includes(mode)) {
        return res.status(400).json({ error: "mode must be receive/pick/transfer/count" });
      }
      query = query.eq("mode", mode);
    }
    if (targetKind) {
      if (!["po","so","cycle_count","adhoc"].includes(targetKind)) {
        return res.status(400).json({ error: "target_kind must be po/so/cycle_count/adhoc" });
      }
      query = query.eq("target_kind", targetKind);
    }

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

    const { data, error } = await admin
      .from("scanner_sessions")
      .insert({ ...v.data, entity_id: entityId })
      .select()
      .single();
    if (error) {
      if (error.code === "23503") {
        return res.status(400).json({ error: `Foreign key violation: ${error.message}` });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// Strict UUID format: 8-4-4-4-12 hex chars with dashes at exact positions.
export function isUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function validateInsert(body) {
  if (!body.mode || typeof body.mode !== "string") {
    return { error: "mode required" };
  }
  if (!["receive","pick","transfer","count"].includes(body.mode)) {
    return { error: "mode must be receive/pick/transfer/count" };
  }
  if (!body.target_kind || typeof body.target_kind !== "string") {
    return { error: "target_kind required" };
  }
  if (!["po","so","cycle_count","adhoc"].includes(body.target_kind)) {
    return { error: "target_kind must be po/so/cycle_count/adhoc" };
  }
  if (!body.device_user_id) {
    return { error: "device_user_id required" };
  }
  if (!isUuid(body.device_user_id)) {
    return { error: "device_user_id must be a uuid" };
  }
  if (body.target_id != null && body.target_id !== "" && !isUuid(body.target_id)) {
    return { error: "target_id must be a uuid" };
  }
  // adhoc => target_id should be null
  if (body.target_kind === "adhoc" && body.target_id) {
    return { error: "target_id must be null when target_kind=adhoc" };
  }
  // non-adhoc => target_id required
  if (body.target_kind !== "adhoc" && !body.target_id) {
    return { error: `target_id required when target_kind=${body.target_kind}` };
  }
  if (body.client_meta != null && (typeof body.client_meta !== "object" || Array.isArray(body.client_meta))) {
    return { error: "client_meta must be an object" };
  }

  return {
    data: {
      mode: body.mode,
      target_kind: body.target_kind,
      target_id: body.target_id || null,
      device_user_id: body.device_user_id,
      client_meta: body.client_meta || {},
      status: "open",
    },
  };
}
