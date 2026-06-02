// Tests for Tangerine P8-2 — CRM handlers + stage-change RPC.
//
// Pure validators + query parsers + the pipeline-report aggregator are
// covered here. Live RPC + Supabase upserts are covered by the P8-1 schema
// migration tests + deployed app smoke tests.

import { describe, it, expect } from "vitest";

import {
  parseListQuery as oppParseListQuery,
  validateInsert as oppValidateInsert,
  isUuid,
} from "../../_handlers/internal/crm/opportunities/index.js";
import { validatePatch as oppValidatePatch } from "../../_handlers/internal/crm/opportunities/[id].js";
import { validateBody as oppStageValidateBody } from "../../_handlers/internal/crm/opportunities/[id]/stage.js";

import {
  parseListQuery as actParseListQuery,
  validateInsert as actValidateInsert,
} from "../../_handlers/internal/crm/activities/index.js";
import { validatePatch as actValidatePatch } from "../../_handlers/internal/crm/activities/[id].js";

import {
  parseListQuery as taskParseListQuery,
  validateInsert as taskValidateInsert,
} from "../../_handlers/internal/crm/tasks/index.js";
import { validatePatch as taskValidatePatch } from "../../_handlers/internal/crm/tasks/[id].js";

import {
  parseQuery as pipelineParseQuery,
  aggregateByStage,
} from "../../_handlers/internal/crm/pipeline-report/index.js";

const UUID  = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";

// ────────────────────────────────────────────────────────────────────────
// isUuid sanity (opportunities exports it)
// ────────────────────────────────────────────────────────────────────────

