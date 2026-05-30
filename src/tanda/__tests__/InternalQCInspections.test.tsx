// @vitest-environment jsdom
//
// Tangerine P13-5 — <InternalQCInspections /> component tests.
//
// Coverage:
//  - helper exports (statusColor, severityColor, computeAutoPassRate,
//    STATUS_OPTIONS, SEVERITY_OPTIONS, ALLOWED_TRANSITIONS catalog)
//  - panel rendering loading + empty + populated rows
//  - "+ New inspection" button opens the modal
//  - modal placeholders (findings list, photo URL textarea)
//  - failed-inspection auto-case banner surfaces on PATCH response
//  - T11 D3 — DELETE prompts for reason
//  - ExportButton + DateRangePresets presence
//  - include_passed toggles query param
//  - RowHistory slot reserved (T11-3 placeholder note present)

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

import InternalQCInspections, {
  statusColor,
  severityColor,
  computeAutoPassRate,
  STATUS_OPTIONS,
  SEVERITY_OPTIONS,
  ALLOWED_TRANSITIONS,
  InspectionModal,
  type InspectionStatus,
} from "../InternalQCInspections";

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
  globalThis.prompt = vi.fn(() => "test reason");
});

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.confirm = origConfirm;
  globalThis.alert = origAlert;
  globalThis.prompt = origPrompt;
  vi.restoreAllMocks();
});

describe("InternalQCInspections — helpers", () => {
  it("statusColor distinguishes passed / failed / partial / pending", () => {
    expect(statusColor("passed")).not.toBe(statusColor("failed"));
    expect(statusColor("partial")).not.toBe(statusColor("pending"));
  });

  it("severityColor distinguishes critical from minor/major", () => {
    expect(severityColor("critical")).not.toBe(severityColor("minor"));
    expect(severityColor("major")).not.toBe(severityColor("minor"));
  });

  it("STATUS_OPTIONS exposes all 4 statuses + the Open default", () => {
    const values = STATUS_OPTIONS.map((o) => o.value);
    expect(values).toContain("");
    expect(values).toContain("pending");
    expect(values).toContain("passed");
    expect(values).toContain("failed");
    expect(values).toContain("partial");
  });

  it("SEVERITY_OPTIONS exposes the three canonical severities", () => {
    expect(SEVERITY_OPTIONS.map((o) => o.value)).toEqual(["minor", "major", "critical"]);
  });

  it("ALLOWED_TRANSITIONS encodes pending → 3 targets", () => {
    expect(ALLOWED_TRANSITIONS.pending).toHaveLength(3);
    expect(ALLOWED_TRANSITIONS.pending).toContain("passed");
    expect(ALLOWED_TRANSITIONS.pending).toContain("failed");
    expect(ALLOWED_TRANSITIONS.pending).toContain("partial");
  });

  it("ALLOWED_TRANSITIONS makes passed + failed terminal", () => {
    expect(ALLOWED_TRANSITIONS.passed).toHaveLength(0);
    expect(ALLOWED_TRANSITIONS.failed).toHaveLength(0);
  });

  it("computeAutoPassRate returns null for zero totalInspected", () => {
    expect(computeAutoPassRate([], 0)).toBeNull();
  });

  it("computeAutoPassRate returns 1.0 when no findings affect qty", () => {
    expect(computeAutoPassRate([], 100)).toBe(1);
  });

  it("computeAutoPassRate aggregates qty_affected across findings", () => {
    const rate = computeAutoPassRate(
      [
        { category: "stitch", severity: "minor", qty_affected: 5, description: "x", photo_urls: null, resolution: null },
        { category: "stain",  severity: "major", qty_affected: 3, description: "y", photo_urls: null, resolution: null },
      ],
      100,
    );
    expect(rate).toBeCloseTo(0.92, 4);
  });

  it("computeAutoPassRate clamps negative passing to 0", () => {
    const rate = computeAutoPassRate(
      [{ category: "x", severity: "major", qty_affected: 200, description: "x", photo_urls: null, resolution: null }],
      100,
    );
    expect(rate).toBe(0);
  });
});

