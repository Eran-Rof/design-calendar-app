// @vitest-environment jsdom
//
// Tests for Cross-cutter T11-3 — <InternalAuditLog /> admin panel.
//
// Covers the pure helpers (buildAuditLogQuery + flattenChangeForExport)
// plus the rendered behaviour (filter wiring → URL params, operation
// toggle, side panel open/close, pagination guards, error banner).

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import InternalAuditLog, {
  buildAuditLogQuery,
  flattenChangeForExport,
  T11_SOURCE_TABLES,
  AUDIT_OPERATIONS,
} from "../InternalAuditLog.tsx";

const ENTITY_ID = "11111111-1111-1111-1111-111111111111";
const ROW_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "33333333-3333-3333-3333-333333333333";

// Track all fetch URLs the component requested.
function installFetch(handlers: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    calls.push(u);
    let payload: unknown = {};
    for (const [pattern, body] of Object.entries(handlers)) {
      if (u.includes(pattern)) {
        payload = body;
        break;
      }
    }
    return {
      ok: true,
      status: 200,
      async json() { return payload; },
    } as unknown as Response;
  });
  // vitest fetch shim
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return { fn, calls };
}

function makeChange(over: Record<string, unknown> = {}) {
  return {
    id: "c-" + Math.random().toString(36).slice(2, 8),
    entity_id: ENTITY_ID,
    source_table: "ar_invoices",
    source_id: ROW_ID,
    operation: "UPDATE",
    changed_at: new Date().toISOString(),
    actor_auth_id: null,
    actor_employee_id: ACTOR_ID,
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

afterEach(() => { vi.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────
describe("buildAuditLogQuery", () => {
  it("emits all filters when set", () => {
    const p = buildAuditLogQuery({
      from: "2026-05-01",
      to: "2026-05-29",
      source_table: "ar_invoices",
      actor: ACTOR_ID,
      operations: ["INSERT", "VOID"],
      limit: 50,
      offset: 100,
    });
    expect(p.get("from")).toBe("2026-05-01");
    expect(p.get("to")).toBe("2026-05-29");
    expect(p.get("source_table")).toBe("ar_invoices");
    expect(p.get("actor")).toBe(ACTOR_ID);
    expect(p.get("operation")).toBe("INSERT,VOID");
    expect(p.get("limit")).toBe("50");
    expect(p.get("offset")).toBe("100");
  });

  it("omits null filters", () => {
    const p = buildAuditLogQuery({
      from: "",
      to: "",
      source_table: null,
      actor: null,
      operations: [],
    });
    expect(p.get("from")).toBeNull();
    expect(p.get("to")).toBeNull();
    expect(p.get("source_table")).toBeNull();
    expect(p.get("actor")).toBeNull();
    expect(p.get("operation")).toBeNull();
  });
});

describe("flattenChangeForExport", () => {
  it("collapses changed_columns into a CSV-style string", () => {
    const row = flattenChangeForExport(makeChange({
      changed_columns: ["amount_cents", "due_date"],
    }) as Parameters<typeof flattenChangeForExport>[0]);
    expect(row.changed_columns).toBe("amount_cents, due_date");
  });

  it("falls back to '' when a field is null", () => {
    const row = flattenChangeForExport(makeChange({
      reason: null,
      correlation_id: null,
      source: null,
    }) as Parameters<typeof flattenChangeForExport>[0]);
    expect(row.reason).toBe("");
    expect(row.correlation_id).toBe("");
    expect(row.source_tag).toBe("");
  });

  it("includes the row's source_table + operation verbatim", () => {
    const row = flattenChangeForExport(makeChange({
      source_table: "vendors",
      operation: "POST",
    }) as Parameters<typeof flattenChangeForExport>[0]);
    expect(row.source_table).toBe("vendors");
    expect(row.operation).toBe("POST");
  });
});

describe("constants", () => {
  it("exposes the 16-entity T11 coverage allowlist", () => {
    expect(T11_SOURCE_TABLES.length).toBe(16);
    expect(T11_SOURCE_TABLES).toContain("ar_invoices");
    expect(T11_SOURCE_TABLES).toContain("virtual_cards");
  });

  it("exposes all 6 operations", () => {
    expect(AUDIT_OPERATIONS).toEqual([
      "INSERT", "UPDATE", "DELETE", "VOID", "POST", "REVERSE",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering + filter wiring
// ─────────────────────────────────────────────────────────────────────────────
describe("<InternalAuditLog /> rendering", () => {
  beforeEach(() => {
    installFetch({
      "/api/internal/audit/log": { count: 0, limit: 100, offset: 0, changes: [] },
      "/api/internal/employees": [],
    });
  });

  it("renders the header + a Load button", async () => {
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(screen.getByText(/Audit Log/)).toBeInTheDocument();
    });
    expect(screen.getByTestId("audit-load")).toBeInTheDocument();
  });

  it("renders one checkbox per operation", async () => {
    render(<InternalAuditLog />);
    for (const op of AUDIT_OPERATIONS) {
      expect(screen.getByTestId(`audit-op-${op}`)).toBeInTheDocument();
    }
  });

  it("offers every allowlisted source_table as an option", async () => {
    render(<InternalAuditLog />);
    // Themed SearchableSelect (combobox) — open it and read the listbox options.
    const input = screen.getByTestId("audit-source-table").querySelector("input")!;
    fireEvent.focus(input);
    const optionTexts = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    for (const t of T11_SOURCE_TABLES) {
      expect(optionTexts).toContain(t);
    }
  });

  it("shows the empty-state message when no rows are returned", async () => {
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(screen.getByText(/No audit rows match/)).toBeInTheDocument();
    });
  });

  it("fetches /api/internal/audit/log on mount with default date window", async () => {
    const { calls } = installFetch({
      "/api/internal/audit/log": { count: 0, limit: 100, offset: 0, changes: [] },
      "/api/internal/employees": [],
    });
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(calls.some((u) => u.includes("/api/internal/audit/log"))).toBe(true);
    });
    const auditCall = calls.find((u) => u.includes("/api/internal/audit/log"))!;
    expect(auditCall).toMatch(/from=\d{4}-\d{2}-\d{2}/);
    expect(auditCall).toMatch(/to=\d{4}-\d{2}-\d{2}/);
    expect(auditCall).toMatch(/limit=100/);
  });

  it("toggles operation filter on checkbox click", async () => {
    const { calls } = installFetch({
      "/api/internal/audit/log": { count: 0, limit: 100, offset: 0, changes: [] },
      "/api/internal/employees": [],
    });
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByTestId("audit-op-VOID"));
    fireEvent.click(screen.getByTestId("audit-load"));
    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(last).toMatch(/operation=VOID/);
    });
  });

  it("renders a row per change and lets us open the side panel", async () => {
    installFetch({
      "/api/internal/audit/log": {
        count: 1,
        limit: 100,
        offset: 0,
        changes: [
          makeChange({
            id: "c1",
            source_table: "ar_invoices",
            reason: "Customer cancelled",
          }),
        ],
      },
      "/api/internal/employees": [],
    });
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(screen.getAllByTestId("audit-row")).toHaveLength(1);
    });
    expect(screen.queryByTestId("audit-side-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("audit-row"));
    expect(screen.getByTestId("audit-side-panel")).toBeInTheDocument();
    // Reason appears in both the row and the side panel — match at least one.
    expect(screen.getAllByText(/Customer cancelled/).length).toBeGreaterThan(0);
  });

  it("closes the side panel via the Close button", async () => {
    installFetch({
      "/api/internal/audit/log": {
        count: 1, limit: 100, offset: 0,
        changes: [makeChange({ id: "c1" })],
      },
      "/api/internal/employees": [],
    });
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(screen.getAllByTestId("audit-row")).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId("audit-row"));
    expect(screen.getByTestId("audit-side-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("audit-side-panel-close"));
    expect(screen.queryByTestId("audit-side-panel")).toBeNull();
  });

  it("renders the side panel's changed_columns chips", async () => {
    installFetch({
      "/api/internal/audit/log": {
        count: 1, limit: 100, offset: 0,
        changes: [
          makeChange({
            id: "c1",
            changed_columns: ["amount_cents", "due_date", "memo"],
          }),
        ],
      },
      "/api/internal/employees": [],
    });
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(screen.getAllByTestId("audit-row")).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId("audit-row"));
    const cols = screen.getByTestId("audit-changed-cols");
    expect(cols).toHaveTextContent("amount_cents");
    expect(cols).toHaveTextContent("due_date");
    expect(cols).toHaveTextContent("memo");
  });

  it("disables Prev on page 1", async () => {
    installFetch({
      "/api/internal/audit/log": { count: 0, limit: 100, offset: 0, changes: [] },
      "/api/internal/employees": [],
    });
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(screen.getByTestId("audit-prev")).toBeDisabled();
    });
  });

  it("disables Next when current page has < PAGE rows", async () => {
    installFetch({
      "/api/internal/audit/log": {
        count: 1, limit: 100, offset: 0,
        changes: [makeChange()],
      },
      "/api/internal/employees": [],
    });
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(screen.getByTestId("audit-next")).toBeDisabled();
    });
  });

  it("surfaces the API error message in the error banner", async () => {
    const fn = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/internal/audit/log")) {
        return {
          ok: false, status: 500,
          async json() { return { error: "server kablooey" }; },
        } as unknown as Response;
      }
      return { ok: true, status: 200, async json() { return []; } } as unknown as Response;
    });
    (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
    render(<InternalAuditLog />);
    await waitFor(() => {
      expect(screen.getByTestId("audit-error")).toHaveTextContent(/server kablooey/);
    });
  });
});
