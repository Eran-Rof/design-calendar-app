// P28 capability pack — Planning (the /planning app, M31).
//
// The planning app lives outside the Tangerine shell, so its items link by
// href (same-origin SPA route — no noopener, same tab). Deliberately does
// NOT read the ATS on-hand feed: that feed is flagged unreliable (see the
// phantom-on-hand handover memory) and a wrong "low stock" flag erodes
// trust in the whole page faster than a missing one.

async function headCount(q) {
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

// Execution batches sitting in draft — buy plans built but never approved,
// so nothing downstream (PO creation) can happen.
const execBatchesDraft = {
  key: "planning.exec_batches_draft",
  module_key: "ats",
  async run(admin) {
    const n = await headCount(
      admin.from("ip_execution_batches").select("id", { count: "exact", head: true })
        .eq("status", "draft"),
    );
    if (n === 0) return [];
    return [{
      key: "planning.exec_batches_draft",
      title: "Buy-plan batches awaiting approval",
      detail: "Approved batches unlock Create-Tangerine-POs",
      count: n,
      severity: "action",
      href: "/planning",
      panel: null,
    }];
  },
};

// Latest planning run state — surfaces a failed/stuck run.
const latestRun = {
  key: "planning.latest_run",
  module_key: "ats",
  async run(admin) {
    const { data, error } = await admin
      .from("ip_planning_runs")
      .select("id, name, status, created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const run = (data || [])[0];
    if (!run) return [];
    const bad = ["failed", "error"].includes(String(run.status || "").toLowerCase());
    return [{
      key: "planning.latest_run",
      label: "Planning run",
      state: bad ? "error" : "ok",
      detail: `${run.name || run.id}: ${run.status}`,
      last_run_at: run.created_at,
      panel: null,
    }];
  },
};

export default {
  key: "planning",
  label: "Planning",
  module_keys: ["ats"],
  todos: [execBatchesDraft],
  processes: [latestRun],
  suggestions: [],
  panels: {},
};
