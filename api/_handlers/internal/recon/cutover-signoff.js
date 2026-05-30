// api/internal/recon/cutover-signoff
//
// Tangerine P9-9 — Operator-confirmed cutover signoff.
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.4 D8 +
// §6.9 cutover flow.
//
//   POST /api/internal/recon/cutover-signoff
//     body: {
//       domain: 'ap' | 'ar' | 'cash' | 'gl' | 'inventory',
//       source_tag?: string,           // null = whole-domain cutover
//       notes?: string,                // optional operator note (≤500)
//     }
//
// Flow:
//   1. Authenticated via Bearer (Supabase Auth JWT).
//   2. Resolve auth → employees row → entity_users.role. Role must be
//      'admin' or 'accountant'; 403 otherwise.
//   3. Compute eligibility via computeCutoverEligibility — return 409
//      with the reason if not eligible.
//   4. INSERT into recon_cutover_signoffs with the computed
//      clean_window_start/end + total_recons + signoff_employee_id +
//      signoff_at + notes.
//   5. UPDATE entities.parallel_run_status jsonb to mark
//      <domain>.status='solo' + cutover_at=now() — preserve other
//      domains. For channel-level signoff we additionally append the
//      source_tag onto <domain>.source_tags_solo.
//   6. Return the inserted signoff row + the post-update entity status.
//
// 401 / 403 / 400 / 409 / 500.

import { createClient } from "@supabase/supabase-js";
import { authenticateCaller } from "../../../_lib/auth.js";
import {
  computeCutoverEligibility,
  RECON_DOMAINS,
} from "../../../_lib/recon/cutover-eligibility.js";

export const config = { maxDuration: 30 };

const ALLOWED_ROLES = new Set(["admin", "accountant"]);
const MAX_NOTES_LEN = 500;
const MAX_SOURCE_TAG_LEN = 64;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Entity-ID, X-Request-Id",
  );
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Body validator. Exported for unit tests.
 *
 * Returns { data: { domain, source_tag, notes } } on success or
 * { error } on validation failure.
 */
export function validateSignoffBody(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
  if (!domain) {
    return { error: "domain is required" };
  }
  if (!RECON_DOMAINS.includes(domain)) {
    return {
      error: `domain must be one of: ${RECON_DOMAINS.join(", ")} (got "${domain}")`,
    };
  }

  let source_tag = null;
  if (body.source_tag != null && body.source_tag !== "") {
    if (typeof body.source_tag !== "string") {
      return { error: "source_tag must be a string when provided" };
    }
    const v = body.source_tag.trim();
    if (v.length === 0) {
      // operator sent whitespace-only — treat as null (whole-domain).
      source_tag = null;
    } else if (v.length > MAX_SOURCE_TAG_LEN) {
      return {
        error: `source_tag must be <= ${MAX_SOURCE_TAG_LEN} chars (got ${v.length})`,
      };
    } else {
      source_tag = v;
    }
  }

  let notes = null;
  if (body.notes != null) {
    if (typeof body.notes !== "string") {
      return { error: "notes must be a string when provided" };
    }
    const v = body.notes.trim();
    if (v.length > MAX_NOTES_LEN) {
      return {
        error: `notes must be <= ${MAX_NOTES_LEN} chars (got ${v.length})`,
      };
    }
    notes = v.length > 0 ? v : null;
  }

  return { data: { domain, source_tag, notes } };
}

/**
 * Resolve the calling auth user to { auth_id, employee_id, role,
 * entity_id }. Returns { ok:false, status, error } when no employee /
 * no role match is found.
 *
 * Exported for unit tests so the resolver can be exercised standalone.
 */
export async function resolveActorContext(admin, authId) {
  // 1. employees → employee_id.
  let employee = null;
  try {
    const { data, error } = await admin
      .from("employees")
      .select("id, full_name, first_name, last_name, email")
      .eq("auth_user_id", authId)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        status: 500,
        error: `employees lookup failed: ${error.message}`,
      };
    }
    employee = data || null;
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `employees lookup threw: ${err?.message || String(err)}`,
    };
  }

  // 2. entity_users → role. We look up roles for this auth id and
  //    require at least one row to be admin/accountant. The cutover
  //    handler is entity-scoped via the ROF default entity, so for v1
  //    we accept any entity_users row carrying an allowed role.
  let entityUsers;
  try {
    const { data, error } = await admin
      .from("entity_users")
      .select("entity_id, role")
      .eq("auth_id", authId);
    if (error) {
      return {
        ok: false,
        status: 500,
        error: `entity_users lookup failed: ${error.message}`,
      };
    }
    entityUsers = data || [];
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `entity_users lookup threw: ${err?.message || String(err)}`,
    };
  }

  const allowed = entityUsers.find((eu) => ALLOWED_ROLES.has(eu.role));
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      error: "Cutover signoff requires admin or accountant role",
    };
  }

  return {
    ok: true,
    status: 200,
    auth_id: authId,
    employee_id: employee?.id || null,
    role: allowed.role,
    entity_id: allowed.entity_id,
  };
}

