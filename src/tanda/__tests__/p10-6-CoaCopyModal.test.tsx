// @vitest-environment jsdom
//
// Tests for the P10-6 <CoaCopyModal />. Confirmation, success-state, error-state
// rendering and the POST behavior. The modal lives inside InternalEntities.tsx
// and is exported for testability.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CoaCopyModal } from "../InternalEntities";

const ENTITY = { id: "11111111-1111-1111-1111-111111111111", name: "SANDBOX" };

describe("CoaCopyModal", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the confirmation copy with the entity name", () => {
    render(<CoaCopyModal entity={ENTITY} onClose={() => {}} />);
    expect(screen.getByText(/Copy Chart of Accounts from ROF/i)).toBeTruthy();
    expect(screen.getByText("SANDBOX", { exact: false })).toBeTruthy();
  });

  it("shows Cancel and Copy COA buttons in the confirm state", () => {
    render(<CoaCopyModal entity={ENTITY} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy COA/i })).toBeTruthy();
  });

  it("invokes onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<CoaCopyModal entity={ENTITY} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose when the overlay backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(<CoaCopyModal entity={ENTITY} onClose={onClose} />);
    // The outermost div is the overlay; clicking it closes the modal.
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it("POSTs to the correct entity-scoped endpoint on Copy COA click", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ inserted: 42, skipped: 0, message: "ok" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    render(<CoaCopyModal entity={ENTITY} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy COA/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`/api/internal/entities/${ENTITY.id}/coa-copy-from-rof`);
    expect(init.method).toBe("POST");
  });

  it("renders the success result with inserted + skipped counts", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ inserted: 42, skipped: 3, message: "Inserted 42 accounts, skipped 3 existing" }),
    }) as unknown as typeof globalThis.fetch;
    render(<CoaCopyModal entity={ENTITY} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy COA/i }));
    await waitFor(() => expect(screen.getByText(/Inserted 42 accounts/i)).toBeTruthy());
    // <strong>42</strong> appears in the Inserted row; <strong>3</strong> in
    // the Skipped row. Use getAllByText since the digits are repeated in the
    // headline message and the counts.
    expect(screen.getAllByText(/42/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/3/).length).toBeGreaterThan(0);
  });

  it("renders an error message on non-2xx response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    }) as unknown as typeof globalThis.fetch;
    render(<CoaCopyModal entity={ENTITY} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy COA/i }));
    await waitFor(() => expect(screen.getByText(/Error: boom/i)).toBeTruthy());
  });

  it("shows 'Copying…' label while the request is in-flight", async () => {
    // Block the fetch promise so we can assert the in-flight UI.
    let resolveFetch: (v: unknown) => void = () => {};
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })) as unknown as typeof globalThis.fetch;
    render(<CoaCopyModal entity={ENTITY} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy COA/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Copying/i })).toBeTruthy());
    // Cleanup — resolve the dangling promise.
    resolveFetch({ ok: true, json: async () => ({ inserted: 0, skipped: 0, message: "ok" }) });
  });
});
