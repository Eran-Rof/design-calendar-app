// api/internal/entities/:id/coa-copy-from-rof
//
// Tangerine P10-6 — Per-entity COA "Copy from ROF" wizard.
// Per docs/tangerine/P10-tenancy-architecture.md §6 D7.
//
// POST — Bootstraps a new entity's chart of accounts by copying every active
// gl_accounts row from the ROF entity (rof_entity_id()) into the target
// entity's namespace, preserving (code, name, account_type, account_subtype,
// normal_balance, is_postable, is_control, status, description).
//
// Re-runs are safe: ON CONFLICT (entity_id, code) DO NOTHING — already-copied
// codes are skipped, only new codes are inserted. Response reports inserted vs
// skipped counts so the UI can show progress.
//
// Notes
//   - parent_account_id is intentionally NULL on the copies. The schema points
//     to ROF gl_accounts(id) which would not exist in the target entity. The
//     operator can re-parent rows after the initial seed.
//   - The target entity must NOT be ROF itself (a self-copy is a no-op anyway
//     but we reject 400 to make the intent explicit).
//   - Handler is idempotent — second POST against the same entity returns
//     { inserted: 0, skipped: <N> }.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function getEntityId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("entities");
  return idx >= 0 ? parts[idx + 1] : null;
}

export function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * Project a source-entity COA row down to the persistable fields for a copy
 * into the target entity. Exposed for unit tests.
 */
export function projectRowForCopy(srcRow, targetEntityId) {
  return {
    entity_id: targetEntityId,
    code: srcRow.code,
    name: srcRow.name,
    account_type: srcRow.account_type,
    account_subtype: srcRow.account_subtype ?? null,
    normal_balance: srcRow.normal_balance,
    is_postable: srcRow.is_postable === false ? false : true,
    is_control: srcRow.is_control === true,
    status: srcRow.status || "active",
    description: srcRow.description ?? null,
    // parent_account_id intentionally NULL — source IDs do not exist in target.
    parent_account_id: null,
  };
}

export async function resolveRofEntityId(admin) {
  const { data, error } = await admin.rpc("rof_entity_id");
  if (!error && data) return data;
  // Fallback: look up by code.
  const fb = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return fb.data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const targetEntityId = getEntityId(req);
  if (!targetEntityId) return res.status(400).json({ error: "Missing entity id" });
  if (!isUuid(targetEntityId)) return res.status(400).json({ error: "entity id must be a UUID" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Verify target entity exists.
  const { data: target, error: tErr } = await admin
    .from("entities")
    .select("id, code, name")
    .eq("id", targetEntityId)
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!target) return res.status(404).json({ error: "Target entity not found" });

  // Resolve ROF source entity.
  const rofId = await resolveRofEntityId(admin);
  if (!rofId) return res.status(500).json({ error: "ROF source entity not resolvable" });

  if (rofId === targetEntityId) {
    return res.status(400).json({ error: "Target entity is ROF — copy-from-ROF is a no-op" });
  }

  // Read source COA — only active rows are seeded. Inactive accounts the operator
  // archived in ROF would just clutter the new entity.
  const { data: srcRows, error: sErr } = await admin
    .from("gl_accounts")
    .select("code, name, account_type, account_subtype, normal_balance, is_postable, is_control, status, description")
    .eq("entity_id", rofId)
    .eq("status", "active");
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!srcRows || srcRows.length === 0) {
    return res.status(200).json({
      target_entity_id: targetEntityId,
      source_entity_id: rofId,
      source_row_count: 0,
      inserted: 0,
      skipped: 0,
      message: "ROF has no active COA rows to copy",
    });
  }

  // Read existing codes in target so we can short-circuit reporting + avoid an
  // unnecessary upsert burst on full re-runs.
  const { data: existingRows, error: eErr } = await admin
    .from("gl_accounts")
    .select("code")
    .eq("entity_id", targetEntityId);
  if (eErr) return res.status(500).json({ error: eErr.message });
  const existingCodes = new Set((existingRows || []).map((r) => r.code));

  const toInsert = [];
  let skipped = 0;
  for (const row of srcRows) {
    if (existingCodes.has(row.code)) { skipped += 1; continue; }
    toInsert.push(projectRowForCopy(row, targetEntityId));
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    // Use upsert with onConflict for belt-and-suspenders — even if a concurrent
    // POST races in between our SELECT and INSERT, the unique constraint on
    // (entity_id, code) keeps us safe.
    const { data, error } = await admin
      .from("gl_accounts")
      .upsert(toInsert, { onConflict: "entity_id,code", ignoreDuplicates: true })
      .select("id");
    if (error) return res.status(500).json({ error: error.message });
    inserted = (data || []).length;
    // upsert with ignoreDuplicates returns only inserted rows; any difference
    // means a race-conflict bumped some into the skipped bucket.
    if (inserted < toInsert.length) skipped += (toInsert.length - inserted);
  }

  return res.status(200).json({
    target_entity_id: targetEntityId,
    source_entity_id: rofId,
    source_row_count: srcRows.length,
    inserted,
    skipped,
    message: inserted === 0
      ? `No new rows inserted (all ${skipped} codes already exist)`
      : `Inserted ${inserted} accounts, skipped ${skipped} existing`,
  });
}
