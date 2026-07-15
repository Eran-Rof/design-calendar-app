// @vitest-environment jsdom
//
// Cross-cutter T4-4 — Unit tests for useAutoLanding hook.
//
// Covers the spec'd behaviour:
//   • Fires once when home_route set + at root + sentinel not set
//   • Sets sentinel BEFORE navigating (so a re-render can't double-fire)
//   • Bails when sentinel already set
//   • Bails when ?nolanding=1 (and sets sentinel)
//   • Bails when not at root (deep-linked URL with ?view=)
//   • Bails when homeRoute is null
//   • Bails (waits) when loading is still true
//   • Bails when menu_key doesn't resolve in registry
//
// The hook accepts `navigate`, `storage`, and `location` overrides so we
// don't have to fight jsdom's read-only `window.location` or share
// sessionStorage between tests.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

import {
  useAutoLanding,
  __resetAutoLandingSentinelForTests,
  __AUTO_LANDING_SENTINEL_KEY,
} from "../../hooks/useAutoLanding";
import { __resetPersonalizationCacheForTests } from "../../hooks/usePersonalization";

// ── Test helpers ───────────────────────────────────────────────────────────

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

function makeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    storage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); },
    } as Pick<Storage, "getItem" | "setItem">,
    data,
  };
}

interface HarnessOpts {
  navigate: ReturnType<typeof vi.fn>;
  storage: Pick<Storage, "getItem" | "setItem">;
  location: { pathname: string; search: string };
  skipParam?: string;
}

function Harness({ navigate, storage, location, skipParam }: HarnessOpts) {
  const r = useAutoLanding({ navigate, storage, location, skipParam });
  return (
    <div>
      <span data-testid="redirecting">{r.redirecting ? "1" : "0"}</span>
      <span data-testid="target">{r.redirectTarget ?? ""}</span>
      <span data-testid="label">{r.redirectLabel ?? ""}</span>
    </div>
  );
}

