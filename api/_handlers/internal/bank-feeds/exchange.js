// api/internal/bank-feeds/exchange
//
// POST. Body: {
//   public_token: <from Plaid Link>,
//   gl_account_id: <uuid; which GL cash account to link to>,
//   name?: <display name; default = institution_name + mask>,
//   account_kind?: 'checking' | 'savings' | 'credit_card' | 'line_of_credit' | 'other',
//   created_by_user_id?: <uuid>
// }
//
// Exchanges the Plaid Link public_token for a long-lived access_token,
// encrypts it, enumerates the Plaid accounts inside the Item, and
// upserts one `bank_accounts` row per Plaid account. The operator can
// re-link the same Item to refresh credentials — same access_token gets
// re-encrypted in place.
//
// Tangerine P6-2.

import { createClient } from "@supabase/supabase-js";
import { exchangePublicToken, getAccounts, isPlaidConfigured, PlaidError } from "../../../_lib/plaid/client.js";
import { encryptToken } from "../../../_lib/plaid/encryption.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_VALUES = ["checking","savings","credit_card","line_of_credit","other"];

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
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.public_token || typeof body.public_token !== "string") {
    return { error: "public_token is required" };
  }
  if (body.public_token.length > 200) {
    return { error: "public_token is implausibly long" };
  }
  if (!body.gl_account_id || !UUID_RE.test(String(body.gl_account_id))) {
    return { error: "gl_account_id (uuid) is required" };
  }
  const out = {
    public_token: body.public_token,
    gl_account_id: String(body.gl_account_id),
    name: null,
    account_kind: "checking",
    created_by_user_id: null,
  };
  if (body.name != null && body.name !== "") {
    const n = String(body.name).trim();
    if (n.length > 120) return { error: "name must be <= 120 chars" };
    if (n.length > 0) out.name = n;
  }
  if (body.account_kind != null && body.account_kind !== "") {
    if (!KIND_VALUES.includes(body.account_kind)) {
      return { error: `account_kind must be one of ${KIND_VALUES.join(", ")}` };
    }
    out.account_kind = body.account_kind;
  }
  if (body.created_by_user_id != null && body.created_by_user_id !== "") {
    if (!UUID_RE.test(String(body.created_by_user_id))) {
      return { error: "created_by_user_id must be a UUID" };
    }
    out.created_by_user_id = String(body.created_by_user_id);
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
    return res.status(503).json({ error: "Plaid integration not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // Verify the GL account exists, is an asset, and belongs to this entity.
  const { data: glAccount, error: glErr } = await admin
    .from("gl_accounts")
    .select("id, code, name, account_type, entity_id")
    .eq("id", v.data.gl_account_id)
    .maybeSingle();
  if (glErr) return res.status(500).json({ error: glErr.message });
  if (!glAccount) return res.status(404).json({ error: "gl_account_id not found" });
  if (glAccount.entity_id !== entity.id) {
    return res.status(403).json({ error: "GL account belongs to a different entity" });
  }
  if (!["asset","contra_asset","liability"].includes(glAccount.account_type)) {
    return res.status(400).json({
      error: `GL account ${glAccount.code} (${glAccount.account_type}) is not a valid cash/CC account — expected asset/contra_asset (for bank/checking/savings) or liability (for credit card)`,
    });
  }

  let exchange, accounts;
  try {
    exchange = await exchangePublicToken(v.data.public_token);
    accounts = await getAccounts(exchange.access_token);
  } catch (e) {
    if (e instanceof PlaidError) {
      return res.status(e.status || 502).json({ error: e.message, code: e.code, request_id: e.request_id });
    }
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }

  const ciphertext = encryptToken(exchange.access_token);
  const linkedAccounts = [];

  for (const acct of (accounts.accounts || [])) {
    // Convention: one bank_accounts row per Plaid sub-account. Operator's
    // primary Item account links to the chosen gl_account_id; secondary
    // sub-accounts get the SAME gl_account_id by default (operator can
    // re-point each via the Bank Accounts panel post-link).
    const displayName = v.data.name
      || `${accounts.item?.institution_id || "Bank"} ${acct.name || acct.official_name || ""} ${acct.mask ? `••${acct.mask}` : ""}`.trim();

    const { data: existing } = await admin
      .from("bank_accounts")
      .select("id")
      .eq("plaid_account_id", acct.account_id)
      .maybeSingle();

    if (existing) {
      // Re-link path: refresh the ciphertext + cursor + last_synced_at.
      const { error: upErr } = await admin
        .from("bank_accounts")
        .update({
          plaid_item_id: exchange.item_id,
          plaid_access_token_ciphertext: ciphertext,
          plaid_cursor: null,                    // force re-sync next cron
          last_synced_at: null,
          institution_name: acct.official_name || null,
          mask: acct.mask || null,
          feed_source: "plaid",
        })
        .eq("id", existing.id);
      if (upErr) return res.status(500).json({ error: `bank_accounts update failed: ${upErr.message}` });
      linkedAccounts.push({ bank_account_id: existing.id, plaid_account_id: acct.account_id, action: "relinked" });
      continue;
    }

    const { data: inserted, error: insErr } = await admin
      .from("bank_accounts")
      .insert({
        entity_id: entity.id,
        gl_account_id: v.data.gl_account_id,
        name: displayName,
        account_kind: v.data.account_kind,
        institution_name: acct.official_name || null,
        mask: acct.mask || null,
        plaid_item_id: exchange.item_id,
        plaid_account_id: acct.account_id,
        plaid_access_token_ciphertext: ciphertext,
        feed_source: "plaid",
        current_balance_cents:
          acct.balances?.current != null
            ? Math.round(Number(acct.balances.current) * 100)
            : null,
        created_by_user_id: v.data.created_by_user_id,
      })
      .select("id")
      .maybeSingle();
    if (insErr) return res.status(500).json({ error: `bank_accounts insert failed: ${insErr.message}` });
    linkedAccounts.push({ bank_account_id: inserted?.id, plaid_account_id: acct.account_id, action: "linked" });
  }

  return res.status(200).json({
    item_id: exchange.item_id,
    institution_id: accounts.item?.institution_id || null,
    accounts: linkedAccounts,
  });
}
