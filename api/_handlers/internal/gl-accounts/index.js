// api/internal/gl-accounts
//
// GET  — list COA. Default returns active only; ?include_inactive=true for all.
//        Query: ?q=<search> matches code/name; ?account_type=...; ?parent_account_id=<uuid>
// POST — create one account. Auto-derives normal_balance from account_type if omitted.
//
// Tangerine P1 Chunk 8a. Mirrors style-master / vendor-master / customer-master shape.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const TYPE_VALUES   = ["asset", "liability", "equity", "revenue", "expense", "contra_asset", "contra_revenue"];
const STATUS_VALUES = ["active", "inactive"];
const BALANCE_VALUES = ["DEBIT", "CREDIT"];

const TYPE_TO_NORMAL = {
  asset:         "DEBIT",
  expense:       "DEBIT",
  contra_revenue: "DEBIT",  // increases reduce revenue → debit-normal
  liability:     "CREDIT",
  equity:        "CREDIT",
  revenue:       "CREDIT",
  contra_asset:  "CREDIT",  // increases reduce asset → credit-normal
};

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
    const includeInactive  = url.searchParams.get("include_inactive") === "true";
    const q                = (url.searchParams.get("q") || "").trim();
    const accountType      = (url.searchParams.get("account_type") || "").trim();
    const parentAccountId  = (url.searchParams.get("parent_account_id") || "").trim();

    let query = admin
      .from("gl_accounts")
      .select("*")
      .eq("entity_id", entityId)
      .order("code", { ascending: true });

    if (!includeInactive)   query = query.eq("status", "active");
    if (q)                  query = query.or(`code.ilike.%${q}%,name.ilike.%${q}%`);
    if (accountType)        query = query.eq("account_type", accountType);
    if (parentAccountId)    query = query.eq("parent_account_id", parentAccountId);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    const rows = data || [];

    // Merge real-money balances from vw_gl_account_balances (ACCRUAL-basis,
    // sign-flipped to be positive on each account's normal side). Single
    // additional round-trip keyed by entity_id — never N+1 per row. Failure
    // here is non-fatal: COA list still renders without balances if the view
    // is unavailable (e.g. fresh DB before the 20260630 migration applies).
    if (rows.length > 0) {
      const { data: balRows, error: balErr } = await admin
        .from("vw_gl_account_balances")
        .select("account_id, balance_signed_cents")
        .eq("entity_id", entityId);
      if (!balErr && Array.isArray(balRows)) {
        const byId = new Map(balRows.map((b) => [b.account_id, Number(b.balance_signed_cents) || 0]));
        for (const r of rows) {
          r.balance_signed_cents = byId.get(r.id) ?? 0;
        }
      } else {
        for (const r of rows) {
          r.balance_signed_cents = 0;
        }
      }
    }

    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Validate parent_account_id (if provided) exists in this entity.
    if (v.data.parent_account_id) {
      const { data: parent, error: parentErr } = await admin
        .from("gl_accounts")
        .select("id, entity_id")
        .eq("id", v.data.parent_account_id)
        .maybeSingle();
      if (parentErr) return res.status(500).json({ error: parentErr.message });
      if (!parent || parent.entity_id !== entityId) {
        return res.status(400).json({ error: "parent_account_id not found in this entity" });
      }
    }

    const { data, error } = await admin
      .from("gl_accounts")
      .insert({ ...v.data, entity_id: entityId })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `Account code '${v.data.code}' already exists for this entity` });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (!body.code || !String(body.code).trim()) {
    return { error: "code is required" };
  }
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }
  if (!body.account_type || !TYPE_VALUES.includes(body.account_type)) {
    return { error: `account_type must be one of ${TYPE_VALUES.join(", ")}` };
  }
  if (body.normal_balance != null && !BALANCE_VALUES.includes(body.normal_balance)) {
    return { error: `normal_balance must be one of ${BALANCE_VALUES.join(", ")}` };
  }
  if (body.status != null && !STATUS_VALUES.includes(body.status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }

  const code = String(body.code).trim().toUpperCase();
  const normalBalance = body.normal_balance || TYPE_TO_NORMAL[body.account_type];

  return {
    data: {
      code,
      name:               String(body.name).trim(),
      account_type:       body.account_type,
      account_subtype:    body.account_subtype ? String(body.account_subtype).trim() : null,
      parent_account_id:  body.parent_account_id || null,
      normal_balance:     normalBalance,
      is_postable:        body.is_postable !== false,
      is_control:         body.is_control === true,
      status:             body.status || "active",
      description:        body.description ? String(body.description).trim() : null,
    },
  };
}
