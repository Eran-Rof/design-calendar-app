import { describe, it, expect, beforeEach, vi } from "vitest";
import { evaluateConditions, fireWorkflowEvent } from "../workflow.js";

describe("evaluateConditions", () => {
  it("returns true when conditions are missing or empty", () => {
    expect(evaluateConditions(undefined, {})).toBe(true);
    expect(evaluateConditions([], {})).toBe(true);
  });

  it("evaluates numeric comparisons", () => {
    const ctx = { amount: 60000 };
    expect(evaluateConditions([{ field: "amount", op: "gt",  value: 50000 }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: "amount", op: "gte", value: 60000 }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: "amount", op: "lt",  value: 50000 }], ctx)).toBe(false);
    expect(evaluateConditions([{ field: "amount", op: "lte", value: 60000 }], ctx)).toBe(true);
  });

  it("evaluates eq / neq as strict equality", () => {
    expect(evaluateConditions([{ field: "status", op: "eq",  value: "open" }], { status: "open" })).toBe(true);
    expect(evaluateConditions([{ field: "status", op: "neq", value: "open" }], { status: "closed" })).toBe(true);
    expect(evaluateConditions([{ field: "amount", op: "eq",  value: 100 }], { amount: "100" })).toBe(false);
  });

  it("evaluates contains case-insensitively on stringified values", () => {
    expect(evaluateConditions([{ field: "name", op: "contains", value: "acme" }], { name: "ACME Widgets" })).toBe(true);
    expect(evaluateConditions([{ field: "name", op: "contains", value: "other" }], { name: "ACME Widgets" })).toBe(false);
  });

  it("evaluates in against an array value", () => {
    expect(evaluateConditions([{ field: "severity", op: "in", value: ["high", "critical"] }], { severity: "high" })).toBe(true);
    expect(evaluateConditions([{ field: "severity", op: "in", value: ["low"] }], { severity: "high" })).toBe(false);
    expect(evaluateConditions([{ field: "severity", op: "in", value: "high" }], { severity: "high" })).toBe(false);
  });

  it("AND-joins multiple conditions", () => {
    const ctx = { amount: 60000, currency: "USD" };
    expect(evaluateConditions([
      { field: "amount",   op: "gt", value: 50000 },
      { field: "currency", op: "eq", value: "USD" },
    ], ctx)).toBe(true);
    expect(evaluateConditions([
      { field: "amount",   op: "gt", value: 50000 },
      { field: "currency", op: "eq", value: "EUR" },
    ], ctx)).toBe(false);
  });

  it("supports dot-path field lookups into nested context", () => {
    const ctx = { vendor: { health_score: 42 } };
    expect(evaluateConditions([{ field: "vendor.health_score", op: "lt", value: 50 }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: "vendor.missing",      op: "eq", value: "x" }], ctx)).toBe(false);
  });

  it("returns false for unknown operators", () => {
    expect(evaluateConditions([{ field: "x", op: "bogus", value: 1 }], { x: 1 })).toBe(false);
  });
});

// ---- fireWorkflowEvent integration harness ----

