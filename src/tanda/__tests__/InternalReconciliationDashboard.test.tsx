// @vitest-environment jsdom
//
// Tangerine P9-7 — tests for <InternalReconciliationDashboard />.
//
// Covers the pure helpers (buildRunsQuery / buildVariancesQuery /
// indexRunsByDomainDate / latestRunPerDomain / varianceCount / fmtCents /
// buildDateRange / flattenVarianceForExport) and the rendered behaviour:
// 5 domain cards, run-now wiring to the engine handler, date-range
// picker → grid query, cell click → side panel, clear button + reason
// modal (D3 audit pattern — reason required), cleared status badge,
// ExportButton presence, cutover history table.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// On Windows (case-insensitive FS), the dashboard's
// `./components/DateRangePresets` import can resolve to the lower-case
// helper file (`dateRangePresets.ts`) which has no default export.
// Vercel (Linux, case-sensitive) hits the .tsx so prod is fine.
// Mock the .tsx component module so the test mounts cleanly on either OS.
vi.mock("../components/DateRangePresets", () => ({
  default: ({ onChange }: { onChange?: (f: string, t: string) => void }) => (
    <div data-testid="mock-date-range-presets" onClick={() => onChange?.("2026-01-01", "2026-01-31")}>
      mock-presets
    </div>
  ),
}));

import InternalReconciliationDashboard, {
  buildRunsQuery,
  buildVariancesQuery,
  indexRunsByDomainDate,
  latestRunPerDomain,
  varianceCount,
  fmtCents,
  buildDateRange,
  flattenVarianceForExport,
  DOMAINS,
  DOMAIN_LABEL,
  RUN_ENDPOINTS,
} from "../InternalReconciliationDashboard.tsx";

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const VARIANCE_ID = "22222222-2222-2222-2222-222222222222";

// ────────────────────────────────────────────────────────────────────────
// Test-doubles for fetch — pattern-matches the URL substring to a payload.
// ────────────────────────────────────────────────────────────────────────
type FetchHandler =
  | unknown
  | ((url: string, init?: RequestInit) => unknown);

function installFetch(handlers: Record<string, FetchHandler>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    let payload: unknown = {};
    let ok = true;
    let status = 200;
    for (const [pattern, body] of Object.entries(handlers)) {
      if (u.includes(pattern)) {
        const resolved = typeof body === "function"
          ? (body as (s: string, i?: RequestInit) => unknown)(u, init)
          : body;
        if (resolved && typeof resolved === "object" && "__ok" in (resolved as Record<string, unknown>)) {
          const r = resolved as { __ok: boolean; __status?: number; body: unknown };
          ok = r.__ok;
          status = r.__status ?? (r.__ok ? 200 : 500);
          payload = r.body;
        } else {
          payload = resolved;
        }
        break;
      }
    }
    return {
      ok,
      status,
      async json() { return payload; },
    } as unknown as Response;
  });
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return { fn, calls };
}

function makeRun(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN_ID,
    entity_id: "ent-1",
    domain: "inventory",
    run_date: "2026-05-29",
    period_start: "2026-05-01",
    period_end: "2026-05-31",
    cadence: "manual",
    status: "clean",
    started_at: "2026-05-29T01:00:00Z",
    completed_at: "2026-05-29T01:05:00Z",
    totals_jsonb: { variances_found: 0 },
    replay_of_id: null,
    replay_reason: null,
    notes: null,
    created_at: "2026-05-29T01:00:00Z",
    updated_at: "2026-05-29T01:05:00Z",
    ...over,
  };
}

function makeVariance(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: VARIANCE_ID,
    recon_run_id: RUN_ID,
    source_table: "ar_invoices",
    source_id: "inv-001",
    source_tag: "shopify",
    tangerine_amount_cents: 12345,
    xoro_amount_cents: 12300,
    variance_amount_cents: 45,
    variance_percent: 0.0036,
    status: "over",
    notes: null,
    created_at: "2026-05-29T02:00:00Z",
    ...over,
  };
}

