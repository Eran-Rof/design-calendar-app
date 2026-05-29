// @vitest-environment jsdom
//
// Tests for Cross-cutter T11-3 — <RowHistory /> drop-in component.
//
// Covers the pure helpers (relativeTime + summarizeJsonb) plus the
// rendered behaviour against a mocked fetch (loading → list, error,
// empty, expand-on-click).

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RowHistory, { relativeTime, summarizeJsonb } from "../RowHistory.tsx";

const SOURCE_ID = "11111111-1111-1111-1111-111111111111";
const ANOTHER_ID = "22222222-2222-2222-2222-222222222222";

type FetchInit = RequestInit | undefined;

function mockFetchOnce(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn(async (_url: RequestInfo | URL, _init?: FetchInit) => {
    return {
      ok: opts.ok !== false,
      status: opts.status ?? 200,
      async json() { return payload; },
    } as unknown as Response;
  });
  // vitest fetch shim
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

function makeChange(over: Record<string, unknown> = {}) {
  return {
    id: "c-" + Math.random().toString(36).slice(2, 8),
    operation: "UPDATE",
    changed_at: new Date().toISOString(),
    actor_auth_id: null,
    actor_employee_id: null,
    actor_display_name: "Eve Op",
    source: "manual",
    reason: null,
    correlation_id: null,
    changed_columns: ["amount_cents"],
    before_jsonb: { amount_cents: 100 },
    after_jsonb: { amount_cents: 200 },
    ...over,
  };
}

beforeEach(() => {
  // Per-test default fetch — overridden inside each test as needed.
  mockFetchOnce({ source_table: "ar_invoices", source_id: SOURCE_ID, count: 0, changes: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// relativeTime (pure)
// ─────────────────────────────────────────────────────────────────────────────
describe("relativeTime", () => {
  const NOW = Date.parse("2026-05-29T12:00:00Z");

  it("returns 'just now' for very recent timestamps", () => {
    expect(relativeTime(new Date(NOW - 1000).toISOString(), NOW)).toBe("just now");
  });

  it("returns Ns ago in the under-minute range", () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe("30s ago");
  });

  it("returns Nm ago for under-an-hour", () => {
    expect(relativeTime(new Date(NOW - 30 * 60_000).toISOString(), NOW)).toBe("30m ago");
  });

  it("returns Nh ago for under-a-day", () => {
    expect(relativeTime(new Date(NOW - 5 * 3_600_000).toISOString(), NOW)).toBe("5h ago");
  });

  it("returns Nd ago for under-a-month", () => {
    expect(relativeTime(new Date(NOW - 5 * 86_400_000).toISOString(), NOW)).toBe("5d ago");
  });

  it("falls back to ISO string when input is not a date", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("not-a-date");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// summarizeJsonb (pure)
// ─────────────────────────────────────────────────────────────────────────────
describe("summarizeJsonb", () => {
  it("returns '—' for null", () => {
    expect(summarizeJsonb(null)).toBe("—");
  });

  it("excludes noise columns (updated_at, synced_at)", () => {
    const s = summarizeJsonb({ amount_cents: 100, updated_at: "x", synced_at: "y" });
    expect(s).not.toMatch(/updated_at/);
    expect(s).not.toMatch(/synced_at/);
    expect(s).toMatch(/amount_cents=100/);
  });

  it("caps at 6 keys + adds a + more suffix", () => {
    const blob: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) blob[`k${i}`] = i;
    const s = summarizeJsonb(blob);
    expect(s).toMatch(/\+4 more/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
describe("<RowHistory /> rendering", () => {
  it("shows the loading placeholder then the empty state", async () => {
    mockFetchOnce({ source_table: "ar_invoices", source_id: SOURCE_ID, count: 0, changes: [] });
    render(<RowHistory source_table="ar_invoices" source_id={SOURCE_ID} />);
    // Both the header and the inner pane say "Loading…" during fetch; either
    // is fine — assert at least one matches.
    expect(screen.getAllByText(/Audit trail — loading…|Loading…/).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByTestId("row-history-empty")).toBeInTheDocument();
    });
    // The header also contains "No audit history" — match at least one.
    expect(screen.getAllByText(/No audit history/i).length).toBeGreaterThan(0);
  });

  it("renders one row per change", async () => {
    mockFetchOnce({
      source_table: "ar_invoices",
      source_id: SOURCE_ID,
      count: 2,
      changes: [
        makeChange({ id: "a", operation: "INSERT" }),
        makeChange({ id: "b", operation: "VOID", reason: "Customer cancelled" }),
      ],
    });
    render(<RowHistory source_table="ar_invoices" source_id={SOURCE_ID} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("row-history-row")).toHaveLength(2);
    });
    expect(screen.getByText(/Audit trail — 2 changes/)).toBeInTheDocument();
  });

  it("shows the reason text when present", async () => {
    mockFetchOnce({
      source_table: "ar_invoices",
      source_id: SOURCE_ID,
      count: 1,
      changes: [makeChange({ reason: "Operator typed this reason" })],
    });
    render(<RowHistory source_table="ar_invoices" source_id={SOURCE_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/Operator typed this reason/)).toBeInTheDocument();
    });
  });

  it("renders the operation badge with the operation name", async () => {
    mockFetchOnce({
      source_table: "ar_invoices",
      source_id: SOURCE_ID,
      count: 1,
      changes: [makeChange({ operation: "POST" })],
    });
    render(<RowHistory source_table="ar_invoices" source_id={SOURCE_ID} />);
    await waitFor(() => {
      const badges = screen.getAllByTestId("row-history-op-badge");
      expect(badges[0]).toHaveTextContent("POST");
    });
  });

  it("expands on click to show changed_columns + before/after", async () => {
    mockFetchOnce({
      source_table: "ar_invoices",
      source_id: SOURCE_ID,
      count: 1,
      changes: [
        makeChange({
          id: "row-a",
          changed_columns: ["amount_cents", "due_date"],
          before_jsonb: { amount_cents: 100 },
          after_jsonb: { amount_cents: 250 },
        }),
      ],
    });
    render(<RowHistory source_table="ar_invoices" source_id={SOURCE_ID} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("row-history-row")).toHaveLength(1);
    });
    expect(screen.queryByTestId("row-history-expanded")).toBeNull();
    fireEvent.click(screen.getByTestId("row-history-row"));
    expect(screen.getByTestId("row-history-expanded")).toBeInTheDocument();
    expect(screen.getByText("amount_cents")).toBeInTheDocument();
    expect(screen.getByText("due_date")).toBeInTheDocument();
  });

  it("collapses on second click", async () => {
    mockFetchOnce({
      source_table: "ar_invoices",
      source_id: SOURCE_ID,
      count: 1,
      changes: [makeChange()],
    });
    render(<RowHistory source_table="ar_invoices" source_id={SOURCE_ID} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("row-history-row")).toHaveLength(1);
    });
    const row = screen.getByTestId("row-history-row");
    fireEvent.click(row);
    expect(screen.getByTestId("row-history-expanded")).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.queryByTestId("row-history-expanded")).toBeNull();
  });

  it("renders the error banner when fetch is not ok", async () => {
    mockFetchOnce({ error: "boom" }, { ok: false, status: 500 });
    render(<RowHistory source_table="ar_invoices" source_id={SOURCE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId("row-history-error")).toHaveTextContent("boom");
    });
  });

  it("falls back to HTTP status text when the JSON body has no error key", async () => {
    mockFetchOnce({}, { ok: false, status: 503 });
    render(<RowHistory source_table="ar_invoices" source_id={SOURCE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId("row-history-error")).toHaveTextContent(/HTTP 503/);
    });
  });

  it("requests the documented URL with source_table + source_id params", async () => {
    const fn = mockFetchOnce({
      source_table: "vendors", source_id: ANOTHER_ID, count: 0, changes: [],
    });
    render(<RowHistory source_table="vendors" source_id={ANOTHER_ID} />);
    await waitFor(() => {
      expect(fn).toHaveBeenCalled();
    });
    const url = String(fn.mock.calls[0][0]);
    expect(url).toMatch(/\/api\/internal\/audit\/row-history/);
    expect(url).toMatch(/source_table=vendors/);
    expect(url).toMatch(new RegExp(`source_id=${ANOTHER_ID}`));
  });

  it("uses the endpoint override when provided", async () => {
    const fn = mockFetchOnce({
      source_table: "ar_invoices", source_id: SOURCE_ID, count: 0, changes: [],
    });
    render(
      <RowHistory
        source_table="ar_invoices"
        source_id={SOURCE_ID}
        endpoint="/proxy/audit/row-history"
      />,
    );
    await waitFor(() => {
      expect(fn).toHaveBeenCalled();
    });
    expect(String(fn.mock.calls[0][0])).toMatch(/^\/proxy\/audit\/row-history/);
  });

  it("renders the singular 'change' label when count === 1", async () => {
    mockFetchOnce({
      source_table: "ar_invoices",
      source_id: SOURCE_ID,
      count: 1,
      changes: [makeChange()],
    });
    render(<RowHistory source_table="ar_invoices" source_id={SOURCE_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/Audit trail — 1 change\b/)).toBeInTheDocument();
    });
  });
});