describe("crm isUuid", () => {
  it("accepts a canonical uuid", () => {
    expect(isUuid(UUID)).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isUuid("abc")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// OPPORTUNITIES
// ════════════════════════════════════════════════════════════════════════

describe("crm opportunities parseListQuery", () => {
  it("accepts empty params and defaults limit=100, offset=0", () => {
    const v = oppParseListQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.limit).toBe(100);
    expect(v.data.offset).toBe(0);
    expect(v.data.stage).toBeNull();
    expect(v.data.owner_user_id).toBeNull();
    expect(v.data.customer_id).toBeNull();
    expect(v.data.q).toBeNull();
  });
  it("rejects bad stage enum value", () => {
    expect(oppParseListQuery({ stage: "pending" }).error).toMatch(/stage/);
  });
  it("accepts all five valid stages", () => {
    for (const s of ["new", "qualified", "proposal", "won", "lost"]) {
      expect(oppParseListQuery({ stage: s }).data.stage).toBe(s);
    }
  });
  it("rejects non-uuid owner_user_id", () => {
    expect(oppParseListQuery({ owner_user_id: "nope" }).error).toMatch(/owner_user_id/);
  });
  it("accepts valid owner_user_id", () => {
    expect(oppParseListQuery({ owner_user_id: UUID }).data.owner_user_id).toBe(UUID);
  });
  it("rejects non-uuid customer_id", () => {
    expect(oppParseListQuery({ customer_id: "x" }).error).toMatch(/customer_id/);
  });
  it("rejects q over 200 chars", () => {
    expect(oppParseListQuery({ q: "x".repeat(201) }).error).toMatch(/q/);
  });
  it("preserves a normal q substring", () => {
    expect(oppParseListQuery({ q: "wholesale deal" }).data.q).toBe("wholesale deal");
  });
  it("caps limit at 500", () => {
    expect(oppParseListQuery({ limit: "9999" }).data.limit).toBe(500);
  });
  it("treats NaN limit as default 100", () => {
    expect(oppParseListQuery({ limit: "garbage" }).data.limit).toBe(100);
  });
  it("treats negative offset as 0", () => {
    expect(oppParseListQuery({ offset: "-10" }).data.offset).toBe(0);
  });
});

const okOpp = { title: "Spring 2026 buy" };

describe("crm opportunities validateInsert", () => {
  it("accepts a minimal valid body", () => {
    const v = oppValidateInsert(okOpp);
    expect(v.error).toBeUndefined();
    expect(v.data.title).toBe("Spring 2026 buy");
    expect(v.data.stage).toBe("new");
    expect(v.data.probability_pct).toBe(50);
    expect(v.data.expected_cents).toBeNull();
  });
  it("rejects missing title", () => {
    expect(oppValidateInsert({}).error).toMatch(/title/);
  });
  it("rejects whitespace-only title", () => {
    expect(oppValidateInsert({ title: "   " }).error).toMatch(/title/);
  });
  it("trims title", () => {
    expect(oppValidateInsert({ title: "  hi  " }).data.title).toBe("hi");
  });
  it("rejects title over 500 chars", () => {
    expect(oppValidateInsert({ title: "x".repeat(501) }).error).toMatch(/title/);
  });
  it("rejects an unknown stage", () => {
    expect(oppValidateInsert({ ...okOpp, stage: "archived" }).error).toMatch(/stage/);
  });
  it("accepts every valid stage", () => {
    for (const s of ["new", "qualified", "proposal", "won", "lost"]) {
      expect(oppValidateInsert({ ...okOpp, stage: s }).data.stage).toBe(s);
    }
  });
  it("rejects probability_pct < 0", () => {
    expect(oppValidateInsert({ ...okOpp, probability_pct: -1 }).error).toMatch(/probability_pct/);
  });
  it("rejects probability_pct > 100", () => {
    expect(oppValidateInsert({ ...okOpp, probability_pct: 101 }).error).toMatch(/probability_pct/);
  });
  it("rejects non-integer probability_pct", () => {
    expect(oppValidateInsert({ ...okOpp, probability_pct: 42.5 }).error).toMatch(/probability_pct/);
  });
  it("accepts probability_pct=0 and probability_pct=100", () => {
    expect(oppValidateInsert({ ...okOpp, probability_pct: 0 }).data.probability_pct).toBe(0);
    expect(oppValidateInsert({ ...okOpp, probability_pct: 100 }).data.probability_pct).toBe(100);
  });
  it("rejects negative expected_cents", () => {
    expect(oppValidateInsert({ ...okOpp, expected_cents: -1 }).error).toMatch(/expected_cents/);
  });
  it("rejects non-integer expected_cents", () => {
    expect(oppValidateInsert({ ...okOpp, expected_cents: 42.5 }).error).toMatch(/expected_cents/);
  });
  it("accepts expected_cents=0", () => {
    expect(oppValidateInsert({ ...okOpp, expected_cents: 0 }).data.expected_cents).toBe(0);
  });
  it("rejects malformed expected_close_date", () => {
    expect(oppValidateInsert({ ...okOpp, expected_close_date: "soon" }).error).toMatch(/expected_close_date/);
  });
  it("accepts ISO expected_close_date", () => {
    expect(oppValidateInsert({ ...okOpp, expected_close_date: "2026-09-30" }).data.expected_close_date)
      .toBe("2026-09-30");
  });
  it("rejects non-uuid customer_id", () => {
    expect(oppValidateInsert({ ...okOpp, customer_id: "x" }).error).toMatch(/customer_id/);
  });
  it("rejects non-uuid owner_user_id", () => {
    expect(oppValidateInsert({ ...okOpp, owner_user_id: "x" }).error).toMatch(/owner_user_id/);
  });
  it("rejects malformed opportunity_number", () => {
    expect(oppValidateInsert({ ...okOpp, opportunity_number: "OPP-26-1" }).error).toMatch(/opportunity_number/);
  });
  it("accepts a well-formed opportunity_number override", () => {
    expect(oppValidateInsert({ ...okOpp, opportunity_number: "OPP-2026-00042" }).data.opportunity_number)
      .toBe("OPP-2026-00042");
  });
  it("rejects non-object metadata", () => {
    expect(oppValidateInsert({ ...okOpp, metadata: "string" }).error).toMatch(/metadata/);
    expect(oppValidateInsert({ ...okOpp, metadata: [] }).error).toMatch(/metadata/);
  });
  it("preserves metadata object", () => {
    expect(oppValidateInsert({ ...okOpp, metadata: { source: "trade-show" } }).data.metadata)
      .toEqual({ source: "trade-show" });
  });
});

describe("crm opportunities validatePatch", () => {
  it("empty body → empty data", () => {
    expect(oppValidatePatch({}).data).toEqual({});
  });
  it("rejects locked entity_id", () => {
    expect(oppValidatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
  });
  it("rejects locked opportunity_number", () => {
    expect(oppValidatePatch({ opportunity_number: "OPP-2026-00001" }).error).toMatch(/opportunity_number/);
  });
  it("rejects locked stage with helpful pointer", () => {
    const e = oppValidatePatch({ stage: "won" }).error;
    expect(e).toMatch(/stage/);
    expect(e).toMatch(/opportunities\/:id\/stage/);
  });
  it("rejects locked stage_changed_at", () => {
    expect(oppValidatePatch({ stage_changed_at: "2026-05-28" }).error).toMatch(/stage_changed_at/);
  });
  it("accepts title change", () => {
    expect(oppValidatePatch({ title: "Fall buy" }).data.title).toBe("Fall buy");
  });
  it("rejects empty title patch", () => {
    expect(oppValidatePatch({ title: "   " }).error).toMatch(/title/);
  });
  it("trims title patch", () => {
    expect(oppValidatePatch({ title: "  fix  " }).data.title).toBe("fix");
  });
  it("allows clearing owner_user_id with null", () => {
    expect(oppValidatePatch({ owner_user_id: null }).data.owner_user_id).toBeNull();
  });
  it("rejects non-uuid owner_user_id", () => {
    expect(oppValidatePatch({ owner_user_id: "x" }).error).toMatch(/owner_user_id/);
  });
  it("accepts customer_id change", () => {
    expect(oppValidatePatch({ customer_id: UUID }).data.customer_id).toBe(UUID);
  });
  it("rejects malformed expected_close_date", () => {
    expect(oppValidatePatch({ expected_close_date: "soon" }).error).toMatch(/expected_close_date/);
  });
  it("accepts cleared expected_close_date", () => {
    expect(oppValidatePatch({ expected_close_date: null }).data.expected_close_date).toBeNull();
  });
  it("rejects bad probability_pct", () => {
    expect(oppValidatePatch({ probability_pct: 150 }).error).toMatch(/probability_pct/);
    expect(oppValidatePatch({ probability_pct: 12.5 }).error).toMatch(/probability_pct/);
  });
  it("accepts valid probability_pct", () => {
    expect(oppValidatePatch({ probability_pct: 75 }).data.probability_pct).toBe(75);
  });
  it("rejects bad expected_cents", () => {
    expect(oppValidatePatch({ expected_cents: -10 }).error).toMatch(/expected_cents/);
  });
  it("clears expected_cents to null", () => {
    expect(oppValidatePatch({ expected_cents: null }).data.expected_cents).toBeNull();
  });
  it("accepts loss_reason text", () => {
    expect(oppValidatePatch({ loss_reason: "Price too high" }).data.loss_reason).toBe("Price too high");
  });
  it("multi-field patch composes correctly", () => {
    const v = oppValidatePatch({
      title: "Updated",
      probability_pct: 80,
      owner_user_id: UUID2,
    });
    expect(v.data.title).toBe("Updated");
    expect(v.data.probability_pct).toBe(80);
    expect(v.data.owner_user_id).toBe(UUID2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// OPPORTUNITIES — stage change RPC body validator
// ────────────────────────────────────────────────────────────────────────

describe("crm opportunities stage validateBody", () => {
  it("rejects non-object body", () => {
    expect(oppStageValidateBody(null).error).toMatch(/object/);
    expect(oppStageValidateBody("x").error).toMatch(/object/);
  });
  it("rejects missing stage", () => {
    expect(oppStageValidateBody({}).error).toMatch(/stage/);
  });
  it("rejects unknown stage", () => {
    expect(oppStageValidateBody({ stage: "archived" }).error).toMatch(/stage/);
  });
  it("accepts every valid stage", () => {
    for (const s of ["new", "qualified", "proposal", "won", "lost"]) {
      expect(oppStageValidateBody({ stage: s }).data.stage).toBe(s);
    }
  });
  it("rejects non-uuid actor_user_id", () => {
    expect(oppStageValidateBody({ stage: "won", actor_user_id: "x" }).error).toMatch(/actor_user_id/);
  });
  it("accepts valid actor_user_id", () => {
    expect(oppStageValidateBody({ stage: "won", actor_user_id: UUID }).data.actor_user_id).toBe(UUID);
  });
  it("rejects reason over 2000 chars", () => {
    expect(oppStageValidateBody({ stage: "lost", reason: "x".repeat(2001) }).error).toMatch(/reason/);
  });
  it("preserves reason text", () => {
    expect(oppStageValidateBody({ stage: "lost", reason: "Price" }).data.reason).toBe("Price");
  });
  it("defaults reason + actor_user_id to null", () => {
    const v = oppStageValidateBody({ stage: "qualified" });
    expect(v.data.reason).toBeNull();
    expect(v.data.actor_user_id).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// ACTIVITIES
// ════════════════════════════════════════════════════════════════════════

describe("crm activities parseListQuery", () => {
  it("accepts empty params", () => {
    const v = actParseListQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.limit).toBe(100);
    expect(v.data.include_hidden).toBe(false);
  });
  it("rejects non-uuid customer_id", () => {
    expect(actParseListQuery({ customer_id: "x" }).error).toMatch(/customer_id/);
  });
  it("rejects non-uuid opportunity_id", () => {
    expect(actParseListQuery({ opportunity_id: "x" }).error).toMatch(/opportunity_id/);
  });
  it("rejects unknown activity_type", () => {
    expect(actParseListQuery({ activity_type: "ping" }).error).toMatch(/activity_type/);
  });
  it("accepts all 8 valid activity_types", () => {
    for (const t of ["note", "call", "email_in", "email_out", "meeting", "task_done", "stage_change", "system"]) {
      expect(actParseListQuery({ activity_type: t }).data.activity_type).toBe(t);
    }
  });
  it("rejects bad from date", () => {
    expect(actParseListQuery({ from: "yesterday" }).error).toMatch(/from/);
  });
  it("rejects bad to date", () => {
    expect(actParseListQuery({ to: "soon" }).error).toMatch(/to/);
  });
  it("accepts valid YYYY-MM-DD from/to", () => {
    const v = actParseListQuery({ from: "2026-01-01", to: "2026-12-31" });
    expect(v.data.from).toBe("2026-01-01");
    expect(v.data.to).toBe("2026-12-31");
  });
  it("parses include_hidden=true", () => {
    expect(actParseListQuery({ include_hidden: "true" }).data.include_hidden).toBe(true);
  });
  it("treats include_hidden=anything-else as false", () => {
    expect(actParseListQuery({ include_hidden: "yes" }).data.include_hidden).toBe(false);
    expect(actParseListQuery({ include_hidden: "1" }).data.include_hidden).toBe(false);
  });
});

const okAct = { activity_type: "note", subject: "Called customer" };

describe("crm activities validateInsert", () => {
  it("accepts a minimal valid body", () => {
    const v = actValidateInsert(okAct);
    expect(v.error).toBeUndefined();
    expect(v.data.activity_type).toBe("note");
    expect(v.data.subject).toBe("Called customer");
  });
  it("rejects missing subject", () => {
    expect(actValidateInsert({ activity_type: "note" }).error).toMatch(/subject/);
  });
  it("rejects whitespace-only subject", () => {
    expect(actValidateInsert({ activity_type: "note", subject: "   " }).error).toMatch(/subject/);
  });
  it("rejects missing activity_type", () => {
    expect(actValidateInsert({ subject: "x" }).error).toMatch(/activity_type/);
  });
  it("rejects unknown activity_type", () => {
    expect(actValidateInsert({ ...okAct, activity_type: "pinged" }).error).toMatch(/activity_type/);
  });
  it("rejects stage_change manually (trigger-only)", () => {
    expect(actValidateInsert({ ...okAct, activity_type: "stage_change" }).error).toMatch(/reserved/);
  });
  it("rejects task_done manually (trigger-only)", () => {
    expect(actValidateInsert({ ...okAct, activity_type: "task_done" }).error).toMatch(/reserved/);
  });
  it("accepts user-facing activity types", () => {
    for (const t of ["note", "call", "email_in", "email_out", "meeting", "system"]) {
      expect(actValidateInsert({ subject: "x", activity_type: t }).data.activity_type).toBe(t);
    }
  });
  it("rejects negative duration_minutes", () => {
    expect(actValidateInsert({ ...okAct, duration_minutes: -1 }).error).toMatch(/duration_minutes/);
  });
  it("rejects non-integer duration_minutes", () => {
    expect(actValidateInsert({ ...okAct, duration_minutes: 12.5 }).error).toMatch(/duration_minutes/);
  });
  it("accepts duration_minutes=0", () => {
    expect(actValidateInsert({ ...okAct, duration_minutes: 0 }).data.duration_minutes).toBe(0);
  });
  it("rejects non-object payload", () => {
    expect(actValidateInsert({ ...okAct, payload: "x" }).error).toMatch(/payload/);
    expect(actValidateInsert({ ...okAct, payload: [] }).error).toMatch(/payload/);
  });
  it("accepts payload object", () => {
    expect(actValidateInsert({ ...okAct, payload: { src: "test" } }).data.payload)
      .toEqual({ src: "test" });
  });
  it("rejects bad occurred_at", () => {
    expect(actValidateInsert({ ...okAct, occurred_at: "yesterday" }).error).toMatch(/occurred_at/);
  });
  it("accepts ISO occurred_at", () => {
    expect(actValidateInsert({ ...okAct, occurred_at: "2026-05-28T10:00:00Z" }).data.occurred_at)
      .toBe("2026-05-28T10:00:00Z");
  });
  it("trims external_email", () => {
    expect(actValidateInsert({ ...okAct, external_email: "  a@b.com  " }).data.external_email)
      .toBe("a@b.com");
  });
  it("rejects non-uuid customer_id / opportunity_id / case_id", () => {
    expect(actValidateInsert({ ...okAct, customer_id: "x" }).error).toMatch(/customer_id/);
    expect(actValidateInsert({ ...okAct, opportunity_id: "x" }).error).toMatch(/opportunity_id/);
    expect(actValidateInsert({ ...okAct, case_id: "x" }).error).toMatch(/case_id/);
  });
});

describe("crm activities validatePatch", () => {
  it("rejects missing is_hidden", () => {
    expect(actValidatePatch({}).error).toMatch(/is_hidden/);
  });
  it("rejects any other key", () => {
    expect(actValidatePatch({ subject: "x" }).error).toMatch(/subject/);
    expect(actValidatePatch({ body: "x" }).error).toMatch(/body/);
    expect(actValidatePatch({ payload: {} }).error).toMatch(/payload/);
    expect(actValidatePatch({ is_hidden: true, subject: "x" }).error).toMatch(/subject/);
  });
  it("rejects non-boolean is_hidden", () => {
    expect(actValidatePatch({ is_hidden: "true" }).error).toMatch(/boolean/);
    expect(actValidatePatch({ is_hidden: 1 }).error).toMatch(/boolean/);
  });
  it("accepts is_hidden=true", () => {
    expect(actValidatePatch({ is_hidden: true }).data.is_hidden).toBe(true);
  });
  it("accepts is_hidden=false", () => {
    expect(actValidatePatch({ is_hidden: false }).data.is_hidden).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// TASKS
// ════════════════════════════════════════════════════════════════════════

describe("crm tasks parseListQuery", () => {
  it("accepts empty params", () => {
    const v = taskParseListQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.limit).toBe(100);
  });
  it("rejects unknown status", () => {
    expect(taskParseListQuery({ status: "stalled" }).error).toMatch(/status/);
  });
  it("accepts all four statuses", () => {
    for (const s of ["open", "in_progress", "done", "cancelled"]) {
      expect(taskParseListQuery({ status: s }).data.status).toBe(s);
    }
  });
  it("rejects non-uuid assignee_user_id", () => {
    expect(taskParseListQuery({ assignee_user_id: "x" }).error).toMatch(/assignee_user_id/);
  });
  it("rejects non-uuid customer_id", () => {
    expect(taskParseListQuery({ customer_id: "x" }).error).toMatch(/customer_id/);
  });
  it("rejects non-uuid opportunity_id", () => {
    expect(taskParseListQuery({ opportunity_id: "x" }).error).toMatch(/opportunity_id/);
  });
  it("rejects bad due_before date", () => {
    expect(taskParseListQuery({ due_before: "soon" }).error).toMatch(/due_before/);
  });
  it("accepts valid due_before", () => {
    expect(taskParseListQuery({ due_before: "2026-12-31" }).data.due_before).toBe("2026-12-31");
  });
});

const okTask = { title: "Follow up with Walmart" };

describe("crm tasks validateInsert", () => {
  it("accepts a minimal valid body", () => {
    const v = taskValidateInsert(okTask);
    expect(v.error).toBeUndefined();
    expect(v.data.title).toBe("Follow up with Walmart");
    expect(v.data.status).toBe("open");
    expect(v.data.priority).toBe("normal");
  });
  it("rejects missing title", () => {
    expect(taskValidateInsert({}).error).toMatch(/title/);
  });
  it("rejects whitespace-only title", () => {
    expect(taskValidateInsert({ title: "   " }).error).toMatch(/title/);
  });
  it("rejects unknown status", () => {
    expect(taskValidateInsert({ ...okTask, status: "queued" }).error).toMatch(/status/);
  });
  it("rejects unknown priority", () => {
    expect(taskValidateInsert({ ...okTask, priority: "asap" }).error).toMatch(/priority/);
  });
  it("accepts all four priorities", () => {
    for (const p of ["low", "normal", "high", "urgent"]) {
      expect(taskValidateInsert({ ...okTask, priority: p }).data.priority).toBe(p);
    }
  });
  it("rejects bad due_date", () => {
    expect(taskValidateInsert({ ...okTask, due_date: "soon" }).error).toMatch(/due_date/);
  });
  it("accepts ISO due_date", () => {
    expect(taskValidateInsert({ ...okTask, due_date: "2026-06-15" }).data.due_date).toBe("2026-06-15");
  });
  it("rejects non-uuid assignee_user_id", () => {
    expect(taskValidateInsert({ ...okTask, assignee_user_id: "x" }).error).toMatch(/assignee_user_id/);
  });
  it("rejects non-uuid opportunity_id", () => {
    expect(taskValidateInsert({ ...okTask, opportunity_id: "x" }).error).toMatch(/opportunity_id/);
  });
});

describe("crm tasks validatePatch", () => {
  it("empty body → empty data", () => {
    expect(taskValidatePatch({}).data).toEqual({});
  });
  it("rejects locked completed_at", () => {
    expect(taskValidatePatch({ completed_at: "2026-05-28" }).error).toMatch(/completed_at/);
  });
  it("rejects locked completed_by_user_id", () => {
    expect(taskValidatePatch({ completed_by_user_id: UUID }).error).toMatch(/completed_by_user_id/);
  });
  it("rejects locked entity_id", () => {
    expect(taskValidatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
  });
  it("accepts status flip to done", () => {
    expect(taskValidatePatch({ status: "done" }).data.status).toBe("done");
  });
  it("rejects empty title patch", () => {
    expect(taskValidatePatch({ title: "   " }).error).toMatch(/title/);
  });
  it("accepts priority flip", () => {
    expect(taskValidatePatch({ priority: "urgent" }).data.priority).toBe("urgent");
  });
  it("allows clearing assignee_user_id with null", () => {
    expect(taskValidatePatch({ assignee_user_id: null }).data.assignee_user_id).toBeNull();
  });
  it("allows clearing assignee_user_id with empty string", () => {
    expect(taskValidatePatch({ assignee_user_id: "" }).data.assignee_user_id).toBeNull();
  });
  it("clears due_date with null", () => {
    expect(taskValidatePatch({ due_date: null }).data.due_date).toBeNull();
  });
  it("multi-field patch composes correctly", () => {
    const v = taskValidatePatch({
      status: "in_progress",
      priority: "high",
      assignee_user_id: UUID2,
    });
    expect(v.data.status).toBe("in_progress");
    expect(v.data.priority).toBe("high");
    expect(v.data.assignee_user_id).toBe(UUID2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// PIPELINE REPORT — pure aggregator + parser
// ════════════════════════════════════════════════════════════════════════

describe("crm pipeline-report parseQuery", () => {
  it("accepts empty params", () => {
    const v = pipelineParseQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.owner_user_id).toBeNull();
    expect(v.data.customer_id).toBeNull();
  });
  it("rejects non-uuid owner_user_id", () => {
    expect(pipelineParseQuery({ owner_user_id: "x" }).error).toMatch(/owner_user_id/);
  });
  it("rejects non-uuid customer_id", () => {
    expect(pipelineParseQuery({ customer_id: "x" }).error).toMatch(/customer_id/);
  });
  it("preserves valid uuid filters", () => {
    const v = pipelineParseQuery({ owner_user_id: UUID, customer_id: UUID2 });
    expect(v.data.owner_user_id).toBe(UUID);
    expect(v.data.customer_id).toBe(UUID2);
  });
});

describe("crm pipeline-report aggregateByStage", () => {
  it("returns all 5 stages zero-filled on empty input", () => {
    const r = aggregateByStage([]);
    expect(r.stages.map((s) => s.stage)).toEqual(["new", "qualified", "proposal", "won", "lost"]);
    expect(r.stages.every((s) => s.count === 0 && s.weighted_value_cents === 0)).toBe(true);
    expect(r.total_count).toBe(0);
    expect(r.total_value_cents).toBe(0);
    expect(r.total_weighted_cents).toBe(0);
  });
  it("computes count + total_value_cents", () => {
    const r = aggregateByStage([
      { stage: "new", expected_cents: 1000, probability_pct: 10 },
      { stage: "new", expected_cents: 2000, probability_pct: 10 },
      { stage: "won", expected_cents: 5000, probability_pct: 100 },
    ]);
    const newRow = r.stages.find((s) => s.stage === "new");
    const wonRow = r.stages.find((s) => s.stage === "won");
    expect(newRow.count).toBe(2);
    expect(newRow.total_value_cents).toBe(3000);
    expect(wonRow.count).toBe(1);
    expect(wonRow.total_value_cents).toBe(5000);
    expect(r.total_count).toBe(3);
    expect(r.total_value_cents).toBe(8000);
  });
  it("computes weighted = expected × probability / 100", () => {
    const r = aggregateByStage([
      { stage: "proposal", expected_cents: 10000, probability_pct: 75 },
    ]);
    const propRow = r.stages.find((s) => s.stage === "proposal");
    expect(propRow.weighted_value_cents).toBe(7500);  // 10000 * 75 / 100
    expect(r.total_weighted_cents).toBe(7500);
  });
  it("rounds weighted sum (probability 33% on $1.00)", () => {
    const r = aggregateByStage([
      { stage: "qualified", expected_cents: 100, probability_pct: 33 },
    ]);
    // 100 * 33 / 100 = 33 exactly
    expect(r.stages.find((s) => s.stage === "qualified").weighted_value_cents).toBe(33);
  });
  it("treats null expected_cents as 0", () => {
    const r = aggregateByStage([
      { stage: "new", expected_cents: null, probability_pct: 50 },
    ]);
    const newRow = r.stages.find((s) => s.stage === "new");
    expect(newRow.count).toBe(1);
    expect(newRow.total_value_cents).toBe(0);
    expect(newRow.weighted_value_cents).toBe(0);
  });
  it("ignores rows with an unknown stage (defensive)", () => {
    const r = aggregateByStage([
      { stage: "alien", expected_cents: 9999, probability_pct: 100 },
      { stage: "new", expected_cents: 1, probability_pct: 50 },
    ]);
    expect(r.total_count).toBe(1);
    expect(r.total_value_cents).toBe(1);
  });
  it("sums totals across all stages", () => {
    const r = aggregateByStage([
      { stage: "new",       expected_cents: 1000, probability_pct: 10 },
      { stage: "qualified", expected_cents: 2000, probability_pct: 25 },
      { stage: "proposal",  expected_cents: 3000, probability_pct: 50 },
      { stage: "won",       expected_cents: 4000, probability_pct: 100 },
      { stage: "lost",      expected_cents: 5000, probability_pct: 0 },
    ]);
    // weighted = 100 + 500 + 1500 + 4000 + 0 = 6100
    expect(r.total_weighted_cents).toBe(6100);
    expect(r.total_value_cents).toBe(15000);
    expect(r.total_count).toBe(5);
  });
  it("handles missing rows array gracefully", () => {
    const r = aggregateByStage(null);
    expect(r.total_count).toBe(0);
    expect(r.stages.length).toBe(5);
  });
});
