// @vitest-environment jsdom
//
// Unit tests for the PLM permission helpers. The session-backed helpers
// (canSeeCostingTabFromSession, getAtsReportPermissionsFromSession) drive
// the actual UI gates in TechPack.tsx (Costing tab) and NavBar.tsx (ATS
// Reports menu), so the contract here is what's actually shipped to
// operators.
//
// Default-true semantics is the load-bearing rule: any missing entry in
// the session blob must map to "access granted" so users that pre-date a
// new permission gate keep working without manual migration.

import { describe, it, expect, beforeEach } from "vitest";
import {
  ATS_REPORT_KEYS,
  ADMIN_PERMISSION,
  DEFAULT_PERMISSION,
  canSeeCostingTabFromSession,
  canSeeVendorPortalCard,
  getAppPermission,
  getAtsReportPermissionsFromSession,
  getAtsReportsPermissions,
  type PermissionUser,
} from "../permissions";

function setSessionUser(u: PermissionUser | null) {
  if (u === null) {
    sessionStorage.removeItem("plm_user");
  } else {
    sessionStorage.setItem("plm_user", JSON.stringify(u));
  }
}

describe("permissions — pure resolvers", () => {
  describe("getAppPermission", () => {
    it("returns ADMIN_PERMISSION for admins regardless of stored config", () => {
      const u: PermissionUser = {
        role: "admin",
        permissions: { ats: { access: false, readOnly: true, seeOthersData: false } },
      };
      expect(getAppPermission(u, "ats")).toEqual(ADMIN_PERMISSION);
    });

    it("returns the stored permission for non-admins when present", () => {
      const u: PermissionUser = {
        role: "user",
        permissions: { vendor: { access: true, readOnly: false, seeOthersData: false } },
      };
      expect(getAppPermission(u, "vendor").access).toBe(true);
    });

    it("falls back to DEFAULT_PERMISSION for non-admins with no entry", () => {
      const u: PermissionUser = { role: "user", permissions: {} };
      expect(getAppPermission(u, "costing")).toEqual(DEFAULT_PERMISSION);
    });
  });

  describe("getAtsReportsPermissions — default-true semantics", () => {
    it("returns all reports enabled for admins", () => {
      const u: PermissionUser = { role: "admin" };
      const perms = getAtsReportsPermissions(u);
      for (const k of ATS_REPORT_KEYS) expect(perms[k]).toBe(true);
    });

    it("returns all reports enabled when ATS access granted but no reports block", () => {
      const u: PermissionUser = {
        role: "user",
        permissions: { ats: { access: true, readOnly: false, seeOthersData: false } },
      };
      const perms = getAtsReportsPermissions(u);
      for (const k of ATS_REPORT_KEYS) expect(perms[k]).toBe(true);
    });

    it("returns all reports enabled for a user with no permissions object at all", () => {
      const u: PermissionUser = { role: "user" };
      const perms = getAtsReportsPermissions(u);
      for (const k of ATS_REPORT_KEYS) expect(perms[k]).toBe(true);
    });

    it("opts the user out of an individual report only when the key is explicitly false", () => {
      const u: PermissionUser = {
        role: "user",
        permissions: {
          ats: {
            access: true,
            readOnly: false,
            seeOthersData: false,
            reports: { salesComps: false },
          },
        },
      };
      const perms = getAtsReportsPermissions(u);
      expect(perms.salesComps).toBe(false);
      // Every other report is still on.
      expect(perms.exportExcel).toBe(true);
      expect(perms.negInven).toBe(true);
      expect(perms.agedInven).toBe(true);
      expect(perms.noMrgnData).toBe(true);
      expect(perms.stockVsSo).toBe(true);
    });
  });

  describe("canSeeVendorPortalCard", () => {
    it("admins always see the card", () => {
      const u: PermissionUser = { role: "admin" };
      expect(canSeeVendorPortalCard(u)).toBe(true);
    });

    it("non-admins without permissions.vendor.access do NOT see the card", () => {
      const u: PermissionUser = { role: "user", permissions: {} };
      expect(canSeeVendorPortalCard(u)).toBe(false);
    });

    it("non-admins WITH permissions.vendor.access === true see the card", () => {
      const u: PermissionUser = {
        role: "user",
        permissions: { vendor: { access: true, readOnly: false, seeOthersData: false } },
      };
      expect(canSeeVendorPortalCard(u)).toBe(true);
    });
  });
});

describe("permissions — session-backed gates", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  describe("getAtsReportPermissionsFromSession", () => {
    it("returns all-on when there is no session blob", () => {
      const perms = getAtsReportPermissionsFromSession();
      for (const k of ATS_REPORT_KEYS) expect(perms[k]).toBe(true);
    });

    it("returns all-on when the session blob can't be parsed", () => {
      sessionStorage.setItem("plm_user", "{not valid JSON");
      const perms = getAtsReportPermissionsFromSession();
      for (const k of ATS_REPORT_KEYS) expect(perms[k]).toBe(true);
    });

    it("hides the salesComps report when the user is opted out", () => {
      setSessionUser({
        role: "user",
        permissions: {
          ats: {
            access: true,
            readOnly: false,
            seeOthersData: false,
            reports: { salesComps: false },
          },
        },
      });
      const perms = getAtsReportPermissionsFromSession();
      expect(perms.salesComps).toBe(false);
      expect(perms.exportExcel).toBe(true);
    });

    it("defaults all 6 reports to accessible when ATS access is on but reports is missing", () => {
      setSessionUser({
        role: "user",
        permissions: {
          ats: { access: true, readOnly: false, seeOthersData: false },
        },
      });
      const perms = getAtsReportPermissionsFromSession();
      for (const k of ATS_REPORT_KEYS) expect(perms[k]).toBe(true);
    });

    it("returns all-on for admins, ignoring stored opt-outs", () => {
      setSessionUser({
        role: "admin",
        permissions: {
          ats: {
            access: false,
            readOnly: true,
            seeOthersData: false,
            reports: { salesComps: false, negInven: false },
          },
        },
      });
      const perms = getAtsReportPermissionsFromSession();
      for (const k of ATS_REPORT_KEYS) expect(perms[k]).toBe(true);
    });
  });

  describe("canSeeCostingTabFromSession", () => {
    it("returns true with no session", () => {
      expect(canSeeCostingTabFromSession()).toBe(true);
    });

    it("returns true for admins regardless of stored config", () => {
      setSessionUser({
        role: "admin",
        permissions: { costing: { access: false, readOnly: false, seeOthersData: false } },
      });
      expect(canSeeCostingTabFromSession()).toBe(true);
    });

    it("returns false for non-admins explicitly opted out", () => {
      setSessionUser({
        role: "user",
        permissions: { costing: { access: false, readOnly: false, seeOthersData: false } },
      });
      expect(canSeeCostingTabFromSession()).toBe(false);
    });

    it("returns true for non-admins with no costing entry (default-true)", () => {
      setSessionUser({ role: "user", permissions: {} });
      expect(canSeeCostingTabFromSession()).toBe(true);
    });

    it("returns true when the session blob can't be parsed", () => {
      sessionStorage.setItem("plm_user", "{not valid JSON");
      expect(canSeeCostingTabFromSession()).toBe(true);
    });
  });
});
