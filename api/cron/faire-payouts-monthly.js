// api/cron/faire-payouts-monthly
//
// Tangerine P12c-2 — Faire payouts ingest cron.
//
// Faire remits monthly. For each active `faire_shops` row:
//   1. Decrypt the static API key.
//   2. listPayouts with paid_at_min = max(last_payouts_sync_at, now - 60 days).
//   3. For each payout: upsert into faire_payouts by
//      (faire_shop_id, faire_payout_id).
//   4. Update faire_shops.last_payouts_sync_at.
//
// Per-shop try/catch. Schedule (vercel.json): 5 AM UTC on the 1st of each
// month — gives Faire's monthly remittance schedule a day to settle.

import { createClient } from "@supabase/supabase-js";
import { FaireClient, FaireApiError, isFaireConfigured } from "../_lib/marketplaces/faire/client.js";
import { decryptToken } from "../_lib/marketplaces/faire/token-encryption.js";
import { postFairePayoutJe } from "../_lib/marketplaces/faire/post-payout-je.js";

export const config = { maxDuration: 300 };

const LOOKBACK_DAYS = 60;
const PAGE_SIZE = 50;
const SAFETY_PAGE_CAP = 100;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  if (!isFaireConfigured()) {
    return res.status(200).json({ ok: true, skipped: "Faire not configured (FAIRE_TOKEN_ENC_KEY missing)" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let onlyShopId = null;
  let sinceOverride = null;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    onlyShopId = url.searchParams.get("faire_shop_id");
    sinceOverride = url.searchParams.get("since");
  } catch { /* fallback */ }

  try {
    const out = await runFairePayoutsIngest(admin, { onlyShopId, sinceOverride });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Compute paid_at_min = max(last_payouts_sync_at, now - 60 days).
 *
 * Exported for tests.
 */
export function computePaidAtMin(lastSyncAt, sinceOverride, nowMs = Date.now()) {
  if (sinceOverride) return sinceOverride;
  const floor = new Date(nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (!lastSyncAt) return floor.toISOString();
  const lastMs = new Date(lastSyncAt).getTime();
  if (!Number.isFinite(lastMs) || lastMs < floor.getTime()) return floor.toISOString();
  return new Date(lastMs).toISOString();
}

/**
 * @param {Object} supabase
 * @param {Object} [opts]
 * @param {string} [opts.onlyShopId]
 * @param {string} [opts.sinceOverride]
 * @param {Object} [opts.deps]   { makeClient, decryptToken, now }
 */
export async function runFairePayoutsIngest(supabase, opts = {}) {
  const deps = {
    makeClient: (apiKey) => new FaireClient({ apiKey }),
    decryptToken,
    now: () => Date.now(),
    ...(opts.deps || {}),
  };

  let q = supabase
    .from("faire_shops")
    .select("id, entity_id, shop_name, api_key_ciphertext, api_key_iv, api_key_tag, last_payouts_sync_at")
    .eq("is_active", true)
    .not("api_key_ciphertext", "is", null);
  if (opts.onlyShopId) q = q.eq("id", opts.onlyShopId);

  const { data: shops, error: sErr } = await q;
  if (sErr) throw new Error(`faire_shops read failed: ${sErr.message}`);

  const summary = {
    shops_scanned: 0,
    payouts_upserted_total: 0,
    je_posted_total: 0,
    je_skipped_total: 0,
    je_errors: [],
    errors: [],
    per_shop: [],
  };

  for (const shop of shops || []) {
    summary.shops_scanned += 1;
    const shopSummary = {
      faire_shop_id: shop.id,
      shop_name: shop.shop_name,
      payouts_upserted: 0,
      je_posted: 0,
      je_skipped: 0,
      je_errors: [],
      pages_walked: 0,
      cursor_updated: false,
      error: null,
    };
    summary.per_shop.push(shopSummary);

    try {
      await ingestShopPayouts(supabase, shop, opts, deps, shopSummary);
    } catch (e) {
      const msg = e instanceof FaireApiError
        ? `Faire ${e.status}: ${e.message}`
        : (e instanceof Error ? e.message : String(e));
      shopSummary.error = msg;
      summary.errors.push(`faire_shop ${shop.id}: ${msg}`);
    }

    summary.payouts_upserted_total += shopSummary.payouts_upserted;
    summary.je_posted_total        += shopSummary.je_posted;
    summary.je_skipped_total       += shopSummary.je_skipped;
    summary.je_errors              = summary.je_errors.concat(shopSummary.je_errors);
  }

  return summary;
}

async function ingestShopPayouts(supabase, shop, opts, deps, shopSummary) {
  const apiKey = deps.decryptToken(
    shop.api_key_ciphertext,
    shop.api_key_iv,
    shop.api_key_tag,
  );
  const client = deps.makeClient(apiKey);
  const paidAtMin = computePaidAtMin(shop.last_payouts_sync_at, opts.sinceOverride, deps.now());

  let page = 1;
  let safety = 0;
  while (safety < SAFETY_PAGE_CAP) {
    safety += 1;
    shopSummary.pages_walked = safety;
    const { data: payouts, hasNextPage } = await client.listPayouts({
      paidAtMin, limit: PAGE_SIZE, page,
    });
    for (const payout of payouts || []) {
      await upsertPayout(supabase, shop, payout, shopSummary);
    }
    if (!hasNextPage) break;
    page += 1;
  }

  const { error: cErr } = await supabase
    .from("faire_shops")
    .update({
      last_payouts_sync_at: new Date(deps.now()).toISOString(),
      updated_at: new Date(deps.now()).toISOString(),
    })
    .eq("id", shop.id);
  if (cErr) throw new Error(`last_payouts_sync_at update failed: ${cErr.message}`);
  shopSummary.cursor_updated = true;
}

async function upsertPayout(supabase, shop, payout, shopSummary) {
  const grossCents      = toCents(payout.gross_amount ?? payout.gross_cents ?? payout.subtotal ?? 0);
  const commissionCents = toCents(payout.commission_amount ?? payout.commission_cents ?? payout.commission ?? 0);
  const refundsCents    = toCents(payout.refunds_amount ?? payout.refunds_cents ?? payout.refunds ?? 0);
  const apiNet = payout.net_amount ?? payout.net_cents ?? payout.net;
  const netCents = apiNet != null
    ? toCents(apiNet)
    : grossCents - commissionCents - refundsCents;

  const payoutRow = {
    entity_id: shop.entity_id,
    faire_shop_id: shop.id,
    faire_payout_id: String(payout.id || payout.payout_id || payout.faire_payout_id),
    payout_date: dateOnly(payout.paid_at || payout.payout_date || payout.created_at || new Date()),
    period_start: dateOnly(payout.period_start || payout.paid_at || new Date()),
    period_end:   dateOnly(payout.period_end || payout.paid_at || new Date()),
    gross_amount_cents: grossCents,
    commission_amount_cents: commissionCents,
    refunds_amount_cents: refundsCents,
    net_amount_cents: netCents,
    currency: payout.currency || "USD",
    raw_payload: payout,
  };

  const { data: upPayout, error } = await supabase
    .from("faire_payouts")
    .upsert(payoutRow, { onConflict: "faire_shop_id,faire_payout_id" })
    .select("id")
    .maybeSingle();
  if (error || !upPayout) {
    throw new Error(`faire_payouts upsert failed for ${payoutRow.faire_payout_id}: ${error?.message || "no row"}`);
  }
  shopSummary.payouts_upserted += 1;

  // ── P12c-3: Post the bank deposit JE for this payout ────────────────────
  // Idempotent — already_posted short-circuits via faire_payouts.je_id.
  try {
    const out = await postFairePayoutJe({
      fairePayoutId: upPayout.id,
      adminClient: supabase,
    });
    if (out.status === "posted") shopSummary.je_posted += 1;
    else if (out.status === "already_posted") shopSummary.je_skipped += 1;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    shopSummary.je_errors.push(`faire_payout ${upPayout.id}: ${msg}`);
  }
}

/**
 * Same cents coercion rule as faire-orders-nightly. Exported for tests.
 */
export function toCents(value) {
  if (value == null) return 0;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  if (Math.floor(num) !== num) return Math.round(num * 100);
  return Math.round(num);
}

function dateOnly(input) {
  if (!input) return new Date().toISOString().slice(0, 10);
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}
