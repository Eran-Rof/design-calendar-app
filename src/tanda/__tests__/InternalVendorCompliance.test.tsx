// @vitest-environment jsdom
//
// Tangerine P13-6 — <InternalVendorCompliance /> component tests (M48).
//
// Coverage:
//  - pure helpers (statusColor, expiringBadge, STATUS_OPTIONS, PRESET_CERT_TYPES)
//  - panel rendering: loading + empty + populated rows
//  - "+ Add certification" button opens the modal
//  - "Expiring soon (60d)" chip toggles a query param
//  - Include inactive checkbox toggles include_inactive query param
//  - ExportButton + DateRangePresets presence
//  - T11 D3 — DELETE prompts for reason
//  - RowHistory slot reserved (T11-3 placeholder note present)

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import InternalVendorCompliance, {
  statusColor,
  expiringBadge,
  STATUS_OPTIONS,
  PRESET_CERT_TYPES,
  CertModal,
  type CertRow,
} from "../InternalVendorCompliance";

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

describe("InternalVendorCompliance — helpers", () => {
  it("statusColor distinguishes active / expired / revoked / pending", () => {
    expect(statusColor("active")).not.toBe(statusColor("expired"));
    expect(statusColor("revoked")).not.toBe(statusColor("active"));
    expect(statusColor("pending")).not.toBe(statusColor("expired"));
  });

  it("STATUS_OPTIONS exposes the default + 4 statuses", () => {
    const values = STATUS_OPTIONS.map((o) => o.value);
    expect(values).toContain("");
    expect(values).toContain("active");
    expect(values).toContain("expired");
    expect(values).toContain("revoked");
    expect(values).toContain("pending");
  });

  it("PRESET_CERT_TYPES exposes the canonical 6 options", () => {
    expect(PRESET_CERT_TYPES).toEqual(["OEKO-TEX", "GOTS", "BSCI", "WRAP", "ISO9001", "custom"]);
  });

  it("expiringBadge returns null for null expires_at", () => {
    expect(expiringBadge(null, "2026-05-29")).toBeNull();
  });

  it("expiringBadge returns 'critical' for ≤30d expiry", () => {
    expect(expiringBadge("2026-06-10", "2026-05-29")).toBe("critical");
  });

  it("expiringBadge returns 'warn' for 30-60d expiry", () => {
    expect(expiringBadge("2026-07-20", "2026-05-29")).toBe("warn");
  });

  it("expiringBadge returns null for far-future expiry", () => {
    expect(expiringBadge("2030-01-01", "2026-05-29")).toBeNull();
  });

  it("expiringBadge returns 'critical' for already-past expiry", () => {
    expect(expiringBadge("2025-01-01", "2026-05-29")).toBe("critical");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Panel rendering
// ────────────────────────────────────────────────────────────────────────

describe("InternalVendorCompliance — rendering", () => {
  it("renders the panel heading with the procurement emoji", async () => {
    mockFetch(async () => []);
    render(<InternalVendorCompliance />);
    await waitFor(() => expect(screen.getByText(/Procurement — Vendor Compliance/i)).toBeTruthy());
  });

  it("renders empty state when no certifications", async () => {
    mockFetch(async () => []);
    render(<InternalVendorCompliance />);
    await waitFor(() => expect(screen.getByText(/No certifications/i)).toBeTruthy());
  });

  it("renders rows from the compliance-certs endpoint", async () => {
    const sample: CertRow[] = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        entity_id: "e",
        vendor_id: "00000000-0000-0000-0000-000000000020",
        certification_type: "OEKO-TEX",
        cert_number: "12.HCN.85789",
        issued_at: "2024-01-15",
        expires_at: "2027-01-15",
        document_url: "https://example.com/cert.pdf",
        status: "active",
        created_at: "2024-01-15T00:00:00Z",
      },
    ];
    mockFetch(async (url) => {
      if (url.includes("/api/internal/procurement/compliance-certs")) return sample;
      if (url.includes("/api/internal/vendors")) return [];
      return [];
    });
    render(<InternalVendorCompliance />);
    await waitFor(() => expect(screen.getByText("OEKO-TEX")).toBeTruthy());
    expect(screen.getByText("12.HCN.85789")).toBeTruthy();
  });

  it("'+ Add certification' button is rendered", async () => {
    mockFetch(async () => []);
    render(<InternalVendorCompliance />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Add certification/i })).toBeTruthy());
  });

  it("opens the new-cert modal on click", async () => {
    mockFetch(async () => []);
    render(<InternalVendorCompliance />);
    await waitFor(() => screen.getByRole("button", { name: /Add certification/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add certification/i }));
    await waitFor(() => expect(screen.getByText(/^Add certification$/)).toBeTruthy());
  });

  it("Expiring soon chip is rendered", async () => {
    mockFetch(async () => []);
    render(<InternalVendorCompliance />);
    await waitFor(() => expect(screen.getByTestId("expiring-soon-chip")).toBeTruthy());
  });

  it("Expiring soon chip adds expiring_within_days query param", async () => {
    mockFetch(async () => []);
    render(<InternalVendorCompliance />);
    await waitFor(() => screen.getByTestId("expiring-soon-chip"));
    fireEvent.click(screen.getByTestId("expiring-soon-chip"));
    await waitFor(() => {
      const sawWindow = fetchCalls.some((c) => c.url.includes("expiring_within_days=60"));
      expect(sawWindow).toBe(true);
    });
  });

  it("Include inactive toggles include_inactive query param", async () => {
    mockFetch(async () => []);
    render(<InternalVendorCompliance />);
    await waitFor(() => screen.getByText(/Include inactive/i));
    const cb = screen.getByText(/Include inactive/i).parentElement!.querySelector("input[type='checkbox']") as HTMLInputElement;
    fireEvent.click(cb);
    await waitFor(() => {
      const sawInactive = fetchCalls.some((c) => c.url.includes("include_inactive=true"));
      expect(sawInactive).toBe(true);
    });
  });

  it("ExportButton is rendered", async () => {
    mockFetch(async () => []);
    render(<InternalVendorCompliance />);
    await waitFor(() => expect(screen.getByText(/Export/i)).toBeTruthy());
  });

  it("RowHistory placeholder is rendered (T11-3 reserved slot)", async () => {
    mockFetch(async () => []);
    render(<InternalVendorCompliance />);
    await waitFor(() => expect(screen.getByText(/T11-3 RowHistory drop-in/i)).toBeTruthy());
  });
});

