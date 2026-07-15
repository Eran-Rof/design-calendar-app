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
import { applyBrandScope, activeBrandId, collapseAgingByBucket } from "../../../_lib/brandContext.js";

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

// Open AR per control account (1105 CC / 1107 factor / 1108 house / …) — drives
// the panel's account selector + the House/Factored/CC summary strip. Always
// the FULL split, independent of the row-level filters, so the CEO sees the
// whole picture regardless of what's selected.
async function loadAccountSummary(admin, entityId) {
  const { data, error } = await admin
    .from("v_ar_open_by_account")
    .select("ar_account_id, ar_account_code, ar_account_name, open_count, open_cents")
    .eq("entity_id", entityId);
  if (error) return { accounts: [], error };
  const accounts = (data || [])
    .map((r) => ({
      ar_account_id: r.ar_account_id,
      code: r.ar_account_code,
      name: r.ar_account_name,
      open_count: Number(r.open_count || 0),
      open_cents: Number(r.open_cents || 0),
    }))
    .sort((a, b) => b.open_cents - a.open_cents);
  return { accounts };
}

// Shopify D2C is a known AR-overstatement artifact: ecom orders backfilled from
// sales history as open AR invoices whose card payment was never applied
// (no per-invoice receipt record exists to auto-clear — see the backfill script).
// They're deterministically the "Shopify …" pseudo-customers; surface the
// magnitude + ids so the panel can flag rows and offer an exclude toggle.
async function loadShopifyD2C(admin, entityId) {
  const { data: custs, error: cErr } = await admin
    .from("customers")
    .select("id, name, code")
    .ilike("name", "Shopify %");
  if (cErr) return { customer_ids: [], open_cents: 0, open_count: 0 };
  const ids = (custs || []).map((c) => c.id);
  if (ids.length === 0) return { customer_ids: [], open_cents: 0, open_count: 0 };
  // Sum open across those customers via the summary already exposed per bucket.
  // (Small set — page-safe: two customers, a few thousand invoices aggregated.)
  const { data: rows, error: rErr } = await admin
    .from("v_ar_aging")
    .select("customer_id, outstanding_cents, invoice_count")
    .eq("entity_id", entityId)
    .in("customer_id", ids);
  if (rErr) return { customer_ids: ids, open_cents: 0, open_count: 0 };
  let openCents = 0;
  let openCount = 0;
  for (const r of rows || []) {
    openCents += Number(r.outstanding_cents || 0);
    openCount += Number(r.invoice_count || 0);
  }
  return { customer_ids: ids, open_cents: openCents, open_count: openCount };
}

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

export function parseListQuery(params) {
  const out = { mode: "current", customer_id: null, ar_account_id: null, limit: 500 };

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

  // AR control-account filter — a gl_accounts UUID (1105 CC / 1107 factor /
  // 1108 house / any AR account). Absent or "all" = every account.
  const arAccount = (params.get("ar_account") || "").trim();
  if (arAccount && arAccount !== "all") {
    if (!isUuid(arAccount)) {
      return { error: "ar_account must be a UUID or 'all'" };
    }
    out.ar_account_id = arAccount;
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
      // P15 C3b — brand filtered server-side via p_brand_id (null = all brands).
      // AR-account split via p_ar_account_id (null = all AR control accounts).
      const { data, error } = await admin.rpc("ar_aging_as_of", {
        p_entity_id: entityId,
        p_as_of_date: v.data.as_of,
        p_brand_id: activeBrandId(req),
        p_ar_account_id: v.data.ar_account_id,
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
      if (v.data.ar_account_id) q = q.eq("ar_account_id", v.data.ar_account_id);
      // P15 C3b — gated brand filter; then collapse the brand-split view rows
      // back to one row per (customer, bucket) (no-op shape change for "All").
      q = applyBrandScope(q, req);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      rows = collapseAgingByBucket(data || [], "customer_id");

      // The view carries only customer_id — resolve name/code so the panel
      // (and the Phase 2 bucket drill) can label rows. Chunked .in() lookups.
      const custIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
      const custById = new Map();
      for (let i = 0; i < custIds.length; i += 200) {
        const { data: custs, error: custErr } = await admin
          .from("customers")
          .select("id, name, code")
          .in("id", custIds.slice(i, i + 200));
        if (custErr) return res.status(500).json({ error: custErr.message });
        for (const c of custs || []) custById.set(c.id, c);
      }
      for (const r of rows) {
        const c = custById.get(r.customer_id);
        r.customer_name = c?.name || null;
        r.customer_code = c?.code || null;
      }
    }

    // Sort by open exposure DESC and apply the limit per CUSTOMER (view mode
    // returns one row per customer × bucket — slicing raw rows would silently
    // drop buckets and the panel cells would no longer tie to the drill).
    if (v.data.mode === "as_of") {
      rows.sort((a, b) => Number(b.total_outstanding_cents || 0) - Number(a.total_outstanding_cents || 0));
      rows = rows.slice(0, v.data.limit);
    } else {
      const totals = new Map();
      for (const r of rows) {
        totals.set(r.customer_id, (totals.get(r.customer_id) || 0) + Number(r.outstanding_cents || 0));
      }
      const keep = new Set(
        [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, v.data.limit).map(([id]) => id),
      );
      rows = rows.filter((r) => keep.has(r.customer_id));
      rows.sort((a, b) => (totals.get(b.customer_id) || 0) - (totals.get(a.customer_id) || 0));
    }

    const { accounts } = await loadAccountSummary(admin, entityId);
    const shopify = await loadShopifyD2C(admin, entityId);

    return res.status(200).json({
      mode: v.data.mode,
      as_of: v.data.as_of || null,
      ar_account_id: v.data.ar_account_id,
      accounts,
      shopify_d2c: shopify,
      rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
