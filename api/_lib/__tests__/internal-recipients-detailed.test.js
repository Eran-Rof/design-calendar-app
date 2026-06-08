import { describe, it, expect, beforeEach } from "vitest";
import { resolveInternalRecipientsDetailed } from "../internal-recipients.js";

// Minimal admin double for .from('employees').select(...).eq(...).contains(...)
function mockAdmin(employees) {
  return {
    from() {
      const api = {
        select() { return api; },
        eq() { return api; },
        contains() { return Promise.resolve({ data: employees, error: null }); },
      };
      return api;
    },
  };
}

describe("resolveInternalRecipientsDetailed", () => {
  beforeEach(() => { delete process.env.INTERNAL_PROCUREMENT_EMAILS; });

  it("env-var email → recipient with plm_user_id null (email-only)", async () => {
    process.env.INTERNAL_PROCUREMENT_EMAILS = "buyer@rof.com";
    const out = await resolveInternalRecipientsDetailed(mockAdmin([]), "procurement");
    expect(out.recipients).toEqual([{ email: "buyer@rof.com", plm_user_id: null, apps: null }]);
    expect(out.emails).toEqual(["buyer@rof.com"]);
  });

  it("subscribed employee with plm_user_id → in-app reachable", async () => {
    const admin = mockAdmin([{ email: "pm@rof.com", apps: ["tangerine"], metadata: { plm_user_id: "u-123" } }]);
    const out = await resolveInternalRecipientsDetailed(admin, "procurement");
    expect(out.recipients).toContainEqual({ email: "pm@rof.com", plm_user_id: "u-123", apps: ["tangerine"] });
  });

  it("env email that is ALSO a subscribed employee → enriched + deduped", async () => {
    process.env.INTERNAL_PROCUREMENT_EMAILS = "pm@rof.com";
    const admin = mockAdmin([{ email: "PM@rof.com", apps: null, metadata: { plm_user_id: "u-9" } }]);
    const out = await resolveInternalRecipientsDetailed(admin, "procurement");
    expect(out.recipients).toHaveLength(1);
    expect(out.recipients[0]).toMatchObject({ plm_user_id: "u-9" });
  });

  it("degrades to env-only when the employee lookup throws", async () => {
    process.env.INTERNAL_PROCUREMENT_EMAILS = "buyer@rof.com";
    const admin = { from() { throw new Error("db down"); } };
    const out = await resolveInternalRecipientsDetailed(admin, "procurement");
    expect(out.recipients).toEqual([{ email: "buyer@rof.com", plm_user_id: null, apps: null }]);
  });
});