// ────────────────────────────────────────────────────────────────────────
// CertModal — T11 D3 destructive delete reason prompt
// ────────────────────────────────────────────────────────────────────────

describe("CertModal — T11 D3 destructive delete", () => {
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
    const existing: CertRow = {
      id: "00000000-0000-0000-0000-000000000010",
      entity_id: "e",
      vendor_id: "00000000-0000-0000-0000-000000000020",
      certification_type: "GOTS",
      cert_number: null,
      issued_at: null,
      expires_at: null,
      document_url: null,
      status: "active",
      created_at: "2024-01-15T00:00:00Z",
    };
    const onSaved = vi.fn();
    render(<CertModal cert={existing} vendors={[]} onClose={() => {}} onSaved={onSaved} />);
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
    const existing: CertRow = {
      id: "00000000-0000-0000-0000-000000000010",
      entity_id: "e",
      vendor_id: "00000000-0000-0000-0000-000000000020",
      certification_type: "GOTS",
      cert_number: null,
      issued_at: null,
      expires_at: null,
      document_url: null,
      status: "active",
      created_at: "2024-01-15T00:00:00Z",
    };
    render(<CertModal cert={existing} vendors={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => screen.getByRole("button", { name: /Delete \(with reason\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /Delete \(with reason\)/i }));
    // Microtask drain — no fetch should have fired.
    await new Promise((r) => setTimeout(r, 10));
    expect(deleteFired).toBe(false);
  });
});
