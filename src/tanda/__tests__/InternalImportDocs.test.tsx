// @vitest-environment jsdom
//
// Tangerine P13-6 — <InternalImportDocs /> component tests (M48).
//
// Coverage:
//  - pure helpers (statusColor, formatCents, STATUS_OPTIONS, DOC_TYPE_OPTIONS, DOCUMENT_TYPES)
//  - panel rendering: loading + empty + populated rows
//  - "+ Add document" button opens the modal
//  - status filter adds query param
//  - document_type filter adds query param
//  - ExportButton present
//  - T11 D3 — DELETE prompts for reason
//  - RowHistory slot reserved (T11-3 placeholder note present)

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import InternalImportDocs, {
  statusColor,
  formatCents,
  STATUS_OPTIONS,
  DOC_TYPE_OPTIONS,
  DOCUMENT_TYPES,
  ImportDocModal,
  type ImportDocRow,
} from "../InternalImportDocs";

const origFetch = globalThis.fetch;
const origConfirm = globalThis.confirm;
const origAlert = globalThis.alert;
const origPrompt = globalThis.prompt;

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];

function mockFetch(responder: (url: string, init?: RequestInit) => Promise<unknown> | unknown) {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    fetchCalls.push({ url, init });
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
  globalThis.prompt = vi.fn(() => "test reason");
});

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.confirm = origConfirm;
  globalThis.alert = origAlert;
  globalThis.prompt = origPrompt;
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────
// Helper exports
// ────────────────────────────────────────────────────────────────────────

describe("InternalImportDocs — helpers", () => {
  it("statusColor distinguishes pending / received / verified / filed", () => {
    expect(statusColor("pending")).not.toBe(statusColor("filed"));
    expect(statusColor("received")).not.toBe(statusColor("verified"));
    expect(statusColor("filed")).not.toBe(statusColor("pending"));
  });

  it("formatCents handles null/undefined as em-dash", () => {
    expect(formatCents(null)).toBe("—");
  });

  it("formatCents formats whole + fractional cents", () => {
    expect(formatCents(2700000)).toBe("$27,000.00");
    expect(formatCents(1234)).toBe("$12.34");
  });

  it("formatCents handles negatives", () => {
    expect(formatCents(-1234)).toBe("-$12.34");
  });

  it("STATUS_OPTIONS exposes default + 4 statuses", () => {
    const values = STATUS_OPTIONS.map((o) => o.value);
    expect(values).toContain("");
    expect(values).toContain("pending");
    expect(values).toContain("received");
    expect(values).toContain("verified");
    expect(values).toContain("filed");
  });

  it("DOC_TYPE_OPTIONS exposes default + 5 doc types", () => {
    const values = DOC_TYPE_OPTIONS.map((o) => o.value);
    expect(values.length).toBe(6); // 5 + the "All types" entry
    expect(values).toContain("commercial_invoice");
    expect(values).toContain("packing_list");
    expect(values).toContain("bill_of_lading");
    expect(values).toContain("certificate_of_origin");
    expect(values).toContain("customs_declaration");
  });

  it("DOCUMENT_TYPES exposes the 5 canonical types (no default)", () => {
    expect(DOCUMENT_TYPES.length).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Panel rendering
// ────────────────────────────────────────────────────────────────────────

describe("InternalImportDocs — rendering", () => {
  it("renders the panel heading", async () => {
    mockFetch(async () => []);
    render(<InternalImportDocs />);
    await waitFor(() => expect(screen.getByText(/Procurement — Import Documentation/i)).toBeTruthy());
  });

  it("renders empty state when no docs", async () => {
    mockFetch(async () => []);
    render(<InternalImportDocs />);
    await waitFor(() => expect(screen.getByText(/No import documents/i)).toBeTruthy());
  });

  it("renders rows from the import-docs endpoint", async () => {
    const sample: ImportDocRow[] = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        entity_id: "e",
        tanda_po_id: "00000000-0000-0000-0000-000000000020",
        document_type: "commercial_invoice",
        document_url: "https://example.com/inv.pdf",
        hs_code: "6109.10.0040",
        country_of_origin: "CN",
        declared_value_cents: 2700000,
        duty_rate_pct: 7.5,
        status: "received",
        created_at: "2026-05-29T00:00:00Z",
      },
    ];
    mockFetch(async (url) => {
      if (url.includes("/api/internal/procurement/import-docs")) return sample;
      if (url.includes("/api/internal/procurement/pos")) return [];
      return [];
    });
    render(<InternalImportDocs />);
    await waitFor(() => expect(screen.getByText("commercial_invoice")).toBeTruthy());
    expect(screen.getByText("6109.10.0040")).toBeTruthy();
    expect(screen.getByText("$27,000.00")).toBeTruthy();
  });

  it("'+ Add document' button is rendered", async () => {
    mockFetch(async () => []);
    render(<InternalImportDocs />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Add document/i })).toBeTruthy());
  });

  it("opens the new-doc modal on click", async () => {
    mockFetch(async () => []);
    render(<InternalImportDocs />);
    await waitFor(() => screen.getByRole("button", { name: /Add document/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add document/i }));
    await waitFor(() => expect(screen.getByText(/^Add import document$/)).toBeTruthy());
  });

  it("status filter adds status= query param", async () => {
    mockFetch(async () => []);
    render(<InternalImportDocs />);
    await waitFor(() => screen.getAllByRole("combobox")[1]); // status select
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1], { target: { value: "received" } });
    await waitFor(() => {
      const sawStatus = fetchCalls.some((c) => c.url.includes("status=received"));
      expect(sawStatus).toBe(true);
    });
  });

  it("document_type filter adds document_type= query param", async () => {
    mockFetch(async () => []);
    render(<InternalImportDocs />);
    await waitFor(() => screen.getAllByRole("combobox")[2]);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[2], { target: { value: "bill_of_lading" } });
    await waitFor(() => {
      const sawType = fetchCalls.some((c) => c.url.includes("document_type=bill_of_lading"));
      expect(sawType).toBe(true);
    });
  });

  it("ExportButton is rendered", async () => {
    mockFetch(async () => []);
    render(<InternalImportDocs />);
    await waitFor(() => expect(screen.getByText(/Export/i)).toBeTruthy());
  });

  it("RowHistory placeholder is rendered (T11-3 reserved slot)", async () => {
    mockFetch(async () => []);
    render(<InternalImportDocs />);
    await waitFor(() => expect(screen.getByText(/T11-3 RowHistory drop-in/i)).toBeTruthy());
  });
});

