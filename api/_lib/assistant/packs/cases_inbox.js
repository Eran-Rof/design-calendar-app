// P28 capability pack — Cases & Notifications inbox.
//
// The only pack whose to-dos are PER-USER by data (not just by RBAC):
// "my cases" and "my unread notifications" key on ctx.userId. Without a
// resolvable user (legacy PLM session) the personal providers stay quiet
// and only the entity-wide unassigned-cases item can show.

async function headCount(q) {
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

// Open cases assigned to me.
const myOpenCases = {
  key: "cases.mine_open",
  module_key: "cases",
  async run(admin, ctx) {
    if (!ctx.userId) return [];
    const n = await headCount(
      admin.from("cases").select("id", { count: "exact", head: true })
        .eq("assignee_user_id", ctx.userId).in("status", ["open", "in_progress"]),
    );
    if (n === 0) return [];
    return [{
      key: "cases.mine_open",
      title: "Cases assigned to you",
      detail: "Open / in-progress customer-service cases",
      count: n,
      severity: "action",
      panel: "cases",
      // Cases panel resolves assignee="me" to the signed-in user + status filter.
      drill: { assignee: "me", status: "open" },
    }];
  },
};

// Open cases nobody owns — somebody has to pick them up.
const unassignedCases = {
  key: "cases.unassigned_open",
  module_key: "cases",
  async run(admin) {
    const n = await headCount(
      admin.from("cases").select("id", { count: "exact", head: true })
        .is("assignee_user_id", null).in("status", ["open", "in_progress"]),
    );
    if (n === 0) return [];
    return [{
      key: "cases.unassigned_open",
      title: "Unassigned open cases",
      detail: "No owner yet — triage and assign",
      count: n,
      severity: "warn",
      panel: "cases",
      // assignee="none" → Cases panel shows only the unassigned open cases.
      drill: { assignee: "none", status: "open" },
    }];
  },
};

// My unread in-app notifications.
const myUnreadNotifications = {
  key: "cases.notifications_unread",
  module_key: "notifications",
  async run(admin, ctx) {
    if (!ctx.userId) return [];
    const n = await headCount(
      admin.from("notification_dispatches").select("id", { count: "exact", head: true })
        .eq("recipient_user_id", ctx.userId).eq("channel", "in_app").is("read_at", null),
    );
    if (n === 0) return [];
    return [{
      key: "cases.notifications_unread",
      title: "Unread notifications",
      detail: "Your in-app notification inbox",
      count: n,
      severity: "info",
      panel: "notifications",
      // Notification Center opens with "Show read" off (unread only).
      drill: { unread: "1" },
    }];
  },
};

export default {
  key: "cases_inbox",
  label: "Cases & Inbox",
  module_keys: ["cases", "notifications"],
  todos: [myOpenCases, unassignedCases, myUnreadNotifications],
  processes: [],
  suggestions: [],
  panels: { cases: {}, notifications: {} },
};