describe("InternalQCInspections — rendering", () => {
  it("renders the panel heading with the procurement emoji", async () => {
    mockFetch(async () => []);
    render(<InternalQCInspections />);
    await waitFor(() => expect(screen.getByText(/Procurement — QC Inspections/i)).toBeTruthy());
  });

  it("renders empty state when no inspections", async () => {
    mockFetch(async () => []);
    render(<InternalQCInspections />);
    await waitFor(() => expect(screen.getByText(/No inspections/i)).toBeTruthy());
  });

  it("renders rows from the inspections endpoint", async () => {
    const sample = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        entity_id: "e",
        receipt_id: "00000000-0000-0000-0000-000000000020",
        inspection_date: "2026-05-29",
        inspector_employee_id: null,
        status: "failed" as InspectionStatus,
        overall_pass_rate: 0.875,
        notes: "tear in seam",
        case_id: "00000000-0000-0000-0000-000000000030",
        created_at: "2026-05-29T00:00:00Z",
      },
    ];
    mockFetch(async (url) => {
      if (url.includes("/api/internal/procurement/qc-inspections?")) return sample;
      return [];
    });
    render(<InternalQCInspections />);
    await waitFor(() => expect(screen.getByText(/2026-05-29/)).toBeTruthy());
    expect(screen.getByText(/87\.5%/)).toBeTruthy();
  });

  it("'+ New inspection' button is rendered", async () => {
    mockFetch(async () => []);
    render(<InternalQCInspections />);
    await waitFor(() => expect(screen.getByRole("button", { name: /New inspection/i })).toBeTruthy());
  });

  it("opens the new-inspection modal on click", async () => {
    mockFetch(async () => []);
    render(<InternalQCInspections />);
    await waitFor(() => screen.getByRole("button", { name: /New inspection/i }));
    fireEvent.click(screen.getByRole("button", { name: /New inspection/i }));
    // After opening, the "Save the inspection first" hint is unique to the
    // modal so we use it as the modal-open marker (instead of /New inspection/
    // which clashes with the trigger button).
    await waitFor(() => expect(screen.getByText(/Save the inspection first/i)).toBeTruthy());
  });

  it("new-inspection modal shows the 'Save findings later' hint when isNew", async () => {
    mockFetch(async () => []);
    render(<InternalQCInspections />);
    await waitFor(() => screen.getByRole("button", { name: /New inspection/i }));
    fireEvent.click(screen.getByRole("button", { name: /New inspection/i }));
    await waitFor(() => expect(screen.getByText(/Save the inspection first/i)).toBeTruthy());
  });

  it("Include passed checkbox toggles include_passed=true URL param", async () => {
    const calls: string[] = [];
    mockFetch(async (url) => { calls.push(url); return []; });
    render(<InternalQCInspections />);
    await waitFor(() => screen.getByLabelText(/Include passed/i));
    fireEvent.click(screen.getByLabelText(/Include passed/i));
    await waitFor(() => expect(calls.some((c) => c.includes("include_passed=true"))).toBe(true));
  });

  it("ExportButton renders on the toolbar", async () => {
    mockFetch(async () => []);
    render(<InternalQCInspections />);
    await waitFor(() => expect(screen.getAllByText(/Export/i).length).toBeGreaterThan(0));
  });

  it("RowHistory slot is reserved (T11-3 placeholder note)", async () => {
    mockFetch(async () => []);
    render(<InternalQCInspections />);
    await waitFor(() => expect(screen.getByText(/T11-3 RowHistory drop-in ships/i)).toBeTruthy());
  });

  it("Status filter dropdown contains all status options", async () => {
    mockFetch(async () => []);
    render(<InternalQCInspections />);
    await waitFor(() => screen.getByRole("button", { name: /New inspection/i }));
    // Pending, Partial, Failed, Passed all appear as <option> text.
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Partial")).toBeTruthy();
    expect(screen.getByText("Passed")).toBeTruthy();
  });
});

