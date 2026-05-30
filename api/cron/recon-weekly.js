// api/cron/recon-weekly
//
// Tangerine P9-8 — Weekly Parallel-Run reconciliation orchestrator.
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.1 D1
// (operator-confirmed weekly cadence) + §3.6 (notifications) + §6
// (parallel_run_status update path).
//
// Schedule: Monday 06:00 UTC. For each entity, computes the prior
// Mon-Sun week (period_start = last_monday - 7d, period_end =
// last_monday - 1d) and invokes the 5 reconciliation engines
// sequentially:
//
//   1. AP        (api/_lib/recon/ap-engine.js  →  runApReconciliation)
//   2. AR        (api/_lib/recon/ar-engine.js  →  runArReconciliation)
//   3. Cash      (api/_lib/recon/cash-engine.js →  runCashReconciliation)
//   4. Inventory (api/_lib/recon/inventory-engine.js → runInventoryReconciliation)
//   5. GL        (api/_lib/recon/gl-engine.js  →  runGlReconciliation)
//
// GL is LAST so its lagging-indicator missing_standalone_je auto-cat
// logic (P9-5) can read the sibling recon_runs for the period from the
// previous engines. Order matters — do not reshuffle.
//
// Per-engine error isolation: one failing engine doesn't abort the
// others. Each engine is wrapped in try/catch; a thrown exception
// becomes status='error' for that domain and the orchestrator moves on.
// The per-entity summary surfaces the error list for the daily email.
//
// After each engine, we:
//   a) Update entities.parallel_run_status with per-domain {status,
//      last_recon, last_status} so the dashboard top-bar can show
//      "Last recon: clean (5 min ago)" without re-querying recon_runs.
//   b) If the engine result.status is 'variance' or 'error', fire a
//      variance notification via notifyReconVariance (M28 fanout to
//      admin + accountant).
//
// Query params (manual re-run):
//   ?period_start=YYYY-MM-DD  override the auto-computed Monday
//   ?period_end=YYYY-MM-DD
//   ?entity_id=<uuid>         only run for one entity (default: all
//                             entities where parallel_run_status is
//                             non-empty OR all entities if no filter)
//
// Result shape:
//   {
//     period_start, period_end,
//     entities: [
//       {
//         entity_id, entity_code,
//         domains_run: ['ap','ar','cash','inventory','gl'],
//         total_variances_found: int,
//         domains_with_overages: ['ap','gl'],
//         errors: [{ domain, scope, reason }],
//         results: {
//           ap:        { recon_run_id, status, ... },
//           ar:        { ... },
//           cash:      { ... },
//           inventory: { ... },
//           gl:        { ... },
//         },
//         notifications_emitted: int
//       }, ...
//     ],
//     total_entities: int,
//     total_notifications: int,
//   }
//
// The 5 engine modules are loaded lazily so this cron handler still
// imports (and the routes.js wire-up still resolves) even if one of
// the per-engine modules hasn't landed in a particular branch yet.
// At runtime, a missing module surfaces as a per-domain "error" result
// rather than a module-load crash that takes the whole cron down.

import { createClient } from "@supabase/supabase-js";
import { notifyReconVariance } from "../_lib/recon/notifications.js";

