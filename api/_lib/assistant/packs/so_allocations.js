// P28 capability pack — Sales Orders & Allocations.
//
// Demand-side to-dos on top of v_allocation_demand (the Allocations
// Workbench view: one row per open SO line with factor/card context).
// The open-demand universe is huge (~35k lines), so every to-do here is
// DATE- or STATE-bounded — raw backlog counts are noise, not signal.

async function headCount(q) {
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

// Draft SOs older than 3 days — entered but never confirmed.
const draftSosAging = {
  key: "so.drafts_aging",
  module_key: "sales_orders",
  async run(admin, ctx) {
    const today = ctx.todayISO || new Date().toISOString().slice(0, 10);
    const cutoff = new Date(new Date(today).getTime() - 3 * 86400 * 1000).toISOString();
    const n = await headCount(
      admin.from("sales_orders").select("id", { count: "exact", head: true })
        .eq("status", "draft").lt("created_at", cutoff),
    );
    if (n === 0) return [];
    return [{
      key: "so.drafts_aging",
      title: "Draft SOs older than 3 days",
      detail: "Entered but never confirmed — confirm or delete",
      count: n,
      severity: "action",
      panel: "sales_orders",
      // Sales Orders defaults to all live statuses — narrow it to just drafts.
      drill: { status: "draft" },
    }];
  },
};

// Open SO lines due to ship within 7 days — the allocation work of the week.
const shipDue7d = {
  key: "so.ship_due_7d",
  module_key: "sales_allocations",
  async run(admin, ctx) {
    const today = ctx.todayISO || new Date().toISOString().slice(0, 10);
    const plus7 = new Date(new Date(today).getTime() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    const n = await headCount(
      admin.from("v_allocation_demand").select("line_id", { count: "exact", head: true })
        .gt("open_qty", 0).gte("requested_ship_date", today).lte("requested_ship_date", plus7),
    );
    if (n === 0) return [];
    return [{
      key: "so.ship_due_7d",
      title: "SO lines due to ship this week",
      detail: "Open quantity with a requested ship date in the next 7 days",
      count: n,
      severity: "action",
      panel: "sales_allocations",
    }];
  },
};

// Open SO lines already past their requested ship date.
const shipOverdue = {
  key: "so.ship_overdue",
  module_key: "sales_allocations",
  async run(admin, ctx) {
    const today = ctx.todayISO || new Date().toISOString().slice(0, 10);
    const n = await headCount(
      admin.from("v_allocation_demand").select("line_id", { count: "exact", head: true })
        .gt("open_qty", 0).lt("requested_ship_date", today),
    );
    if (n === 0) return [];
    return [{
      key: "so.ship_overdue",
      title: "SO lines past requested ship",
      detail: "Open quantity behind its requested ship date",
      count: n,
      severity: "warn",
      panel: "sales_allocations",
    }];
  },
};

// Factored demand that was never submitted for factor approval — it can't
// ship until the factor-credit gate clears.
const factorNotSubmitted = {
  key: "so.factor_not_submitted",
  module_key: "sales_allocations",
  async run(admin, ctx) {
    const today = ctx.todayISO || new Date().toISOString().slice(0, 10);
    const plus14 = new Date(new Date(today).getTime() + 14 * 86400 * 1000).toISOString().slice(0, 10);
    const n = await headCount(
      admin.from("v_allocation_demand").select("line_id", { count: "exact", head: true })
        .eq("is_factored", true).gt("open_qty", 0)
        .neq("factor_approval_status", "approved")
        .lte("requested_ship_date", plus14),
    );
    if (n === 0) return [];
    return [{
      key: "so.factor_not_submitted",
      title: "Factored lines shipping ≤14d without factor approval",
      detail: "The factor-credit gate will block these at allocation",
      count: n,
      severity: "warn",
      panel: "sales_allocations",
    }];
  },
};

const suggestAutoAllocate = {
  key: "so.suggest_auto_allocate",
  module_key: "sales_allocations",
  derive(aggregate) {
    const due = aggregate.todos.find((t) => t.key === "so.ship_due_7d");
    if (!due || (due.count || 0) === 0) return [];
    return [{
      key: "so.suggest_auto_allocate",
      text: "Run Auto-allocate in the Allocations Workbench for this week's ship-due lines — priority full-fill respects the factor-credit gate, so approved demand fills first.",
      panel: "sales_allocations",
    }];
  },
};

export default {
  key: "so_allocations",
  label: "Sales & Allocations",
  module_keys: ["sales_orders", "sales_allocations"],
  todos: [draftSosAging, shipDue7d, shipOverdue, factorNotSubmitted],
  processes: [],
  suggestions: [suggestAutoAllocate],
  panels: { sales_orders: {}, sales_allocations: {} },
};
