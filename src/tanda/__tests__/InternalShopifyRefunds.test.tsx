// @vitest-environment jsdom
//
// Tests for <InternalShopifyRefunds /> — Tangerine P11-7 reports panel.
//
// Read-only surface listing shopify_refunds with refund date, parent order
// number (joined from shopify_orders), refund_type, refund_amount,
// restocking_fee, and ar_credit_memo_id link.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, cleanup } from "@testing-library/react";
import InternalShopifyRefunds from "../InternalShopifyRefunds";

type Json = unknown;

function mockShopifyFetch(state: {
  refunds: Json[];
  orders: Json[];
  refundCalls: URL[];
  orderCalls: URL[];
}) {
  const impl = (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : (input as URL).toString();
    const url = new URL(urlStr, "http://localhost");
    if (url.pathname.endsWith("/rest/v1/shopify_refunds")) {
      state.refundCalls.push(url);
      return Promise.resolve(new Response(JSON.stringify(state.refunds), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    }
    if (url.pathname.endsWith("/rest/v1/shopify_orders")) {
      state.orderCalls.push(url);
      return Promise.resolve(new Response(JSON.stringify(state.orders), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    }
    return Promise.resolve(new Response("[]", { status: 200 }));
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl as typeof fetch);
}

describe("<InternalShopifyRefunds /> — list rendering", () => {
  let state: {
    refunds: Json[];
    orders: Json[];
    refundCalls: URL[];
    orderCalls: URL[];
  };

  beforeEach(() => {
    state = { refunds: [], orders: [], refundCalls: [], orderCalls: [] };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders the panel heading", async () => {
    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);
    expect(await screen.findByRole("heading", { name: /Shopify Refunds/i })).toBeInTheDocument();
  });

  it("shows the empty state when no refunds are returned", async () => {
    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);
    expect(await screen.findByText(/No Shopify refunds\./i)).toBeInTheDocument();
  });

  it("hydrates parent order numbers from shopify_orders for each refund row", async () => {
    state.refunds = [
      {
        id: "r1", entity_id: "e1",
        shopify_order_id: "o1", shopify_refund_id: "rf1",
        refund_type: "partial",
        refund_amount_cents: "2500",
        restocking_fee_cents: "500",
        processed_at: "2026-05-15T12:00:00Z",
        ar_credit_memo_id: "11111111-2222-3333-4444-555555555555",
        je_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        created_at: "2026-05-15T12:00:00Z",
      },
      {
        id: "r2", entity_id: "e1",
        shopify_order_id: "o2", shopify_refund_id: "rf2",
        refund_type: "full",
        refund_amount_cents: "10000",
        restocking_fee_cents: "0",
        processed_at: "2026-05-14T09:00:00Z",
        ar_credit_memo_id: null,
        je_id: null,
        created_at: "2026-05-14T09:00:00Z",
      },
    ];
    state.orders = [
      { id: "o1", order_number: "#1001" },
      { id: "o2", order_number: "#1002" },
    ];

    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);

    await waitFor(() => expect(state.refundCalls.length).toBeGreaterThan(0));
    await waitFor(() => expect(state.orderCalls.length).toBeGreaterThan(0));

    expect(await screen.findByText("#1001")).toBeInTheDocument();
    expect(await screen.findByText("#1002")).toBeInTheDocument();
  });

  it("formats refund_amount and restocking_fee cents → dollar strings", async () => {
    state.refunds = [{
      id: "r1", entity_id: "e1",
      shopify_order_id: "o1", shopify_refund_id: "rf1",
      refund_type: "partial",
      refund_amount_cents: "12345",
      restocking_fee_cents: "678",
      processed_at: "2026-05-15T12:00:00Z",
      ar_credit_memo_id: null,
      je_id: null,
      created_at: "2026-05-15T12:00:00Z",
    }];
    state.orders = [{ id: "o1", order_number: "#1001" }];

    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);

    expect(await screen.findByText("$123.45")).toBeInTheDocument();
    expect(await screen.findByText("$6.78")).toBeInTheDocument();
  });

  it("renders refund_type as a colored badge text (full / partial)", async () => {
    state.refunds = [
      {
        id: "r1", entity_id: "e1",
        shopify_order_id: "o1", shopify_refund_id: "rf1",
        refund_type: "full",
        refund_amount_cents: "10000",
        restocking_fee_cents: "0",
        processed_at: "2026-05-14T09:00:00Z",
        ar_credit_memo_id: null,
        je_id: null,
        created_at: "2026-05-14T09:00:00Z",
      },
    ];
    state.orders = [{ id: "o1", order_number: "#1002" }];

    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);

    expect(await screen.findByText(/full/i)).toBeInTheDocument();
  });

  it("renders ar_credit_memo_id as a link when present, '(none)' otherwise", async () => {
    state.refunds = [
      {
        id: "r1", entity_id: "e1",
        shopify_order_id: "o1", shopify_refund_id: "rf1",
        refund_type: "partial",
        refund_amount_cents: "2500",
        restocking_fee_cents: "500",
        processed_at: "2026-05-15T12:00:00Z",
        ar_credit_memo_id: "12345678-aaaa-bbbb-cccc-dddddddddddd",
        je_id: null,
        created_at: "2026-05-15T12:00:00Z",
      },
      {
        id: "r2", entity_id: "e1",
        shopify_order_id: "o2", shopify_refund_id: "rf2",
        refund_type: "full",
        refund_amount_cents: "10000",
        restocking_fee_cents: "0",
        processed_at: "2026-05-14T09:00:00Z",
        ar_credit_memo_id: null,
        je_id: null,
        created_at: "2026-05-14T09:00:00Z",
      },
    ];
    state.orders = [
      { id: "o1", order_number: "#1001" },
      { id: "o2", order_number: "#1002" },
    ];

    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);

    // Partial → anchor with truncated UUID, "(none)" for full
    const link = await screen.findByRole("link");
    expect(link.getAttribute("href")).toContain("module=ar_invoices");
    expect(link.getAttribute("href")).toContain("12345678-aaaa-bbbb-cccc-dddddddddddd");
    expect(screen.getByText(/\(none\)/)).toBeInTheDocument();
  });
});

