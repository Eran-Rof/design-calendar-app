// @vitest-environment jsdom
//
// Tangerine P12-99 — <InternalMarketplaceStatus /> component tests.
//
// Coverage: catalogs (channels, feeds, deposit tables), helper fns,
// rendering (loading / loaded / error), per-channel rollups, manual
// "Run now" button gating, ExportButton presence, date-range presets
// integration, stub fallback when /api/internal/marketplace-status is
// missing in the env.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// The panel routes its confirm/alert through the canonical warn surface
// (src/shared/ui/warn). In isolation there's no <WarnHost> to drive the modal,
// so stub confirmDialog to auto-confirm and notify to a noop.
vi.mock("../../shared/ui/warn", () => ({
  notify: vi.fn(),
  confirmDialog: vi.fn(() => Promise.resolve(true)),
  WarnHost: () => null,
}));

import InternalMarketplaceStatus, {
  CHANNEL_LABEL,
  FEEDS,
  DEPOSIT_TABLES,
  UNPOSTED_JE_TABLES,
  stubStatuses,
  fmtDateTime,
  type FeedStatus,
} from "../InternalMarketplaceStatus";

// ─────────────────────────────────────────────────────────────────────────
// Test harness — global fetch mock + localStorage for auth.
// ─────────────────────────────────────────────────────────────────────────
const origFetch = globalThis.fetch;
const origConfirm = globalThis.confirm;
const origAlert = globalThis.alert;

function mockFetchOnce(payload: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  }) as unknown as typeof fetch;
}

function makeFeedStatuses(): FeedStatus[] {
  return FEEDS.map((f, i) => ({
    channel: f.channel,
    kind: f.kind,
    table: f.table,
    last_sync_at: `2026-05-2${(8 - (i % 5))}T12:00:00Z`,
    rows_in_range: 10 + i,
    unposted_count: f.kind === "orders" ? i % 3 : null,
    unmatched_deposits: f.kind === "payouts" || f.kind === "settlements" ? i % 2 : null,
    errors_24h: i % 4,
  }));
}

