// api/_lib/notifications-phase9.js
//
// Pure helpers for the two daily digest / due-soon crons.

export function digestSubject(count) {
  return `Procurement insights: ${count} new recommendations`;
}

export function digestBody(insights) {
  if (!insights || insights.length === 0) return "No new insights.";
  const lines = insights.slice(0, 20).map((i) => {
    const type = (i.type || "").replace(/_/g, " ");
    return `• [${type}] ${i.title}${i.recommendation ? `\n    → ${i.recommendation}` : ""}`;
  });
  if (insights.length > 20) lines.push(`\n…and ${insights.length - 20} more. Open the Insights tab to review.`);
  return lines.join("\n");
}

export function dueSoonSubject(task) {
  return `Task due soon: ${task.title} — due ${task.due_date}`;
}

// Business rule: insights digest should include only type in {risk_alert, cost_saving}
// and status='new', within the last 24h.
export function filterDigestInsights(rows, { now = new Date(), withinHours = 24 } = {}) {
  const cutoff = new Date(now.getTime() - withinHours * 60 * 60 * 1000);
  return (rows || []).filter((r) =>
    r.status === "new"
    && (r.type === "risk_alert" || r.type === "cost_saving")
    && new Date(r.generated_at) >= cutoff,
  );
}

// Business rule: send due-soon notification for tasks with
// due_date within [today, today + N days] and status not complete/cancelled.
export function filterDueSoonTasks(rows, { now = new Date(), withinDays = 2 } = {}) {
  const start = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
  const end   = new Date(start.getTime() + withinDays * 86400000);
  return (rows || []).filter((t) => {
    if (!t.due_date) return false;
    if (t.status === "complete" || t.status === "cancelled") return false;
    const d = new Date(t.due_date + "T00:00:00Z");
    return d >= start && d <= end;
  });
}
