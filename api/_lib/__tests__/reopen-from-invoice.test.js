// Unit tests for reopenSalesOrderFromInvoice — the SO state-machine repair run
// when an AR invoice generated from a sales order is deleted/voided.

import { describe, it, expect } from "vitest";
import { reopenSalesOrderFromInvoice } from "../sales-orders/reopenFromInvoice.js";

// Minimal supabase mock. Reads are canned per table; updates are captured.
function mockAdmin({ invoice, so, invLines, soLines }) {
  const updates = { sales_order_lines: [], sales_orders: [] };
  function builder(table) {
    const ctx = { table, isUpdate: false, payload: null };
    const chain = {
      select: () => chain,
      update: (payload) => { ctx.isUpdate = true; ctx.payload = payload; return chain; },
      eq: () => chain,
      maybeSingle: async () => {
        if (table === "ar_invoices") return { data: invoice };
        if (table === "sales_orders") return { data: so };
        return { data: null };
      },
      then: (resolve) => {
        if (ctx.isUpdate) { updates[table].push(ctx.payload); return resolve({ error: null }); }
        if (table === "ar_invoice_lines") return resolve({ data: invLines });
        if (table === "sales_order_lines") return resolve({ data: soLines });
        return resolve({ data: null });
      },
    };
    return chain;
  }
  return { from: (t) => builder(t), _updates: updates };
}

describe("reopenSalesOrderFromInvoice", () => {
  it("no-ops for an invoice with no sales order", async () => {
    const admin = mockAdmin({ invoice: { id: "i1", sales_order_id: null } });
    const r = await reopenSalesOrderFromInvoice(admin, "i1");
    expect(r.reopened).toBe(false);
    expect(admin._updates.sales_orders).toHaveLength(0);
  });

  it("un-invoices SO lines and re-opens the header to 'allocated' when fully allocated", async () => {
    const admin = mockAdmin({
      invoice: { id: "i1", sales_order_id: "so1" },
      so: { id: "so1", so_number: "SO-2026-00010", status: "invoiced" },
      invLines: [{ sales_order_line_id: "l1", quantity: 100 }],
      soLines: [{ id: "l1", qty_ordered: 100, qty_invoiced: 100, qty_allocated: 100, status: "invoiced" }],
    });
    const r = await reopenSalesOrderFromInvoice(admin, "i1");
    expect(r).toMatchObject({ reopened: true, so_number: "SO-2026-00010" });
    // line reset: qty_invoiced 100→0, status invoiced→allocated (fully allocated)
    expect(admin._updates.sales_order_lines[0]).toMatchObject({ qty_invoiced: 0, status: "allocated" });
    // header reopened to allocated
    expect(admin._updates.sales_orders[0]).toMatchObject({ status: "allocated" });
  });

  it("re-opens to 'confirmed' when not fully allocated", async () => {
    const admin = mockAdmin({
      invoice: { id: "i1", sales_order_id: "so1" },
      so: { id: "so1", so_number: "SO-1", status: "invoiced" },
      invLines: [{ sales_order_line_id: "l1", quantity: 50 }],
      soLines: [{ id: "l1", qty_ordered: 100, qty_invoiced: 50, qty_allocated: 0, status: "invoiced" }],
    });
    await reopenSalesOrderFromInvoice(admin, "i1");
    expect(admin._updates.sales_order_lines[0]).toMatchObject({ qty_invoiced: 0, status: "confirmed" });
    expect(admin._updates.sales_orders[0]).toMatchObject({ status: "confirmed" });
  });

  it("never resurrects a cancelled order header", async () => {
    const admin = mockAdmin({
      invoice: { id: "i1", sales_order_id: "so1" },
      so: { id: "so1", so_number: "SO-1", status: "cancelled" },
      invLines: [{ sales_order_line_id: "l1", quantity: 100 }],
      soLines: [{ id: "l1", qty_ordered: 100, qty_invoiced: 100, qty_allocated: 100, status: "cancelled" }],
    });
    await reopenSalesOrderFromInvoice(admin, "i1");
    // header not touched (status stays cancelled — no update pushed)
    expect(admin._updates.sales_orders).toHaveLength(0);
  });
});
