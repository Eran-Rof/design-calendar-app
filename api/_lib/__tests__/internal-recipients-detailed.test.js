import { describe, it, expect, beforeEach } from "vitest";
import { resolveInternalRecipientsDetailed, loadPlmLoginIdsByEmail } from "../internal-recipients.js";

// Table-aware admin double.
//   .from('employees').select(...).eq(...).contains(...)  -> { data: employees }
//   .from('app_data').select(...).eq('key','users').maybeSingle() -> { data: { value } }
// `plmUsers` is the JSON array stored in app_data['users'] (each { id, teamsEmail }).
function mockAdmin(employees, plmUsers = null) {
  return {
    from(table) {
      if (table === "app_data") {
        const api = {
          select() { return api; },
          eq() { return api; },
          maybeSingle() {
            return Promise.resolve({
              data: plmUsers == null ? null : { value: plmUsers },
              error: null,
            });
          },
        };
        return api;
      }
      // employees
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

  // ── AUTO-LINK: email → app_data['users'].teamsEmail → plm_user_id ──────────

  it("env-var recipient with NO employee link gets plm_user_id from a matching PLM login email", async () => {
    process.env.INTERNAL_PROCUREMENT_EMAILS = "buyer@rof.com";
    const plmUsers = [
      { id: "zc3zsp6vs", name: "Eran Bitton", teamsEmail: "eran@rof.com" },
      { id: "abc123xyz", name: "Buyer Person", teamsEmail: "Buyer@ROF.com" }, // different casing on purpose
    ];
    const out = await resolveInternalRecipientsDetailed(mockAdmin([], plmUsers), "procurement");
    // The bell is now reachable WITHOUT any employees.metadata edit.
    expect(out.recipients).toEqual([{ email: "buyer@rof.com", plm_user_id: "abc123xyz", apps: null }]);
  });

  it("employee with no metadata.plm_user_id still gets auto-linked by email", async () => {
    const admin = mockAdmin(
      [{ email: "molly@rof.com", apps: ["tangerine"], metadata: {} }],
      [{ id: "n8ky55vpo", teamsEmail: "molly@rof.com" }],
    );
    const out = await resolveInternalRecipientsDetailed(admin, "procurement");
    expect(out.recipients).toContainEqual({ email: "molly@rof.com", plm_user_id: "n8ky55vpo", apps: ["tangerine"] });
  });

  it("explicit employee metadata link WINS over the email auto-link", async () => {
    const admin = mockAdmin(
      [{ email: "pm@rof.com", apps: null, metadata: { plm_user_id: "explicit-1" } }],
      [{ id: "autolink-2", teamsEmail: "pm@rof.com" }],
    );
    const out = await resolveInternalRecipientsDetailed(admin, "procurement");
    expect(out.recipients[0]).toMatchObject({ plm_user_id: "explicit-1" });
  });

  it("no PLM-login email match → stays email-only (plm_user_id null)", async () => {
    process.env.INTERNAL_PROCUREMENT_EMAILS = "stranger@rof.com";
    const plmUsers = [{ id: "zc3zsp6vs", teamsEmail: "eran@rof.com" }];
    const out = await resolveInternalRecipientsDetailed(mockAdmin([], plmUsers), "procurement");
    expect(out.recipients).toEqual([{ email: "stranger@rof.com", plm_user_id: null, apps: null }]);
  });
});

describe("loadPlmLoginIdsByEmail", () => {
  it("maps lowercased teamsEmail → id, first-seen wins, skips empty emails/ids", async () => {
    const admin = mockAdmin([], [
      { id: "a1", teamsEmail: "Eran@ROF.com" },
      { id: "a2", teamsEmail: "" },                // skip: no email
      { id: "",   teamsEmail: "x@rof.com" },        // skip: no id
      { id: "a3", teamsEmail: "eran@rof.com" },     // dup email, first-seen (a1) wins
      { id: "a4", email: "fallback@rof.com" },       // accepts `email` field too
    ]);
    const map = await loadPlmLoginIdsByEmail(admin);
    expect(map.get("eran@rof.com")).toBe("a1");
    expect(map.get("fallback@rof.com")).toBe("a4");
    expect(map.has("x@rof.com")).toBe(false);
  });

  it("handles a stringified JSON value blob", async () => {
    const admin = mockAdmin([], JSON.stringify([{ id: "s1", teamsEmail: "s@rof.com" }]));
    const map = await loadPlmLoginIdsByEmail(admin);
    expect(map.get("s@rof.com")).toBe("s1");
  });

  it("returns empty Map (never throws) when app_data read fails", async () => {
    const admin = { from() { throw new Error("boom"); } };
    const map = await loadPlmLoginIdsByEmail(admin);
    expect(map.size).toBe(0);
  });

  it("returns empty Map when no users blob exists", async () => {
    const map = await loadPlmLoginIdsByEmail(mockAdmin([], null));
    expect(map.size).toBe(0);
  });
});
