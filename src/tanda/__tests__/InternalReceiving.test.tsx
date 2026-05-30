// @vitest-environment jsdom
//
// Tangerine P13-3 — <InternalReceiving /> component tests.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import InternalReceiving, {
  statusColor,
  fmtCents,
  dollarsToCents,
  RECEIPT_STATUS_OPTIONS,
  ALLOWED_TRANSITIONS,
  type ReceiptStatus,
} from "../InternalReceiving";

const origFetch = globalThis.fetch;
const origConfirm = globalThis.confirm;
const origAlert = globalThis.alert;
const origPrompt = globalThis.prompt;

function mockFetch(responder: (url: string, init?: RequestInit) => Promise<unknown> | unknown) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const payload = await responder(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.confirm = vi.fn(() => true);
  globalThis.alert = vi.fn();
  globalThis.prompt = vi.fn(() => "x");
});

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.confirm = origConfirm;
  globalThis.alert = origAlert;
  globalThis.prompt = origPrompt;
  vi.restoreAllMocks();
});

describe("InternalReceiving — helpers", () => {
  it("statusColor distinguishes posted from approved", () => {
    expect(statusColor("approved")).not.toBe(statusColor("posted"));
  });

  it("fmtCents handles big numbers cleanly", () => {
    expect(fmtCents("100000000")).toBe("$1,000,000.00");
  });

  it("fmtCents handles bad input gracefully", () => {
    expect(fmtCents("garbage")).toBe("$0.00");
  });

  it("dollarsToCents parses two-decimal values", () => {
    expect(dollarsToCents("12.50")?.toString()).toBe("1250");
    expect(dollarsToCents("0.01")?.toString()).toBe("1");
  });

  it("dollarsToCents rejects three decimals", () => {
    expect(dollarsToCents("1.234")).toBeNull();
  });

  it("RECEIPT_STATUS_OPTIONS includes all four statuses + the All option", () => {
    const values = RECEIPT_STATUS_OPTIONS.map((o) => o.value);
    expect(values).toContain("");
    expect(values).toContain("draft");
    expect(values).toContain("pending_approval");
    expect(values).toContain("approved");
    expect(values).toContain("posted");
  });

  it("ALLOWED_TRANSITIONS encodes the canonical 4-step receipt flow", () => {
    expect(ALLOWED_TRANSITIONS.draft).toEqual(["pending_approval"]);
    expect(ALLOWED_TRANSITIONS.pending_approval).toContain("approved");
    expect(ALLOWED_TRANSITIONS.approved).toEqual(["posted"]);
    expect(ALLOWED_TRANSITIONS.posted).toEqual([]);
  });
});

describe("InternalReceiving — rendering", () => {
  it("renders the panel heading with the procurement emoji", async () => {
    mockFetch(async () => []);
    render(<InternalReceiving />);
    await waitFor(() => expect(screen.getByText(/Procurement — Receiving/i)).toBeTruthy());
  });

  it("renders empty state when no receipts", async () => {
    mockFetch(async () => []);
    render(<InternalReceiving />);
    await waitFor(() => expect(screen.getByText(/No receipts/i)).toBeTruthy());
  });

  it("renders rows from the receipts endpoint", async () => {
    const sample = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        entity_id: "e",
        tanda_po_id: "00000000-0000-0000-0000-000000000020",
        receipt_date: "2026-05-29",
        received_by_employee_id: null,
        status: "draft" as ReceiptStatus,
        landed_cost_cents: "172500",
        notes: "test",
        je_id: null,
        created_at: "2026-05-29T00:00:00Z",
        updated_at: "2026-05-29T00:00:00Z",
      },
    ];
    mockFetch(async (url) => {
      if (url.includes("/api/internal/procurement/receipts?")) return sample;
      return [];
    });
    render(<InternalReceiving />);
    await waitFor(() => expect(screen.getByText(/2026-05-29/)).toBeTruthy());
    expect(screen.getByText("$1,725.00")).toBeTruthy();
  });

  it("'+ New receipt' button is rendered", async () => {
    mockFetch(async () => []);
    render(<InternalReceiving />);
    await waitFor(() => expect(screen.getByRole("button", { name: /New receipt/i })).toBeTruthy());
  });

  it("opens the new-receipt modal on click", async () => {
    mockFetch(async () => []);
    render(<InternalReceiving />);
    await waitFor(() => screen.getByRole("button", { name: /New receipt/i }));
    fireEvent.click(screen.getByRole("button", { name: /New receipt/i }));
    // The D19 rollups section only appears once the modal opens.
    await waitFor(() => expect(screen.getByText(/D19 Rollups/i)).toBeTruthy());
  });

  it("modal's rollups section starts empty with hint copy", async () => {
    mockFetch(async () => []);
    render(<InternalReceiving />);
    await waitFor(() => screen.getByRole("button", { name: /New receipt/i }));
    fireEvent.click(screen.getByRole("button", { name: /New receipt/i }));
    await waitFor(() => screen.getByText(/D19 Rollups/i));
    expect(screen.getByText(/No rollups yet/i)).toBeTruthy();
  });

  it("modal's rollups section exposes Add button", async () => {
    mockFetch(async () => []);
    render(<InternalReceiving />);
    await waitFor(() => screen.getByRole("button", { name: /New receipt/i }));
    fireEvent.click(screen.getByRole("button", { name: /New receipt/i }));
    await waitFor(() => screen.getByText(/D19 Rollups/i));
    expect(screen.getByRole("button", { name: /Add rollup line/i })).toBeTruthy();
  });

  it("includes capitalized + all-rollups totals in the rollups header", async () => {
    mockFetch(async () => []);
    render(<InternalReceiving />);
    await waitFor(() => screen.getByRole("button", { name: /New receipt/i }));
    fireEvent.click(screen.getByRole("button", { name: /New receipt/i }));
    await waitFor(() => screen.getByText(/D19 Rollups/i));
    expect(screen.getByText(/Capitalized total/i)).toBeTruthy();
    expect(screen.getByText(/All rollups/i)).toBeTruthy();
  });

  it("Include posted checkbox toggles include_posted=true URL param", async () => {
    const calls: string[] = [];
    mockFetch(async (url) => { calls.push(url); return []; });
    render(<InternalReceiving />);
    await waitFor(() => screen.getByLabelText(/Include posted/i));
    fireEvent.click(screen.getByLabelText(/Include posted/i));
    await waitFor(() => expect(calls.some((c) => c.includes("include_posted=true"))).toBe(true));
  });

  it("ExportButton renders on the toolbar", async () => {
    mockFetch(async () => []);
    render(<InternalReceiving />);
    await waitFor(() => expect(screen.getAllByText(/Export/i).length).toBeGreaterThan(0));
  });
});
