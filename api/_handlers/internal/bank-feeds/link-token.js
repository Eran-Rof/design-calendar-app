// api/internal/bank-feeds/link-token
//
// POST. Body: { client_user_id?: <uuid>, webhook?: <absolute url> }
//
// Generates a Plaid link_token. The Tangerine Bank Accounts panel calls
// this, opens Plaid Link with the returned token, the operator signs in
// to their bank, Plaid returns a public_token which the frontend POSTs
// back to /api/internal/bank-feeds/exchange.
//
// Tangerine P6-2.

import { createClient } from "@supabase/supabase-js";
import { createLinkToken, isPlaidConfigured, PlaidError } from "../../../_lib/plaid/client.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validateBody(body) {
  const out = { client_user_id: null, webhook: null };
  if (body && typeof body === "object") {
    if (body.client_user_id != null && body.client_user_id !== "") {
      if (!UUID_RE.test(String(body.client_user_id))) {
        return { error: "client_user_id must be a UUID" };
      }
      out.client_user_id = String(body.client_user_id);
    }
    if (body.webhook != null && body.webhook !== "") {
      const w = String(body.webhook);
      if (!/^https:\/\//.test(w)) {
        return { error: "webhook must be an absolute https URL" };
      }
      if (w.length > 500) return { error: "webhook url too long" };
      out.webhook = w;
    }
  }
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isPlaidConfigured()) {
    return res.status(503).json({
      error: "Plaid integration not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in Vercel env (sandbox keys work for dev).",
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { body = {}; }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  // client_user_id falls back to the default entity id so every Plaid link
  // is associated with the operator at the Plaid side. Use the entity uuid;
  // single-tenant for now.
  let clientUserId = v.data.client_user_id;
  if (!clientUserId) {
    const admin = client();
    if (admin) {
      const { data: entity } = await admin
        .from("entities").select("id").eq("code", "ROF").maybeSingle();
      if (entity?.id) clientUserId = entity.id;
    }
    if (!clientUserId) clientUserId = "00000000-0000-0000-0000-000000000000";
  }

  try {
    const resp = await createLinkToken({
      client_user_id: clientUserId,
      client_name: "Tangerine ERP",
      products: ["transactions"],
      country_codes: ["US"],
      webhook: v.data.webhook,
    });
    return res.status(200).json({
      link_token: resp.link_token,
      expiration: resp.expiration,
      request_id: resp.request_id,
    });
  } catch (e) {
    if (e instanceof PlaidError) {
      return res.status(e.status || 500).json({
        error: e.message,
        code: e.code,
        type: e.type,
        request_id: e.request_id,
      });
    }
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
