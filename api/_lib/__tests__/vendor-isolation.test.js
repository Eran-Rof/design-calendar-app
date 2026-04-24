import { describe, it, expect } from "vitest";
import { authenticateVendor } from "../vendor-auth.js";
import { generateApiKey } from "../api-key.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function buildAdmin(tables = {}) {
  return {
    auth: {
      getUser: async (token) => {
        const user = (tables._jwtMap || {})[token];
        if (user) return { data: { user }, error: null };
        return { data: null, error: { message: "invalid" } };
      },
    },
    from(name) {
      const rows = [...(tables[name] || [])];
      let _filters = [];
      const chain = {
        select: () => chain,
        eq: (f, v) => { _filters = [..._filters, (r) => r[f] === v]; return chain; },
        maybeSingle: async () => ({
          data: rows.find((r) => _filters.every((fn) => fn(r))) ?? null,
          error: null,
        }),
        insert: (row) => {
          const arr = Array.isArray(row) ? row : [row];
          (tables[name] ??= []).push(...arr);
          return {
            select: () => ({ single: async () => ({ data: arr[0], error: null }) }),
            then: (fn) => Promise.resolve({ data: null, error: null }).then(fn),
          };
        },
        update: () => ({ eq: function () { return this; }, then: (fn) => Promise.resolve({ data: null, error: null }).then(fn) }),
      };
      return chain;
    },
    _tables: tables,
  };
}

function makeReq({ bearer, apiKey, body, query } = {}) {
  const headers = {};
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  if (apiKey) headers["x-api-key"] = apiKey;
  return { headers, body: body ?? {}, query: query ?? {}, method: "GET", url: "/api/vendor/test" };
}

// ─── Scenario fixtures ────────────────────────────────────────────────────────

function twoVendorSetup() {
  const { raw: rawA, keyPrefix: prefA, keyHash: hashA } = generateApiKey();
  const { raw: rawB, keyPrefix: prefB, keyHash: hashB } = generateApiKey();

  const tables = {
    _jwtMap: {
      "jwt-vendor-a": { id: "auth-a", email: "a@supplier.com" },
      "jwt-vendor-b": { id: "auth-b", email: "b@supplier.com" },
    },
    vendor_users: [
      { id: "vu-a", auth_id: "auth-a", vendor_id: "vendor-A", display_name: "Supplier A", role: "primary" },
      { id: "vu-b", auth_id: "auth-b", vendor_id: "vendor-B", display_name: "Supplier B", role: "primary" },
    ],
    vendor_api_keys: [
      { id: "ak-a", vendor_id: "vendor-A", key_prefix: prefA, key_hash: hashA, scopes: ["*"], revoked_at: null, expires_at: null },
      { id: "ak-b", vendor_id: "vendor-B", key_prefix: prefB, key_hash: hashB, scopes: ["*"], revoked_at: null, expires_at: null },
    ],
    vendor_api_logs: [],
    tanda_pos: [
      { uuid_id: "po-A1", vendor_id: "vendor-A", po_number: "PO-100" },
      { uuid_id: "po-B1", vendor_id: "vendor-B", po_number: "PO-200" },
    ],
    invoices: [
      { id: "inv-A1", vendor_id: "vendor-A", invoice_number: "INV-001", status: "submitted" },
      { id: "inv-B1", vendor_id: "vendor-B", invoice_number: "INV-002", status: "submitted" },
    ],
    workspaces: [
      { id: "ws-A1", vendor_id: "vendor-A", name: "Workspace A" },
      { id: "ws-B1", vendor_id: "vendor-B", name: "Workspace B" },
    ],
  };

  return { tables, rawA, rawB };
}

// ─── vendor_id always comes from JWT, not request ─────────────────────────────

