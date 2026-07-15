import { describe, it, expect, afterEach } from "vitest";
import { resolveMarginAccess, stripMarginKeys } from "../marginAccess.js";

const savedMode = process.env.RBAC_MODE;
afterEach(() => {
  if (savedMode === undefined) delete process.env.RBAC_MODE;
  else process.env.RBAC_MODE = savedMode;
});

describe("stripMarginKeys", () => {
  it("removes the named keys non-destructively", () => {
    const row = { style: "ABC", margin_cents: 500, margin_pct: 0.25, total: 2000 };
    const out = stripMarginKeys(row, ["margin_cents", "margin_pct"]);
    expect(out).toEqual({ style: "ABC", total: 2000 });
    // original untouched
    expect(row.margin_cents).toBe(500);
  });
  it("tolerates non-objects", () => {
    expect(stripMarginKeys(null, ["x"])).toBe(null);
    expect(stripMarginKeys(undefined, ["x"])).toBe(undefined);
  });
});

describe("resolveMarginAccess — fail-open contract", () => {
  it("returns canView/canExport true when RBAC_MODE is not enforce", async () => {
    process.env.RBAC_MODE = "off";
    const res = await resolveMarginAccess({ headers: {} });
    expect(res.canView).toBe(true);
    expect(res.canExport).toBe(true);
    expect(res.enforcing).toBe(false);
  });

  it("fails open in log mode too", async () => {
    process.env.RBAC_MODE = "log";
    const res = await resolveMarginAccess({ headers: {} });
    expect(res.canView).toBe(true);
    expect(res.canExport).toBe(true);
  });

  it("fails open under enforce when the caller is unidentified (no auth header)", async () => {
    process.env.RBAC_MODE = "enforce";
    // No X-Auth-User-Id → cannot resolve caller → fail open (never blank a
    // legitimate operator on a missing header; the browser attaches it live).
    const res = await resolveMarginAccess({ headers: {} });
    expect(res.canView).toBe(true);
  });
});
