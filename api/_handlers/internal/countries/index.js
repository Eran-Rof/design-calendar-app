// api/internal/countries
//
// GET  — list country_master rows. By default returns is_active=true rows
//        only; ?include_inactive=true returns all. ?q=<search> ilike on
//        iso2 or name. Ordered alphabetically by name (countries have no
//        manual sort-order concept in the UI).
// POST — create one country_master row. Body:
//          { iso2 (required, 2-char, uppercased), name (required),
//            sort_order (>=0, optional, default 0), is_active (default true) }
//
// Chunk I — Country Master. country_master is GLOBAL (entity-agnostic), so
// no entity_id scope. Mirrors the payment-terms handler shape otherwise.

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

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const q = (url.searchParams.get("q") || "").trim();

    let query = admin
      .from("country_master")
      .select("*")
      .order("name", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`iso2.ilike.%${esc}%,name.ilike.%${esc}%`);
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
      .from("country_master")
      .insert(v.data)
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `iso2 '${v.data.iso2}' already exists` });
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
  if (!body.iso2 || !String(body.iso2).trim()) {
    return { error: "iso2 is required" };
  }
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }

  const iso2 = String(body.iso2).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso2)) {
    return { error: "iso2 must be exactly 2 letters" };
  }

  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { error: "sort_order must be a non-negative integer" };
    }
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  let phoneCode = null;
  if (body.phone_code != null && body.phone_code !== "") {
    phoneCode = typeof body.phone_code === "number" ? body.phone_code : parseInt(String(body.phone_code).replace(/\D/g, ""), 10);
    if (!Number.isInteger(phoneCode) || phoneCode < 0) {
      return { error: "phone_code must be a non-negative integer" };
    }
  }

  return {
    data: {
      iso2,
      name:       String(body.name).trim(),
      sort_order: sortOrder,
      is_active:  isActive,
      ...(phoneCode != null ? { phone_code: phoneCode } : {}),
    },
  };
}