describe("InternalQCInspections — InspectionModal (edit + critical/auto-case + delete reason)", () => {
  const baseInspection = {
    id: "00000000-0000-0000-0000-000000000099",
    entity_id: "e",
    receipt_id: "00000000-0000-0000-0000-000000000020",
    inspection_date: "2026-05-29",
    inspector_employee_id: null,
    status: "pending" as InspectionStatus,
    overall_pass_rate: null,
    notes: null,
    case_id: null,
    created_at: "2026-05-29T00:00:00Z",
  };

  it("loads findings on edit and shows the count chip", async () => {
    mockFetch(async (url) => {
      if (url.includes(`/api/internal/procurement/qc-inspections/${baseInspection.id}`)) {
        return {
          ...baseInspection,
          findings: [
            { id: "00000000-0000-0000-0000-0000000000a1", category: "stitch", severity: "minor",    qty_affected: 1, description: "loose thread", photo_urls: null, resolution: null },
            { id: "00000000-0000-0000-0000-0000000000a2", category: "tear",   severity: "critical", qty_affected: 5, description: "ripped seam",   photo_urls: null, resolution: null },
          ],
        };
      }
      return [];
    });
    render(<InspectionModal inspection={baseInspection} receipts={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Findings \(2\)/i)).toBeTruthy());
    expect(screen.getByText(/1 critical/i)).toBeTruthy();
  });

  it("DELETE prompts for reason and skips when blank (T11 D3)", async () => {
    const calls: string[] = [];
    mockFetch(async (url, init) => {
      if (init?.method === "DELETE") calls.push(url);
      if (url.includes(`/api/internal/procurement/qc-inspections/${baseInspection.id}`)) {
        return {
          ...baseInspection,
          findings: [
            { id: "00000000-0000-0000-0000-0000000000aa", category: "stitch", severity: "minor", qty_affected: 1, description: "x", photo_urls: null, resolution: null },
          ],
        };
      }
      return [];
    });
    globalThis.prompt = vi.fn(() => "");   // operator cancels reason
    render(<InspectionModal inspection={baseInspection} receipts={[]} onClose={() => {}} onSaved={() => {}} />);
    // Wait for finding row to load (Save/Add and ✕ buttons appear once findings render).
    const deleteBtn = await screen.findByText("✕");
    await act(async () => { fireEvent.click(deleteBtn); });
    expect(calls.length).toBe(0);     // no DELETE fired because reason was empty
  });

  it("DELETE fires with reason in body when operator supplies one (T11 D3)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch(async (url, init) => {
      calls.push({ url, init });
      if (url.includes(`/api/internal/procurement/qc-inspections/${baseInspection.id}`)) {
        return {
          ...baseInspection,
          findings: [
            { id: "00000000-0000-0000-0000-0000000000ab", category: "stitch", severity: "minor", qty_affected: 1, description: "x", photo_urls: null, resolution: null },
          ],
        };
      }
      return { deleted: "00000000-0000-0000-0000-0000000000ab", reason: "wrong row" };
    });
    globalThis.prompt = vi.fn(() => "wrong row");
    render(<InspectionModal inspection={baseInspection} receipts={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => screen.getByText("✕"));
    await act(async () => { fireEvent.click(screen.getByText("✕")); });
    const del = calls.find((c) => c.init?.method === "DELETE");
    expect(del).toBeTruthy();
    expect(String(del!.init!.body)).toMatch(/wrong row/);
  });

  it("surfaces auto_case_id from PATCH response as the QC failure banner", async () => {
    mockFetch(async (url, init) => {
      if (url.includes(`/api/internal/procurement/qc-inspections/${baseInspection.id}`) && !init) {
        return {
          ...baseInspection,
          findings: [
            { id: "00000000-0000-0000-0000-0000000000ac", category: "tear", severity: "critical", qty_affected: 10, description: "bad", photo_urls: null, resolution: null },
          ],
        };
      }
      if (init?.method === "PATCH") {
        return { ...baseInspection, status: "failed", case_id: "00000000-0000-0000-0000-0000000000ca", auto_case_id: "00000000-0000-0000-0000-0000000000ca" };
      }
      return [];
    });
    render(<InspectionModal inspection={baseInspection} receipts={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => screen.getByRole("button", { name: /Mark failed/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Mark failed/i }));
    });
    await waitFor(() => expect(screen.getByText(/Case auto-linked/i)).toBeTruthy());
  });

  it("existing case_id surfaces immediately when modal opens", async () => {
    const withCase = { ...baseInspection, case_id: "00000000-0000-0000-0000-0000000000cb" };
    mockFetch(async (url) => {
      if (url.includes(`/api/internal/procurement/qc-inspections/${baseInspection.id}`)) {
        return { ...withCase, findings: [] };
      }
      return [];
    });
    render(<InspectionModal inspection={withCase} receipts={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Case auto-linked/i)).toBeTruthy());
  });

  it("Add finding button is rendered when editing a pending inspection", async () => {
    mockFetch(async (url) => {
      if (url.includes(`/api/internal/procurement/qc-inspections/${baseInspection.id}`)) {
        return { ...baseInspection, findings: [] };
      }
      return [];
    });
    render(<InspectionModal inspection={baseInspection} receipts={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Add finding/i })).toBeTruthy());
  });

  it("Photo URL textarea placeholder mentions M29", async () => {
    mockFetch(async (url) => {
      if (url.includes(`/api/internal/procurement/qc-inspections/${baseInspection.id}`)) {
        return {
          ...baseInspection,
          findings: [
            { id: "00000000-0000-0000-0000-0000000000ad", category: "x", severity: "minor", qty_affected: 0, description: "y", photo_urls: null, resolution: null },
          ],
        };
      }
      return [];
    });
    render(<InspectionModal inspection={baseInspection} receipts={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getAllByPlaceholderText(/M29/i).length).toBeGreaterThan(0));
  });

  it("inspection date input is rendered in the edit modal", async () => {
    mockFetch(async (url) => {
      if (url.includes(`/api/internal/procurement/qc-inspections/${baseInspection.id}`)) {
        return { ...baseInspection, findings: [] };
      }
      return [];
    });
    render(<InspectionModal inspection={baseInspection} receipts={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getAllByDisplayValue("2026-05-29").length).toBeGreaterThan(0));
  });

  it("Total inspected field renders for auto-rate computation", async () => {
    mockFetch(async (url) => {
      if (url.includes(`/api/internal/procurement/qc-inspections/${baseInspection.id}`)) {
        return { ...baseInspection, findings: [] };
      }
      return [];
    });
    render(<InspectionModal inspection={baseInspection} receipts={[]} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Total inspected/i)).toBeTruthy());
  });
});
