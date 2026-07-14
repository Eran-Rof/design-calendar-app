// P28 Assistant-First — Today-page aggregator.
//
// buildToday(admin, ctx) runs every registered capability pack's providers
// and merges their output into one RBAC-filtered payload:
//   { todos[], processes[], suggestions[], insights[], errors[] }
//
// Design invariants (arch doc §4-§5):
//   - DETERMINISTIC: providers are plain queries + pure shaping. No AI here.
//   - ISOLATED: one broken provider yields an errors[] entry, never a blank
//     page — every provider runs under its own try/catch.
//   - RBAC-FILTERED: each provider declares a module_key; its output is
//     included only when the caller holds `<module_key>:read`. A ctx with
//     permissions === null means "no per-user permission set available"
//     (legacy PLM-session path) and mirrors rbacEnforce's pass-through:
//     nothing is filtered.
//   - COUNTS ARE SERVER-SIDE: providers must use head:true count queries or
//     aggregate RPCs — never fetch-then-count (PostgREST 1000-row cap).

export const SEVERITY_RANK = { action: 0, warn: 1, error: 0, info: 2 };

/** Does the caller's permission set allow reading this module's items?
 *  permissions === null → legacy pass-through (no filtering).            */
export function permitsModule(permissions, moduleKey) {
  if (permissions === null || permissions === undefined) return true;
  if (!(permissions instanceof Set)) return false;
  return permissions.has(`${moduleKey}:read`);
}

/** Drop items the user dismissed today. Item identity = its provider key. */
export function filterDismissed(items, dismissedKeys) {
  if (!dismissedKeys || dismissedKeys.size === 0) return items;
  return items.filter((it) => !dismissedKeys.has(it.key));
}

/** Severity-first ordering (action/error → warn → info), count desc inside. */
export function sortTodos(items) {
  return [...items].sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] ?? 3;
    const rb = SEVERITY_RANK[b.severity] ?? 3;
    if (ra !== rb) return ra - rb;
    return (b.count || 0) - (a.count || 0);
  });
}

/** Latest xoro_mirror_runs-style row per domain. Pure; rows must be sorted
 *  newest-first (the query orders started_at desc).                       */
export function reduceLatestByDomain(rows) {
  const seen = new Map();
  for (const r of rows || []) {
    if (r && r.domain && !seen.has(r.domain)) seen.set(r.domain, r);
  }
  return [...seen.values()];
}

/** UTC calendar date (YYYY-MM-DD) — matches assistant_dismissals default. */
export function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function runProvider(kind, pack, provider, admin, ctx, out) {
  try {
    const items = (await provider.run(admin, ctx)) || [];
    for (const it of items) {
      out[kind].push({ ...it, pack: pack.key, module_key: provider.module_key });
    }
  } catch (e) {
    out.errors.push({
      pack: pack.key,
      provider: provider.key,
      kind,
      error: e?.message || String(e),
    });
  }
}

/**
 * @param admin  service-role supabase client
 * @param ctx    { userId, entityId, permissions: Set|null, dismissedKeys: Set, packs }
 *               ctx.packs lets tests inject a fixture registry; production
 *               callers omit it and get the real one.
 */
export async function buildToday(admin, ctx) {
  const { PACKS } = await import("./registry.js");
  const packs = ctx.packs || PACKS;
  const out = { todos: [], processes: [], suggestions: [], insights: [], errors: [] };

  const jobs = [];
  for (const pack of packs) {
    for (const p of pack.todos || []) {
      if (!permitsModule(ctx.permissions, p.module_key)) continue;
      jobs.push(runProvider("todos", pack, p, admin, ctx, out));
    }
    for (const p of pack.processes || []) {
      if (!permitsModule(ctx.permissions, p.module_key)) continue;
      jobs.push(runProvider("processes", pack, p, admin, ctx, out));
    }
  }
  await Promise.all(jobs);

  // Suggestion rules are pure derivations over the aggregate (no queries) —
  // they run after the fan-in so they can see counts across providers.
  for (const pack of packs) {
    for (const rule of pack.suggestions || []) {
      if (!permitsModule(ctx.permissions, rule.module_key)) continue;
      try {
        const items = rule.derive(out) || [];
        for (const it of items) {
          out.suggestions.push({ ...it, pack: pack.key, module_key: rule.module_key });
        }
      } catch (e) {
        out.errors.push({ pack: pack.key, provider: rule.key, kind: "suggestions", error: e?.message || String(e) });
      }
    }
  }

  // Current-state insights: the existing ai_insights feed, pack-attributed
  // rows RBAC-filtered by their pack's module_keys; NULL pack_key = legacy.
  try {
    const { data, error } = await admin
      .from("ai_insights")
      .select("id, pack_key, type, title, summary, recommendation, confidence_pct, status, generated_at")
      .neq("status", "dismissed")
      .order("generated_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    const packByKey = new Map(packs.map((p) => [p.key, p]));
    out.insights = (data || []).filter((row) => {
      if (!row.pack_key) return true;
      const pk = packByKey.get(row.pack_key);
      if (!pk) return true;
      return (pk.module_keys || []).some((mk) => permitsModule(ctx.permissions, mk));
    });
  } catch (e) {
    out.errors.push({ pack: "_core", provider: "insights_feed", kind: "insights", error: e?.message || String(e) });
  }

  out.todos = sortTodos(filterDismissed(out.todos, ctx.dismissedKeys));
  out.suggestions = filterDismissed(out.suggestions, ctx.dismissedKeys);
  return out;
}
