// api/internal/payment-terms
//
// GET  — list payment terms for the default entity. By default returns
//        is_active=true rows only; ?include_inactive=true returns all.
//        Query:
//          ?q=<search>             — ilike match on code or name
//          ?include_inactive=true  — include inactive rows
// POST — create one payment_terms row. Body:
//          { code (required, uppercased), name (required), due_days (>=0),
//            discount_pct (0..0.9999, optional, default 0),
//            discount_days (>=0, optional, default 0), is_active (default true) }
//
// Tangerine P3 Chunk 9 — Payment Terms Master. Mirrors the gl-accounts /
// customer-master handler shape (resolveDefaultEntityId + ROF scope).

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 15 };

// Chunk M — payment-term codes are server-generated + read-only (operator item 14).
const CODE_PREFIX = "TERM-";

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
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const q = (url.searchParams.get("q") || "").trim();

    let query = admin
      .from("payment_terms")
      .select("*")
      .eq("entity_id", entityId)
      .order("due_days", { ascending: true })
      .order("code", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`code.ilike.%${esc}%,name.ilike.%${esc}%`);
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

    // Chunk M — `code` is always server-generated; any client-supplied code is ignored.
    const { data, error } = await insertWithAutoCode(
      admin, "payment_terms", "code", CODE_PREFIX,
      (code) => ({ ...v.data, code, entity_id: entityId }),
      { entityId },
    );
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Could not allocate a unique payment-term code; please retry" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  // Chunk M — `code` is server-generated; no longer required/validated from the client.
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }
  if (body.due_days == null || body.due_days === "") {
    return { error: "due_days is required" };
  }

  const dueDays = typeof body.due_days === "number" ? body.due_days : parseInt(body.due_days, 10);
  if (!Number.isInteger(dueDays) || dueDays < 0) {
    return { error: "due_days must be a non-negative integer" };
  }

  let discountPct = 0;
  if (body.discount_pct != null && body.discount_pct !== "") {
    discountPct = typeof body.discount_pct === "number" ? body.discount_pct : parseFloat(body.discount_pct);
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct >= 1) {
      return { error: "discount_pct must be a number in [0, 1)" };
    }
  }

  let discountDays = 0;
  if (body.discount_days != null && body.discount_days !== "") {
    discountDays = typeof body.discount_days === "number" ? body.discount_days : parseInt(body.discount_days, 10);
    if (!Number.isInteger(discountDays) || discountDays < 0) {
      return { error: "discount_days must be a non-negative integer" };
    }
  }

  if (discountPct > 0 && discountDays <= 0) {
    return { error: "discount_days must be > 0 when discount_pct > 0" };
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  return {
    data: {
      // code is injected by the handler (server-generated); not taken from body.
      name:          String(body.name).trim(),
      due_days:      dueDays,
      discount_pct:  discountPct,
      discount_days: discountDays,
      is_active:     isActive,
    },
  };
}
