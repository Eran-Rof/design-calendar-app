// @vitest-environment jsdom
//
// Tests for <GlobalSearchPalette /> — Cross-cutter T6-3.
//
// Coverage:
//   - open/close (visibility + Escape via the hotkey hook)
//   - empty state when query is too short
//   - debounced fetch (no fetch before 200ms; one fetch after)
//   - loading spinner during fetch
//   - results render with title / subtitle / badge
//   - ArrowUp / ArrowDown navigate highlight
//   - Enter jumps to the highlighted result (calls navigate with routeFor URL)
//   - route_hint preferred when present
//   - no-results state
//   - error state
//   - click-outside closes
//
// fetch is mocked per-test so no real network is hit.

import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  GlobalSearchPalette,
  routeFor,
  type SearchResult,
} from "../../components/GlobalSearchPalette";

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockFetchOnceJson(json: unknown, opts?: { status?: number }) {
  const status = opts?.status ?? 200;
  const body = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  };
  global.fetch = vi.fn(() => Promise.resolve(body as unknown as Response));
}

function mockFetchReject(err: Error) {
  global.fetch = vi.fn(() => Promise.reject(err));
}

function sampleResults(): SearchResult[] {
  return [
    {
      entity_type: "customer",
      entity_id: "cust-1",
      title: "Acme Apparel Co",
      subtitle: "ACME01 · Net 30",
      rank: 0.9,
      route_hint: null,
    },
    {
      entity_type: "vendor",
      entity_id: "vend-2",
      title: "Bravo Mills",
      subtitle: "BR002",
      rank: 0.8,
      route_hint: null,
    },
    {
      entity_type: "po",
      entity_id: "po-3",
      title: "PO-12345",
      subtitle: "Bravo Mills",
      rank: 0.7,
      route_hint: "/custom/route?id=po-3",
    },
  ];
}

function Wrapper({
  initialOpen = true,
  navigate,
}: {
  initialOpen?: boolean;
  navigate?: (url: string) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <GlobalSearchPalette
      open={open}
      onClose={() => setOpen(false)}
      onToggle={(next) => setOpen(next)}
      navigate={navigate}
    />
  );
}

// ─── Setup / teardown ──────────────────────────────────────────────────────

// Real timers throughout. Debounce (200ms) is short enough that adding a
// 250ms wait per test is acceptable, and using real timers avoids subtle
// interaction with React effects, the autofocus setTimeout(0), and waitFor.

const DEBOUNCE_WAIT_MS = 260;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GlobalSearchPalette — visibility", () => {
  it("renders nothing when open=false", () => {
    render(<Wrapper initialOpen={false} />);
    expect(screen.queryByTestId("global-search-palette")).not.toBeInTheDocument();
  });

  it("renders the modal when open=true", () => {
    render(<Wrapper />);
    expect(screen.getByTestId("global-search-palette")).toBeInTheDocument();
    expect(screen.getByTestId("global-search-input")).toBeInTheDocument();
  });

  it("autofocuses the input when opened", async () => {
    render(<Wrapper />);
    // Autofocus fires inside a setTimeout 0 — wait one tick.
    const input = screen.getByTestId("global-search-input");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});

describe("GlobalSearchPalette — empty state", () => {
  it("shows the type-to-search hint while query < 2 chars", () => {
    render(<Wrapper />);
    expect(screen.getByTestId("global-search-empty")).toBeInTheDocument();
    expect(screen.getByTestId("global-search-empty").textContent).toMatch(/customers/i);
  });

  it("hint shown after typing 1 char (still below min)", () => {
    render(<Wrapper />);
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "a" } });
    expect(screen.getByTestId("global-search-empty")).toBeInTheDocument();
  });
});

