// P28 capability pack — Accounting.
//
// One pack among many (arch §4.1): to-dos and process state for the
// GL / AP / AR / close / mirror surface. Every count is a head:true
// server-side count (1000-row cap does not apply).
//
// Provider contract: { key, module_key, run(admin, ctx) => item[] }.
// module_key values come from api/_lib/rbac/routePermissions.js.

async function headCount(q) {
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

// Approvals waiting on the caller: pending requests minus the ones the
// caller created (self-approval is forbidden by #1743, so "yours" are
// never actionable by you).
const approvalsPending = {
  key: "accounting.approvals_pending",
  module_key: "workflows",
  async run(admin, ctx) {
    const total = await headCount(
      admin.from("approval_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
    );
    if (total === 0) return [];
    let mine = 0;
    if (ctx.userId) {
      mine = await headCount(
        admin.from("approval_requests").select("id", { count: "exact", head: true })
          .eq("status", "pending").eq("created_by_user_id", ctx.userId),
      );
    }
    const actionable = Math.max(0, total - mine);
    if (actionable === 0) return [];
    return [{
      key: "accounting.approvals_pending",
      title: "Approvals waiting on you",
      detail: mine > 0 ? `${actionable} to decide (${mine} more are your own submissions)` : `${actionable} pending request${actionable === 1 ? "" : "s"}`,
      count: actionable,
      severity: "action",
      panel: "approval_requests",
    }];
  },
};

// Chargebacks still at disposition='open' (#1744 worklist).
const chargebacksOpen = {
  key: "accounting.chargebacks_open",
  module_key: "finance_misc",
  async run(admin) {
    const n = await headCount(
      admin.from("factor_chargebacks").select("id", { count: "exact", head: true }).eq("disposition", "open"),
    );
    if (n === 0) return [];
    return [{
      key: "accounting.chargebacks_open",
      title: "Chargebacks to disposition",
      detail: "Open items on the chargeback worklist",
      count: n,
      severity: "warn",
      panel: "chargebacks",
    }];
  },
};

// Month-end close state. Two shapes:
//   - close rows exist and some prior month is still open → action item
//   - NO close rows exist at all → info nudge (the module is live but
//     unused — the audit's system-of-record gap)
const monthEndClose = {
  key: "accounting.month_end_close",
  module_key: "gl_periods",
  async run(admin, ctx) {
    const totalRows = await headCount(
      admin.from("close_periods").select("id", { count: "exact", head: true }),
    );
    if (totalRows === 0) {
      return [{
        key: "accounting.close_not_started",
        title: "Month-end close not yet in use",
        detail: "No period has been run through the close checklist",
        count: 1,
        severity: "info",
        panel: "month_end_close",
      }];
    }
    const currentMonth = (ctx.todayISO || new Date().toISOString().slice(0, 10)).slice(0, 7) + "-01";
    const openPrior = await headCount(
      admin.from("close_periods").select("id", { count: "exact", head: true })
        .neq("status", "closed").lt("period_month", currentMonth),
    );
    if (openPrior === 0) return [];
    return [{
      key: "accounting.close_open_prior",
      title: "Prior months not closed",
      detail: "Close checklist has unfinished prior periods",
      count: openPrior,
      severity: "action",
      panel: "month_end_close",
    }];
  },
};

// Nightly-job failures in the last 24h (tie-out cron writes app_errors
// with source='cron').
const cronErrors24h = {
  key: "accounting.cron_errors_24h",
  module_key: "parallel_run",
  async run(admin) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const n = await headCount(
      admin.from("app_errors").select("id", { count: "exact", head: true })
        .eq("source", "cron").gte("created_at", since),
    );
    if (n === 0) return [];
    return [{
      key: "accounting.cron_errors_24h",
      title: "Nightly job errors (last 24h)",
      detail: "Cron runs logged errors — check tie-outs and sync health",
      count: n,
      severity: "warn",
      panel: "sync_health",
    }];
  },
};

// Shadow-mirror run state, latest per domain (ar / ap / inventory /
// summary_je). Fetching 16 newest rows is enough to cover every domain's
// latest run; reduction is pure (unit-tested in the aggregator module).
const mirrorRuns = {
  key: "accounting.mirror_runs",
  module_key: "parallel_run",
  async run(admin) {
    const { reduceLatestByDomain } = await import("../today.js");
    const { data, error } = await admin
      .from("xoro_mirror_runs")
      .select("domain, status, mirror_date, completed_at, errors")
      .order("started_at", { ascending: false })
      .limit(16);
    if (error) throw new Error(error.message);
    return reduceLatestByDomain(data).map((r) => {
      // xoro_mirror_runs.status is 'complete' | 'running' | 'failed' |
      // 'skipped_no_change' | 'skipped_stale_xoro' (it NEVER writes 'success').
      // The old check `status === "success"` therefore mislabeled every
      // successful nightly run as an error → a bogus "mirror failed" on Today
      // even though all four domains completed. Treat a completed/skipped-no-op
      // run as ok, running as running, and only genuine failures / stale-skips
      // as error.
      const ok = r.status === "complete" || r.status === "success" || r.status === "skipped_no_change";
      const errText = Array.isArray(r.errors) ? (r.errors.length ? JSON.stringify(r.errors) : "") : String(r.errors || "");
      return {
        key: `accounting.mirror.${r.domain}`,
        label: `Xoro mirror — ${r.domain}`,
        state: ok ? "ok" : r.status === "running" ? "running" : "error",
        detail: ok ? `Mirrored ${r.mirror_date}` : (errText || r.status || ""),
        last_run_at: r.completed_at,
        panel: "shadow_mirror",
      };
    });
  },
};

const suggestCloseAdoption = {
  key: "accounting.suggest_close_adoption",
  module_key: "gl_periods",
  derive(aggregate) {
    const hit = aggregate.todos.find((t) => t.key === "accounting.close_not_started");
    if (!hit) return [];
    return [{
      key: "accounting.suggest_close_adoption",
      text: "Start running months through Month-End Close — it runs 8 automated checks per period and is the fastest way to make Tangerine the system of record.",
      panel: "month_end_close",
    }];
  },
};

export default {
  key: "accounting",
  label: "Accounting",
  module_keys: ["workflows", "finance_misc", "gl_periods", "parallel_run"],
  todos: [approvalsPending, chargebacksOpen, monthEndClose, cronErrors24h],
  processes: [mirrorRuns],
  suggestions: [suggestCloseAdoption],
  panels: {
    approval_requests: {}, chargebacks: {}, month_end_close: {}, sync_health: {}, shadow_mirror: {},
  },
};
