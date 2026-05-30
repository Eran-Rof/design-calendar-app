// Tests for the P10-6 COA copy-from-ROF handler.
// Pure-JS — exercises the helper exports (getEntityId, isUuid, projectRowForCopy).
// Full DB integration is covered by deploy smoke + the multi-entity tests.

import { describe, it, expect } from "vitest";
import {
  getEntityId,
  isUuid,
  projectRowForCopy,
} from "../../_handlers/internal/entities/[id]/coa-copy.js";

describe("isUuid", () => {
  it("accepts well-formed UUIDs", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isUuid("11111111-1111-1111-1111-111111111111")).toBe(true);
  });
  it("accepts uppercase UUIDs (case-insensitive)", () => {
    expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });
  it("rejects non-strings", () => {
    expect(isUuid(123)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid({})).toBe(false);
  });
  it("rejects malformed UUIDs", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("550e8400-e29b-41d4-a716")).toBe(false); // too short
    expect(isUuid("550e8400e29b41d4a716446655440000")).toBe(false); // no dashes
  });
});

describe("getEntityId", () => {
  it("returns req.query.id when present (dispatcher path)", () => {
    expect(getEntityId({ query: { id: "abc-123" } })).toBe("abc-123");
  });
  it("parses the path when query is empty (fallback)", () => {
    const req = { query: {}, url: "/api/internal/entities/xyz-456/coa-copy-from-rof" };
    expect(getEntityId(req)).toBe("xyz-456");
  });
  it("handles trailing slashes in the URL", () => {
    const req = { query: {}, url: "/api/internal/entities/aaa-111/coa-copy-from-rof/" };
    expect(getEntityId(req)).toBe("aaa-111");
  });
  it("strips query strings from the URL when parsing", () => {
    const req = { query: {}, url: "/api/internal/entities/qqq-222/coa-copy-from-rof?foo=bar" };
    expect(getEntityId(req)).toBe("qqq-222");
  });
  it("returns null when entities segment is absent", () => {
    expect(getEntityId({ query: {}, url: "/api/internal/something-else" })).toBeNull();
  });
});

describe("projectRowForCopy", () => {
  const TARGET = "11111111-1111-1111-1111-111111111111";
  const SRC = {
    code: "1000",
    name: "Cash",
    account_type: "asset",
    account_subtype: "current_asset",
    normal_balance: "DEBIT",
    is_postable: true,
    is_control: false,
    status: "active",
    description: "Main checking",
  };

  it("preserves code/name/type/subtype/normal_balance verbatim", () => {
    const out = projectRowForCopy(SRC, TARGET);
    expect(out.code).toBe("1000");
    expect(out.name).toBe("Cash");
    expect(out.account_type).toBe("asset");
    expect(out.account_subtype).toBe("current_asset");
    expect(out.normal_balance).toBe("DEBIT");
  });

  it("attaches the target entity_id", () => {
    expect(projectRowForCopy(SRC, TARGET).entity_id).toBe(TARGET);
  });

  it("nulls out parent_account_id (source IDs do not exist in target)", () => {
    expect(projectRowForCopy(SRC, TARGET).parent_account_id).toBeNull();
  });

  it("preserves is_postable=false (roll-up rows)", () => {
    const out = projectRowForCopy({ ...SRC, is_postable: false }, TARGET);
    expect(out.is_postable).toBe(false);
  });

  it("preserves is_control=true (AR / AP control accounts)", () => {
    const out = projectRowForCopy({ ...SRC, is_control: true }, TARGET);
    expect(out.is_control).toBe(true);
  });

  it("defaults missing is_postable to true", () => {
    const { is_postable: _drop, ...rest } = SRC;
    void _drop;
    expect(projectRowForCopy(rest, TARGET).is_postable).toBe(true);
  });

  it("defaults missing is_control to false", () => {
    const { is_control: _drop, ...rest } = SRC;
    void _drop;
    expect(projectRowForCopy(rest, TARGET).is_control).toBe(false);
  });

  it("defaults missing status to 'active'", () => {
    const { status: _drop, ...rest } = SRC;
    void _drop;
    expect(projectRowForCopy(rest, TARGET).status).toBe("active");
  });

  it("preserves explicit status='inactive' if source was inactive (but resolveSrc filters first in practice)", () => {
    expect(projectRowForCopy({ ...SRC, status: "inactive" }, TARGET).status).toBe("inactive");
  });

  it("preserves description verbatim", () => {
    expect(projectRowForCopy(SRC, TARGET).description).toBe("Main checking");
  });

  it("normalizes null description to null", () => {
    const out = projectRowForCopy({ ...SRC, description: null }, TARGET);
    expect(out.description).toBeNull();
  });

  it("normalizes undefined description to null", () => {
    const { description: _drop, ...rest } = SRC;
    void _drop;
    expect(projectRowForCopy(rest, TARGET).description).toBeNull();
  });

  it("normalizes null account_subtype to null", () => {
    expect(projectRowForCopy({ ...SRC, account_subtype: null }, TARGET).account_subtype).toBeNull();
  });

  it("does NOT carry the source entity_id through (always uses target)", () => {
    const out = projectRowForCopy({ ...SRC, entity_id: "src-entity-id" }, TARGET);
    expect(out.entity_id).toBe(TARGET);
  });

  it("does NOT carry the source id through (no id field on result)", () => {
    const out = projectRowForCopy({ ...SRC, id: "src-row-id" }, TARGET);
    expect("id" in out).toBe(false);
  });

  it("does NOT carry created_at / updated_at / created_by_user_id", () => {
    const out = projectRowForCopy({ ...SRC, created_at: "2024-01-01", updated_at: "2024-01-02", created_by_user_id: "u1" }, TARGET);
    expect("created_at" in out).toBe(false);
    expect("updated_at" in out).toBe(false);
    expect("created_by_user_id" in out).toBe(false);
  });

  it("handles all account_type values without re-derivation", () => {
    for (const t of ["asset", "liability", "equity", "revenue", "expense", "contra_asset", "contra_revenue"]) {
      expect(projectRowForCopy({ ...SRC, account_type: t }, TARGET).account_type).toBe(t);
    }
  });
});