describe("GlobalSearchPalette — debounced fetch + results", () => {
  it("debounces fetch (no call immediately on keystroke)", async () => {
    mockFetchOnceJson({ results: [] });
    render(<Wrapper />);

    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "acm" } });

    // 100ms later — still no fetch (debounce is 200ms).
    await sleep(100);
    expect(global.fetch).not.toHaveBeenCalled();

    // After the debounce window — one fetch.
    await sleep(DEBOUNCE_WAIT_MS);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("renders fetched results with title + subtitle", async () => {
    mockFetchOnceJson({ results: sampleResults() });
    render(<Wrapper />);

    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "acme" } });
    await sleep(DEBOUNCE_WAIT_MS);

    await waitFor(() => {
      expect(screen.getByText("Acme Apparel Co")).toBeInTheDocument();
    });
    expect(screen.getByText("ACME01 · Net 30")).toBeInTheDocument();
    // "Bravo Mills" appears twice (vendor title + PO subtitle) — assert ≥1.
    expect(screen.getAllByText("Bravo Mills").length).toBeGreaterThan(0);
    // Three result rows.
    expect(screen.getByTestId("global-search-result-0")).toBeInTheDocument();
    expect(screen.getByTestId("global-search-result-1")).toBeInTheDocument();
    expect(screen.getByTestId("global-search-result-2")).toBeInTheDocument();
  });

  it("fetch URL includes the debounced query + limit=30", async () => {
    mockFetchOnceJson({ results: [] });
    render(<Wrapper />);
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "acm" } });
    await sleep(DEBOUNCE_WAIT_MS);
    const calledUrl = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/internal/search?q=acm");
    expect(calledUrl).toContain("limit=30");
  });

  it("typing fast only fires one fetch (debounce reset)", async () => {
    mockFetchOnceJson({ results: [] });
    render(<Wrapper />);
    const input = screen.getByTestId("global-search-input");

    fireEvent.change(input, { target: { value: "ac" } });
    await sleep(80);
    fireEvent.change(input, { target: { value: "acm" } });
    await sleep(80);
    fireEvent.change(input, { target: { value: "acme" } });
    await sleep(DEBOUNCE_WAIT_MS);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const calledUrl = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("q=acme");
  });
});

describe("GlobalSearchPalette — loading state", () => {
  it("shows the spinner while a fetch is in flight", async () => {
    // Hand-rolled deferred so we can hold the fetch open.
    let resolveFetch!: (v: unknown) => void;
    global.fetch = vi.fn(() => new Promise((res) => { resolveFetch = res; }));

    render(<Wrapper />);
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "acm" } });
    await sleep(DEBOUNCE_WAIT_MS);

    // Fetch is in flight → spinner visible.
    expect(screen.getByTestId("global-search-spinner")).toBeInTheDocument();

    // Resolve → spinner disappears.
    resolveFetch({ ok: true, status: 200, json: async () => ({ results: [] }) });
    await waitFor(() => {
      expect(screen.queryByTestId("global-search-spinner")).not.toBeInTheDocument();
    });
  });
});

describe("GlobalSearchPalette — keyboard nav + Enter", () => {
  it("ArrowDown highlights the next row, ArrowUp the previous", async () => {
    mockFetchOnceJson({ results: sampleResults() });
    render(<Wrapper />);
    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "acm" } });
    await sleep(DEBOUNCE_WAIT_MS);
    await waitFor(() => expect(screen.getByText("Acme Apparel Co")).toBeInTheDocument());

    // Row 0 is initially highlighted (aria-selected=true).
    expect(screen.getByTestId("global-search-result-0").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("global-search-result-1").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("global-search-result-0").getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("global-search-result-2").getAttribute("aria-selected")).toBe("true");

    // Wrap to start.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("global-search-result-0").getAttribute("aria-selected")).toBe("true");

    // ArrowUp wraps to last.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByTestId("global-search-result-2").getAttribute("aria-selected")).toBe("true");
  });

  it("Enter calls navigate() with the routeFor URL of the highlighted result", async () => {
    mockFetchOnceJson({ results: sampleResults() });
    const navigate = vi.fn();
    render(<Wrapper navigate={navigate} />);

    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "acm" } });
    await sleep(DEBOUNCE_WAIT_MS);
    await waitFor(() => expect(screen.getByText("Acme Apparel Co")).toBeInTheDocument());

    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/tanda?view=customers&open=cust-1");
  });

  it("Enter on the route_hint row uses the hint, not the fallback", async () => {
    mockFetchOnceJson({ results: sampleResults() });
    const navigate = vi.fn();
    render(<Wrapper navigate={navigate} />);

    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "acm" } });
    await sleep(DEBOUNCE_WAIT_MS);
    await waitFor(() => expect(screen.getByText("PO-12345")).toBeInTheDocument());

    // Navigate down to the PO row (index 2).
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("/custom/route?id=po-3");
  });

  it("clicking a row navigates to that row's URL", async () => {
    mockFetchOnceJson({ results: sampleResults() });
    const navigate = vi.fn();
    render(<Wrapper navigate={navigate} />);

    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "acm" } });
    await sleep(DEBOUNCE_WAIT_MS);
    await waitFor(() => expect(screen.getByTestId("global-search-result-1")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("global-search-result-1"));
    expect(navigate).toHaveBeenCalledWith("/tanda?view=vendors&open=vend-2");
  });
});

