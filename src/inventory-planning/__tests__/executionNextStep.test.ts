import { describe, it, expect } from "vitest";
import { nextStepFor, styleOf } from "../execution/panels/nextStep";
import type { IpExecutionBatchStatus } from "../execution/types/execution";
import type { TangerinePoResult } from "../execution/services/tangerinePoService";

function batch(status: IpExecutionBatchStatus) {
  return { status };
}

function preview(over: Partial<TangerinePoResult>): TangerinePoResult {
  return {
    dry_run: true,
    created: [],
    skipped: [],
    warnings: [],
    vendor_suggestions: [],
    diagnostics: null,
    message: "",
    ...over,
  };
}

const CAN = { canApproveBatch: true, posCreated: false };
const CANT = { canApproveBatch: false, posCreated: false };

describe("styleOf", () => {
  it("strips the color suffix after the last dash", () => {
    expect(styleOf("ABC123-BLK")).toBe("ABC123");
    expect(styleOf("ABC-123-WHT")).toBe("ABC-123");
  });
  it("returns the whole code when there is no dash", () => {
    expect(styleOf("ABC123")).toBe("ABC123");
    expect(styleOf("")).toBe("");
  });
});

describe("nextStepFor", () => {
  it("draft → move to ready", () => {
    const ns = nextStepFor(batch("draft"), null, CAN);
    expect(ns.primary?.kind).toBe("moveReady");
    expect(ns.tone).toBe("action");
  });

  it("ready + can approve → approve", () => {
    const ns = nextStepFor(batch("ready"), null, CAN);
    expect(ns.primary?.kind).toBe("approve");
    expect(ns.tone).toBe("action");
  });

  it("ready without permission → blocked, no primary", () => {
    const ns = nextStepFor(batch("ready"), null, CANT);
    expect(ns.tone).toBe("blocked");
    expect(ns.primary).toBeUndefined();
  });

  it("approved, no preview → preview POs", () => {
    const ns = nextStepFor(batch("approved"), null, CAN);
    expect(ns.primary?.kind).toBe("preview");
  });

  it("exported, no preview → preview POs", () => {
    const ns = nextStepFor(batch("exported"), null, CAN);
    expect(ns.primary?.kind).toBe("preview");
  });

  it("preview clean (no skips) → create POs", () => {
    const p = preview({ diagnostics: { actions_total: 3, vendors: 2, eligible_lines: 3, skipped: 0, warnings: 0, skip_breakdown: {} } });
    const ns = nextStepFor(batch("approved"), p, CAN);
    expect(ns.primary?.kind).toBe("createPos");
    expect(ns.secondary?.kind).toBe("preview");
  });

  it("preview with skips but some eligible → create POs for eligible + re-preview", () => {
    const p = preview({ diagnostics: { actions_total: 5, vendors: 1, eligible_lines: 3, skipped: 2, warnings: 0, skip_breakdown: { no_vendor: 2 } } });
    const ns = nextStepFor(batch("approved"), p, CAN);
    expect(ns.primary?.kind).toBe("createPos");
    expect(ns.title).toContain("2 of 5");
    expect(ns.tone).toBe("action");
  });

  it("preview where every line skips → blocked, no create", () => {
    const p = preview({ diagnostics: { actions_total: 4, vendors: 0, eligible_lines: 0, skipped: 4, warnings: 0, skip_breakdown: { no_vendor: 4 } } });
    const ns = nextStepFor(batch("approved"), p, CAN);
    expect(ns.tone).toBe("blocked");
    expect(ns.primary).toBeUndefined();
    expect(ns.secondary?.kind).toBe("preview");
  });

  it("POs created (live result with po_id) → done + Procurement link", () => {
    const p = preview({
      dry_run: false,
      created: [{ vendor_id: "v1", po_id: "po1", line_count: 2, total_cents: 1000 }],
      diagnostics: { actions_total: 2, vendors: 1, eligible_lines: 2, skipped: 0, warnings: 0, skip_breakdown: {} },
    });
    const ns = nextStepFor(batch("submitted"), p, CAN);
    expect(ns.tone).toBe("done");
    expect(ns.href).toBeTruthy();
  });

  it("posCreated flag (survives refresh, no local preview) → done", () => {
    const ns = nextStepFor(batch("approved"), null, { canApproveBatch: true, posCreated: true });
    expect(ns.tone).toBe("done");
    expect(ns.href).toBeTruthy();
  });

  it("executed → done", () => {
    const ns = nextStepFor(batch("executed"), null, CAN);
    expect(ns.tone).toBe("done");
  });

  it("archived → muted, no action", () => {
    const ns = nextStepFor(batch("archived"), null, CAN);
    expect(ns.tone).toBe("muted");
    expect(ns.primary).toBeUndefined();
  });
});
