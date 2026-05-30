// @vitest-environment jsdom
//
// Tangerine P13-3 — <InternalBookkeeperApprovalQueue /> component tests.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import InternalBookkeeperApprovalQueue, {
  fmtCents,
  statusColor,
  type RollupInvoice,
} from "../InternalBookkeeperApprovalQueue";

const origFetch = globalThis.fetch;
const origConfirm = globalThis.confirm;
const origAlert = globalThis.alert;
const origPrompt = globalThis.prompt;

function mockFetch(responder: (url: string, init?: RequestInit) => Promise<unknown> | unknown, opts: { ok?: boolean; status?: number } = {}) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const payload = await responder(url, init);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.confirm = vi.fn(() => true);
  globalThis.alert = vi.fn();
  globalThis.prompt = vi.fn(() => "reason");
});

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.confirm = origConfirm;
  globalThis.alert = origAlert;
  globalThis.prompt = origPrompt;
  vi.restoreAllMocks();
});

function sampleInvoice(overrides: Partial<RollupInvoice> = {}): RollupInvoice {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entity_id: "e",
    vendor_id: "00000000-0000-0000-0000-000000000099",
    invoice_number: "AUTO-TPR-12345678-1",
    invoice_kind: "vendor_bill",
    status: "pending_bookkeeper_approval",
    gl_status: "unposted",
    posting_date: "2026-05-29",
    total_amount_cents: "125000",
    expense_account_id: null,
    description: "Inbound freight rollup",
    is_receipt_rollup: true,
    rollup_parent_receipt_id: "00000000-0000-0000-0000-000000000200",
    source: "manual",
    created_at: "2026-05-29T00:00:00Z",
    updated_at: "2026-05-29T00:00:00Z",
    ...overrides,
  };
}

describe("InternalBookkeeperApprovalQueue — helpers", () => {
  it("fmtCents formats amount cents", () => {
    expect(fmtCents("125000")).toBe("$1,250.00");
  });
  it("statusColor differs across pending/approved/rejected", () => {
    expect(statusColor("pending_bookkeeper_approval")).not.toBe(statusColor("approved"));
    expect(statusColor("rejected")).not.toBe(statusColor("approved"));
  });
});

describe("InternalBookkeeperApprovalQueue — rendering", () => {
  it("renders the panel heading", async () => {
    mockFetch(async () => []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => expect(screen.getByText(/Bookkeeper Approval Queue/i)).toBeTruthy());
  });

  it("renders the D19 context banner mentioning P13-3 stub + P13-4 future", async () => {
    mockFetch(async () => []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => expect(screen.getByText(/D19 receipt-rollup workflow/i)).toBeTruthy());
    expect(screen.getByText(/P13-4/i)).toBeTruthy();
  });

  it("renders empty state when no rollup invoices are pending", async () => {
    mockFetch(async () => []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => expect(screen.getByText(/No rollup AP invoices/i)).toBeTruthy());
  });

  it("renders a queue row with invoice #, vendor, amount", async () => {
    mockFetch(async (url) => url.includes("bookkeeper-queue") ? [sampleInvoice()] : []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => expect(screen.getByText("AUTO-TPR-12345678-1")).toBeTruthy());
    expect(screen.getByText("$1,250.00")).toBeTruthy();
  });

  it("renders both Approve + Reject buttons for pending row", async () => {
    mockFetch(async (url) => url.includes("bookkeeper-queue") ? [sampleInvoice()] : []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve/i })).toBeTruthy());
    expect(screen.getByRole("button", { name: /Reject/i })).toBeTruthy();
  });

  it("hides Approve/Reject buttons for approved rows", async () => {
    mockFetch(async (url) => url.includes("bookkeeper-queue") ? [sampleInvoice({ status: "approved" })] : []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => expect(screen.getByText("AUTO-TPR-12345678-1")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Approve/i })).toBeNull();
  });

  it("Include history checkbox flips include_history=true URL param", async () => {
    const calls: string[] = [];
    mockFetch(async (url) => { calls.push(url); return []; });
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => screen.getByLabelText(/Include approved \+ rejected history/i));
    fireEvent.click(screen.getByLabelText(/Include approved \+ rejected history/i));
    await waitFor(() => expect(calls.some((c) => c.includes("include_history=true"))).toBe(true));
  });

  it("Approve click hits the stub endpoint and surfaces the 501 message", async () => {
    let approveHit = false;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as { url: string }).url;
      if (url.includes("/bookkeeper-approve")) {
        approveHit = true;
        return {
          ok: false, status: 501,
          json: async () => ({ error: "Not implemented", detail: "ships in P13-4" }),
          text: async () => "501",
        } as Response;
      }
      if (url.includes("bookkeeper-queue")) {
        return {
          ok: true, status: 200,
          json: async () => [sampleInvoice()],
          text: async () => "[]",
        } as Response;
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" } as Response;
    }) as unknown as typeof fetch;
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => screen.getByRole("button", { name: /Approve/i }));
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() => expect(approveHit).toBe(true));
    await waitFor(() => expect(globalThis.alert).toHaveBeenCalled());
  });

  it("Approve confirmation includes the formatted amount", async () => {
    mockFetch(async (url) => url.includes("bookkeeper-queue") ? [sampleInvoice()] : []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => screen.getByRole("button", { name: /Approve/i }));
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() => expect(globalThis.confirm).toHaveBeenCalled());
    const arg = (globalThis.confirm as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(arg).toMatch(/AUTO-TPR-12345678-1/);
    expect(arg).toMatch(/\$1,250\.00/);
  });

  it("Reject prompts for a reason and bails out if user cancels prompt", async () => {
    globalThis.prompt = vi.fn(() => null) as unknown as typeof globalThis.prompt;
    mockFetch(async (url) => url.includes("bookkeeper-queue") ? [sampleInvoice()] : []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => screen.getByRole("button", { name: /Reject/i }));
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    await waitFor(() => expect(globalThis.prompt).toHaveBeenCalled());
  });

  it("Refresh button re-issues the fetch", async () => {
    let calls = 0;
    mockFetch(async (url) => { if (url.includes("bookkeeper-queue")) calls++; return []; });
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => screen.getByRole("button", { name: /Refresh/i }));
    const before = calls;
    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });

  it("ExportButton renders even on empty queue", async () => {
    mockFetch(async () => []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => expect(screen.getAllByText(/Export/i).length).toBeGreaterThan(0));
  });

  it("Queue count badge updates with rows length", async () => {
    mockFetch(async (url) => url.includes("bookkeeper-queue") ? [sampleInvoice()] : []);
    render(<InternalBookkeeperApprovalQueue />);
    await waitFor(() => expect(screen.getByText(/1 in queue/i)).toBeTruthy());
  });
});
