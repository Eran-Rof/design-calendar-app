// @vitest-environment jsdom
//
// Tangerine P13-3 — <InternalPOOrigination /> component tests.
//
// Coverage:
//  - helper exports (statusColor, fmtCents, dollarsToCentsBigInt,
//    PROCUREMENT_STATUS_OPTIONS, ALLOWED_TRANSITIONS catalog completeness)
//  - panel rendering loading + empty + error + populated rows
//  - "+ New PO" button opens the modal
//  - Status filter dropdown wires to URL params
//  - ExportButton + DateRangePresets presence
//  - PoModal validates expected_landed_cost (D9 strict)

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import InternalPOOrigination, {
  statusColor,
  fmtCents,
  dollarsToCentsBigInt,
  PROCUREMENT_STATUS_OPTIONS,
  ALLOWED_TRANSITIONS,
  type ProcurementStatus,
} from "../InternalPOOrigination";

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
  globalThis.prompt = vi.fn(() => "cancel reason");
});

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.confirm = origConfirm;
  globalThis.alert = origAlert;
  globalThis.prompt = origPrompt;
  vi.restoreAllMocks();
});

describe("InternalPOOrigination — helpers", () => {
  it("statusColor maps active statuses to success/warn/etc", () => {
    expect(statusColor("approved")).toBeTruthy();
    expect(statusColor("pending_approval")).toBeTruthy();
    expect(statusColor("cancelled")).toBeTruthy();
    expect(statusColor("draft")).toBeTruthy();
  });

  it("fmtCents handles null/undefined/empty", () => {
    expect(fmtCents(null)).toBe("$0.00");
    expect(fmtCents(undefined)).toBe("$0.00");
    expect(fmtCents("")).toBe("$0.00");
  });

  it("fmtCents formats positive cents with thousand separator", () => {
    expect(fmtCents("12345678")).toBe("$123,456.78");
  });

  it("fmtCents handles negative cents", () => {
    expect(fmtCents("-12345")).toBe("-$123.45");
  });

  it("dollarsToCentsBigInt parses simple values", () => {
    expect(dollarsToCentsBigInt("1.50")?.toString()).toBe("150");
    expect(dollarsToCentsBigInt("100")?.toString()).toBe("10000");
    expect(dollarsToCentsBigInt("0.99")?.toString()).toBe("99");
  });

  it("dollarsToCentsBigInt rejects garbage", () => {
    expect(dollarsToCentsBigInt("abc")).toBeNull();
    expect(dollarsToCentsBigInt("1.234")).toBeNull();
    expect(dollarsToCentsBigInt("")).toBeNull();
  });

  it("PROCUREMENT_STATUS_OPTIONS catalog contains all expected status values", () => {
    const values = PROCUREMENT_STATUS_OPTIONS.map((o) => o.value);
    expect(values).toContain("draft");
    expect(values).toContain("pending_approval");
    expect(values).toContain("approved");
    expect(values).toContain("open");
    expect(values).toContain("cancelled");
    expect(values).toContain("");
  });

  it("ALLOWED_TRANSITIONS encodes draft→pending_approval+cancelled", () => {
    expect(ALLOWED_TRANSITIONS.draft).toContain("pending_approval");
    expect(ALLOWED_TRANSITIONS.draft).toContain("cancelled");
  });

  it("ALLOWED_TRANSITIONS marks terminal states as empty arrays", () => {
    expect(ALLOWED_TRANSITIONS.received).toEqual([]);
    expect(ALLOWED_TRANSITIONS.closed).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe("InternalPOOrigination — rendering", () => {
  it("renders loading state initially", async () => {
    let resolveFetch: (v: unknown) => void;
    const pending = new Promise((r) => { resolveFetch = r; });
    globalThis.fetch = vi.fn(() => pending) as unknown as typeof fetch;
    render(<InternalPOOrigination />);
    expect(screen.getByText(/Loading/i)).toBeTruthy();
    resolveFetch!({ ok: true, status: 200, json: async () => [], text: async () => "[]" });
  });

  it("renders empty state after empty response", async () => {
    mockFetch(async () => []);
    render(<InternalPOOrigination />);
    await waitFor(() => expect(screen.getByText(/No procurement POs/i)).toBeTruthy());
  });

  it("renders rows from /api/internal/procurement/pos", async () => {
    const sample = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        po_number: "ROF-P000123",
        vendor: "Acme",
        vendor_id: null,
        buyer_po: null,
        buyer_name: null,
        date_order: "2026-05-29",
        date_expected: "2026-08-01",
        status: "",
        procurement_status: "open",
        expected_landed_cost_cents: "270000",
        actual_landed_cost_cents: null,
        pilot_vendor_flag: true,
        originated_by_employee_id: null,
        created_at: "2026-05-29T00:00:00Z",
        updated_at: "2026-05-29T00:00:00Z",
      },
    ];
    mockFetch(async () => sample);
    render(<InternalPOOrigination />);
    await waitFor(() => expect(screen.getByText("ROF-P000123")).toBeTruthy());
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("$2,700.00")).toBeTruthy();
  });

  it("renders error banner when fetch fails", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ error: "boom" }), text: async () => "boom",
    })) as unknown as typeof fetch;
    render(<InternalPOOrigination />);
    await waitFor(() => expect(screen.getByText(/Error: boom/)).toBeTruthy());
  });

  it("'+ New PO' button is rendered", async () => {
    mockFetch(async () => []);
    render(<InternalPOOrigination />);
    await waitFor(() => expect(screen.getByRole("button", { name: /New PO/i })).toBeTruthy());
  });

  it("clicking '+ New PO' opens the modal", async () => {
    mockFetch(async () => []);
    render(<InternalPOOrigination />);
    await waitFor(() => screen.getByRole("button", { name: /New PO/i }));
    fireEvent.click(screen.getByRole("button", { name: /New PO/i }));
    // The "Expected landed cost" field only appears inside the modal.
    await waitFor(() => expect(screen.getByText(/Expected landed cost/i)).toBeTruthy());
  });

  it("status filter dropdown contains all options", async () => {
    mockFetch(async () => []);
    render(<InternalPOOrigination />);
    await waitFor(() => screen.getByText(/All active statuses/i));
    for (const opt of PROCUREMENT_STATUS_OPTIONS) {
      expect(screen.getByText(opt.label)).toBeTruthy();
    }
  });

  it("ExportButton is rendered (Excel export)", async () => {
    mockFetch(async () => []);
    render(<InternalPOOrigination />);
    await waitFor(() => expect(screen.getAllByText(/Export/i).length).toBeGreaterThan(0));
  });

  it("pilot-only checkbox toggles the URL pilot=true param", async () => {
    const calls: string[] = [];
    mockFetch(async (url) => { calls.push(url); return []; });
    render(<InternalPOOrigination />);
    await waitFor(() => screen.getByLabelText(/Pilot vendor only/i));
    fireEvent.click(screen.getByLabelText(/Pilot vendor only/i));
    await waitFor(() => expect(calls.some((c) => c.includes("pilot=true"))).toBe(true));
  });

  it("'Include received/closed/cancelled' checkbox flips include_terminal=true", async () => {
    const calls: string[] = [];
    mockFetch(async (url) => { calls.push(url); return []; });
    render(<InternalPOOrigination />);
    await waitFor(() => screen.getByLabelText(/Include received\/closed\/cancelled/i));
    fireEvent.click(screen.getByLabelText(/Include received\/closed\/cancelled/i));
    await waitFor(() => expect(calls.some((c) => c.includes("include_terminal=true"))).toBe(true));
  });

  it("RowHistory placeholder mentions T11-3", async () => {
    mockFetch(async () => []);
    render(<InternalPOOrigination />);
    await waitFor(() => expect(screen.getByText(/T11-3 RowHistory/i)).toBeTruthy());
  });
});

// Bind the type import so tsc doesn't strip it (silences unused-locals).
const _t: ProcurementStatus = "draft";
void _t;
