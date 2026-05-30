// Tests for Tangerine P13-6 — M48 vendor compliance certifications +
// import documentation + per-PO compliance status handler validators.
// Pure-function coverage of the exported validators / parsers /
// pure helpers; live DB posting is exercised by the cron + UI tests.

import { describe, it, expect } from "vitest";

import {
  parseListQuery as parseCertListQuery,
  validateCertInsert,
  isUuid as certIsUuid,
  STATUS_VALUES as CERT_STATUS_VALUES,
  PRESET_CERT_TYPES,
} from "../../_handlers/internal/procurement/compliance-certs/index.js";
import {
  validateCertPatch,
  validateCertDelete,
} from "../../_handlers/internal/procurement/compliance-certs/[id].js";
import {
  parseListQuery as parseDocListQuery,
  validateImportDocInsert,
  isUuid as docIsUuid,
  DOCUMENT_TYPES,
} from "../../_handlers/internal/procurement/import-docs/index.js";
import {
  validateImportDocPatch,
  validateImportDocDelete,
} from "../../_handlers/internal/procurement/import-docs/[id].js";
import {
  assembleStatus,
  REQUIRED_CERT_TYPES,
  REQUIRED_DOC_TYPES,
} from "../../_handlers/internal/procurement/compliance-status/po/[uuid_id].js";

const UUID  = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";
const UUID3 = "00000000-0000-0000-0000-000000000003";

// ────────────────────────────────────────────────────────────────────────
// uuid sanity
// ────────────────────────────────────────────────────────────────────────

