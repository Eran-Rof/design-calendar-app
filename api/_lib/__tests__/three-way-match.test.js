import { describe, it, expect } from "vitest";

// ─── Pure JS implementation of 3-way match classification ────────────────────
//
// The production implementation is a Postgres view (three_way_match_view).
// This module mirrors the same decision tree in JS so the rules can be
// unit-tested exhaustively without a database connection.
//
// Each function maps a set of line-level quantities / prices to a status
// string and a set of boolean discrepancy flags, exactly as the SQL view does.

const PRICE_VARIANCE_THRESHOLD = 0.01; // 1% tolerance

/**
 * @typedef {Object} MatchLine
 * @property {number} qty_ordered       PO quantity
 * @property {number|null} qty_shipped  Quantity on shipment (null = no shipment)
 * @property {number|null} qty_received Quantity confirmed received (null = not received)
 * @property {number|null} qty_invoiced Quantity on vendor invoice (null = no invoice)
 * @property {number} unit_price_po     PO unit price
 * @property {number|null} unit_price_invoiced  Invoice unit price (null = no invoice)
 * @property {string|null} receipt_date ISO date of goods receipt
 * @property {string|null} invoice_submitted_at ISO datetime of invoice submission
 */

/**
 * @typedef {Object} MatchResult
 * @property {string} match_status
 * @property {boolean} flag_under_received
 * @property {boolean} flag_over_received
 * @property {boolean} flag_shipped_not_received
 * @property {boolean} flag_invoiced_more_than_received
 * @property {boolean} flag_price_variance
 * @property {boolean} flag_invoiced_before_receipt
 */

/**
 * Classify a single PO line's match status.
 * @param {MatchLine} line
 * @returns {MatchResult}
 */
function classifyLine(line) {
  const {
    qty_ordered,
    qty_shipped,
    qty_received,
    qty_invoiced,
    unit_price_po,
    unit_price_invoiced,
    receipt_date,
    invoice_submitted_at,
  } = line;

  const flag_under_received =
    qty_received != null && qty_received < qty_ordered;
  const flag_over_received =
    qty_received != null && qty_received > qty_ordered;
  const flag_shipped_not_received =
    qty_shipped != null && qty_received != null && qty_shipped > qty_received;
  const flag_invoiced_more_than_received =
    qty_invoiced != null && qty_received != null && qty_invoiced > qty_received;
  const flag_price_variance =
    unit_price_invoiced != null &&
    unit_price_po > 0 &&
    Math.abs(unit_price_invoiced - unit_price_po) / unit_price_po > PRICE_VARIANCE_THRESHOLD;
  const flag_invoiced_before_receipt =
    invoice_submitted_at != null &&
    receipt_date == null; // invoice arrived before any receipt was recorded

  let match_status;

  if (flag_invoiced_before_receipt) {
    // Exception: invoice submitted before any goods receipt was recorded
    match_status = "invoiced_before_receipt";
  } else if (qty_received == null || qty_received === 0) {
    if (qty_shipped != null && qty_shipped > 0) {
      match_status = "in_transit";
    } else {
      match_status = "pending";
    }
  } else if (qty_invoiced == null) {
    match_status = "awaiting_invoice";
  } else if (
    flag_invoiced_more_than_received ||
    flag_price_variance ||
    flag_over_received
  ) {
    match_status = "discrepancy";
  } else if (
    qty_received === qty_ordered &&
    qty_invoiced === qty_received &&
    !flag_price_variance
  ) {
    match_status = "matched";
  } else {
    // under_received but invoiced for received amount — partial match, still a discrepancy
    match_status = "discrepancy";
  }

  return {
    match_status,
    flag_under_received,
    flag_over_received,
    flag_shipped_not_received,
    flag_invoiced_more_than_received,
    flag_price_variance,
    flag_invoiced_before_receipt,
  };
}

/**
 * Roll up line-level results to a PO-level summary status.
 * Order: exception > discrepancy > awaiting_invoice > in_transit > pending > matched
 */