function makeCutover(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cu-1",
    entity_id: "ent-1",
    domain: "ap",
    source_tag: "xoro_mirror",
    clean_window_start: "2026-01-01",
    clean_window_end: "2026-04-30",
    total_recons: 120,
    signoff_employee_id: "ee-aaaa1111-bbbb-2222-cccc-3333dddd4444",
    signoff_at: "2026-05-01T00:00:00Z",
    notes: null,
    ...over,
  };
}

afterEach(() => { vi.restoreAllMocks(); });

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────
describe("buildRunsQuery", () => {
  it("emits domain + from + to when set", () => {
    const p = buildRunsQuery({ domain: "inventory", from: "2026-05-01", to: "2026-05-29", limit: 500, offset: 0 });
    expect(p.get("domain")).toBe("inventory");
    expect(p.get("from")).toBe("2026-05-01");
    expect(p.get("to")).toBe("2026-05-29");
    expect(p.get("limit")).toBe("500");
    expect(p.get("offset")).toBe("0");
  });
  it("omits null domain", () => {
    const p = buildRunsQuery({ domain: null, from: "2026-05-01", to: "2026-05-29" });
    expect(p.get("domain")).toBeNull();
  });
});

describe("buildVariancesQuery", () => {
  it("always emits recon_run_id", () => {
    const p = buildVariancesQuery({ recon_run_id: RUN_ID });
    expect(p.get("recon_run_id")).toBe(RUN_ID);
  });
  it("includes optional status + source_tag", () => {
    const p = buildVariancesQuery({ recon_run_id: RUN_ID, status: "over", source_tag: "fba" });
    expect(p.get("status")).toBe("over");
    expect(p.get("source_tag")).toBe("fba");
  });
});

describe("indexRunsByDomainDate / latestRunPerDomain", () => {
  it("indexes by (domain, run_date)", () => {
    const runs = [
      makeRun({ id: "a", domain: "ap", run_date: "2026-05-01" }),
      makeRun({ id: "b", domain: "ap", run_date: "2026-05-02" }),
      makeRun({ id: "c", domain: "inventory", run_date: "2026-05-02" }),
    ];
    // @ts-expect-error — test fixture types
    const idx = indexRunsByDomainDate(runs);
    expect(idx.ap["2026-05-01"].id).toBe("a");
    expect(idx.ap["2026-05-02"].id).toBe("b");
    expect(idx.inventory["2026-05-02"].id).toBe("c");
  });
  it("prefers most-recent updated_at on (domain, run_date) collision", () => {
    const older = makeRun({ id: "old", domain: "ap", run_date: "2026-05-01", updated_at: "2026-05-01T00:00:00Z" });
    const newer = makeRun({ id: "new", domain: "ap", run_date: "2026-05-01", updated_at: "2026-05-02T00:00:00Z" });
    // @ts-expect-error — test fixture types
    const idx = indexRunsByDomainDate([older, newer]);
    expect(idx.ap["2026-05-01"].id).toBe("new");
  });
  it("picks the most recent run per domain", () => {
    const runs = [
      makeRun({ id: "old", domain: "ap", run_date: "2026-05-01" }),
      makeRun({ id: "new", domain: "ap", run_date: "2026-05-29" }),
    ];
    // @ts-expect-error — test fixture types
    const latest = latestRunPerDomain(runs);
    expect(latest.ap!.id).toBe("new");
  });
});

describe("varianceCount", () => {
  it("returns 0 when totals_jsonb is missing", () => {
    expect(varianceCount(null)).toBe(0);
    expect(varianceCount(undefined)).toBe(0);
    // @ts-expect-error
    expect(varianceCount({ totals_jsonb: null })).toBe(0);
  });
  it("reads totals_jsonb.variances_found", () => {
    // @ts-expect-error
    expect(varianceCount({ totals_jsonb: { variances_found: 7 } })).toBe(7);
  });
  it("falls back to variances_over alias", () => {
    // @ts-expect-error
    expect(varianceCount({ totals_jsonb: { variances_over: 4 } })).toBe(4);
  });
});

