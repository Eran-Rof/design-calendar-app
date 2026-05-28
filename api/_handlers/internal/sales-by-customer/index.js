// api/internal/sales-by-customer
//
// Tangerine P7-7 — Sales by Customer × Period report.
//
// GET — return per-customer aggregates (invoice_count, gross_cents,
// credit_memo_cents, net_cents) for a date window via RPC sales_by_customer.
//
// Query params:
//   from = YYYY-MM-DD (required)
//   to   = YYYY-MM-DD (required)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

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

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

export function validateQuery(params) {
  const fromRaw = (params.get("from") || "").trim();
  const toRaw = (params.get("to") || "").trim();

  if (!fromRaw) return { error: "from is required (YYYY-MM-DD)" };
  if (!toRaw)   return { error: "to is required (YYYY-MM-DD)" };
  if (!isISODate(fromRaw)) return { error: "from must be YYYY-MM-DD" };
  if (!isISODate(toRaw))   return { error: "to must be YYYY-MM-DD" };
  if (fromRaw > toRaw)     return { error: "from must be on or before to" };

  return { data: { from: fromRaw, to: toRaw } };
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
  const v = validateQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    const { data, error } = await admin.rpc("sales_by_customer", {
      p_entity_id: entityId,
      p_from: v.data.from,
      p_to: v.data.to,
    });
    if (error) return res.status(500).json({ error: error.message });

    const rows = (data || []).slice().sort(
      (a, b) => Number(b.net_cents || 0) - Number(a.net_cents || 0),
    );

    return res.status(200).json({ from: v.data.from, to: v.data.to, rows });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
