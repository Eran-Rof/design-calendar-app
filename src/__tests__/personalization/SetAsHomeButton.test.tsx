// @vitest-environment jsdom
//
// Cross-cutter T4-3 — Unit tests for <SetAsHomeButton />.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import SetAsHomeButton from "../../components/SetAsHomeButton";
import { __resetPersonalizationCacheForTests } from "../../hooks/usePersonalization";

interface MockResponseInit { ok?: boolean; status?: number; body?: unknown }
function mockJsonResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => init.body ?? {},
    text: async () => (init.body ? JSON.stringify(init.body) : ""),
  } as unknown as Response;
}

describe("SetAsHomeButton", () => {
  beforeEach(() => {
    __resetPersonalizationCacheForTests();
    vi.restoreAllMocks();
  });

  it("renders 'Set as landing page' when not current", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") return mockJsonResponse({ body: {} });
      throw new Error("unexpected url " + url);
    }));

    render(<SetAsHomeButton menuKey="tanda/accounting/journal-entries" />);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /Set as landing page/i });
      expect(btn).toBeInTheDocument();
      expect(btn.hasAttribute("disabled")).toBe(false);
      expect(btn.textContent).toMatch(/Set as landing page/);
    });
  });

  it("renders disabled '✓ Your landing page' when current matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { home_route: { menu_key: "tanda/accounting/journal-entries" } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<SetAsHomeButton menuKey="tanda/accounting/journal-entries" />);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /Current landing page/i });
      expect(btn).toBeInTheDocument();
      expect(btn.hasAttribute("disabled")).toBe(true);
      expect(btn.textContent).toMatch(/Your landing page/);
    });
  });

  it("calls PUT home-route on click + flips to disabled state", async () => {
    const putBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/internal/users/me/preferences") return mockJsonResponse({ body: {} });
      if (url === "/api/internal/users/me/preferences/home-route") {
        putBodies.push(JSON.parse((init?.body as string) ?? "{}"));
        return mockJsonResponse({ body: { key: "home_route", value: { menu_key: "ats/grid" } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<SetAsHomeButton menuKey="ats/grid" />);
    const btn = await screen.findByRole("button", { name: /Set as landing page/i });

    await act(async () => { btn.click(); });

    await waitFor(() => {
      const updated = screen.getByRole("button");
      expect(updated.hasAttribute("disabled")).toBe(true);
    });
    expect(putBodies).toEqual([{ menu_key: "ats/grid" }]);
  });
});