/**
 * Resolve the default entity (ROF) for the signoff. Exported for tests.
 */
export async function resolveSignoffEntity(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id, code, parallel_run_status")
    .eq("code", "ROF")
    .maybeSingle();
  if (error) {
    return { error: `entities lookup failed: ${error.message}` };
  }
  if (!data) {
    return { error: "Default entity (ROF) not found" };
  }
  return { entity: data };
}

/**
 * Pure helper: merge cutover signoff state into entities.parallel_run_status
 * jsonb. Preserves other domains; flips <domain>.status to 'solo' and
 * stamps cutover_at. For source_tag != null appends the channel onto
 * <domain>.source_tags_solo (dedup).
 *
 * Exported for unit tests.
 */
export function mergeParallelRunStatus(current, { domain, source_tag, cutover_at }) {
  const safe = current && typeof current === "object" ? current : {};
  const existing = safe[domain] && typeof safe[domain] === "object" ? safe[domain] : {};
  let source_tags_solo = Array.isArray(existing.source_tags_solo)
    ? [...existing.source_tags_solo]
    : [];

  if (source_tag) {
    if (!source_tags_solo.includes(source_tag)) {
      source_tags_solo.push(source_tag);
    }
  }

  const next = {
    ...existing,
    status: "solo",
    cutover_at,
  };
  if (source_tag || source_tags_solo.length > 0) {
    next.source_tags_solo = source_tags_solo;
  }
  return {
    ...safe,
    [domain]: next,
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. Auth gate — Bearer JWT (Supabase Auth).
  const auth = await authenticateCaller(req, admin);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // 2. Body parse + validate.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  }
  const v = validateSignoffBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const { domain, source_tag, notes } = v.data;

  // 3. Resolve actor (employees + entity_users role).
  const actor = await resolveActorContext(admin, auth.authId);
  if (!actor.ok) {
    return res.status(actor.status).json({ error: actor.error });
  }

  // 4. Resolve target entity (ROF). The cutover scope follows the
  // entity the operator's signoff role belongs to, but for v1 we use
  // the default ROF entity which matches every other recon handler.
  const er = await resolveSignoffEntity(admin);
  if (er.error) return res.status(500).json({ error: er.error });
  const entity = er.entity;

  // 5. Compute eligibility — 409 with the reason if not eligible.
  let verdict;
  try {
    verdict = await computeCutoverEligibility({
      adminClient: admin,
      entity_id: entity.id,
      domain,
      source_tag,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: `eligibility check threw: ${err?.message || String(err)}` });
  }
  if (!verdict.eligible) {
    return res.status(409).json({
      error: "Cutover not eligible",
      reason: verdict.reason,
      verdict,
    });
  }

  // 6. Insert recon_cutover_signoffs.
  let signoff;
  try {
    const { data, error } = await admin
      .from("recon_cutover_signoffs")
      .insert({
        entity_id: entity.id,
        domain,
        source_tag,
        clean_window_start: verdict.clean_window_start,
        clean_window_end: verdict.clean_window_end,
        total_recons: verdict.clean_runs_count,
        signoff_employee_id: actor.employee_id,
        notes,
      })
      .select(
        "id, entity_id, domain, source_tag, clean_window_start, " +
          "clean_window_end, total_recons, signoff_employee_id, " +
          "signoff_at, notes",
      )
      .maybeSingle();
    if (error) {
      // 23505 = unique_violation (already signed off for this
      // (entity, domain, source_tag) triple).
      const code = String(error.code || "").trim();
      const msg = String(error.message || "");
      if (code === "23505" || /duplicate key|unique/i.test(msg)) {
        return res.status(409).json({
          error: "Cutover already signed off for this (entity, domain, source_tag)",
          detail: error.message,
        });
      }
      return res.status(500).json({ error: error.message });
    }
    signoff = data;
  } catch (err) {
    return res
      .status(500)
      .json({ error: `signoff insert threw: ${err?.message || String(err)}` });
  }

  // 7. Update entities.parallel_run_status[domain] → solo. Preserve
  //    every other domain by reading-merging-writing the jsonb. Best
  //    effort: failure here doesn't roll back the signoff (the signoff
  //    is the authoritative audit row) but surfaces in the response.
  const cutover_at = signoff?.signoff_at || new Date().toISOString();
  let next_parallel_run_status = entity.parallel_run_status || {};
  let parallelStatusError = null;
  try {
    next_parallel_run_status = mergeParallelRunStatus(
      entity.parallel_run_status,
      { domain, source_tag, cutover_at },
    );
    const { error } = await admin
      .from("entities")
      .update({ parallel_run_status: next_parallel_run_status })
      .eq("id", entity.id);
    if (error) parallelStatusError = error.message;
  } catch (err) {
    parallelStatusError = err?.message || String(err);
  }

  return res.status(200).json({
    ok: true,
    signoff,
    parallel_run_status: next_parallel_run_status,
    parallel_run_status_error: parallelStatusError,
    actor: {
      auth_id: actor.auth_id,
      employee_id: actor.employee_id,
      role: actor.role,
    },
  });
}
