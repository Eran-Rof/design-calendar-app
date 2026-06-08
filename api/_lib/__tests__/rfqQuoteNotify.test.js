import { describe, it, expect } from "vitest";
import { buildQuoteNotification } from "../rfqQuoteNotify.js";

describe("buildQuoteNotification", () => {
  const base = { id: "q1", total_price: 1234.5, lead_time_days: 30 };

  it("first submission → rfq_quote_submitted", () => {
    const n = buildQuoteNotification({ quote: { ...base, revision: 1 }, rfqTitle: "Spring Tees", vendorName: "Acme" });
    expect(n.isRevision).toBe(false);
    expect(n.event_type).toBe("rfq_quote_submitted");
    expect(n.title).toBe("Acme submitted a quote on Spring Tees");
    expect(n.dedupeKeyFor("a@b.com")).toBe("rfq_quote_submitted_q1_a@b.com");
  });

  it("missing revision defaults to first submission", () => {
    const n = buildQuoteNotification({ quote: { ...base }, rfqTitle: "Spring Tees", vendorName: "Acme" });
    expect(n.isRevision).toBe(false);
    expect(n.revision).toBe(1);
    expect(n.event_type).toBe("rfq_quote_submitted");
  });

  it("revision > 1 → rfq_quote_revised with version in title + per-revision dedupe", () => {
    const n = buildQuoteNotification({ quote: { ...base, revision: 3 }, rfqTitle: "Spring Tees", vendorName: "Acme" });
    expect(n.isRevision).toBe(true);
    expect(n.revision).toBe(3);
    expect(n.event_type).toBe("rfq_quote_revised");
    expect(n.title).toBe("Acme revised their quote on Spring Tees (v3)");
    expect(n.body).toMatch(/Revised total/);
    expect(n.body).toMatch(/revision history/);
    // dedupe includes the revision so each successive revision notifies
    expect(n.dedupeKeyFor("a@b.com")).toBe("rfq_quote_revised_q1_3_a@b.com");
  });

  it("handles null price/lead-time gracefully", () => {
    const n = buildQuoteNotification({ quote: { id: "q2", revision: 2, total_price: null, lead_time_days: null }, rfqTitle: "X", vendorName: "V" });
    expect(n.event_type).toBe("rfq_quote_revised");
    expect(n.body).toContain("—");
    expect(n.body).not.toContain("lead time");
  });
});
