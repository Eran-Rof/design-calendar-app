// Tests for Tangerine P8-4 — Resend `contact@<domain>` inbound extension.
//
// Scope: the contact@ branch added to the existing P7-9 webhook
// (api/_handlers/webhooks/resend-inbound.js). The cases@ path is covered
// by cases-handlers.test.js — we only smoke-test that the router still
// recognizes cases@ so this extension doesn't regress it.
//
// Live posting (Supabase insert into crm_activities) is covered by the
// P8-1 schema migration tests + the deployed-app smoke test. Here we
// verify the pure routing + payload-shape logic that decides what to
// write.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

import {
  routeForToList,
  extractInboundEvent,
  verifyResendSignature,
} from "../../_handlers/webhooks/resend-inbound.js";

const CASES   = "cases@ringoffireclothing.com";
const CONTACT = "contact@ringoffireclothing.com";
const TARGETS = { casesTarget: CASES, contactTarget: CONTACT };

// ────────────────────────────────────────────────────────────────────────
// routeForToList — decide which branch handles a given `to` list
// ────────────────────────────────────────────────────────────────────────

describe("resend-inbound routeForToList (P8-4)", () => {
  it("returns null on empty / non-array input", () => {
    expect(routeForToList(null, TARGETS)).toBeNull();
    expect(routeForToList(undefined, TARGETS)).toBeNull();
    expect(routeForToList([], TARGETS)).toBeNull();
    expect(routeForToList("cases@…", TARGETS)).toBeNull();
  });

  it("routes a contact@ address to the contact branch", () => {
    expect(routeForToList([CONTACT], TARGETS)).toBe("contact");
  });

  it("routes a cases@ address to the cases branch (P7-9 unchanged)", () => {
    expect(routeForToList([CASES], TARGETS)).toBe("cases");
  });

  it("normalizes mixed-case input before matching", () => {
    expect(routeForToList(["Contact@RingOfFireClothing.com"], TARGETS)).toBe("contact");
    expect(routeForToList(["CASES@ringoffireclothing.com"], TARGETS)).toBe("cases");
  });

  it("returns null for an unrelated to address", () => {
    expect(routeForToList(["billing@example.com"], TARGETS)).toBeNull();
  });

  it("prefers cases@ when both targets appear in the to list", () => {
    // Defensive: if both addresses end up on the recipient list (BCC,
    // mailing list, copy-paste), keep the real case workflow.
    expect(routeForToList([CONTACT, CASES], TARGETS)).toBe("cases");
    expect(routeForToList([CASES, CONTACT], TARGETS)).toBe("cases");
  });

  it("honors env-overridden target addresses", () => {
    const alt = { casesTarget: "support@acme.co", contactTarget: "hello@acme.co" };
    expect(routeForToList(["hello@acme.co"], alt)).toBe("contact");
    expect(routeForToList(["support@acme.co"], alt)).toBe("cases");
    expect(routeForToList([CONTACT], alt)).toBeNull(); // default address NOT a match anymore
  });

  it("ignores empty / null entries in the to list", () => {
    expect(routeForToList(["", null, CONTACT], TARGETS)).toBe("contact");
    expect(routeForToList(["", null], TARGETS)).toBeNull();
  });

  it("matches when contact@ is one of several recipients", () => {
    expect(routeForToList(["other@x.com", CONTACT, "third@x.com"], TARGETS)).toBe("contact");
  });

  it("treats a typo'd contact-prefix as no-match (exact-address only)", () => {
    expect(routeForToList(["contacts@ringoffireclothing.com"], TARGETS)).toBeNull();
    expect(routeForToList(["contact+tag@ringoffireclothing.com"], TARGETS)).toBeNull();
  });

  it("works when only one target is configured", () => {
    expect(routeForToList([CONTACT], { casesTarget: "", contactTarget: CONTACT })).toBe("contact");
    expect(routeForToList([CASES], { casesTarget: CASES, contactTarget: "" })).toBe("cases");
  });
});

// ────────────────────────────────────────────────────────────────────────
// extractInboundEvent — payload shape used by the contact branch
//
// These mirror the cases@ shape tests but key on contact@ delivery, since
// the new branch reads the same normalized `event` object.
// ────────────────────────────────────────────────────────────────────────

describe("resend-inbound extractInboundEvent → contact@ (P8-4)", () => {
  it("normalizes a contact@ wrapped payload", () => {
    const ev = extractInboundEvent({
      type: "email.received",
      data: {
        from: { email: "Customer@example.com", name: "Cust" },
        to: [{ email: CONTACT }],
        subject: "Hello",
        text: "Just saying hi",
      },
    });
    expect(ev).not.toBeNull();
    expect(ev.fromEmail).toBe("customer@example.com");
    expect(ev.toList).toEqual([CONTACT]);
    expect(ev.subject).toBe("Hello");
    expect(ev.text).toBe("Just saying hi");
    // Confirm router would pick the contact branch downstream.
    expect(routeForToList(ev.toList, TARGETS)).toBe("contact");
  });

  it("strips HTML body when contact@ payload only has html", () => {
    const ev = extractInboundEvent({
      from: "anon@x.com",
      to: [CONTACT],
      subject: "FYI",
      html: "<p>Hello <em>world</em></p>",
    });
    expect(ev.text).toBe("Hello world");
    expect(routeForToList(ev.toList, TARGETS)).toBe("contact");
  });

  it("captures sender for external_email even when customer match would fail", () => {
    // The handler stores `external_email = event.fromEmail` regardless of
    // whether the customer lookup succeeds. We verify the normalized
    // sender is preserved through extraction.
    const ev = extractInboundEvent({
      from: "noone@unknown.co",
      to: [CONTACT],
      subject: "anonymous inquiry",
      text: "body",
    });
    expect(ev.fromEmail).toBe("noone@unknown.co");
  });
});

// ────────────────────────────────────────────────────────────────────────
// verifyResendSignature — sanity check P7-9 behavior still holds.
//
// The contact@ extension reuses the same signature gate; if it broke we'd
// silently start accepting unsigned payloads on either branch.
// ────────────────────────────────────────────────────────────────────────

describe("resend-inbound verifyResendSignature sanity (P8-4)", () => {
  const secret = "whsec_p8_4_secret";
  const body = JSON.stringify({ to: [CONTACT], from: "x@y.com", subject: "hi" });
  const goodHex = createHmac("sha256", secret).update(body).digest("hex");

  it("still accepts a valid signature (P7-9 behavior intact)", () => {
    expect(verifyResendSignature(goodHex, body, secret)).toBe(true);
  });

  it("still rejects a tampered body (P7-9 behavior intact)", () => {
    expect(verifyResendSignature(goodHex, body + "!", secret)).toBe(false);
  });
});