describe("fmtCents", () => {
  it("formats positive cents to $", () => {
    expect(fmtCents(12345)).toBe("$123.45");
  });
  it("formats null/undefined to em-dash", () => {
    expect(fmtCents(null)).toBe("—");
    expect(fmtCents(undefined)).toBe("—");
  });
});

describe("buildDateRange", () => {
  it("returns descending dates inclusive", () => {
    const out = buildDateRange("2026-05-27", "2026-05-29");
    expect(out).toEqual(["2026-05-29", "2026-05-28", "2026-05-27"]);
  });
  it("caps at 60 days by default", () => {
    const out = buildDateRange("2025-01-01", "2026-05-29");
    expect(out.length).toBe(60);
  });
  it("returns [] on inverted range", () => {
    expect(buildDateRange("2026-05-29", "2026-05-01")).toEqual([]);
  });
});

describe("flattenVarianceForExport", () => {
  it("flattens cents to dollars + nulls source_tag fallback", () => {
    // @ts-expect-error
    const row = flattenVarianceForExport(makeVariance({ source_tag: null, notes: null }));
    expect(row.tangerine_dollars).toBe(123.45);
    expect(row.xoro_dollars).toBe(123.00);
    expect(row.variance_dollars).toBe(0.45);
    expect(row.source_tag).toBe("");
    expect(row.notes).toBe("");
  });
});

