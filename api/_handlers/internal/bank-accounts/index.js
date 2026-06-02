// api/internal/bank-accounts
//
// GET — list bank_accounts for the default entity. Includes the joined
// gl_accounts.code for display + last_synced_at + current_balance_cents.
// Filters: ?is_active=true|false (default true), ?feed_source=plaid|csv_upload|manual.
//
// Tangerine P6-5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const FEED_SOURCE_VALUES = ["plaid", "csv_upload", "manual"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function parseListQuery(params) {
  const out = { is_active: true, feed_source: null };
  const ia = params.get("is_active");
  if (ia != null) {
    if (ia === "true")  out.is_active = true;
    else if (ia === "false") out.is_active = false;
    else if (ia !== "")  return { error: "is_active must be true|false" };
  }
  const fs = params.get("feed_source");
  if (fs) {
    if (!FEED_SOURCE_VALUES.includes(fs)) {
      return { error: `feed_source must be one of ${FEED_SOURCE_VALUES.join(", ")}` };
    }
    out.feed_source = fs;
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

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = parseListQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  let q = admin
    .from("bank_accounts")
    .select(
      "id, name, account_kind, institution_name, mask, " +
      "feed_source, last_synced_at, current_balance_cents, is_active, " +
      "gl_account_id, gl_accounts(code, name), created_at",
    )
    .eq("entity_id", entity.id)
    .order("name", { ascending: true });
  if (v.data.is_active != null) q = q.eq("is_active", v.data.is_active);
  if (v.data.feed_source) q = q.eq("feed_source", v.data.feed_source);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