beforeEach(() => {
  globalThis.confirm = vi.fn(() => true);
  globalThis.alert = vi.fn();
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.confirm = origConfirm;
  globalThis.alert = origAlert;
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// Catalogs
// ─────────────────────────────────────────────────────────────────────────
describe("InternalMarketplaceStatus — catalogs", () => {
  it("CHANNEL_LABEL exposes all four channels", () => {
    expect(Object.keys(CHANNEL_LABEL).sort()).toEqual(["faire", "fba", "shopify", "walmart"]);
  });

  it("every channel has a human label", () => {
    for (const ch of ["shopify", "fba", "walmart", "faire"] as const) {
      expect(CHANNEL_LABEL[ch]).toBeTruthy();
    }
  });

  it("FEEDS covers ≥3 feeds per channel", () => {
    for (const ch of ["shopify", "fba", "walmart", "faire"] as const) {
      const feeds = FEEDS.filter((f) => f.channel === ch);
      expect(feeds.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("every FEEDS entry has a non-empty manualUrl", () => {
    for (const f of FEEDS) {
      expect(f.manualUrl).toMatch(/^\/api\//);
      expect(f.manualLabel).toBeTruthy();
    }
  });

  it("DEPOSIT_TABLES catalog matches the four channel deposit tables", () => {
    expect(DEPOSIT_TABLES.map((d) => d.table).sort()).toEqual([
      "faire_payouts",
      "fba_settlements",
      "shopify_payouts",
      "walmart_settlements",
    ]);
  });

  it("UNPOSTED_JE_TABLES covers all four channels exactly once", () => {
    expect(UNPOSTED_JE_TABLES.map((u) => u.channel).sort()).toEqual(["faire", "fba", "shopify", "walmart"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
describe("helpers", () => {
  it("fmtDateTime returns em-dash for null/undefined", () => {
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
    expect(fmtDateTime("")).toBe("—");
  });

  it("fmtDateTime renders an ISO string into a non-empty local-string", () => {
    const v = fmtDateTime("2026-05-29T12:00:00Z");
    expect(v).not.toBe("—");
    expect(v.length).toBeGreaterThan(0);
  });

  it("stubStatuses produces one row per FEEDS entry with null counts", () => {
    const rows = stubStatuses();
    expect(rows).toHaveLength(FEEDS.length);
    for (const r of rows) {
      expect(r.last_sync_at).toBeNull();
      expect(r.unposted_count).toBeNull();
      expect(r.unmatched_deposits).toBeNull();
      expect(r.errors_24h).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────
describe("<InternalMarketplaceStatus /> — rendering", () => {
  it("shows a loading state on first mount before fetch resolves", () => {
    // Use an unresolved promise so the panel stays in loading.
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<InternalMarketplaceStatus />);
    expect(screen.getAllByText(/Loading…/)[0]).toBeInTheDocument();
  });

  it("renders four channel rollup cards after load", async () => {
    mockFetchOnce({ feeds: makeFeedStatuses() });
    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(screen.getByText(/Feed status/)).toBeInTheDocument());
    expect(screen.getAllByText(/Shopify/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Amazon FBA/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Walmart/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Faire/).length).toBeGreaterThan(0);
  });

  it("renders one row per feed in the status table", async () => {
    mockFetchOnce({ feeds: makeFeedStatuses() });
    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(screen.getByText(new RegExp(`Feed status \\(${FEEDS.length}\\)`))).toBeInTheDocument());
  });

  it("falls back to stub statuses when the endpoint returns 404", async () => {
    mockFetchOnce({ error: "not deployed" }, 404);
    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(screen.getByText(/marketplace-status endpoint not deployed/)).toBeInTheDocument());
    // Stub still produces FEEDS rows so the table is non-empty.
    expect(screen.getByText(new RegExp(`Feed status \\(${FEEDS.length}\\)`))).toBeInTheDocument();
  });

  it("surfaces a non-404 error banner without crashing", async () => {
    mockFetchOnce({ error: "boom" }, 500);
    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
  });

  it("renders an ExportButton labeled with the row count", async () => {
    mockFetchOnce({ feeds: makeFeedStatuses() });
    render(<InternalMarketplaceStatus />);
    await waitFor(() => {
      const btn = screen.getByTitle(/Export \d+ rows? \(Excel or PDF\)/);
      expect(btn).toBeInTheDocument();
    });
  });

  it("renders the DateRangePresets dropdown with date-input pair", async () => {
    mockFetchOnce({ feeds: makeFeedStatuses() });
    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(screen.getByLabelText(/From date/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/To date/i)).toBeInTheDocument();
    // Presets are folded into a single dropdown <select>.
    expect(screen.getByTestId("date-range-presets-dropdown")).toBeInTheDocument();
  });

  it("Manual 'Run now' buttons are disabled when no cached auth user", async () => {
    mockFetchOnce({ feeds: makeFeedStatuses() });
    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(document.querySelectorAll("button[data-manual-url]").length).toBeGreaterThan(0));
    const runBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-manual-url]"));
    for (const b of runBtns) expect(b).toBeDisabled();
  });

  it("Manual 'Run now' buttons enabled once authUserId is cached", async () => {
    localStorage.setItem("tangerine.auth_user_id", "00000000-0000-0000-0000-000000000001");
    mockFetchOnce({ feeds: makeFeedStatuses() });
    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(document.querySelectorAll("button[data-manual-url]").length).toBeGreaterThan(0));
    const runBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-manual-url]"));
    expect(runBtns[0]).not.toBeDisabled();
  });

  it("clicking 'Run now' POSTs to the feed's manualUrl", async () => {
    localStorage.setItem("tangerine.auth_user_id", "00000000-0000-0000-0000-000000000002");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ // initial load
        ok: true, status: 200,
        json: async () => ({ feeds: makeFeedStatuses() }),
        text: async () => "",
      })
      .mockResolvedValueOnce({ // manual POST
        ok: true, status: 200,
        json: async () => ({ ok: true }),
        text: async () => "{\"ok\":true}",
      })
      .mockResolvedValue({ // post-run reload
        ok: true, status: 200,
        json: async () => ({ feeds: makeFeedStatuses() }),
        text: async () => "",
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(document.querySelectorAll("button[data-manual-url]").length).toBeGreaterThan(0));
    const firstRun = document.querySelector<HTMLButtonElement>("button[data-manual-url]")!;
    const url = firstRun.getAttribute("data-manual-url");
    expect(url).toMatch(/^\/api\//);

    fireEvent.click(firstRun);
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((c) => c[0] === url && c[1]?.method === "POST");
      expect(postCall).toBeTruthy();
    });
  });

  it("changing the from-date triggers a re-fetch with the new range", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ feeds: makeFeedStatuses() }),
      text: async () => "",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByLabelText(/From date/i), { target: { value: "2026-01-01" } });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
    // The new call URL should embed the chosen date.
    const refreshCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(String(refreshCall[0])).toMatch(/from=2026-01-01/);
  });

  it("Period close hook reminder block is rendered", async () => {
    mockFetchOnce({ feeds: makeFeedStatuses() });
    render(<InternalMarketplaceStatus />);
    await waitFor(() => expect(screen.getByText(/Period close hook/i)).toBeInTheDocument());
    expect(screen.getByText(/unmatched_marketplace_deposits/)).toBeInTheDocument();
  });
});
