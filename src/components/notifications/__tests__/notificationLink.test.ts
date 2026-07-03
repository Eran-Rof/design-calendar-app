import { describe, it, expect } from "vitest";
import { notificationLink } from "../notificationLink";

describe("notificationLink (notifications-table resolver)", () => {
  it("keeps an already-specific producer link", () => {
    expect(notificationLink({ link: "/vendor/pos/abc", event_type: "po_issued", metadata: {} }, "vendor"))
      .toBe("/vendor/pos/abc");
    expect(notificationLink({ link: "/tangerine?m=ar_invoices&q=AR-7", event_type: "ar_invoice_posted", metadata: {} }, "internal"))
      .toBe("/tangerine?m=ar_invoices&q=AR-7");
  });

  it("upgrades a weak vendor link (home) using metadata", () => {
    expect(notificationLink({ link: "/", event_type: "rfq_quote_submitted", metadata: { rfq_id: "r1" } }, "vendor"))
      .toBe("/vendor/rfqs/r1");
    expect(notificationLink({ link: null, event_type: "po_issued", metadata: { po_id: "p1" } }, "vendor"))
      .toBe("/vendor/pos/p1");
  });

  it("upgrades a bare Tangerine list link using metadata so_number", () => {
    expect(notificationLink({ link: "/tangerine?m=sales_orders", event_type: "production_order_requested", metadata: { so_number: "SO-9" } }, "internal"))
      .toBe("/tangerine?m=sales_orders&q=SO-9");
  });

  it("derives an internal AP invoice link from invoice_number", () => {
    expect(notificationLink({ link: null, event_type: "ap_invoice_posted", metadata: { invoice_number: "AP-3" } }, "internal"))
      .toBe("/tangerine?m=ap_invoices&q=AP-3");
  });

  it("falls back to a vendor list by event type when no id present", () => {
    expect(notificationLink({ link: "/", event_type: "onboarding_approved", metadata: {} }, "vendor"))
      .toBe("/vendor/onboarding");
  });

  it("returns the weak link when nothing better can be derived", () => {
    // unknown internal event with no metadata → keep whatever link existed
    expect(notificationLink({ link: "/tangerine?m=dashboard&tab=x", event_type: "weird", metadata: {} }, "internal"))
      .toBe("/tangerine?m=dashboard&tab=x");
    expect(notificationLink({ link: null, event_type: "weird", metadata: {} }, "internal"))
      .toBeNull();
  });
});