describe("vendor_id source — JWT auth", () => {
  it("vendor_id is the one in the JWT-linked vendor_users row", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const result = await authenticateVendor(admin, makeReq({ bearer: "jwt-vendor-a" }));
    expect(result.ok).toBe(true);
    expect(result.auth.vendor_id).toBe("vendor-A");
  });

  it("spoofed vendor_id in request body is ignored — auth.vendor_id comes from JWT only", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const result = await authenticateVendor(
      admin,
      makeReq({ bearer: "jwt-vendor-a", body: { vendor_id: "vendor-B" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.auth.vendor_id).toBe("vendor-A");
    expect(result.auth.vendor_id).not.toBe("vendor-B");
  });

  it("spoofed vendor_id in query string is ignored", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const result = await authenticateVendor(
      admin,
      makeReq({ bearer: "jwt-vendor-a", query: { vendor_id: "vendor-B" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.auth.vendor_id).toBe("vendor-A");
  });

  it("two different tokens resolve to their respective vendor_ids", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const resA = await authenticateVendor(admin, makeReq({ bearer: "jwt-vendor-a" }));
    const resB = await authenticateVendor(admin, makeReq({ bearer: "jwt-vendor-b" }));
    expect(resA.auth.vendor_id).toBe("vendor-A");
    expect(resB.auth.vendor_id).toBe("vendor-B");
    expect(resA.auth.vendor_id).not.toBe(resB.auth.vendor_id);
  });
});

// ─── vendor_id always comes from API key record, not request ──────────────────

describe("vendor_id source — API key auth", () => {
  it("vendor_id is bound to the API key row, not request params", async () => {
    const { tables, rawA } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const result = await authenticateVendor(
      admin,
      makeReq({ apiKey: rawA, body: { vendor_id: "vendor-B" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.auth.vendor_id).toBe("vendor-A");
  });

  it("using Vendor B's raw key resolves to vendor-B regardless of request body", async () => {
    const { tables, rawB } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const result = await authenticateVendor(
      admin,
      makeReq({ apiKey: rawB, body: { vendor_id: "vendor-A" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.auth.vendor_id).toBe("vendor-B");
  });
});

// ─── PO ownership enforcement ─────────────────────────────────────────────────
// Replicates the check in api/_handlers/vendor/invoices.js:
//   admin.from("tanda_pos").select(...).eq("uuid_id", po_id).eq("vendor_id", caller.vendor_id)
// A vendor receiving null back from this query must be rejected.

describe("PO ownership isolation", () => {
  function lookupPO(admin, po_id, caller_vendor_id) {
    return admin
      .from("tanda_pos")
      .select("uuid_id, po_number, vendor_id")
      .eq("uuid_id", po_id)
      .eq("vendor_id", caller_vendor_id)
      .maybeSingle();
  }

  it("returns the PO when vendor_id matches", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const { data } = await lookupPO(admin, "po-A1", "vendor-A");
    expect(data).not.toBeNull();
    expect(data.po_number).toBe("PO-100");
  });

  it("returns null when a vendor tries to access another vendor's PO", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    // Vendor B tries to reference Vendor A's PO
    const { data } = await lookupPO(admin, "po-A1", "vendor-B");
    expect(data).toBeNull();
  });

  it("returns null for a PO that doesn't exist at all", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const { data } = await lookupPO(admin, "po-NONEXISTENT", "vendor-A");
    expect(data).toBeNull();
  });
});

// ─── Invoice ownership isolation ──────────────────────────────────────────────

describe("invoice ownership isolation", () => {
  function lookupInvoice(admin, invoice_id, caller_vendor_id) {
    return admin
      .from("invoices")
      .select("id, invoice_number, vendor_id, status")
      .eq("id", invoice_id)
      .eq("vendor_id", caller_vendor_id)
      .maybeSingle();
  }

  it("returns the invoice for its owning vendor", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const { data } = await lookupInvoice(admin, "inv-A1", "vendor-A");
    expect(data).not.toBeNull();
    expect(data.invoice_number).toBe("INV-001");
  });

  it("returns null when vendor B tries to access vendor A's invoice", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const { data } = await lookupInvoice(admin, "inv-A1", "vendor-B");
    expect(data).toBeNull();
  });
});

// ─── Workspace ownership isolation ───────────────────────────────────────────

describe("workspace ownership isolation", () => {
  function lookupWorkspace(admin, workspace_id, caller_vendor_id) {
    return admin
      .from("workspaces")
      .select("id, name, vendor_id")
      .eq("id", workspace_id)
      .eq("vendor_id", caller_vendor_id)
      .maybeSingle();
  }

  it("returns workspace for the owning vendor", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const { data } = await lookupWorkspace(admin, "ws-A1", "vendor-A");
    expect(data).not.toBeNull();
    expect(data.name).toBe("Workspace A");
  });

  it("blocks cross-vendor workspace access", async () => {
    const { tables } = twoVendorSetup();
    const admin = buildAdmin(tables);
    const { data } = await lookupWorkspace(admin, "ws-B1", "vendor-A");
    expect(data).toBeNull();
  });
});

// ─── Onboarding gate ─────────────────────────────────────────────────────────
// Replicates the guard in api/_handlers/vendor/invoices.js that checks
// onboarding_workflows.status === "approved" before allowing invoice submission.

describe("onboarding gate", () => {
  function checkOnboarding(wfStatus) {
    // Returns null when no workflow row exists (treated as not yet started)
    if (!wfStatus) return null;
    return { status: wfStatus };
  }

  function canSubmitInvoice(wf) {
    if (wf && wf.status !== "approved") return false;
    return true;
  }

  it("allows submission when onboarding is approved", () => {
    expect(canSubmitInvoice({ status: "approved" })).toBe(true);
  });

  it("blocks submission when onboarding is pending", () => {
    expect(canSubmitInvoice({ status: "pending" })).toBe(false);
  });

  it("blocks submission when onboarding is rejected", () => {
    expect(canSubmitInvoice({ status: "rejected" })).toBe(false);
  });

  it("blocks submission when onboarding is in_progress", () => {
    expect(canSubmitInvoice({ status: "in_progress" })).toBe(false);
  });

  it("allows submission when no onboarding row exists (legacy vendor)", () => {
    expect(canSubmitInvoice(null)).toBe(true);
  });
});

// ─── Invoice field validation ─────────────────────────────────────────────────
// Mirrors the validation logic in api/_handlers/vendor/invoices.js before the DB write.

describe("invoice submission validation", () => {
  function validateInvoiceBody(body) {
    const { po_id, invoice_number, line_items } = body || {};
    if (!po_id) return { ok: false, status: 400, error: "po_id is required" };
    if (!invoice_number || typeof invoice_number !== "string" || !invoice_number.trim())
      return { ok: false, status: 400, error: "invoice_number is required" };
    if (!Array.isArray(line_items) || line_items.length === 0)
      return { ok: false, status: 400, error: "At least one line_item is required" };
    return { ok: true };
  }

  it("rejects missing po_id", () => {
    expect(validateInvoiceBody({ invoice_number: "INV-1", line_items: [{}] }).ok).toBe(false);
  });

  it("rejects blank invoice_number", () => {
    expect(validateInvoiceBody({ po_id: "po-1", invoice_number: "   ", line_items: [{}] }).ok).toBe(false);
  });

  it("rejects missing invoice_number", () => {
    expect(validateInvoiceBody({ po_id: "po-1", line_items: [{}] }).ok).toBe(false);
  });

  it("rejects empty line_items array", () => {
    expect(validateInvoiceBody({ po_id: "po-1", invoice_number: "INV-1", line_items: [] }).ok).toBe(false);
  });

  it("rejects non-array line_items", () => {
    expect(validateInvoiceBody({ po_id: "po-1", invoice_number: "INV-1", line_items: "bad" }).ok).toBe(false);
  });

  it("accepts a valid body", () => {
    expect(validateInvoiceBody({
      po_id: "po-1",
      invoice_number: "INV-001",
      line_items: [{ description: "Goods", quantity_invoiced: 10, unit_price: 5 }],
    }).ok).toBe(true);
  });
});