export const config = { maxDuration: 600 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Engine execution order. GL is LAST (P9-5 lagging-indicator depends
// on the sibling recon_runs from the other 4 having been written).
export const ENGINE_ORDER = Object.freeze([
  "ap",
  "ar",
  "cash",
  "inventory",
  "gl",
]);

// Per-domain dynamic-import wiring. Tests inject deps via
// runReconWeekly's second arg `opts.deps`.
async function loadEngine(domain) {
  switch (domain) {
    case "ap": {
      const mod = await import("../_lib/recon/ap-engine.js");
      return mod.runApReconciliation;
    }
    case "ar": {
      const mod = await import("../_lib/recon/ar-engine.js");
      return mod.runArReconciliation;
    }
    case "cash": {
      const mod = await import("../_lib/recon/cash-engine.js");
      return mod.runCashReconciliation;
    }
    case "inventory": {
      const mod = await import("../_lib/recon/inventory-engine.js");
      return mod.runInventoryReconciliation;
    }
    case "gl": {
      const mod = await import("../_lib/recon/gl-engine.js");
      return mod.runGlReconciliation;
    }
    default:
      throw new Error(`unknown engine domain: ${domain}`);
  }
}

/**
 * Compute the prior Mon-Sun week relative to `now`. Returns
 * { period_start, period_end } as YYYY-MM-DD strings.
 *
 *   - "last_monday" = the most recent Monday on or before now (so for a
 *     Monday-06:00 cron firing, last_monday = today).
 *   - period_start = last_monday - 7d (the Monday before that)
 *   - period_end   = last_monday - 1d (the Sunday before today)
 *
 * E.g. Mon 2026-06-08 06:00 UTC → period 2026-06-01 .. 2026-06-07
 * (covering the prior Mon-Sun calendar week).
 */
export function computeWeekRange(now = new Date()) {
  // Get UTC day-of-week. 0=Sun, 1=Mon, ..., 6=Sat.
  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const dow = d.getUTCDay();
  // Days to subtract to reach last Monday. Monday=1 → 0 (today is last_monday).
  // Tuesday=2 → 1, ..., Sunday=0 → 6.
  const daysBack = dow === 0 ? 6 : dow - 1;
  const lastMonday = new Date(d.getTime() - daysBack * 86400000);
  const periodEnd = new Date(lastMonday.getTime() - 86400000);   // last_monday - 1
  const periodStart = new Date(lastMonday.getTime() - 7 * 86400000); // last_monday - 7

  return {
    period_start: periodStart.toISOString().slice(0, 10),
    period_end: periodEnd.toISOString().slice(0, 10),
  };
}

/**
 * Update entities.parallel_run_status[domain] with the latest recon
 * snapshot. JSON merge: preserves other domains' state, overwrites only
 * the target domain's key.
 *
 * shape: { ap: { status: 'parallel', last_recon: <uuid>, last_status: 'clean' }, ... }
 *
 * Best-effort: failures are captured as errors but do not abort.
 */
export async function updateParallelRunStatus(admin, { entity_id, domain, recon_run_id, last_status }) {
  // Fetch current state, merge, write back. Could be a JSONB merge
  // expression but a read-merge-write is fine at this cadence (1× per
  // engine × per entity × weekly = ~5 writes/week).
  try {
    const { data: ent, error: readErr } = await admin
      .from("entities")
      .select("parallel_run_status")
      .eq("id", entity_id)
      .maybeSingle();
    if (readErr) {
      return { ok: false, error: readErr.message };
    }
    const current = (ent && ent.parallel_run_status && typeof ent.parallel_run_status === "object")
      ? ent.parallel_run_status
      : {};
    const existing = current[domain] && typeof current[domain] === "object" ? current[domain] : {};
    const merged = {
      ...current,
      [domain]: {
        ...existing,
        status: existing.status || "parallel",
        last_recon: recon_run_id || existing.last_recon || null,
        last_status: last_status || existing.last_status || null,
        last_run_at: new Date().toISOString(),
      },
    };
    const { error: upErr } = await admin
      .from("entities")
      .update({ parallel_run_status: merged })
      .eq("id", entity_id);
    if (upErr) {
      return { ok: false, error: upErr.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Resolve which entities to run for. If opts.entity_id is provided we
 * limit to that one; otherwise we pull every row from entities (the
 * caller may pre-filter by parallel_run_status being non-empty, but for
 * this initial roll-out we just hit every entity).
 */
export async function resolveEntities(admin, { entity_id_override } = {}) {
  if (entity_id_override) {
    const { data, error } = await admin
      .from("entities")
      .select("id, code")
      .eq("id", entity_id_override)
      .maybeSingle();
    if (error) {
      return { error: `entity read failed: ${error.message}` };
    }
    if (!data) {
      return { error: `entity ${entity_id_override} not found` };
    }
    return { entities: [data] };
  }
  const { data, error } = await admin
    .from("entities")
    .select("id, code");
  if (error) {
    return { error: `entities read failed: ${error.message}` };
  }
  return { entities: Array.isArray(data) ? data : [] };
}

/**
 * Run all 5 engines for one (entity, period). Sequential — see
 * file-header for why GL must be last. Each engine wrapped in try/catch
 * so one throwing engine doesn't sink the rest.
 */
export async function runEntityRecon(admin, { entity, period_start, period_end, deps = {} }) {
  const out = {
    entity_id: entity.id,
    entity_code: entity.code || null,
    domains_run: [],
    total_variances_found: 0,
    domains_with_overages: [],
    errors: [],
    results: {},
    notifications_emitted: 0,
  };

  for (const domain of ENGINE_ORDER) {
    // 1. Resolve engine fn. Dynamic-load OR test seam.
    let engineFn = deps[domain];
    if (!engineFn) {
      try {
        engineFn = await loadEngine(domain);
      } catch (err) {
        out.errors.push({
          domain,
          scope: "engine_load",
          reason: err?.message || String(err),
        });
        out.results[domain] = { status: "error", recon_run_id: null, errors: [{ scope: "engine_load", reason: err?.message || String(err) }] };
        continue;
      }
    }

    // 2. Run engine.
    let result;
    try {
      result = await engineFn({
        admin,
        entity_id: entity.id,
        period_start,
        period_end,
        cadence: "weekly",
      });
    } catch (err) {
      out.errors.push({
        domain,
        scope: "engine_throw",
        reason: err?.message || String(err),
      });
      out.results[domain] = { status: "error", recon_run_id: null, errors: [{ scope: "engine_throw", reason: err?.message || String(err) }] };
      continue;
    }

    out.domains_run.push(domain);
    out.results[domain] = result || { status: "error" };
    const variancesFound = Number(result?.variances_found || 0);
    out.total_variances_found += variancesFound;
    if (result?.status === "variance") {
      out.domains_with_overages.push(domain);
    }

    // 3. Update entities.parallel_run_status.
    if (result?.recon_run_id) {
      const upd = await updateParallelRunStatus(admin, {
        entity_id: entity.id,
        domain,
        recon_run_id: result.recon_run_id,
        last_status: result.status,
      });
      if (!upd.ok) {
        out.errors.push({ domain, scope: "parallel_run_status_update", reason: upd.error });
      }
    }

    // 4. Notification fanout for variance/error.
    if (result?.recon_run_id && (result.status === "variance" || result.status === "error")) {
      try {
        const notifyFn = deps.notify || notifyReconVariance;
        const notif = await notifyFn({
          adminClient: admin,
          reconRunId: result.recon_run_id,
        });
        if (notif?.emitted) {
          out.notifications_emitted += 1;
        }
        if (notif?.errors && notif.errors.length > 0) {
          for (const e of notif.errors) {
            out.errors.push({ domain, scope: `notify_${e.scope}`, reason: e.reason });
          }
        }
      } catch (err) {
        out.errors.push({
          domain,
          scope: "notify_throw",
          reason: err?.message || String(err),
        });
      }
    }
  }

  return out;
}

/**
 * Orchestrator. Exposed for testability — tests pass a mocked supabase
 * and inject per-domain engine fns via opts.deps.
 *
 * @param {Object} admin            service-role client
 * @param {Object} opts
 * @param {string} [opts.period_start]
 * @param {string} [opts.period_end]
 * @param {string} [opts.entity_id_override]
 * @param {Object} [opts.deps]      { ap, ar, cash, inventory, gl, notify }
 */
export async function runReconWeekly(admin, opts = {}) {
  const range = (opts.period_start && opts.period_end)
    ? { period_start: opts.period_start, period_end: opts.period_end }
    : computeWeekRange(opts.now || new Date());

  if (!ISO_DATE_RE.test(range.period_start)) {
    throw new Error(`runReconWeekly: period_start '${range.period_start}' is not YYYY-MM-DD`);
  }
  if (!ISO_DATE_RE.test(range.period_end)) {
    throw new Error(`runReconWeekly: period_end '${range.period_end}' is not YYYY-MM-DD`);
  }
  if (range.period_end < range.period_start) {
    throw new Error(`runReconWeekly: period_end '${range.period_end}' < period_start '${range.period_start}'`);
  }

  const entRes = await resolveEntities(admin, { entity_id_override: opts.entity_id_override || null });
  if (entRes.error) {
    throw new Error(entRes.error);
  }

  const out = {
    period_start: range.period_start,
    period_end: range.period_end,
    entities: [],
    total_entities: 0,
    total_notifications: 0,
  };

  for (const entity of entRes.entities) {
    const entRecon = await runEntityRecon(admin, {
      entity,
      period_start: range.period_start,
      period_end: range.period_end,
      deps: opts.deps || {},
    });
    out.entities.push(entRecon);
    out.total_notifications += entRecon.notifications_emitted;
  }
  out.total_entities = out.entities.length;
  return out;
}

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
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Parse query params (manual re-run knobs).
  let period_start = null;
  let period_end = null;
  let entity_id_override = null;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    period_start = url.searchParams.get("period_start");
    period_end = url.searchParams.get("period_end");
    entity_id_override = url.searchParams.get("entity_id");
  } catch { /* fall through */ }

  if (period_start && !ISO_DATE_RE.test(period_start)) {
    return res.status(400).json({ error: "period_start must be YYYY-MM-DD" });
  }
  if (period_end && !ISO_DATE_RE.test(period_end)) {
    return res.status(400).json({ error: "period_end must be YYYY-MM-DD" });
  }
  if (period_start && period_end && period_end < period_start) {
    return res.status(400).json({ error: "period_end must be >= period_start" });
  }
  if ((period_start && !period_end) || (period_end && !period_start)) {
    return res.status(400).json({ error: "period_start and period_end must both be provided or both omitted" });
  }

  try {
    const result = await runReconWeekly(admin, {
      period_start: period_start || undefined,
      period_end: period_end || undefined,
      entity_id_override: entity_id_override || undefined,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
