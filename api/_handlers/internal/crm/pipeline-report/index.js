// api/internal/crm/pipeline-report
//
// GET — aggregate open + closed pipeline by stage.
//   Returns:
//     {
//       stages: [
//         { stage, count, total_value_cents, weighted_value_cents }, ...
//       ],
//       total_count: N,
//       total_value_cents: N,
//       total_weighted_cents: N
//     }
//
// weighted_value_cents = sum( expected_cents × probability_pct / 100 ).
// All 5 stages always present (zero-filled if no rows).
//
// Optional filters (intersect with rows before aggregation):
//   ?owner_user_id=<uuid>
//   ?customer_id=<uuid>
//
// Tangerine P8-2 (arch §4).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGE_VALUES = ["new", "qualified", "proposal", "won", "lost"];

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

async function resolveDefaultEntity(admin) {
  const { data } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  return data || null;
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

  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
  const entityId = entity.id;

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const params = Object.fromEntries(url.searchParams.entries());
  const v = parseQuery(params);
  if (v.error) return res.status(400).json({ error: v.error });

  let query = admin
    .from("crm_opportunities")
    .select("stage, expected_cents, probability_pct")
    .eq("entity_id", entityId);

  if (v.data.owner_user_id) query = query.eq("owner_user_id", v.data.owner_user_id);
  if (v.data.customer_id)   query = query.eq("customer_id", v.data.customer_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const aggregated = aggregateByStage(data || []);
  return res.status(200).json(aggregated);
}

// ────────────────────────────────────────────────────────────────────────
// Pure aggregator + validator — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function parseQuery(params) {
  const owner_user_id = (params.owner_user_id || "").trim();
  const customer_id   = (params.customer_id || "").trim();

  if (owner_user_id && !UUID_RE.test(owner_user_id)) {
    return { error: "owner_user_id must be a uuid" };
  }
  if (customer_id && !UUID_RE.test(customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  return {
    data: {
      owner_user_id: owner_user_id || null,
      customer_id: customer_id || null,
    },
  };
}

/**
 * Bucket rows by stage; compute count + total_value_cents +
 * weighted_value_cents (= sum(expected × prob / 100)).
 *
 * `rows` is a flat array of { stage, expected_cents, probability_pct } from
 * the DB. Probability is integer 0-100; expected_cents is bigint (may be
 * null → treat as 0).
 *
 * All 5 enum stages are present in the output even if no rows for that
 * stage — zero-filled.
 */
export function aggregateByStage(rows) {
  const buckets = {};
  for (const s of STAGE_VALUES) {
    buckets[s] = { stage: s, count: 0, total_value_cents: 0, weighted_value_cents: 0 };
  }

  for (const r of rows || []) {
    const stage = r.stage;
    if (!buckets[stage]) continue;  // defensive — should never happen given CHECK constraint
    const expected = Number(r.expected_cents) || 0;
    const prob = Number(r.probability_pct) || 0;
    buckets[stage].count += 1;
    buckets[stage].total_value_cents += expected;
    buckets[stage].weighted_value_cents += Math.round(expected * prob / 100);
  }

  const stages = STAGE_VALUES.map((s) => buckets[s]);
  const total_count           = stages.reduce((a, b) => a + b.count, 0);
  const total_value_cents     = stages.reduce((a, b) => a + b.total_value_cents, 0);
  const total_weighted_cents  = stages.reduce((a, b) => a + b.weighted_value_cents, 0);

  return { stages, total_count, total_value_cents, total_weighted_cents };
}
