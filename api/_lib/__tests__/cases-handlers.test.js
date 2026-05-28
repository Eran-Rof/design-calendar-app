// Tests for Tangerine P7-9 — Cases handlers + Resend inbound webhook.
//
// Pure validators + the subject [CASE-YYYY-NNNNN] extractor are covered
// here. Live posting (which inserts into Supabase) is covered by the
// schema's own migration tests (P7-8 / p7-chunk8) + the deployed app
// smoke test.

import { describe, it, expect } from "vitest";

import {
  parseListQuery,
  validateInsert,
  isUuid,
} from "../../_handlers/internal/cases/index.js";
import { validatePatch } from "../../_handlers/internal/cases/[id].js";
import { validateCommentInsert } from "../../_handlers/internal/cases/[id]/comments.js";
import {
  extractCaseNumber,
  extractInboundEvent,
  verifyResendSignature,
} from "../../_handlers/webhooks/resend-inbound.js";
import { createHmac } from "node:crypto";

const UUID = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";

// ────────────────────────────────────────────────────────────────────────
// isUuid sanity
// ────────────────────────────────────────────────────────────────────────

describe("cases isUuid", () => {
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

// ────────────────────────────────────────────────────────────────────────
// parseListQuery
// ────────────────────────────────────────────────────────────────────────

describe("cases parseListQuery", () => {
  it("accepts empty params and defaults limit=100, offset=0", () => {
    const v = parseListQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.limit).toBe(100);
    expect(v.data.offset).toBe(0);
    expect(v.data.status).toBeNull();
    expect(v.data.severity).toBeNull();
    expect(v.data.assignee_user_id).toBeNull();
    expect(v.data.customer_id).toBeNull();
    expect(v.data.q).toBeNull();
  });
  it("rejects bad status enum value", () => {
    expect(parseListQuery({ status: "pending" }).error).toMatch(/status/);
  });
  it("rejects bad severity enum value", () => {
    expect(parseListQuery({ severity: "critical" }).error).toMatch(/severity/);
  });
  it("accepts all valid statuses", () => {
    for (const s of ["open", "in_progress", "resolved", "closed"]) {
      expect(parseListQuery({ status: s }).data.status).toBe(s);
    }
  });
  it("accepts all valid severities", () => {
    for (const s of ["low", "normal", "high", "urgent"]) {
      expect(parseListQuery({ severity: s }).data.severity).toBe(s);
    }
  });
  it("rejects non-uuid assignee_user_id", () => {
    expect(parseListQuery({ assignee_user_id: "nope" }).error).toMatch(/assignee_user_id/);
  });
  it("rejects non-uuid customer_id", () => {
    expect(parseListQuery({ customer_id: "x" }).error).toMatch(/customer_id/);
  });
  it("accepts a valid assignee_user_id uuid", () => {
    expect(parseListQuery({ assignee_user_id: UUID }).data.assignee_user_id).toBe(UUID);
  });
  it("rejects an overly long q string", () => {
    expect(parseListQuery({ q: "x".repeat(201) }).error).toMatch(/q/);
  });
  it("preserves a normal q substring", () => {
    expect(parseListQuery({ q: "order issue" }).data.q).toBe("order issue");
  });
  it("caps limit at 500", () => {
    expect(parseListQuery({ limit: "9999" }).data.limit).toBe(500);
  });
  it("treats NaN limit as default 100", () => {
    expect(parseListQuery({ limit: "garbage" }).data.limit).toBe(100);
  });
  it("treats negative offset as 0", () => {
    expect(parseListQuery({ offset: "-10" }).data.offset).toBe(0);
  });
  it("preserves a valid offset", () => {
    expect(parseListQuery({ offset: "1000" }).data.offset).toBe(1000);
  });
});

// ────────────────────────────────────────────────────────────────────────
// validateInsert
// ────────────────────────────────────────────────────────────────────────

const okCase = { subject: "Order issue" };

describe("cases validateInsert", () => {
  it("accepts a minimal valid body", () => {
    const v = validateInsert(okCase);
    expect(v.error).toBeUndefined();
    expect(v.data.subject).toBe("Order issue");
    expect(v.data.status).toBe("open");
    expect(v.data.severity).toBe("normal");
  });
  it("rejects missing subject", () => {
    expect(validateInsert({}).error).toMatch(/subject/);
  });
  it("rejects whitespace-only subject", () => {
    expect(validateInsert({ subject: "   " }).error).toMatch(/subject/);
  });
  it("trims subject whitespace", () => {
    expect(validateInsert({ subject: "  hi  " }).data.subject).toBe("hi");
  });
  it("rejects subject over 500 chars", () => {
    expect(validateInsert({ subject: "x".repeat(501) }).error).toMatch(/subject/);
  });
  it("rejects an unknown status", () => {
    expect(validateInsert({ ...okCase, status: "archived" }).error).toMatch(/status/);
  });
  it("rejects an unknown severity", () => {
    expect(validateInsert({ ...okCase, severity: "critical" }).error).toMatch(/severity/);
  });
  it("accepts every valid status", () => {
    for (const s of ["open", "in_progress", "resolved", "closed"]) {
      expect(validateInsert({ ...okCase, status: s }).data.status).toBe(s);
    }
  });
  it("rejects non-uuid customer_id", () => {
    expect(validateInsert({ ...okCase, customer_id: "x" }).error).toMatch(/customer_id/);
  });
  it("rejects non-uuid ar_invoice_id", () => {
    expect(validateInsert({ ...okCase, ar_invoice_id: "x" }).error).toMatch(/ar_invoice_id/);
  });
  it("rejects non-uuid assignee_user_id", () => {
    expect(validateInsert({ ...okCase, assignee_user_id: "x" }).error).toMatch(/assignee_user_id/);
  });
  it("rejects non-uuid sales_order_id", () => {
    expect(validateInsert({ ...okCase, sales_order_id: "x" }).error).toMatch(/sales_order_id/);
  });
  it("rejects malformed case_number", () => {
    expect(validateInsert({ ...okCase, case_number: "CASE-26-1" }).error).toMatch(/case_number/);
  });
  it("accepts a well-formed case_number override", () => {
    expect(validateInsert({ ...okCase, case_number: "CASE-2026-00042" }).data.case_number)
      .toBe("CASE-2026-00042");
  });
  it("trims external_email", () => {
    expect(validateInsert({ ...okCase, external_email: "  a@b.com  " }).data.external_email)
      .toBe("a@b.com");
  });
});

// ────────────────────────────────────────────────────────────────────────
// validatePatch
// ────────────────────────────────────────────────────────────────────────

describe("cases validatePatch", () => {
  it("empty body → empty data", () => {
    expect(validatePatch({}).data).toEqual({});
  });
  it("rejects locked entity_id", () => {
    expect(validatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
  });
  it("rejects locked case_number", () => {
    expect(validatePatch({ case_number: "CASE-2026-00001" }).error).toMatch(/case_number/);
  });
  it("rejects locked resolved_at", () => {
    expect(validatePatch({ resolved_at: "2026-05-28" }).error).toMatch(/resolved_at/);
  });
  it("rejects unknown status", () => {
    expect(validatePatch({ status: "archived" }).error).toMatch(/status/);
  });
  it("accepts all valid statuses", () => {
    for (const s of ["open", "in_progress", "resolved", "closed"]) {
      expect(validatePatch({ status: s }).data.status).toBe(s);
    }
  });
  it("accepts severity change", () => {
    expect(validatePatch({ severity: "urgent" }).data.severity).toBe("urgent");
  });
  it("rejects empty subject patch", () => {
    expect(validatePatch({ subject: "   " }).error).toMatch(/subject/);
  });
  it("trims subject patch", () => {
    expect(validatePatch({ subject: "  fix  " }).data.subject).toBe("fix");
  });
  it("allows clearing assignee_user_id with null", () => {
    expect(validatePatch({ assignee_user_id: null }).data.assignee_user_id).toBeNull();
  });
  it("allows clearing assignee_user_id with empty string", () => {
    expect(validatePatch({ assignee_user_id: "" }).data.assignee_user_id).toBeNull();
  });
  it("rejects non-uuid assignee_user_id", () => {
    expect(validatePatch({ assignee_user_id: "x" }).error).toMatch(/assignee_user_id/);
  });
  it("accepts customer_id change", () => {
    expect(validatePatch({ customer_id: UUID }).data.customer_id).toBe(UUID);
  });
  it("allows clearing customer_id", () => {
    expect(validatePatch({ customer_id: null }).data.customer_id).toBeNull();
  });
  it("body can be cleared to null", () => {
    expect(validatePatch({ body: null }).data.body).toBeNull();
  });
  it("multi-field patch composes correctly", () => {
    const v = validatePatch({
      status: "in_progress",
      severity: "high",
      assignee_user_id: UUID2,
    });
    expect(v.data.status).toBe("in_progress");
    expect(v.data.severity).toBe("high");
    expect(v.data.assignee_user_id).toBe(UUID2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// validateCommentInsert
// ────────────────────────────────────────────────────────────────────────

describe("case_comments validateCommentInsert", () => {
  it("rejects missing body", () => {
    expect(validateCommentInsert({}).error).toMatch(/body/);
  });
  it("rejects whitespace-only body", () => {
    expect(validateCommentInsert({ body: "   " }).error).toMatch(/body/);
  });
  it("trims body whitespace", () => {
    expect(validateCommentInsert({ body: "  yo  " }).data.body).toBe("yo");
  });
  it("rejects body over 10k chars", () => {
    expect(validateCommentInsert({ body: "x".repeat(10001) }).error).toMatch(/body/);
  });
  it("defaults is_internal to true", () => {
    expect(validateCommentInsert({ body: "hi" }).data.is_internal).toBe(true);
  });
  it("respects an explicit is_internal=false", () => {
    expect(validateCommentInsert({ body: "hi", is_internal: false }).data.is_internal).toBe(false);
  });
  it("coerces truthy is_internal", () => {
    expect(validateCommentInsert({ body: "hi", is_internal: 1 }).data.is_internal).toBe(true);
  });
  it("rejects non-uuid author_user_id", () => {
    expect(validateCommentInsert({ body: "hi", author_user_id: "x" }).error).toMatch(/author_user_id/);
  });
  it("accepts valid author_user_id", () => {
    expect(validateCommentInsert({ body: "hi", author_user_id: UUID }).data.author_user_id).toBe(UUID);
  });
  it("trims external_email", () => {
    expect(validateCommentInsert({ body: "hi", external_email: "  a@b.com  " }).data.external_email)
      .toBe("a@b.com");
  });
});

// ────────────────────────────────────────────────────────────────────────
// extractCaseNumber — subject-line CASE-YYYY-NNNNN parser
// ────────────────────────────────────────────────────────────────────────

describe("resend-inbound extractCaseNumber", () => {
  it("returns null on empty / non-string", () => {
    expect(extractCaseNumber(null)).toBeNull();
    expect(extractCaseNumber(undefined)).toBeNull();
    expect(extractCaseNumber("")).toBeNull();
    expect(extractCaseNumber(123)).toBeNull();
  });
  it("returns null when no tag present", () => {
    expect(extractCaseNumber("Just a normal subject")).toBeNull();
  });
  it("extracts a tag at the start", () => {
    expect(extractCaseNumber("[CASE-2026-00042] Order issue")).toBe("CASE-2026-00042");
  });
  it("extracts a Re: tag", () => {
    expect(extractCaseNumber("Re: [CASE-2026-00042] Order issue")).toBe("CASE-2026-00042");
  });
  it("extracts a Fwd: nested tag", () => {
    expect(extractCaseNumber("Fwd: Re: [CASE-2027-12345] foo")).toBe("CASE-2027-12345");
  });
  it("upper-cases lowercase prefix", () => {
    expect(extractCaseNumber("Re: [case-2026-00042] x")).toBe("CASE-2026-00042");
  });
  it("ignores tags without all parts", () => {
    expect(extractCaseNumber("Re: [CASE-2026] x")).toBeNull();
    expect(extractCaseNumber("Re: [CASE-26-00042] x")).toBeNull();
    expect(extractCaseNumber("Re: [CASE-2026-001] x")).toBeNull();  // need ≥5 digits
  });
  it("accepts 6-digit sequence", () => {
    expect(extractCaseNumber("Re: [CASE-2026-123456] big number")).toBe("CASE-2026-123456");
  });
});

// ────────────────────────────────────────────────────────────────────────
// extractInboundEvent — Resend payload shape normalization
// ────────────────────────────────────────────────────────────────────────

describe("resend-inbound extractInboundEvent", () => {
  it("returns null for null / non-object", () => {
    expect(extractInboundEvent(null)).toBeNull();
    expect(extractInboundEvent("x")).toBeNull();
  });
  it("parses the wrapped { data: { ... } } shape", () => {
    const ev = extractInboundEvent({
      type: "email.received",
      data: {
        from: { email: "Bob@example.com" },
        to: [{ email: "cases@ringoffireclothing.com" }],
        subject: "Help",
        text: "Body line",
      },
    });
    expect(ev.fromEmail).toBe("bob@example.com");
    expect(ev.toList).toEqual(["cases@ringoffireclothing.com"]);
    expect(ev.subject).toBe("Help");
    expect(ev.text).toBe("Body line");
  });
  it("parses the flatter shape (no data wrapper)", () => {
    const ev = extractInboundEvent({
      from: "Bob <bob@example.com>",
      to: ["cases@ringoffireclothing.com"],
      subject: "Hi",
      text: "x",
    });
    expect(ev.fromEmail).toBe("bob@example.com");
    expect(ev.toList).toEqual(["cases@ringoffireclothing.com"]);
  });
  it("falls back to stripped HTML when text missing", () => {
    const ev = extractInboundEvent({
      from: "a@b.com",
      to: ["cases@ringoffireclothing.com"],
      subject: "s",
      html: "<p>Hello <strong>world</strong></p>",
    });
    expect(ev.text).toBe("Hello world");
  });
  it("handles raw 'Name <email>' string form", () => {
    const ev = extractInboundEvent({
      from: "Alice <alice@x.com>",
      to: "cases@ringoffireclothing.com",
      subject: "hi",
      text: "",
    });
    expect(ev.fromEmail).toBe("alice@x.com");
    expect(ev.toList).toEqual(["cases@ringoffireclothing.com"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// verifyResendSignature — HMAC verification
// ────────────────────────────────────────────────────────────────────────

describe("resend-inbound verifyResendSignature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ hello: "world" });
  const goodHex = createHmac("sha256", secret).update(body).digest("hex");
  const goodB64 = createHmac("sha256", secret).update(body).digest("base64");

  it("returns false when any arg missing", () => {
    expect(verifyResendSignature(null, body, secret)).toBe(false);
    expect(verifyResendSignature(goodHex, null, secret)).toBe(false);
    expect(verifyResendSignature(goodHex, body, null)).toBe(false);
  });
  it("accepts a bare hex signature", () => {
    expect(verifyResendSignature(goodHex, body, secret)).toBe(true);
  });
  it("accepts a sha256=<hex> signature", () => {
    expect(verifyResendSignature(`sha256=${goodHex}`, body, secret)).toBe(true);
  });
  it("accepts a base64 signature", () => {
    expect(verifyResendSignature(goodB64, body, secret)).toBe(true);
  });
  it("accepts a Svix v1=<base64> form", () => {
    expect(verifyResendSignature(`v1=${goodB64}`, body, secret)).toBe(true);
  });
  it("rejects a wrong signature", () => {
    expect(verifyResendSignature("deadbeef".repeat(8), body, secret)).toBe(false);
  });
  it("rejects body-tampered payload", () => {
    expect(verifyResendSignature(goodHex, body + "tamper", secret)).toBe(false);
  });
});
