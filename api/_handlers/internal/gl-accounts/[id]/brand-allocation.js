// api/internal/gl-accounts/:id/brand-allocation
//
// M50 GL Brand Allocation — Chunk B (server). Read/save an account's brand
// allocation rule + (re)generate its brand-child accounts.
//
// GET  → { account, allocations:[{brand_id,pct,is_default}], children:[…] }
// PUT  body { allocations:[{brand_id,pct,is_default?}] }
//        • validate (≥1 brand, pct 0–100, SUM=100±0.01, ≤1 default, unique)
//        • replace brand_account_allocations for the account
//        • >1 brand  → brand_rollup=true + upsert brand-child accounts
//                      ({code}-{BRAND} / "{name} — {Brand}"); deactivate removed
//        • 1 brand   → set the account's own brand_id, brand_rollup=false
//        • the actual posting SPLIT happens in chunk C; this just defines the rule.
//
// Service-role (the rule table is anon-read-only). Account type is gated to P&L
// by the UI; this endpoint is permissive on type.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === "string" && UUID_RE.test(s);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return null;
  return createClient(SB_URL, KEY, { auth: { persistSession: false } });
}

// ── pure helpers (exported for tests) ────────────────────────────────────────

export function validateAllocations(body) {
  const arr = body && body.allocations;
  if (!Array.isArray(arr) || arr.length === 0) return { error: "allocations must be a non-empty array" };
  const seen = new Set();
  let sum = 0, defaults = 0;
  for (const a of arr) {
    if (!isUuid(a.brand_id)) return { error: "each allocation needs a uuid brand_id" };
    if (seen.has(a.brand_id)) return { error: `duplicate brand_id ${a.brand_id}` };
    seen.add(a.brand_id);
    const pct = Number(a.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { error: "pct must be 0–100" };
    sum += pct;
    if (a.is_default) defaults++;
  }
  if (Math.abs(sum - 100) > 0.01) return { error: `allocations must total 100% (got ${sum})` };
  if (defaults > 1) return { error: "at most one default brand" };
  return { data: arr.map((a) => ({ brand_id: a.brand_id, pct: Number(a.pct), is_default: !!a.is_default })) };
}

/** Build the brand-child gl_accounts rows for a parent + selected brands. */
export function childAccountRows(parent, brandsById, allocations) {
  return allocations.map((a) => {
    const b = brandsById[a.brand_id] || {};
    return {
      entity_id: parent.entity_id,
      code: `${parent.code}-${b.code}`,
      name: `${parent.name} — ${b.name}`,
      account_type: parent.account_type,
      account_subtype: parent.account_subtype ?? null,
      normal_balance: parent.normal_balance,
      parent_account_id: parent.id,
      brand_id: a.brand_id,
      is_postable: true,
      is_control: false,
      status: "active",
    };
  });
}

// ── handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id || req.query?.id;
  if (!isUuid(id)) return res.status(400).json({ error: "Invalid account id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: parent, error: pErr } = await admin
    .from("gl_accounts")
    .select("id, entity_id, code, name, account_type, account_subtype, normal_balance, brand_rollup, brand_id")
    .eq("id", id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!parent) return res.status(404).json({ error: "Account not found" });

  if (req.method === "GET") {
    const [{ data: allocs }, { data: children }] = await Promise.all([
      admin.from("brand_account_allocations").select("brand_id, pct, is_default").eq("account_id", id),
      admin.from("gl_accounts").select("id, code, name, brand_id, status").eq("parent_account_id", id),
    ]);
    return res.status(200).json({ account: parent, allocations: allocs || [], children: children || [] });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validateAllocations(body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const allocations = v.data;

    // Resolve the selected brands (codes/names for child generation).
    const brandIds = allocations.map((a) => a.brand_id);
    const { data: brands, error: bErr } = await admin
      .from("brand_master").select("id, code, name").in("id", brandIds);
    if (bErr) return res.status(500).json({ error: bErr.message });
    if ((brands || []).length !== brandIds.length) return res.status(400).json({ error: "Unknown brand_id in allocations" });
    const brandsById = Object.fromEntries(brands.map((b) => [b.id, b]));

    // Replace the allocation rule (delete-all → insert-set; deferred 100% trigger
    // passes the 0-row interim and the 100% final).
    const del = await admin.from("brand_account_allocations").delete().eq("account_id", id);
    if (del.error) return res.status(500).json({ error: del.error.message });
    const ins = await admin.from("brand_account_allocations")
      .insert(allocations.map((a) => ({ account_id: id, ...a })));
    if (ins.error) return res.status(500).json({ error: ins.error.message });

    const multi = allocations.length > 1;
    if (multi) {
      const rows = childAccountRows(parent, brandsById, allocations);
      const up = await admin.from("gl_accounts").upsert(rows, { onConflict: "entity_id,code" });
      if (up.error) return res.status(500).json({ error: `child account upsert failed: ${up.error.message}` });
      // Deactivate children for brands no longer selected (history-safe; no delete).
      await admin.from("gl_accounts").update({ status: "inactive" })
        .eq("parent_account_id", id).not("brand_id", "in", `(${brandIds.join(",")})`);
      await admin.from("gl_accounts").update({ brand_rollup: true, brand_id: null }).eq("id", id);
    } else {
      // Single brand → the account itself is that brand; no children, no rollup.
      await admin.from("gl_accounts").update({ status: "inactive" }).eq("parent_account_id", id);
      await admin.from("gl_accounts").update({ brand_rollup: false, brand_id: allocations[0].brand_id }).eq("id", id);
    }

    const { data: out } = await admin.from("brand_account_allocations").select("brand_id, pct, is_default").eq("account_id", id);
    return res.status(200).json({ account_id: id, allocations: out || [], brand_rollup: multi });
  }

  res.setHeader("Allow", "GET, PUT");
  return res.status(405).json({ error: "Method not allowed" });
}