describe("GlobalSearchPalette — no-results state", () => {
  it("shows the no-results message when results=[] and query is long enough", async () => {
    mockFetchOnceJson({ results: [] });
    render(<Wrapper />);
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "zzzqq" } });
    await sleep(DEBOUNCE_WAIT_MS);

    await waitFor(() => {
      expect(screen.getByTestId("global-search-no-results")).toBeInTheDocument();
    });
    expect(screen.getByTestId("global-search-no-results").textContent).toMatch(/zzzqq/);
  });
});

describe("GlobalSearchPalette — error state", () => {
  it("renders the error banner with the server message on non-200 response", async () => {
    mockFetchOnceJson({ error: "q must be at least 2 characters" }, { status: 400 });
    render(<Wrapper />);
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "ab" } });
    await sleep(DEBOUNCE_WAIT_MS);

    await waitFor(() => {
      expect(screen.getByTestId("global-search-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("global-search-error").textContent).toMatch(/Search failed: q must be at least/);
  });

  it("renders the error banner when fetch itself rejects (network)", async () => {
    mockFetchReject(new Error("network down"));
    render(<Wrapper />);
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "acm" } });
    await sleep(DEBOUNCE_WAIT_MS);

    await waitFor(() => {
      expect(screen.getByTestId("global-search-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("global-search-error").textContent).toMatch(/network down/);
  });
});

describe("GlobalSearchPalette — close behaviour", () => {
  it("clicking the backdrop closes the palette", () => {
    render(<Wrapper />);
    const palette = screen.getByTestId("global-search-palette");
    fireEvent.mouseDown(palette);
    expect(screen.queryByTestId("global-search-palette")).not.toBeInTheDocument();
  });

  it("clicking inside the panel does NOT close (stopPropagation)", () => {
    render(<Wrapper />);
    const input = screen.getByTestId("global-search-input");
    fireEvent.mouseDown(input);
    expect(screen.getByTestId("global-search-palette")).toBeInTheDocument();
  });

  it("Escape closes the palette (via the hotkey hook)", () => {
    render(<Wrapper />);
    expect(screen.getByTestId("global-search-palette")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("global-search-palette")).not.toBeInTheDocument();
  });
});

describe("routeFor — per-entity URL mapping", () => {
  function row(entity_type: string, entity_id: string, hint?: string | null): SearchResult {
    return { entity_type, entity_id, title: null, subtitle: null, rank: 0, route_hint: hint ?? null };
  }

  it.each([
    ["customer",         "abc",  "/tanda?view=customers&open=abc"],
    ["vendor",           "v01",  "/tanda?view=vendors&open=v01"],
    ["ar_invoice",       "inv1", "/tanda?view=ar-invoices&open=inv1"],
    ["ap_invoice",       "ap1",  "/tanda?view=ap-invoices&open=ap1"],
    ["po",               "po9",  "/tanda?view=tanda-pos&po_id=po9"],
    ["style",            "s01",  "/tanda?view=styles&open=s01"],
    ["sku",              "sku1", "/tanda?view=skus&open=sku1"],
    ["gl_account",       "gl1",  "/tanda?view=coa&open=gl1"],
    ["case",             "c01",  "/tanda?view=cases&open=c01"],
    ["sales_rep",        "r01",  "/tanda?view=sales-reps&open=r01"],
    ["bank_transaction", "b01",  "/tanda?view=bank-transactions&open=b01"],
  ])("%s → %s", (type, id, expected) => {
    expect(routeFor(row(type, id))).toBe(expected);
  });

  it("URL-encodes the entity_id", () => {
    expect(routeFor(row("customer", "abc def/123"))).toBe(
      "/tanda?view=customers&open=abc%20def%2F123",
    );
  });

  it("prefers route_hint when present", () => {
    expect(routeFor(row("customer", "abc", "/x/y?z=1"))).toBe("/x/y?z=1");
  });

  it("ignores empty / whitespace route_hint and falls back", () => {
    expect(routeFor(row("customer", "abc", "   "))).toBe("/tanda?view=customers&open=abc");
    expect(routeFor(row("customer", "abc", ""))).toBe("/tanda?view=customers&open=abc");
  });

  it("falls back to /tanda for unknown entity_type", () => {
    expect(routeFor(row("unknown_thing", "x"))).toBe("/tanda");
  });
});
