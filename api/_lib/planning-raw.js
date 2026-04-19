// api/_lib/planning-raw.js
//
// Writer for raw_xoro_payloads / raw_shopify_payloads. Every planning
// ingest route stores the untouched upstream response before normalization
// so we can replay without re-hitting Xoro / Shopify.
//
// Idempotency: pass a stable `source_hash`; the DB's unique partial index
// skips duplicate inserts (we surface the pre-existing id).

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export function hashPayload(endpoint, params, body) {
  const payload = JSON.stringify({ endpoint, params, body });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function insertRawXoro(admin, { endpoint, params, payload, periodStart, periodEnd, recordCount, ingestedBy }) {
  const source_hash = hashPayload(endpoint, params, payload);
  const existing = await admin
    .from("raw_xoro_payloads")
    .select("id")
    .eq("source_hash", source_hash)
    .maybeSingle();
  if (existing.data?.id) return { id: existing.data.id, deduped: true, source_hash };

  const { data, error } = await admin
    .from("raw_xoro_payloads")
    .insert({
      endpoint,
      period_start: periodStart ?? null,
      period_end: periodEnd ?? null,
      source_hash,
      payload,
      record_count: recordCount ?? null,
      ingested_by: ingestedBy ?? null,
    })
    .select("id")
    .single();
  if (error) return { error: error.message, source_hash };
  return { id: data.id, deduped: false, source_hash };
}

export async function insertRawShopify(admin, { endpoint, storefrontCode, params, payload, periodStart, periodEnd, recordCount, ingestedBy }) {
  const source_hash = hashPayload(endpoint, { ...params, storefrontCode }, payload);
  const existing = await admin
    .from("raw_shopify_payloads")
    .select("id")
    .eq("source_hash", source_hash)
    .maybeSingle();
  if (existing.data?.id) return { id: existing.data.id, deduped: true, source_hash };

  const { data, error } = await admin
    .from("raw_shopify_payloads")
    .insert({
      endpoint,
      storefront_code: storefrontCode ?? null,
      period_start: periodStart ?? null,
      period_end: periodEnd ?? null,
      source_hash,
      payload,
      record_count: recordCount ?? null,
      ingested_by: ingestedBy ?? null,
    })
    .select("id")
    .single();
  if (error) return { error: error.message, source_hash };
  return { id: data.id, deduped: false, source_hash };
}

export function supabaseAdminFromEnv() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}
