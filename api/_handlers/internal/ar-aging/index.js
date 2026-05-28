// api/internal/ar-aging
//
// GET — return AR aging buckets per customer for the default entity.
//   Default mode: returns rows from view `v_ar_aging` (uses CURRENT_DATE).
//   ?as_of=YYYY-MM-DD: calls RPC ar_aging_as_of(p_entity_id, p_as_of_date).
//   ?customer_id=<uuid>: filter to a single customer (applied to both modes).
//   ?limit=N: default 500, max 2000.
//   Sorted by total_open_cents DESC.
//
// Both modes return the SAME row shape:
//   { entity_id, customer_id, customer_name, customer_code,
//     bucket_current_cents, bucket_30_cents, bucket_60_cents,
//     bucket_90_cents, bucket_120plus_cents, total_open_cents }
//
// Tangerine P4-6.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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

export function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

export function parseListQuery(params) {
  const out = { mode: "current", customer_id: null, limit: 500 };

  const asOf = (params.get("as_of") || "").trim();
  if (asOf) {
    if (!isISODate(asOf)) {
      return { error: "as_of must be YYYY-MM-DD" };
    }
    out.mode = "as_of";
    out.as_of = asOf;
  }

  const customerId = (params.get("customer_id") || "").trim();
  if (customerId) {
    if (!isUuid(customerId)) {
      return { error: "customer_id must be a UUID" };
    }
    out.customer_id = customerId;
  }

  const limitRaw = (params.get("limit") || "").trim();
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1) {
      return { error: "limit must be a positive integer" };
    }
    out.limit = Math.min(n, 2000);
  }

  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = parseListQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    let rows;
    if (v.data.mode === "as_of") {
      const { data, error } = await admin.rpc("ar_aging_as_of", {
        p_entity_id: entityId,
        p_as_of_date: v.data.as_of,
      });
      if (error) return res.status(500).json({ error: error.message });
      rows = data || [];
      if (v.data.customer_id) {
        rows = rows.filter((r) => r.customer_id === v.data.customer_id);
      }
    } else {
      let q = admin
        .from("v_ar_aging")
        .select("*")
        .eq("entity_id", entityId);
      if (v.data.customer_id) q = q.eq("customer_id", v.data.customer_id);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      rows = data || [];
    }

    // Sort by total_open_cents DESC (biggest exposure on top); apply limit.
    rows.sort((a, b) => Number(b.total_open_cents || 0) - Number(a.total_open_cents || 0));
    rows = rows.slice(0, v.data.limit);

    return res.status(200).json({
      mode: v.data.mode,
      as_of: v.data.as_of || null,
      rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