// Mock GET /preferences → returns the supplied home_route menu_key.
function stubPreferencesFetch(homeMenuKey: string | null) {
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    if (url === "/api/internal/users/me/preferences") {
      return mockJsonResponse({
        body: {
          favorites: { keys: [], v: 1 },
          home_route: homeMenuKey ? { menu_key: homeMenuKey, v: 1 } : null,
        },
      });
    }
    throw new Error("unexpected url " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Mock the personalization endpoint so it never resolves — simulates
// the "still loading" state.
function stubPreferencesFetchNeverResolves() {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/internal/users/me/preferences") {
      // Pending forever.
      return new Promise(() => { /* no resolve */ });
    }
    throw new Error("unexpected url " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("useAutoLanding", () => {
  beforeEach(() => {
    __resetPersonalizationCacheForTests();
    __resetAutoLandingSentinelForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fires once when home_route set + at root + sentinel not set", async () => {
    stubPreferencesFetch("tanda/accounting/journal-entries");
    const navigate = vi.fn();
    const { storage } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/", search: "" }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("redirecting").textContent).toBe("1");
    });

    // Journal Entries is a Tangerine module — its registry route points at the
    // Tangerine shell (/tangerine?m=…), not the TandA (/tanda?view=…) shell.
    expect(screen.getByTestId("target").textContent).toBe("/tangerine?m=journal_entries");
    expect(screen.getByTestId("label").textContent).toBe("Journal Entries");

    // Wait for the 0ms setTimeout to fire (defers navigate so toast can paint).
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith("/tangerine?m=journal_entries");
  });

  it("sets sentinel BEFORE navigating", async () => {
    stubPreferencesFetch("tanda/accounting/journal-entries");
    const { storage, data } = makeStorage();
    let sentinelAtNavTime: string | null = null;
    const navigate = vi.fn(() => {
      sentinelAtNavTime = data.get(__AUTO_LANDING_SENTINEL_KEY) ?? null;
    });

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/", search: "" }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("redirecting").textContent).toBe("1");
    });
    // Sentinel is set as part of the same effect that schedules the navigate;
    // assert it's already in storage before the timer fires.
    expect(data.get(__AUTO_LANDING_SENTINEL_KEY)).toBe("1");

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(sentinelAtNavTime).toBe("1");
  });

  it("bails when sentinel already set", async () => {
    stubPreferencesFetch("tanda/accounting/journal-entries");
    const navigate = vi.fn();
    const { storage } = makeStorage({ [__AUTO_LANDING_SENTINEL_KEY]: "1" });

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/", search: "" }}
      />
    );

    // Let the preferences GET settle, then assert no redirect.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("redirecting").textContent).toBe("0");
  });

  it("bails when ?nolanding=1 and sets the sentinel", async () => {
    stubPreferencesFetch("tanda/accounting/journal-entries");
    const navigate = vi.fn();
    const { storage, data } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/", search: "?nolanding=1" }}
      />
    );

    await waitFor(() => {
      expect(data.get(__AUTO_LANDING_SENTINEL_KEY)).toBe("1");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("respects a custom skipParam", async () => {
    stubPreferencesFetch("tanda/accounting/journal-entries");
    const navigate = vi.fn();
    const { storage, data } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/", search: "?stayPut=1" }}
        skipParam="stayPut"
      />
    );

    await waitFor(() => {
      expect(data.get(__AUTO_LANDING_SENTINEL_KEY)).toBe("1");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("bails when not at root (e.g. /tanda?view=ar_invoices)", async () => {
    stubPreferencesFetch("tanda/accounting/journal-entries");
    const navigate = vi.fn();
    const { storage, data } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/tanda", search: "?view=ar_invoices" }}
      />
    );

    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(navigate).not.toHaveBeenCalled();
    // Sentinel NOT set — operator may return to root in this tab.
    expect(data.get(__AUTO_LANDING_SENTINEL_KEY)).toBeUndefined();
  });

  it("does not redirect from an unrelated deep-link path", async () => {
    stubPreferencesFetch("tanda/accounting/journal-entries");
    const navigate = vi.fn();
    const { storage } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/rof/phase-reviews", search: "" }}
      />
    );

    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("DOES redirect when at a bare app shell (e.g. /tanda with no view)", async () => {
    stubPreferencesFetch("tanda/accounting/journal-entries");
    const navigate = vi.fn();
    const { storage } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/tanda", search: "" }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("redirecting").textContent).toBe("1");
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/tangerine?m=journal_entries"));
  });

  it("bails when homeRoute is null (and sets sentinel)", async () => {
    stubPreferencesFetch(null);
    const navigate = vi.fn();
    const { storage, data } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/", search: "" }}
      />
    );

    await waitFor(() => {
      expect(data.get(__AUTO_LANDING_SENTINEL_KEY)).toBe("1");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("waits when loading is true (no redirect, no sentinel)", async () => {
    stubPreferencesFetchNeverResolves();
    const navigate = vi.fn();
    const { storage, data } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/", search: "" }}
      />
    );

    // Give React multiple ticks; nothing should resolve because the GET
    // never settles → status stays "loading".
    await new Promise((r) => setTimeout(r, 50));

    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("redirecting").textContent).toBe("0");
    expect(data.get(__AUTO_LANDING_SENTINEL_KEY)).toBeUndefined();
  });

  it("bails when menu_key doesn't resolve in the registry", async () => {
    stubPreferencesFetch("ghost/menu/that/does-not-exist");
    const navigate = vi.fn();
    const { storage, data } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/", search: "" }}
      />
    );

    await waitFor(() => {
      expect(data.get(__AUTO_LANDING_SENTINEL_KEY)).toBe("1");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not redirect to the same route the operator is already on", async () => {
    // home_route resolves to /tangerine?m=journal_entries; operator is already
    // there. `?m=journal_entries` is an explicit Tangerine deep link, so
    // isRootLikePath treats it as non-root and step 3 bails — and even if it
    // didn't, the step-7 guard now compares `m=` too. Either way: no navigate.
    stubPreferencesFetch("tanda/accounting/journal-entries");
    const navigate = vi.fn();
    const { storage } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/tangerine", search: "?m=journal_entries" }}
      />
    );

    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("redirects from the BARE Tangerine shell to an m= home route (Today)", async () => {
    // Regression: opening the app at the bare `/tangerine` shell (same pathname
    // as the Today route, differing only by the `m=` param) must still fire the
    // redirect. The old step-7 guard compared only `view=`, so it wrongly saw
    // `/tangerine` == `/tangerine?m=today` and never landed on Today.
    stubPreferencesFetch("tanda/today");
    const navigate = vi.fn();
    const { storage } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/tangerine", search: "" }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("target").textContent).toBe("/tangerine?m=today");
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/tangerine?m=today"));
  });

  it("does NOT override an explicit m= deep link (e.g. /tangerine?m=ar_invoices)", async () => {
    // Deep-link protection extended to the Tangerine `m=` param: a user who
    // opened a specific panel must not be yanked to their Today home route.
    stubPreferencesFetch("tanda/today");
    const navigate = vi.fn();
    const { storage } = makeStorage();

    render(
      <Harness
        navigate={navigate}
        storage={storage}
        location={{ pathname: "/tangerine", search: "?m=ar_invoices" }}
      />
    );

    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(navigate).not.toHaveBeenCalled();
  });
});