// ────────────────────────────────────────────────────────────────────────
// ImportDocModal — T11 D3 destructive delete reason prompt
// ────────────────────────────────────────────────────────────────────────

describe("ImportDocModal — T11 D3 destructive delete", () => {
  it("DELETE prompts for a reason before firing the request", async () => {
    let deleteFired = false;
    let deleteBody: string | undefined;
    mockFetch(async (url, init) => {
      if (init?.method === "DELETE") {
        deleteFired = true;
        deleteBody = init.body as string;
        return { deleted: "id" };
      }
      return [];
    });
    const existing: ImportDocRow = {
      id: "00000000-0000-0000-0000-000000000010",
      entity_id: "e",
      tanda_po_id: "00000000-0000-0000-0000-000000000020",
      document_type: "commercial_invoice",
      document_url: null,
      hs_code: null,
      country_of_origin: null,
      declared_value_cents: null,
      duty_rate_pct: null,
      status: "pending",
      created_at: "2026-05-29T00:00:00Z",
    };
    render(<ImportDocModal doc={existing} pos={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => screen.getByRole("button", { name: /Delete \(with reason\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /Delete \(with reason\)/i }));
    await waitFor(() => {
      expect(globalThis.prompt).toHaveBeenCalled();
      expect(deleteFired).toBe(true);
      expect(deleteBody).toContain("test reason");
    });
  });

  it("DELETE is suppressed when operator cancels the prompt", async () => {
    globalThis.prompt = vi.fn(() => null);
    let deleteFired = false;
    mockFetch(async (_url, init) => {
      if (init?.method === "DELETE") deleteFired = true;
      return [];
    });
    const existing: ImportDocRow = {
      id: "00000000-0000-0000-0000-000000000010",
      entity_id: "e",
      tanda_po_id: "00000000-0000-0000-0000-000000000020",
      document_type: "commercial_invoice",
      document_url: null,
      hs_code: null,
      country_of_origin: null,
      declared_value_cents: null,
      duty_rate_pct: null,
      status: "pending",
      created_at: "2026-05-29T00:00:00Z",
    };
    render(<ImportDocModal doc={existing} pos={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => screen.getByRole("button", { name: /Delete \(with reason\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /Delete \(with reason\)/i }));
    await new Promise((r) => setTimeout(r, 10));
    expect(deleteFired).toBe(false);
  });
});
