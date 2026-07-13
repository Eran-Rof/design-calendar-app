// @vitest-environment jsdom
//
// Tests for the QuickBooks-style source-document viewer.
//
// Verifies the drill's final hop: given an AR invoice ref, the modal fetches the
// document + resolves its SKU line items and renders a real invoice (number,
// customer, line with SKU, and a computed total) — not a filtered list.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SourceDocumentModal, { type SourceDocOpen } from "../SourceDocumentModal";

const INVOICE = {
  invoice_number: "ROF ECOM-I141000",
  invoice_date: "2025-10-14",
  due_date: "2025-11-13",
  gl_status: "paid",
  total_amount_cents: 6370,
  paid_amount_cents: 6370,
  description: null,
  notes: null,
  lines: [
    { id: "l1", line_number: 1, description: "Historical line ROF ECOM-I141000-1", inventory_item_id: "it1", quantity: "1.0000", unit_price_cents: 2990, line_total_cents: 2990, tax_amount_cents: 0 },
    { id: "l2", line_number: 2, description: "Historical line ROF ECOM-I141000-2", inventory_item_id: "it2", quantity: "1.0000", unit_price_cents: 3380, line_total_cents: 3380, tax_amount_cents: 0 },
  ],
};
const ITEMS = [
  { id: "it1", sku_code: "TEE-BLK-M", style_code: "TEE", description: "Logo Tee", color: "Black", size: "M" },
  { id: "it2", sku_code: "TEE-BLU-L", style_code: "TEE", description: "Logo Tee", color: "Blue", size: "L" },
];

function mockFetch() {
  global.fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes("/ar-invoices/")) return Promise.resolve({ ok: true, json: () => Promise.resolve(INVOICE) } as unknown as Response);
    if (u.includes("/items?ids=")) return Promise.resolve({ ok: true, json: () => Promise.resolve(ITEMS) } as unknown as Response);
    return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "unexpected" }) } as unknown as Response);
  }) as unknown as typeof fetch;
}

const doc: SourceDocOpen = { docType: "ar", id: "inv-uuid", number: "ROF ECOM-I141000", party: "Shopify rof-clothing", module: "ar_invoices" };

describe("SourceDocumentModal", () => {
  beforeEach(() => { mockFetch(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders the actual invoice: number, customer, SKU line, and total", async () => {
    render(<SourceDocumentModal doc={doc} onClose={() => {}} />);

    // Header shows the invoice number and the resolved customer name.
    expect(await screen.findByText("ROF ECOM-I141000")).toBeTruthy();
    expect(screen.getByText("Shopify rof-clothing")).toBeTruthy();

    // Lines resolve their SKU from the item master (not the "Historical line…" placeholder).
    await waitFor(() => expect(screen.getByText("TEE-BLK-M")).toBeTruthy());
    expect(screen.getByText("TEE-BLU-L")).toBeTruthy();

    // Total ($63.70) is rendered.
    expect(screen.getAllByText((t) => t.includes("63.70")).length).toBeGreaterThan(0);
  });

  it("labels an AP bill as a Bill with the vendor", async () => {
    global.fetch = vi.fn((url: string) => {
      const u = String(url);
      if (u.includes("/ap-invoices/")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...INVOICE, invoice_number: "PBPT-B000275" }) } as unknown as Response);
      if (u.includes("/items?ids=")) return Promise.resolve({ ok: true, json: () => Promise.resolve(ITEMS) } as unknown as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "x" }) } as unknown as Response);
    }) as unknown as typeof fetch;

    render(<SourceDocumentModal doc={{ docType: "ap", id: "bill-uuid", number: "PBPT-B000275", party: "Psycho Tuna Vendor", module: "ap_invoices" }} onClose={() => {}} />);
    expect(await screen.findByText("PBPT-B000275")).toBeTruthy();
    expect(screen.getByText("Vendor")).toBeTruthy();
    expect(screen.getByText("Psycho Tuna Vendor")).toBeTruthy();
  });
});