describe("<InternalShopifyRefunds /> — filters + query construction", () => {
  let state: {
    refunds: Json[];
    orders: Json[];
    refundCalls: URL[];
    orderCalls: URL[];
  };

  beforeEach(() => {
    state = { refunds: [], orders: [], refundCalls: [], orderCalls: [] };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("requests rows ordered by processed_at DESC and selects all key columns", async () => {
    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);

    await waitFor(() => expect(state.refundCalls.length).toBeGreaterThan(0));
    const url = state.refundCalls[0];
    expect(url.searchParams.get("order")).toBe("processed_at.desc");
    const select = url.searchParams.get("select") || "";
    expect(select).toContain("refund_type");
    expect(select).toContain("refund_amount_cents");
    expect(select).toContain("restocking_fee_cents");
    expect(select).toContain("ar_credit_memo_id");
    expect(select).toContain("processed_at");
  });

  it("applies refund_type=eq.<value> when the type filter is set", async () => {
    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);

    await waitFor(() => expect(state.refundCalls.length).toBeGreaterThan(0));

    // Themed SearchableSelect (combobox): open it and click the "Partial" option.
    const combo = screen.getAllByRole("combobox")[0]; // first combobox = type filter
    fireEvent.focus(combo.querySelector("input")!);
    // SearchableSelect commits on mousedown (beats the input's blur/close).
    fireEvent.mouseDown(within(screen.getByRole("listbox")).getByRole("option", { name: "Partial" }));

    await waitFor(() => {
      const last = state.refundCalls[state.refundCalls.length - 1];
      expect(last.searchParams.getAll("refund_type")).toContain("eq.partial");
    });
  });

  it("applies processed_at gte/lte when from/to dates set", async () => {
    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);

    await waitFor(() => expect(state.refundCalls.length).toBeGreaterThan(0));

    const dateInputs = screen.getAllByDisplayValue("") as HTMLInputElement[];
    const from = dateInputs.find((el) => el.type === "date")!;
    fireEvent.change(from, { target: { value: "2026-05-01" } });

    await waitFor(() => {
      const last = state.refundCalls[state.refundCalls.length - 1];
      const procVals = last.searchParams.getAll("processed_at");
      expect(procVals.some((v) => v.startsWith("gte.2026-05-01"))).toBe(true);
    });
  });

  it("does not call shopify_orders when there are no refunds", async () => {
    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);

    await waitFor(() => expect(state.refundCalls.length).toBeGreaterThan(0));
    // Tick the microtask queue.
    await new Promise((r) => setTimeout(r, 10));
    expect(state.orderCalls.length).toBe(0);
  });

  it("uses an IN-list to hydrate parent orders in a single round-trip", async () => {
    state.refunds = [
      {
        id: "r1", entity_id: "e1",
        shopify_order_id: "o1", shopify_refund_id: "rf1",
        refund_type: "partial",
        refund_amount_cents: "100",
        restocking_fee_cents: "0",
        processed_at: "2026-05-15T12:00:00Z",
        ar_credit_memo_id: null, je_id: null,
        created_at: "2026-05-15T12:00:00Z",
      },
      {
        id: "r2", entity_id: "e1",
        shopify_order_id: "o2", shopify_refund_id: "rf2",
        refund_type: "partial",
        refund_amount_cents: "100",
        restocking_fee_cents: "0",
        processed_at: "2026-05-15T12:00:00Z",
        ar_credit_memo_id: null, je_id: null,
        created_at: "2026-05-15T12:00:00Z",
      },
    ];
    state.orders = [
      { id: "o1", order_number: "#1001" },
      { id: "o2", order_number: "#1002" },
    ];
    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);

    await waitFor(() => expect(state.orderCalls.length).toBeGreaterThan(0));
    const url = state.orderCalls[0];
    const idClause = url.searchParams.get("id") || "";
    expect(idClause.startsWith("in.(")).toBe(true);
    expect(idClause).toContain("o1");
    expect(idClause).toContain("o2");
  });
});

describe("<InternalShopifyRefunds /> — toolbar cross-cutters", () => {
  let state: {
    refunds: Json[];
    orders: Json[];
    refundCalls: URL[];
    orderCalls: URL[];
  };

  beforeEach(() => {
    state = { refunds: [], orders: [], refundCalls: [], orderCalls: [] };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders the DateRangePresets dropdown", async () => {
    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);
    // T7 presets are folded into a single dropdown <select>.
    await waitFor(() => {
      expect(screen.getByTestId("date-range-presets-dropdown")).toBeInTheDocument();
    });
  });

  it("renders the ExportButton (xlsx-only)", async () => {
    mockShopifyFetch(state);
    render(<InternalShopifyRefunds />);
    expect(await screen.findByRole("button", { name: /Export/ })).toBeInTheDocument();
  });
});

describe("<InternalShopifyRefunds /> — error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("surfaces non-OK responses in an error banner", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("oops", { status: 500 }))
    );
    render(<InternalShopifyRefunds />);
    expect(await screen.findByText(/Error:/i)).toBeInTheDocument();
  });
});