describe("constants", () => {
  it("DOMAINS lists the 5 canonical domains", () => {
    expect(DOMAINS).toEqual(["ap", "ar", "cash", "gl", "inventory"]);
  });
  it("DOMAIN_LABEL covers every domain", () => {
    for (const d of DOMAINS) expect(DOMAIN_LABEL[d]).toBeTruthy();
  });
  it("RUN_ENDPOINTS wires inventory only (other domains pending)", () => {
    expect(RUN_ENDPOINTS.inventory).toBe("/api/internal/recon/run-inventory");
    expect(RUN_ENDPOINTS.ap).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Rendering + interactions
// ────────────────────────────────────────────────────────────────────────
describe("<InternalReconciliationDashboard /> rendering", () => {
  beforeEach(() => {
    installFetch({
      "/api/internal/recon/runs":     { count: 0, limit: 1000, offset: 0, runs: [] },
      "/api/internal/recon/cutovers": { count: 0, limit: 200,  offset: 0, cutovers: [] },
    });
  });

  it("renders the header", async () => {
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByText(/Parallel-Run Reconciliation/)).toBeInTheDocument();
    });
  });

  it("renders 5 domain status cards", async () => {
    render(<InternalReconciliationDashboard />);
    for (const d of DOMAINS) {
      expect(screen.getByTestId(`recon-card-${d}`)).toBeInTheDocument();
    }
  });

  it("fetches /api/internal/recon/runs on mount with a date window", async () => {
    const { calls } = installFetch({
      "/api/internal/recon/runs":     { count: 0, limit: 1000, offset: 0, runs: [] },
      "/api/internal/recon/cutovers": { count: 0, limit: 200,  offset: 0, cutovers: [] },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/internal/recon/runs"))).toBe(true);
    });
    const runsCall = calls.find((c) => c.url.includes("/api/internal/recon/runs"))!;
    expect(runsCall.url).toMatch(/from=\d{4}-\d{2}-\d{2}/);
    expect(runsCall.url).toMatch(/to=\d{4}-\d{2}-\d{2}/);
    expect(runsCall.url).toMatch(/limit=1000/);
  });

  it("fetches cutovers on mount", async () => {
    const { calls } = installFetch({
      "/api/internal/recon/runs":     { count: 0, limit: 1000, offset: 0, runs: [] },
      "/api/internal/recon/cutovers": { count: 0, limit: 200,  offset: 0, cutovers: [] },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/internal/recon/cutovers"))).toBe(true);
    });
  });

  it("Run-now button calls the inventory engine handler on inventory card", async () => {
    const { calls } = installFetch({
      "/api/internal/recon/runs":          { count: 0, limit: 1000, offset: 0, runs: [] },
      "/api/internal/recon/cutovers":      { count: 0, limit: 200,  offset: 0, cutovers: [] },
      "/api/internal/recon/run-inventory": { ok: true, status: "clean", recon_run_id: "rrr-1" },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-run-now-inventory")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("recon-run-now-inventory"));
    await waitFor(() => {
      const hit = calls.find((c) =>
        c.url.includes("/api/internal/recon/run-inventory") &&
        c.init?.method === "POST"
      );
      expect(hit).toBeTruthy();
      const body = JSON.parse(String(hit!.init!.body));
      expect(body.cadence).toBe("manual");
      expect(body.period_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.period_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it("Run-now button is disabled on domains without a wired engine (e.g. ap)", async () => {
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-run-now-ap")).toBeInTheDocument();
    });
    const apBtn = screen.getByTestId("recon-run-now-ap") as HTMLButtonElement;
    expect(apBtn.disabled).toBe(true);
  });

  it("date-range picker (to input) triggers a new runs fetch", async () => {
    const { calls } = installFetch({
      "/api/internal/recon/runs":     { count: 0, limit: 1000, offset: 0, runs: [] },
      "/api/internal/recon/cutovers": { count: 0, limit: 200,  offset: 0, cutovers: [] },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/internal/recon/runs"))).toBe(true);
    });
    const before = calls.length;
    fireEvent.change(screen.getByTestId("recon-to"), { target: { value: "2026-04-30" } });
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(before);
      const last = calls.slice(before).find((c) => c.url.includes("/api/internal/recon/runs"))!;
      expect(last.url).toContain("to=2026-04-30");
    });
  });

  it("renders status grid with a row per domain and at least one date column", async () => {
    installFetch({
      "/api/internal/recon/runs": {
        count: 1, limit: 1000, offset: 0,
        runs: [makeRun({ domain: "inventory", status: "clean" })],
      },
      "/api/internal/recon/cutovers": { count: 0, limit: 200, offset: 0, cutovers: [] },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-grid")).toBeInTheDocument();
    });
    // Sticky-left domain cell shows the inventory row label.
    const grid = screen.getByTestId("recon-grid");
    expect(within(grid).getByText(/Inventory/)).toBeInTheDocument();
  });

  it("clicking a populated grid cell opens the variance side panel + fetches variances", async () => {
    const { calls } = installFetch({
      "/api/internal/recon/runs": {
        count: 1, limit: 1000, offset: 0,
        runs: [makeRun({ id: RUN_ID, domain: "inventory", run_date: "2026-05-29", status: "variance" })],
      },
      "/api/internal/recon/cutovers": { count: 0, limit: 200, offset: 0, cutovers: [] },
      "/api/internal/recon/variances": {
        count: 1, limit: 500, offset: 0,
        variances: [makeVariance({ id: VARIANCE_ID, status: "over" })],
      },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-cell-inventory-2026-05-29")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("recon-cell-inventory-2026-05-29"));
    await waitFor(() => {
      expect(screen.getByTestId("recon-side-panel")).toBeInTheDocument();
    });
    expect(calls.some((c) =>
      c.url.includes("/api/internal/recon/variances") &&
      c.url.includes(`recon_run_id=${RUN_ID}`)
    )).toBe(true);
  });

  it("clear button opens the reason modal — Clear-variance disabled until reason typed", async () => {
    installFetch({
      "/api/internal/recon/runs": {
        count: 1, limit: 1000, offset: 0,
        runs: [makeRun({ id: RUN_ID, status: "variance" })],
      },
      "/api/internal/recon/cutovers": { count: 0, limit: 200, offset: 0, cutovers: [] },
      "/api/internal/recon/variances": {
        count: 1, limit: 500, offset: 0,
        variances: [makeVariance({ id: VARIANCE_ID, status: "over" })],
      },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-cell-inventory-2026-05-29")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("recon-cell-inventory-2026-05-29"));
    await waitFor(() => {
      expect(screen.getByTestId(`recon-clear-btn-${VARIANCE_ID}`)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId(`recon-clear-btn-${VARIANCE_ID}`));
    const modal = await screen.findByTestId("recon-clear-modal");
    expect(modal).toBeInTheDocument();
    const confirm = screen.getByTestId("recon-clear-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    // Type reason — confirm becomes enabled.
    fireEvent.change(screen.getByTestId("recon-clear-reason-input"), {
      target: { value: "Xoro CM-99213 not yet mirrored" },
    });
    expect(confirm.disabled).toBe(false);
  });

  it("submitting the reason POSTs to /clear with the reason", async () => {
    const { calls } = installFetch({
      "/api/internal/recon/runs": {
        count: 1, limit: 1000, offset: 0,
        runs: [makeRun({ id: RUN_ID, status: "variance" })],
      },
      "/api/internal/recon/cutovers": { count: 0, limit: 200, offset: 0, cutovers: [] },
      "/api/internal/recon/variances": {
        count: 1, limit: 500, offset: 0,
        variances: [makeVariance({ id: VARIANCE_ID, status: "over" })],
      },
      "/clear": { ok: true, variance: { ...makeVariance({ id: VARIANCE_ID, status: "cleared" }) } },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-cell-inventory-2026-05-29")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("recon-cell-inventory-2026-05-29"));
    await waitFor(() => {
      expect(screen.getByTestId(`recon-clear-btn-${VARIANCE_ID}`)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId(`recon-clear-btn-${VARIANCE_ID}`));
    await screen.findByTestId("recon-clear-modal");
    fireEvent.change(screen.getByTestId("recon-clear-reason-input"), {
      target: { value: "Mirrored late — OK to clear." },
    });
    fireEvent.click(screen.getByTestId("recon-clear-confirm"));
    await waitFor(() => {
      const hit = calls.find((c) =>
        c.url.includes(`/api/internal/recon/variances/${VARIANCE_ID}/clear`)
      );
      expect(hit).toBeTruthy();
      expect(hit!.init?.method).toBe("POST");
      const body = JSON.parse(String(hit!.init!.body));
      expect(body.reason).toBe("Mirrored late — OK to clear.");
    });
  });

  it("cleared variance shows the 'cleared' status badge", async () => {
    installFetch({
      "/api/internal/recon/runs": {
        count: 1, limit: 1000, offset: 0,
        runs: [makeRun({ id: RUN_ID, status: "variance" })],
      },
      "/api/internal/recon/cutovers": { count: 0, limit: 200, offset: 0, cutovers: [] },
      "/api/internal/recon/variances": {
        count: 1, limit: 500, offset: 0,
        variances: [makeVariance({ id: VARIANCE_ID, status: "cleared" })],
      },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-cell-inventory-2026-05-29")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("recon-cell-inventory-2026-05-29"));
    await waitFor(() => {
      expect(screen.getByTestId("recon-variance-table")).toBeInTheDocument();
    });
    const row = screen.getByTestId(`recon-variance-row-${VARIANCE_ID}`);
    expect(within(row).getByText(/cleared/)).toBeInTheDocument();
    // The Clear button must NOT render for an already-cleared row.
    expect(screen.queryByTestId(`recon-clear-btn-${VARIANCE_ID}`)).toBeNull();
  });

  it("renders the ExportButton in the side panel", async () => {
    installFetch({
      "/api/internal/recon/runs": {
        count: 1, limit: 1000, offset: 0,
        runs: [makeRun({ id: RUN_ID, status: "variance" })],
      },
      "/api/internal/recon/cutovers": { count: 0, limit: 200, offset: 0, cutovers: [] },
      "/api/internal/recon/variances": {
        count: 1, limit: 500, offset: 0,
        variances: [makeVariance({ status: "over" })],
      },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-cell-inventory-2026-05-29")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("recon-cell-inventory-2026-05-29"));
    await waitFor(() => {
      expect(screen.getByTestId("recon-side-panel")).toBeInTheDocument();
    });
    // ExportButton renders "⬇ Export (n)" when rows > 0.
    expect(screen.getByText(/⬇ Export/)).toBeInTheDocument();
  });

  it("cutover history table renders when cutovers exist", async () => {
    installFetch({
      "/api/internal/recon/runs":     { count: 0, limit: 1000, offset: 0, runs: [] },
      "/api/internal/recon/cutovers": {
        count: 1, limit: 200, offset: 0,
        cutovers: [makeCutover({ id: "cu-1", domain: "ap" })],
      },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-cutover-table")).toBeInTheDocument();
    });
    expect(screen.getByTestId("recon-cutover-row-cu-1")).toBeInTheDocument();
  });

  it("cutover panel shows the empty-state message when no cutovers", async () => {
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByText(/No cutover sign-offs yet/)).toBeInTheDocument();
    });
  });

  it("side panel close button removes the panel", async () => {
    installFetch({
      "/api/internal/recon/runs": {
        count: 1, limit: 1000, offset: 0,
        runs: [makeRun({ id: RUN_ID, status: "variance" })],
      },
      "/api/internal/recon/cutovers": { count: 0, limit: 200, offset: 0, cutovers: [] },
      "/api/internal/recon/variances": {
        count: 0, limit: 500, offset: 0, variances: [],
      },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-cell-inventory-2026-05-29")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("recon-cell-inventory-2026-05-29"));
    await screen.findByTestId("recon-side-panel");
    fireEvent.click(screen.getByTestId("recon-side-panel-close"));
    expect(screen.queryByTestId("recon-side-panel")).toBeNull();
  });

  it("surfaces the runs API error in the banner", async () => {
    const fn = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/internal/recon/runs")) {
        return {
          ok: false, status: 500,
          async json() { return { error: "runs-kaboom" }; },
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        async json() { return { count: 0, cutovers: [] }; },
      } as unknown as Response;
    });
    (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-error")).toHaveTextContent(/runs-kaboom/);
    });
  });

  it("variance count badge shows the totals_jsonb.variances_found value", async () => {
    installFetch({
      "/api/internal/recon/runs": {
        count: 1, limit: 1000, offset: 0,
        runs: [makeRun({ domain: "inventory", status: "variance", totals_jsonb: { variances_found: 3 } })],
      },
      "/api/internal/recon/cutovers": { count: 0, limit: 200, offset: 0, cutovers: [] },
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      const card = screen.getByTestId("recon-card-inventory");
      // Card has the variance count + the word "variance" or "variances".
      expect(within(card).getByText("3")).toBeInTheDocument();
    });
  });

  it("disables the Run-now button while a run is in flight", async () => {
    // Hold the inventory request open so the button stays in "Running…"
    let resolveRun: ((v: unknown) => void) | null = null;
    installFetch({
      "/api/internal/recon/runs":     { count: 0, limit: 1000, offset: 0, runs: [] },
      "/api/internal/recon/cutovers": { count: 0, limit: 200,  offset: 0, cutovers: [] },
      "/api/internal/recon/run-inventory": () => new Promise((r) => { resolveRun = r; }),
    });
    render(<InternalReconciliationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("recon-run-now-inventory")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("recon-run-now-inventory"));
    await waitFor(() => {
      expect(screen.getByTestId("recon-run-now-inventory")).toHaveTextContent(/Running/);
    });
    const btn = screen.getByTestId("recon-run-now-inventory") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // Resolve so the test doesn't leak the open promise.
    resolveRun?.({ ok: true, status: "clean" });
  });
});
