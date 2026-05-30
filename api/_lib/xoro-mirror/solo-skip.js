// api/_lib/xoro-mirror/solo-skip.js
//
// Tangerine P9-9 — Solo-mode skip helper for the T10 shadow-mirror.
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §6.9.
//
// Once a domain has been operator-signed-off (recon_cutover_signoffs +
// entities.parallel_run_status[domain].status='solo'), Tangerine is the
// authoritative system for that domain and the T10 nightly mirror
// MUST stop copying Xoro rows into Tangerine — otherwise the mirror
// would overwrite Tangerine-direct rows with stale Xoro data.
//
// This helper reads entities.parallel_run_status[domain] and returns
// true when the entity has cut over to solo mode.
//
// Defensive: any DB error returns false (don't skip on error — better
// to mirror with audit noise than silently stop mirroring when the DB
// is unreachable).

/**
 * Returns true iff entities.parallel_run_status[domain].status === 'solo'
 * for the given entity. Returns false on any error or unrecognized shape
 * so the mirror keeps running rather than silently skipping.
 *
 * Pure async — takes a configured admin client. No env reads.
 */
export async function isDomainSolo(adminClient, entity_id, domain) {
  if (!adminClient || typeof adminClient.from !== "function") return false;
  if (!entity_id || typeof entity_id !== "string") return false;
  if (!domain || typeof domain !== "string") return false;

  try {
    const { data, error } = await adminClient
      .from("entities")
      .select("parallel_run_status")
      .eq("id", entity_id)
      .maybeSingle();
    if (error || !data) return false;
    const blob = data.parallel_run_status;
    if (!blob || typeof blob !== "object") return false;
    const entry = blob[domain];
    if (!entry || typeof entry !== "object") return false;
    return entry.status === "solo";
  } catch {
    return false;
  }
}

/**
 * Compose the well-known summary shape returned from a mirror module
 * when it skips due to solo cutover. Centralized so every mirror module
 * (and tests) speak the same shape.
 */
export function makeSoloSkippedSummary(domain) {
  return {
    rows_upserted: 0,
    rows_unchanged: 0,
    rows_skipped_manual_conflict: 0,
    rows_skipped_solo: 0,
    skipped_solo: true,
    solo_domain: domain,
    errors: [],
  };
}
