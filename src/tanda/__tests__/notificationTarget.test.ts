import { describe, it, expect } from "vitest";
import { notificationTarget, notificationTargetUrl } from "../notificationTarget";

describe("notificationTarget (internal notification_events resolver)", () => {
  it("routes a sales order by so_number (human ref, no UUID)", () => {
    const t = notificationTarget({ context_table: "sales_orders", context_id: "uuid-1", payload: { so_number: "SO-2026-00005" } });
    expect(t).toEqual({ module: "sales_orders", params: { q: "SO-2026-00005" } });
  });

  it("routes a sales order by id when so_number absent", () => {
    const t = notificationTarget({ context_table: "sales_orders", context_id: "uuid-1", payload: {} });
    expect(t).toEqual({ module: "sales_orders", params: { so: "uuid-1" } });
  });

  it("routes AP invoices (context_table 'invoices') by invoice_number", () => {
    const t = notificationTarget({ context_table: "invoices", context_id: "x", payload: { invoice_number: "AP-99" } });
    expect(t).toEqual({ module: "ap_invoices", params: { q: "AP-99" } });
  });

  it("routes AR invoices by invoice_number", () => {
    const t = notificationTarget({ context_table: "ar_invoices", context_id: "x", payload: { invoice_number: "AR-7" } });
    expect(t).toEqual({ module: "ar_invoices", params: { q: "AR-7" } });
  });

  it("routes a customer with open + contact + note params", () => {
    const t = notificationTarget({ context_table: "customers", context_id: "cust-1", payload: { contact_id: "c1", note_id: "n1" } });
    expect(t).toEqual({ module: "customer_master", params: { open: "cust-1", contact: "c1", note: "n1" } });
  });

  it("falls back to the module list for crm_tasks (no drill param)", () => {
    const t = notificationTarget({ context_table: "crm_tasks", context_id: "t1", payload: {} });
    expect(t).toEqual({ module: "crm_tasks", params: {} });
  });

  it("returns null for system/run events with no UI home", () => {
    expect(notificationTarget({ context_table: "xoro_mirror_runs", context_id: null })).toBeNull();
    expect(notificationTarget({ context_table: null, context_id: null })).toBeNull();
  });

  it("builds a same-app ?m= URL", () => {
    expect(notificationTargetUrl({ context_table: "sales_orders", context_id: "x", payload: { so_number: "SO-1" } }))
      .toBe("?m=sales_orders&q=SO-1");
    expect(notificationTargetUrl({ context_table: "xoro_mirror_runs", context_id: null })).toBeNull();
  });
});
