// api/internal/recon/run-inventory
//
// Tangerine P9-6 — Manual trigger for the Inventory reconciliation engine.
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.5 + §4.4.
//
// POST /api/internal/recon/run-inventory
//   body: {
//     period_start: 'YYYY-MM-DD',     // inclusive
//     period_end:   'YYYY-MM-DD',     // inclusive
//     cadence?:     'weekly' | 'manual' | 'replay'  (default 'manual')
//     replay_of_id?: <uuid>                          (D11)
//   }
//
// Looks up the default entity (ROF), invokes runInventoryReconciliation,
// and returns the engine summary verbatim (recon_run_id + status + totals).
//
// Wired into:
//   - Wave-B weekly cron (/api/cron/recon-inventory-weekly, P9-6b)
//   - Wave-C "🔁 Parallel Run" admin panel "Re-run Inventory" button (P9-3)
//   - D11 replay action from the variance dashboard
//
// Auth: standard authenticateInternalCaller gate (Bearer / X-Internal-Token,
// soft-open until INTERNAL_API_TOKEN is set in Vercel).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { runInventoryReconciliation } from "../../../_lib/recon/inventory-engine.js";

export const config = { maxDuration: 300 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CADENCES = new Set(["weekly", "manual", "replay"]);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Internal-Token, X-Entity-ID",
  );
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntity(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * Parse + validate body. Exported for unit tests.
 */
export function validateBody(body) {
  const b = body && typeof body === "object" ? body : {};
  if (!b.period_start || typeof b.period_start !== "string" || !ISO_DATE_RE.test(b.period_start)) {
    return { error: "period_start must be YYYY-MM-DD" };
  }
  if (!b.period_end || typeof b.period_end !== "string" || !ISO_DATE_RE.test(b.period_end)) {
    return { error: "period_end must be YYYY-MM-DD" };
  }
  if (b.period_end < b.period_start) {
    return { error: "period_end must be >= period_start" };
  }
  let cadence = b.cadence == null ? "manual" : b.cadence;
  if (typeof cadence !== "string" || !VALID_CADENCES.has(cadence)) {
    return { error: `cadence must be one of ${[...VALID_CADENCES].join(",")}` };
  }
  let replay_of_id = null;
  if (b.replay_of_id != null) {
    if (typeof b.replay_of_id !== "string" || !UUID_RE.test(b.replay_of_id)) {
      return { error: "replay_of_id must be a uuid when provided" };
    }
    replay_of_id = b.replay_of_id;
    // When replay_of_id is set, force cadence='replay' so the audit
    // trail is unambiguous.
    cadence = "replay";
  }
  return {
    data: {
      period_start: b.period_start,
      period_end: b.period_end,
      cadence,
      replay_of_id,
    },
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Auth gate.
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // 2. Body parse + validate.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  // 3. Build admin client.
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 4. Resolve default entity (ROF).
  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // 5. Run.
  let summary;
  try {
    summary = await runInventoryReconciliation({
      admin,
      entity_id: entity.id,
      period_start: v.data.period_start,
      period_end: v.data.period_end,
      cadence: v.data.cadence,
      replay_of_id: v.data.replay_of_id,
    });
  } catch (err) {
    return res.status(500).json({
      error: `runInventoryReconciliation threw: ${err?.message || String(err)}`,
    });
  }

  return res.status(200).json({
    ok: true,
    domain: "inventory",
    entity_id: entity.id,
    ...summary,
  });
}
