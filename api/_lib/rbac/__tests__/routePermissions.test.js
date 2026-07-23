// @vitest-environment node
import { describe, it, expect } from "vitest";
import { routePermissionFor, MODULE_ACTIONS } from "../routePermissions.js";

describe("routePermissionFor", () => {
  it("maps GET on an internal resource to read", () => {
    expect(routePermissionFor("/api/internal/ar-invoices/abc", "GET")).toEqual({ module: "ar_invoices", action: "read" });
    expect(routePermissionFor("/api/internal/coa", "GET")).toEqual({ module: "coa", action: "read" });
  });

  it("maps create/update writes", () => {
    expect(routePermissionFor("/api/internal/style-master", "POST")).toEqual({ module: "style_master", action: "write" });
    expect(routePermissionFor("/api/internal/vendors/v1", "PUT")).toEqual({ module: "vendor_master", action: "write" });
  });

  it("detects post + void subpaths", () => {
    expect(routePermissionFor("/api/internal/ar-invoices/abc/post", "POST")).toEqual({ module: "ar_invoices", action: "post" });
    expect(routePermissionFor("/api/internal/ar-invoices/abc/void", "POST")).toEqual({ module: "ar_invoices", action: "void" });
    expect(routePermissionFor("/api/internal/ap-invoices/abc/pay", "POST")).toEqual({ module: "ap_invoices", action: "post" });
  });

  it("treats period close/reopen as post-grade on BOTH close surfaces", () => {
    // month-end-close already mapped close/reopen → post; the legacy gl-periods
    // segment used to fall through to write, letting a write-only role (beta)
    // close a GL period. Both must be post-grade.
    expect(routePermissionFor("/api/internal/gl-periods/2026-06/close", "POST")).toEqual({ module: "gl_periods", action: "post" });
    expect(routePermissionFor("/api/internal/gl-periods/2026-06/reopen", "POST")).toEqual({ module: "gl_periods", action: "post" });
    expect(routePermissionFor("/api/internal/month-end-close/2026-06/close", "POST")).toEqual({ module: "gl_periods", action: "post" });
    expect(routePermissionFor("/api/internal/gl-periods", "GET")).toEqual({ module: "gl_periods", action: "read" });
    expect(routePermissionFor("/api/internal/gl-periods", "POST")).toEqual({ module: "gl_periods", action: "write" });
  });

  it("routes JE post/void to je_post, drafts to je_entry", () => {
    expect(routePermissionFor("/api/internal/journal-entries", "GET")).toEqual({ module: "je_entry", action: "read" });
    expect(routePermissionFor("/api/internal/journal-entries", "POST")).toEqual({ module: "je_entry", action: "write" });
    expect(routePermissionFor("/api/internal/journal-entries/x/post", "POST")).toEqual({ module: "je_post", action: "post" });
  });

  it("clamps actions a module does not expose (read-only modules never emit write)", () => {
    expect(routePermissionFor("/api/internal/analytics/x", "GET")).toEqual({ module: "analytics", action: "read" });
    expect(routePermissionFor("/api/internal/analytics/x", "POST")).toBeNull();  // analytics read/export only
    expect(routePermissionFor("/api/internal/recon/run-ar", "POST")).toBeNull(); // parallel_run read/export only
    expect(routePermissionFor("/api/internal/shopify/x", "POST")).toBeNull();    // shopify read/export only
  });

  it("gates the RBAC admin surface but NOT personalization", () => {
    // The admin matrix/role/override surface requires users_access.
    expect(routePermissionFor("/api/internal/users-access", "GET")).toEqual({ module: "users_access", action: "read" });
    expect(routePermissionFor("/api/internal/users-access", "PUT")).toEqual({ module: "users_access", action: "write" });
    expect(routePermissionFor("/api/internal/users-access/override", "PUT")).toEqual({ module: "users_access", action: "write" });
    // /users/me/* is each user's OWN prefs — must stay UNMAPPED so a viewer can
    // still save their column prefs / favorites once enforcement is on.
    expect(routePermissionFor("/api/internal/users/me/preferences", "GET")).toBeNull();
    expect(routePermissionFor("/api/internal/users/me/preferences/favorites", "PUT")).toBeNull();
    expect(routePermissionFor("/api/internal/users/me/entity-switch", "PUT")).toBeNull();
  });

  it("skips non-internal, cron, vendor, and uncatalogued paths", () => {
    expect(routePermissionFor("/api/vendor/rfqs", "GET")).toBeNull();
    expect(routePermissionFor("/api/cron/xoro-mirror-nightly", "GET")).toBeNull();
    expect(routePermissionFor("/api/internal/some-future-module/x", "GET")).toBeNull();
    expect(routePermissionFor("", "GET")).toBeNull();
    expect(routePermissionFor(null, "GET")).toBeNull();
  });

  it("exempts the self-read /users-access/me endpoint (P14-4 menu hide)", () => {
    // A viewer must read their OWN perms to hide their own menus, so /me is
    // never gated on users_access. The admin matrix route still is.
    expect(routePermissionFor("/api/internal/users-access/me", "GET")).toBeNull();
    expect(routePermissionFor("/api/internal/users-access/me/", "GET")).toBeNull();
    expect(routePermissionFor("/api/internal/users-access", "GET")).toEqual({ module: "users_access", action: "read" });
  });

  it("only ever emits (module, action) pairs the module actually exposes", () => {
    for (const path of ["/api/internal/coa/x", "/api/internal/ap-payments/x/pay", "/api/internal/inventory-adjustments/x"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const r = routePermissionFor(path, method);
        if (r) expect(MODULE_ACTIONS[r.module]).toContain(r.action);
      }
    }
  });
});
