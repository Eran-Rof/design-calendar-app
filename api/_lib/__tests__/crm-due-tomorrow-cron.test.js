// Tests for the P8-9 CRM tasks-due-tomorrow daily cron handler.
//
// The handler queries crm_tasks WHERE status IN ('open','in_progress')
// AND due_date = today+1 AND assignee_user_id IS NOT NULL, then emits
// notification_events rows. Idempotent — skips tasks that already have
// a today-stamped event of kind crm_task_due_tomorrow.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDueTomorrow } from "../../cron/crm-tasks-due-tomorrow.js";

function makeSupabaseStub({ tasks = [], existing = [], insertOk = true, queryErr = null, insertErr = null } = {}) {
  const insertCalls = [];

  // chainable query mock for tasks SELECT
  const tasksQuery = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockResolvedValue({ data: tasks, error: queryErr }),
  };

  // chainable for notification_events SELECT (probe) AND insert
  const probeQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: existing, error: null }),
  };

  const insertChain = {
    insert: vi.fn((row) => {
      insertCalls.push(row);
      return Promise.resolve({ data: insertErr ? null : [row], error: insertErr });
    }),
  };

  let probeCallCount = 0;
  return {
    insertCalls,
    from: vi.fn((table) => {
      if (table === "crm_tasks") return tasksQuery;
      if (table === "notification_events") {
        probeCallCount += 1;
        // First call per task is the existing-probe SELECT; second is INSERT.
        if (probeCallCount % 2 === 1) return probeQuery;
        return insertChain;
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  };
}

describe("runDueTomorrow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns zero counts on no tasks", async () => {
    const sb = makeSupabaseStub({ tasks: [] });
    const out = await runDueTomorrow(sb);
    expect(out.scanned).toBe(0);
    expect(out.emitted).toBe(0);
    expect(out.skipped_already_notified).toBe(0);
    expect(out.errors).toEqual([]);
    expect(out.tomorrow).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("emits one notification per task with no existing event", async () => {
    const tasks = [
      { id: "t1", entity_id: "e1", title: "Test task", due_date: "2026-05-29", priority: "normal", assignee_user_id: "u1", customer_id: null, opportunity_id: null },
    ];
    const sb = makeSupabaseStub({ tasks, existing: [] });
    const out = await runDueTomorrow(sb);
    expect(out.scanned).toBe(1);
    expect(out.emitted).toBe(1);
    expect(out.skipped_already_notified).toBe(0);
    expect(sb.insertCalls).toHaveLength(1);
    expect(sb.insertCalls[0]).toMatchObject({
      kind: "crm_task_due_tomorrow",
      context_table: "crm_tasks",
      context_id: "t1",
      severity: "info",
    });
    expect(sb.insertCalls[0].subject).toContain("Test task");
  });

  it("maps priority to severity", async () => {
    const tasks = [
      { id: "tU", entity_id: "e1", title: "U", due_date: "2026-05-29", priority: "urgent",  assignee_user_id: "u1" },
      { id: "tH", entity_id: "e1", title: "H", due_date: "2026-05-29", priority: "high",    assignee_user_id: "u1" },
      { id: "tN", entity_id: "e1", title: "N", due_date: "2026-05-29", priority: "normal",  assignee_user_id: "u1" },
      { id: "tL", entity_id: "e1", title: "L", due_date: "2026-05-29", priority: "low",     assignee_user_id: "u1" },
    ];
    const sb = makeSupabaseStub({ tasks });
    await runDueTomorrow(sb);
    const sev = sb.insertCalls.map((c) => c.severity);
    expect(sev).toEqual(["critical", "warning", "info", "info"]);
  });

  it("skips tasks that already have a today-stamped event", async () => {
    const tasks = [
      { id: "t1", entity_id: "e1", title: "Already done", due_date: "2026-05-29", priority: "normal", assignee_user_id: "u1" },
    ];
    const sb = makeSupabaseStub({ tasks, existing: [{ id: "evt-existing" }] });
    const out = await runDueTomorrow(sb);
    expect(out.scanned).toBe(1);
    expect(out.emitted).toBe(0);
    expect(out.skipped_already_notified).toBe(1);
    expect(sb.insertCalls).toHaveLength(0);
  });

  it("propagates query error as thrown", async () => {
    const sb = makeSupabaseStub({ queryErr: { message: "db down" } });
    await expect(runDueTomorrow(sb)).rejects.toThrow(/db down/);
  });

  it("records insert errors in the summary without aborting the loop", async () => {
    const tasks = [
      { id: "t1", entity_id: "e1", title: "A", due_date: "2026-05-29", priority: "normal", assignee_user_id: "u1" },
    ];
    const sb = makeSupabaseStub({ tasks, insertErr: { message: "write failed" } });
    const out = await runDueTomorrow(sb);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toMatch(/write failed/);
  });

  it("computes tomorrow's date in UTC", async () => {
    const sb = makeSupabaseStub({ tasks: [] });
    const out = await runDueTomorrow(sb);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(today.getUTCDate() + 1);
    expect(out.tomorrow).toBe(tomorrow.toISOString().slice(0, 10));
  });
});