function summarisePO(lines) {
  const statuses = lines.map((l) => classifyLine(l).match_status);
  if (statuses.includes("invoiced_before_receipt")) return "exception";
  if (statuses.includes("discrepancy")) return "discrepancy";
  if (statuses.includes("awaiting_invoice")) return "awaiting_invoice";
  if (statuses.includes("in_transit")) return "in_transit";
  if (statuses.includes("pending")) return "pending";
  return "matched";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function line(overrides = {}) {
  return {
    qty_ordered: 100,
    qty_shipped: null,
    qty_received: null,
    qty_invoiced: null,
    unit_price_po: 10.00,
    unit_price_invoiced: null,
    receipt_date: null,
    invoice_submitted_at: null,
    ...overrides,
  };
}

// ─── PENDING ──────────────────────────────────────────────────────────────────

describe("classifyLine — pending", () => {
  it("is pending when nothing has shipped or been received", () => {
    const r = classifyLine(line());
    expect(r.match_status).toBe("pending");
  });

  it("is pending when shipped is null and received is null", () => {
    const r = classifyLine(line({ qty_shipped: null, qty_received: null }));
    expect(r.match_status).toBe("pending");
  });

  it("has no flags set in pending state", () => {
    const r = classifyLine(line());
    expect(r.flag_under_received).toBe(false);
    expect(r.flag_over_received).toBe(false);
    expect(r.flag_invoiced_more_than_received).toBe(false);
    expect(r.flag_price_variance).toBe(false);
  });
});

// ─── IN TRANSIT ───────────────────────────────────────────────────────────────

describe("classifyLine — in_transit", () => {
  it("is in_transit when shipped but not yet received", () => {
    const r = classifyLine(line({ qty_shipped: 100, qty_received: null }));
    expect(r.match_status).toBe("in_transit");
  });

  it("is in_transit when received is 0 and shipped > 0", () => {
    const r = classifyLine(line({ qty_shipped: 50, qty_received: 0 }));
    expect(r.match_status).toBe("in_transit");
  });

  it("flags shipped_not_received when partial receipt pending", () => {
    const r = classifyLine(line({ qty_shipped: 100, qty_received: 40 }));
    expect(r.flag_shipped_not_received).toBe(true);
  });
});

// ─── AWAITING INVOICE ─────────────────────────────────────────────────────────

describe("classifyLine — awaiting_invoice", () => {
  it("is awaiting_invoice when received but no invoice yet", () => {
    const r = classifyLine(line({
      qty_shipped: 100, qty_received: 100,
      receipt_date: "2026-04-10",
    }));
    expect(r.match_status).toBe("awaiting_invoice");
  });

  it("is awaiting_invoice even for partial receipt with no invoice", () => {
    const r = classifyLine(line({
      qty_ordered: 100, qty_received: 60, receipt_date: "2026-04-10",
    }));
    expect(r.match_status).toBe("awaiting_invoice");
    expect(r.flag_under_received).toBe(true);
  });
});

// ─── MATCHED ─────────────────────────────────────────────────────────────────

describe("classifyLine — matched", () => {
  it("is matched when quantities and price all agree", () => {
    const r = classifyLine(line({
      qty_shipped: 100, qty_received: 100, qty_invoiced: 100,
      unit_price_invoiced: 10.00,
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.match_status).toBe("matched");
    expect(r.flag_under_received).toBe(false);
    expect(r.flag_over_received).toBe(false);
    expect(r.flag_invoiced_more_than_received).toBe(false);
    expect(r.flag_price_variance).toBe(false);
    expect(r.flag_invoiced_before_receipt).toBe(false);
  });

  it("is matched when invoice price is within the 1% tolerance", () => {
    const r = classifyLine(line({
      qty_received: 100, qty_invoiced: 100,
      unit_price_po: 10.00, unit_price_invoiced: 10.09, // 0.9% — within tolerance
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.match_status).toBe("matched");
    expect(r.flag_price_variance).toBe(false);
  });
});

// ─── DISCREPANCY — quantity ───────────────────────────────────────────────────

describe("classifyLine — discrepancy (quantity)", () => {
  it("is discrepancy when invoiced qty exceeds received qty", () => {
    const r = classifyLine(line({
      qty_received: 80, qty_invoiced: 100,
      unit_price_invoiced: 10.00,
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.match_status).toBe("discrepancy");
    expect(r.flag_invoiced_more_than_received).toBe(true);
  });

  it("is discrepancy when received qty exceeds ordered qty", () => {
    const r = classifyLine(line({
      qty_ordered: 100, qty_received: 120, qty_invoiced: 120,
      unit_price_invoiced: 10.00,
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.match_status).toBe("discrepancy");
    expect(r.flag_over_received).toBe(true);
  });

  it("flags under_received when partial goods arrived", () => {
    const r = classifyLine(line({
      qty_ordered: 100, qty_received: 50, qty_invoiced: 50,
      unit_price_invoiced: 10.00,
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    // Under-received + invoiced for received amount = discrepancy (partial)
    expect(r.flag_under_received).toBe(true);
    expect(r.match_status).toBe("discrepancy");
  });

  it("is discrepancy even when under-received with matching invoice", () => {
    // PO=100, received=75, invoiced=75 — received < ordered
    const r = classifyLine(line({
      qty_ordered: 100, qty_received: 75, qty_invoiced: 75,
      unit_price_invoiced: 10.00,
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.flag_under_received).toBe(true);
    expect(r.match_status).toBe("discrepancy");
  });
});

// ─── DISCREPANCY — price ──────────────────────────────────────────────────────

describe("classifyLine — discrepancy (price variance)", () => {
  it("flags price_variance when invoice price exceeds PO price by >1%", () => {
    const r = classifyLine(line({
      qty_received: 100, qty_invoiced: 100,
      unit_price_po: 10.00, unit_price_invoiced: 10.15, // 1.5%
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.flag_price_variance).toBe(true);
    expect(r.match_status).toBe("discrepancy");
  });

  it("flags price_variance when invoice price is below PO price by >1%", () => {
    const r = classifyLine(line({
      qty_received: 100, qty_invoiced: 100,
      unit_price_po: 10.00, unit_price_invoiced: 9.80, // 2% below
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.flag_price_variance).toBe(true);
    expect(r.match_status).toBe("discrepancy");
  });

  it("does not flag price_variance for exactly 1% difference", () => {
    // 10.00 → 10.10 is exactly 1% — at the boundary the check is > not >=
    const r = classifyLine(line({
      qty_received: 100, qty_invoiced: 100,
      unit_price_po: 10.00, unit_price_invoiced: 10.10,
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.flag_price_variance).toBe(false);
  });

  it("does not flag price_variance when unit_price_invoiced is null (no invoice)", () => {
    const r = classifyLine(line({ qty_received: 100, receipt_date: "2026-04-10" }));
    expect(r.flag_price_variance).toBe(false);
  });

  it("does not flag price_variance when PO unit price is zero", () => {
    const r = classifyLine(line({
      unit_price_po: 0, unit_price_invoiced: 5.00,
      qty_received: 100, qty_invoiced: 100,
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.flag_price_variance).toBe(false);
  });
});

// ─── EXCEPTION — invoiced_before_receipt ──────────────────────────────────────

describe("classifyLine — invoiced_before_receipt (exception)", () => {
  it("is invoiced_before_receipt when invoice exists but receipt_date is null", () => {
    const r = classifyLine(line({
      qty_invoiced: 100,
      unit_price_invoiced: 10.00,
      receipt_date: null,
      invoice_submitted_at: "2026-04-01T09:00:00Z",
    }));
    expect(r.match_status).toBe("invoiced_before_receipt");
    expect(r.flag_invoiced_before_receipt).toBe(true);
  });

  it("is NOT invoiced_before_receipt when receipt came first", () => {
    const r = classifyLine(line({
      qty_received: 100, qty_invoiced: 100,
      unit_price_invoiced: 10.00,
      receipt_date: "2026-04-01",
      invoice_submitted_at: "2026-04-05T09:00:00Z",
    }));
    expect(r.flag_invoiced_before_receipt).toBe(false);
    expect(r.match_status).toBe("matched");
  });
});

// ─── Multiple flags simultaneously ───────────────────────────────────────────

describe("classifyLine — multiple flags", () => {
  it("can set both invoiced_more_than_received AND price_variance", () => {
    const r = classifyLine(line({
      qty_ordered: 100, qty_received: 80, qty_invoiced: 100,
      unit_price_po: 10.00, unit_price_invoiced: 11.00, // 10% variance
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T10:00:00Z",
    }));
    expect(r.flag_invoiced_more_than_received).toBe(true);
    expect(r.flag_price_variance).toBe(true);
    expect(r.match_status).toBe("discrepancy");
  });

  it("can set both shipped_not_received AND under_received", () => {
    const r = classifyLine(line({
      qty_ordered: 100, qty_shipped: 100, qty_received: 60,
    }));
    expect(r.flag_shipped_not_received).toBe(true);
    expect(r.flag_under_received).toBe(true);
  });
});

// ─── PO summary roll-up ───────────────────────────────────────────────────────

describe("summarisePO", () => {
  it("is matched when all lines are matched", () => {
    const lines = [
      line({ qty_received: 100, qty_invoiced: 100, unit_price_invoiced: 10, receipt_date: "2026-04-10", invoice_submitted_at: "2026-04-15T00:00:00Z" }),
      line({ qty_ordered: 50, qty_received: 50, qty_invoiced: 50, unit_price_invoiced: 10, receipt_date: "2026-04-10", invoice_submitted_at: "2026-04-15T00:00:00Z" }),
    ];
    expect(summarisePO(lines)).toBe("matched");
  });

  it("escalates to discrepancy when any line has a discrepancy", () => {
    const lines = [
      line({ qty_received: 100, qty_invoiced: 100, unit_price_invoiced: 10, receipt_date: "2026-04-10", invoice_submitted_at: "2026-04-15T00:00:00Z" }),
      line({ qty_received: 80, qty_invoiced: 100, unit_price_invoiced: 10, receipt_date: "2026-04-10", invoice_submitted_at: "2026-04-15T00:00:00Z" }),
    ];
    expect(summarisePO(lines)).toBe("discrepancy");
  });

  it("escalates to exception when any line is invoiced_before_receipt", () => {
    const lines = [
      line({ qty_received: 100, qty_invoiced: 100, unit_price_invoiced: 10, receipt_date: "2026-04-10", invoice_submitted_at: "2026-04-15T00:00:00Z" }),
      line({ qty_invoiced: 50, unit_price_invoiced: 10, receipt_date: null, invoice_submitted_at: "2026-04-01T00:00:00Z" }),
    ];
    expect(summarisePO(lines)).toBe("exception");
  });

  it("exception takes priority over discrepancy", () => {
    const lines = [
      line({ qty_received: 80, qty_invoiced: 100, unit_price_invoiced: 10, receipt_date: "2026-04-10", invoice_submitted_at: "2026-04-15T00:00:00Z" }), // discrepancy
      line({ qty_invoiced: 50, unit_price_invoiced: 10, receipt_date: null, invoice_submitted_at: "2026-04-01T00:00:00Z" }), // exception
    ];
    expect(summarisePO(lines)).toBe("exception");
  });

  it("is pending when all lines are pending", () => {
    expect(summarisePO([line(), line()])).toBe("pending");
  });

  it("is awaiting_invoice when received but none invoiced", () => {
    const lines = [
      line({ qty_received: 100, receipt_date: "2026-04-10" }),
    ];
    expect(summarisePO(lines)).toBe("awaiting_invoice");
  });

  it("is in_transit when shipped but not received", () => {
    const lines = [line({ qty_shipped: 100 })];
    expect(summarisePO(lines)).toBe("in_transit");
  });

  it("mixed pending + matched → pending", () => {
    const lines = [
      line(), // pending
      line({ qty_received: 50, qty_invoiced: 50, unit_price_invoiced: 10, receipt_date: "2026-04-10", invoice_submitted_at: "2026-04-15T00:00:00Z" }), // matched partial
    ];
    // The matched line is under_received (50 < 100) → discrepancy
    expect(summarisePO(lines)).toBe("discrepancy");
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles qty_ordered = 0 gracefully (no divide-by-zero in flags)", () => {
    const r = classifyLine(line({ qty_ordered: 0, qty_received: 0 }));
    expect(r.match_status).toBe("pending"); // qty_received 0 → pending
  });

  it("classifies correctly when all fields are exactly at boundary values", () => {
    // qty_received exactly equals qty_ordered — not under or over
    const r = classifyLine(line({
      qty_ordered: 100, qty_received: 100, qty_invoiced: 100,
      unit_price_invoiced: 10.00,
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T00:00:00Z",
    }));
    expect(r.match_status).toBe("matched");
    expect(r.flag_under_received).toBe(false);
    expect(r.flag_over_received).toBe(false);
  });

  it("price variance of exactly 0 does not set the flag", () => {
    const r = classifyLine(line({
      qty_received: 100, qty_invoiced: 100,
      unit_price_po: 15.50, unit_price_invoiced: 15.50,
      receipt_date: "2026-04-10",
      invoice_submitted_at: "2026-04-15T00:00:00Z",
    }));
    expect(r.flag_price_variance).toBe(false);
  });
});