describe("P13-6 isUuid", () => {
  it("certs handler accepts a canonical uuid", () => {
    expect(certIsUuid(UUID)).toBe(true);
  });
  it("docs handler accepts a canonical uuid", () => {
    expect(docIsUuid(UUID)).toBe(true);
  });
  it("rejects garbage", () => {
    expect(certIsUuid("nope")).toBe(false);
    expect(docIsUuid(null)).toBe(false);
    expect(certIsUuid(undefined)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// h510 — parseCertListQuery
// ────────────────────────────────────────────────────────────────────────

describe("compliance-certs parseListQuery", () => {
  it("accepts empty params and defaults limit=200", () => {
    const v = parseCertListQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.limit).toBe(200);
    expect(v.data.include_inactive).toBe(false);
    expect(v.data.expiring_within_days).toBeNull();
  });

  it("clamps limit > 500 to 500", () => {
    expect(parseCertListQuery({ limit: "10000" }).data.limit).toBe(500);
  });

  it("rejects bogus status", () => {
    expect(parseCertListQuery({ status: "garbage" }).error).toMatch(/status/);
  });

  it("rejects non-uuid vendor_id", () => {
    expect(parseCertListQuery({ vendor_id: "x" }).error).toMatch(/vendor_id/);
  });

  it("rejects malformed from date", () => {
    expect(parseCertListQuery({ from: "5/29/2026" }).error).toMatch(/from/);
  });

  it("rejects malformed to date", () => {
    expect(parseCertListQuery({ to: "29-May" }).error).toMatch(/to/);
  });

  it("rejects non-numeric expiring_within_days", () => {
    expect(parseCertListQuery({ expiring_within_days: "soon" }).error).toMatch(/expiring_within_days/);
  });

  it("rejects negative expiring_within_days", () => {
    expect(parseCertListQuery({ expiring_within_days: "-5" }).error).toMatch(/expiring_within_days/);
  });

  it("flips include_inactive when query string is 'true'", () => {
    expect(parseCertListQuery({ include_inactive: "true" }).data.include_inactive).toBe(true);
  });

  it("passes-through a valid combo (vendor + window + status)", () => {
    const v = parseCertListQuery({
      status: "active",
      vendor_id: UUID,
      expiring_within_days: "60",
      limit: "100",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("active");
    expect(v.data.expiring_within_days).toBe(60);
    expect(v.data.limit).toBe(100);
  });

  it("PRESET_CERT_TYPES exposes the canonical 6 options", () => {
    expect(PRESET_CERT_TYPES).toEqual(["OEKO-TEX", "GOTS", "BSCI", "WRAP", "ISO9001", "custom"]);
  });

  it("CERT_STATUS_VALUES exposes the 4 statuses", () => {
    expect(CERT_STATUS_VALUES.sort()).toEqual(["active", "expired", "pending", "revoked"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// h511 (paired with h510) — validateCertInsert
// ────────────────────────────────────────────────────────────────────────

describe("compliance-certs validateCertInsert", () => {
  it("rejects missing vendor_id", () => {
    expect(validateCertInsert({ certification_type: "OEKO-TEX" }).error).toMatch(/vendor_id/);
  });
  it("rejects non-uuid vendor_id", () => {
    expect(validateCertInsert({ vendor_id: "x", certification_type: "OEKO-TEX" }).error).toMatch(/vendor_id/);
  });
  it("rejects missing certification_type", () => {
    expect(validateCertInsert({ vendor_id: UUID }).error).toMatch(/certification_type/);
  });
  it("rejects empty certification_type", () => {
    expect(validateCertInsert({ vendor_id: UUID, certification_type: "   " }).error).toMatch(/certification_type/);
  });
  it("defaults status to active", () => {
    expect(validateCertInsert({ vendor_id: UUID, certification_type: "OEKO-TEX" }).data.status).toBe("active");
  });
  it("rejects unknown status", () => {
    expect(validateCertInsert({ vendor_id: UUID, certification_type: "x", status: "void" }).error).toMatch(/status/);
  });
  it("rejects malformed issued_at", () => {
    expect(validateCertInsert({ vendor_id: UUID, certification_type: "x", issued_at: "5/29/2026" }).error)
      .toMatch(/issued_at/);
  });
  it("rejects expires_at < issued_at", () => {
    expect(validateCertInsert({
      vendor_id: UUID, certification_type: "x",
      issued_at: "2026-05-29", expires_at: "2026-04-29",
    }).error).toMatch(/expires_at/);
  });
  it("accepts a full valid cert", () => {
    const v = validateCertInsert({
      vendor_id: UUID,
      certification_type: "OEKO-TEX",
      cert_number: "12.HCN.85789",
      issued_at: "2024-01-15",
      expires_at: "2027-01-15",
      document_url: "https://example.com/cert.pdf",
      status: "active",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.cert_number).toBe("12.HCN.85789");
    expect(v.data.expires_at).toBe("2027-01-15");
  });
});

// ────────────────────────────────────────────────────────────────────────
// h512 — validateCertPatch + validateCertDelete
// ────────────────────────────────────────────────────────────────────────

describe("compliance-certs validateCertPatch", () => {
  it("rejects empty certification_type", () => {
    expect(validateCertPatch({ certification_type: "  " }).error).toMatch(/certification_type/);
  });
  it("rejects unknown status", () => {
    expect(validateCertPatch({ status: "void" }).error).toMatch(/status/);
  });
  it("rejects malformed issued_at", () => {
    expect(validateCertPatch({ issued_at: "5/1/26" }).error).toMatch(/issued_at/);
  });
  it("rejects malformed expires_at", () => {
    expect(validateCertPatch({ expires_at: "5/1/26" }).error).toMatch(/expires_at/);
  });
  it("nulls cert_number when empty string", () => {
    const v = validateCertPatch({ cert_number: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.cert_number).toBeNull();
  });
  it("nulls document_url when empty string", () => {
    const v = validateCertPatch({ document_url: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.document_url).toBeNull();
  });
  it("accepts status transition active → revoked", () => {
    const v = validateCertPatch({ status: "revoked" });
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("revoked");
  });
  it("accepts a multi-field patch", () => {
    const v = validateCertPatch({
      status: "expired",
      expires_at: "2025-12-31",
      cert_number: "RENEWED-2026",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("expired");
    expect(v.data.expires_at).toBe("2025-12-31");
  });
});

describe("compliance-certs validateCertDelete (T11 D3)", () => {
  it("rejects missing reason in body and query", () => {
    expect(validateCertDelete({}).error).toMatch(/reason is required/);
  });
  it("rejects whitespace-only reason", () => {
    expect(validateCertDelete({ reason: "   " }).error).toMatch(/reason is required/);
  });
  it("rejects reason > 500 chars", () => {
    expect(validateCertDelete({ reason: "x".repeat(501) }).error).toMatch(/≤ 500/);
  });
  it("accepts body reason", () => {
    const v = validateCertDelete({ reason: "vendor disqualified" });
    expect(v.error).toBeUndefined();
    expect(v.data.reason).toBe("vendor disqualified");
  });
  it("accepts query reason fallback (?reason= path)", () => {
    const v = validateCertDelete({ reason_query: "test cleanup" });
    expect(v.error).toBeUndefined();
    expect(v.data.reason).toBe("test cleanup");
  });
  it("body reason wins over query reason when both supplied", () => {
    const v = validateCertDelete({ reason: "body wins", reason_query: "query loses" });
    expect(v.error).toBeUndefined();
    expect(v.data.reason).toBe("body wins");
  });
});

// ────────────────────────────────────────────────────────────────────────
// h514 — parseDocListQuery
// ────────────────────────────────────────────────────────────────────────

describe("import-docs parseListQuery", () => {
  it("accepts empty params and defaults limit=200", () => {
    const v = parseDocListQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.limit).toBe(200);
  });
  it("clamps limit > 500 to 500", () => {
    expect(parseDocListQuery({ limit: "9999" }).data.limit).toBe(500);
  });
  it("rejects non-uuid tanda_po_id", () => {
    expect(parseDocListQuery({ tanda_po_id: "x" }).error).toMatch(/tanda_po_id/);
  });
  it("rejects bogus status", () => {
    expect(parseDocListQuery({ status: "shipped" }).error).toMatch(/status/);
  });
  it("rejects bogus document_type", () => {
    expect(parseDocListQuery({ document_type: "junk" }).error).toMatch(/document_type/);
  });
  it("accepts valid combo", () => {
    const v = parseDocListQuery({
      tanda_po_id: UUID,
      status: "pending",
      document_type: "commercial_invoice",
      limit: "50",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("pending");
    expect(v.data.document_type).toBe("commercial_invoice");
  });
  it("DOCUMENT_TYPES exposes the canonical 5", () => {
    expect(DOCUMENT_TYPES.length).toBe(5);
    expect(DOCUMENT_TYPES).toContain("commercial_invoice");
    expect(DOCUMENT_TYPES).toContain("bill_of_lading");
  });
});

// ────────────────────────────────────────────────────────────────────────
// h515 (paired with h514) — validateImportDocInsert
// ────────────────────────────────────────────────────────────────────────

describe("import-docs validateImportDocInsert", () => {
  it("rejects missing tanda_po_id", () => {
    expect(validateImportDocInsert({ document_type: "commercial_invoice" }).error).toMatch(/tanda_po_id/);
  });
  it("rejects non-uuid tanda_po_id", () => {
    expect(validateImportDocInsert({ tanda_po_id: "x", document_type: "commercial_invoice" }).error).toMatch(/tanda_po_id/);
  });
  it("rejects missing document_type", () => {
    expect(validateImportDocInsert({ tanda_po_id: UUID }).error).toMatch(/document_type/);
  });
  it("rejects unknown document_type", () => {
    expect(validateImportDocInsert({ tanda_po_id: UUID, document_type: "purchase_order" }).error).toMatch(/document_type/);
  });
  it("rejects negative declared_value_cents", () => {
    expect(validateImportDocInsert({
      tanda_po_id: UUID, document_type: "commercial_invoice", declared_value_cents: -1,
    }).error).toMatch(/declared_value_cents/);
  });
  it("rejects duty_rate_pct > 100", () => {
    expect(validateImportDocInsert({
      tanda_po_id: UUID, document_type: "commercial_invoice", duty_rate_pct: 101,
    }).error).toMatch(/duty_rate_pct/);
  });
  it("rejects duty_rate_pct < 0", () => {
    expect(validateImportDocInsert({
      tanda_po_id: UUID, document_type: "commercial_invoice", duty_rate_pct: -1,
    }).error).toMatch(/duty_rate_pct/);
  });
  it("defaults status to pending", () => {
    expect(validateImportDocInsert({ tanda_po_id: UUID, document_type: "packing_list" }).data.status).toBe("pending");
  });
  it("accepts a full valid doc", () => {
    const v = validateImportDocInsert({
      tanda_po_id: UUID,
      document_type: "commercial_invoice",
      document_url: "https://example.com/inv.pdf",
      hs_code: "6109.10.0040",
      country_of_origin: "CN",
      declared_value_cents: 2700000,
      duty_rate_pct: 7.5,
      status: "received",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.declared_value_cents).toBe(2700000);
    expect(v.data.duty_rate_pct).toBe(7.5);
  });
});

// ────────────────────────────────────────────────────────────────────────
// h516 — validateImportDocPatch + validateImportDocDelete
// ────────────────────────────────────────────────────────────────────────

describe("import-docs validateImportDocPatch", () => {
  it("rejects unknown document_type", () => {
    expect(validateImportDocPatch({ document_type: "junk" }).error).toMatch(/document_type/);
  });
  it("rejects unknown status", () => {
    expect(validateImportDocPatch({ status: "shipped" }).error).toMatch(/status/);
  });
  it("rejects negative declared_value_cents", () => {
    expect(validateImportDocPatch({ declared_value_cents: -1 }).error).toMatch(/declared_value_cents/);
  });
  it("rejects out-of-range duty_rate_pct", () => {
    expect(validateImportDocPatch({ duty_rate_pct: 150 }).error).toMatch(/duty_rate_pct/);
  });
  it("nulls hs_code when empty string", () => {
    const v = validateImportDocPatch({ hs_code: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.hs_code).toBeNull();
  });
  it("nulls duty_rate_pct when empty string", () => {
    const v = validateImportDocPatch({ duty_rate_pct: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.duty_rate_pct).toBeNull();
  });
  it("accepts a multi-field patch", () => {
    const v = validateImportDocPatch({
      status: "verified",
      hs_code: "6109.10.0040",
      country_of_origin: "Vietnam",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("verified");
  });
});

describe("import-docs validateImportDocDelete (T11 D3)", () => {
  it("rejects missing reason", () => {
    expect(validateImportDocDelete({}).error).toMatch(/reason is required/);
  });
  it("rejects whitespace-only reason", () => {
    expect(validateImportDocDelete({ reason: "  " }).error).toMatch(/reason is required/);
  });
  it("rejects reason > 500 chars", () => {
    expect(validateImportDocDelete({ reason: "y".repeat(501) }).error).toMatch(/≤ 500/);
  });
  it("accepts body reason", () => {
    const v = validateImportDocDelete({ reason: "duplicate upload" });
    expect(v.error).toBeUndefined();
    expect(v.data.reason).toBe("duplicate upload");
  });
  it("accepts query reason fallback", () => {
    const v = validateImportDocDelete({ reason_query: "test cleanup" });
    expect(v.error).toBeUndefined();
    expect(v.data.reason).toBe("test cleanup");
  });
});

// ────────────────────────────────────────────────────────────────────────
// h518 — assembleStatus pure helper
// ────────────────────────────────────────────────────────────────────────

describe("compliance-status assembleStatus pure helper", () => {
  const baseToday = "2026-05-29";
  const basePo = {
    tanda_po_id: UUID,
    po_number: "RP-2026-00050",
    vendor_id: UUID2,
    vendor_name: "Zhejiang Zhuji Newdan",
  };

  it("REQUIRED_CERT_TYPES exposes OEKO-TEX + GOTS", () => {
    expect(REQUIRED_CERT_TYPES).toContain("OEKO-TEX");
    expect(REQUIRED_CERT_TYPES).toContain("GOTS");
  });
  it("REQUIRED_DOC_TYPES exposes the 4 docs", () => {
    expect(REQUIRED_DOC_TYPES.length).toBe(4);
    expect(REQUIRED_DOC_TYPES).toContain("commercial_invoice");
    expect(REQUIRED_DOC_TYPES).toContain("customs_declaration");
  });

  it("returns is_complete=false when nothing on file", () => {
    const r = assembleStatus({ po: basePo, vendorCerts: [], importDocs: [], today: baseToday });
    expect(r.is_complete).toBe(false);
    expect(r.missing_certs.length).toBeGreaterThan(0);
    expect(r.missing_docs.length).toBe(4);
  });

  it("is_complete=true requires at-least-one cert AND all 4 docs", () => {
    const r = assembleStatus({
      po: basePo,
      vendorCerts: [
        { vendor_id: UUID2, certification_type: "OEKO-TEX", status: "active", expires_at: "2030-01-01" },
      ],
      importDocs: [
        { tanda_po_id: UUID, document_type: "commercial_invoice", status: "received" },
        { tanda_po_id: UUID, document_type: "packing_list",       status: "received" },
        { tanda_po_id: UUID, document_type: "bill_of_lading",     status: "verified" },
        { tanda_po_id: UUID, document_type: "customs_declaration", status: "filed" },
      ],
      today: baseToday,
    });
    expect(r.is_complete).toBe(true);
    expect(r.missing_certs.length).toBe(0);
    expect(r.missing_docs.length).toBe(0);
  });

  it("ignores expired certs (status='active' but expires_at < today)", () => {
    const r = assembleStatus({
      po: basePo,
      vendorCerts: [
        { vendor_id: UUID2, certification_type: "OEKO-TEX", status: "active", expires_at: "2020-01-01" },
      ],
      importDocs: REQUIRED_DOC_TYPES.map((t) => ({
        tanda_po_id: UUID, document_type: t, status: "received",
      })),
      today: baseToday,
    });
    expect(r.is_complete).toBe(false);
    expect(r.missing_certs.length).toBeGreaterThan(0);
  });

  it("treats pending-status docs as NOT received (cannot satisfy the requirement)", () => {
    const r = assembleStatus({
      po: basePo,
      vendorCerts: [
        { vendor_id: UUID2, certification_type: "GOTS", status: "active", expires_at: null },
      ],
      importDocs: REQUIRED_DOC_TYPES.map((t) => ({
        tanda_po_id: UUID, document_type: t, status: "pending",
      })),
      today: baseToday,
    });
    expect(r.is_complete).toBe(false);
    expect(r.missing_docs.length).toBe(4);
  });

  it("accepts a null expires_at (perpetual cert)", () => {
    const r = assembleStatus({
      po: basePo,
      vendorCerts: [
        { vendor_id: UUID2, certification_type: "GOTS", status: "active", expires_at: null },
      ],
      importDocs: REQUIRED_DOC_TYPES.map((t) => ({
        tanda_po_id: UUID, document_type: t, status: "verified",
      })),
      today: baseToday,
    });
    expect(r.is_complete).toBe(true);
  });

  it("either OEKO-TEX OR GOTS satisfies the cert check (at-least-one)", () => {
    const baseDocs = REQUIRED_DOC_TYPES.map((t) => ({ tanda_po_id: UUID, document_type: t, status: "filed" }));
    const onlyOeko = assembleStatus({
      po: basePo,
      vendorCerts: [{ vendor_id: UUID2, certification_type: "OEKO-TEX", status: "active", expires_at: "2030-01-01" }],
      importDocs: baseDocs,
      today: baseToday,
    });
    const onlyGots = assembleStatus({
      po: basePo,
      vendorCerts: [{ vendor_id: UUID2, certification_type: "GOTS", status: "active", expires_at: "2030-01-01" }],
      importDocs: baseDocs,
      today: baseToday,
    });
    expect(onlyOeko.is_complete).toBe(true);
    expect(onlyGots.is_complete).toBe(true);
  });

  it("surfaces missing docs list correctly when some are present", () => {
    const r = assembleStatus({
      po: basePo,
      vendorCerts: [{ vendor_id: UUID2, certification_type: "OEKO-TEX", status: "active", expires_at: "2030-01-01" }],
      importDocs: [
        { tanda_po_id: UUID, document_type: "commercial_invoice", status: "received" },
        { tanda_po_id: UUID, document_type: "packing_list",       status: "received" },
      ],
      today: baseToday,
    });
    expect(r.is_complete).toBe(false);
    expect(r.missing_docs).toContain("bill_of_lading");
    expect(r.missing_docs).toContain("customs_declaration");
    expect(r.missing_docs).not.toContain("commercial_invoice");
    expect(r.missing_certs.length).toBe(0);
  });

  it("echoes the vendor_name + po_number from the input PO", () => {
    const r = assembleStatus({ po: basePo, vendorCerts: [], importDocs: [], today: baseToday });
    expect(r.vendor_name).toBe("Zhejiang Zhuji Newdan");
    expect(r.po_number).toBe("RP-2026-00050");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Cross-handler smoke — UUID set sanity
// ────────────────────────────────────────────────────────────────────────

describe("P13-6 handlers — uuids agree", () => {
  it("certIsUuid and docIsUuid both accept the canonical fixtures", () => {
    expect(certIsUuid(UUID3)).toBe(true);
    expect(docIsUuid(UUID3)).toBe(true);
  });
});