function buildAdminStub({ rules = [], vendors = [] } = {}) {
  const inserted = [];
  function selectable(rows) {
    const state = { rows, filters: [] };
    const api = {
      select: () => api,
      eq: (field, val) => { state.filters.push([field, val]); return api; },
      order: () => api,
      limit: () => api,
      maybeSingle: async () => ({ data: state.rows[0] ?? null }),
      // resolve as array (used by the .eq chain for rule fetch)
      then: (onFulfilled) => {
        const filtered = state.rows.filter((r) => state.filters.every(([f, v]) => r[f] === v));
        return Promise.resolve({ data: filtered, error: null }).then(onFulfilled);
      },
    };
    return api;
  }
  const admin = {
    from(table) {
      if (table === "workflow_rules") return selectable(rules);
      if (table === "vendors")        return selectable(vendors);
      if (table === "entities")       return selectable([{ id: "default-entity" }]);
      if (table === "workflow_executions") {
        return {
          insert: (row) => ({
            select: () => ({
              single: async () => {
                const withId = { id: `exec-${inserted.length + 1}`, ...row };
                inserted.push(withId);
                return { data: withId, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    _inserted: inserted,
  };
  return admin;
}

describe("fireWorkflowEvent", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;
  });

  it("no-ops when event is missing", async () => {
    const admin = buildAdminStub();
    const out = await fireWorkflowEvent({ admin, event: "", entity_id: "e1" });
    expect(out).toEqual({ blocked: false, results: [] });
  });

  it("skips rules whose conditions fail", async () => {
    const admin = buildAdminStub({
      rules: [{
        id: "r1", entity_id: "e1", trigger_event: "invoice_submitted", is_active: true,
        name: "big invoice", conditions: [{ field: "amount", op: "gt", value: 50000 }],
        actions: [{ type: "require_approval", approver_role: "finance_manager" }],
      }],
    });
    const out = await fireWorkflowEvent({ admin, event: "invoice_submitted", entity_id: "e1", context: { amount: 1000 } });
    expect(out.blocked).toBe(false);
    expect(out.results).toEqual([]);
    expect(admin._inserted).toHaveLength(0);
  });

  it("blocks on require_approval and writes a pending execution", async () => {
    const admin = buildAdminStub({
      rules: [{
        id: "r1", entity_id: "e1", trigger_event: "invoice_submitted", is_active: true,
        name: "big invoice", conditions: [{ field: "amount", op: "gt", value: 50000 }],
        actions: [{ type: "require_approval", approver_role: "finance_manager" }],
      }],
    });
    const out = await fireWorkflowEvent({
      admin, event: "invoice_submitted", entity_id: "e1",
      context: { amount: 75000, vendor_id: "v1", entity_type: "invoice" },
    });
    expect(out.blocked).toBe(true);
    expect(out.blocking_execution_id).toBe("exec-1");
    expect(admin._inserted).toHaveLength(1);
    expect(admin._inserted[0]).toMatchObject({
      rule_id: "r1", entity_id: "e1",
      status: "pending",
      current_approver: "finance_manager",
      trigger_entity_type: "invoice",
    });
    expect(out.results[0]).toMatchObject({
      rule_id: "r1", action_type: "require_approval",
      result: { type: "require_approval", status: "pending" },
    });
  });

  it("auto_approve does not block and writes an auto_approved execution", async () => {
    const admin = buildAdminStub({
      rules: [{
        id: "r2", entity_id: "e1", trigger_event: "invoice_submitted", is_active: true,
        name: "auto green", conditions: [], actions: [{ type: "auto_approve" }],
      }],
    });
    const out = await fireWorkflowEvent({ admin, event: "invoice_submitted", entity_id: "e1", context: {} });
    expect(out.blocked).toBe(false);
    expect(admin._inserted[0]).toMatchObject({ status: "auto_approved", rule_id: "r2" });
    expect(out.results[0].result).toMatchObject({ type: "auto_approve", status: "auto_approved" });
  });

  it("webhook action POSTs to the configured url and does not block", async () => {
    const admin = buildAdminStub({
      rules: [{
        id: "r3", entity_id: "e1", trigger_event: "po_issued", is_active: true,
        name: "slack ping", conditions: [],
        actions: [{ type: "webhook", url: "https://hooks.example.com/x" }],
      }],
    });
    const out = await fireWorkflowEvent({ admin, event: "po_issued", entity_id: "e1", context: { po_number: "PO-1" } });
    expect(fetchMock).toHaveBeenCalledWith("https://hooks.example.com/x", expect.objectContaining({ method: "POST" }));
    const calledBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(calledBody).toMatchObject({ rule_id: "r3", rule_name: "slack ping", event: "po_issued", po_number: "PO-1" });
    expect(out.blocked).toBe(false);
    expect(out.results[0].result).toMatchObject({ type: "webhook", status: "sent", http_status: 200 });
  });

  it("only evaluates rules with matching trigger_event, entity_id, and is_active=true", async () => {
    const admin = buildAdminStub({
      rules: [
        // match
        { id: "match", entity_id: "e1", trigger_event: "invoice_submitted", is_active: true,
          name: "match", conditions: [], actions: [{ type: "auto_approve" }] },
        // wrong event
        { id: "wrong-event", entity_id: "e1", trigger_event: "po_issued", is_active: true,
          name: "x", conditions: [], actions: [{ type: "auto_approve" }] },
        // wrong entity
        { id: "wrong-entity", entity_id: "e2", trigger_event: "invoice_submitted", is_active: true,
          name: "x", conditions: [], actions: [{ type: "auto_approve" }] },
        // disabled
        { id: "disabled", entity_id: "e1", trigger_event: "invoice_submitted", is_active: false,
          name: "x", conditions: [], actions: [{ type: "auto_approve" }] },
      ],
    });
    const out = await fireWorkflowEvent({ admin, event: "invoice_submitted", entity_id: "e1", context: {} });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].rule_id).toBe("match");
  });

  it("runs multiple actions in a rule; pending on any action blocks", async () => {
    const admin = buildAdminStub({
      rules: [{
        id: "r-multi", entity_id: "e1", trigger_event: "invoice_submitted", is_active: true,
        name: "notify then approve", conditions: [],
        actions: [
          { type: "notify", to_role: "procurement" },
          { type: "require_approval", approver_role: "finance_manager" },
        ],
      }],
    });
    const out = await fireWorkflowEvent({ admin, event: "invoice_submitted", entity_id: "e1", context: { vendor_id: "v1" }, origin: "https://app.test" });
    expect(out.blocked).toBe(true);
    expect(out.results.map((r) => r.action_type)).toEqual(["notify", "require_approval"]);
    // pending execution written
    expect(admin._inserted.some((e) => e.status === "pending")).toBe(true);
  });
});
