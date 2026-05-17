// Unit tests for the workbench persistence helpers. Uses a tiny
// in-memory localStorage shim so vitest doesn't need a jsdom
// environment for these specific cases. Covers: collapse flag round
// trips, system-suggestions negative-flag default-ON semantics,
// last-upload timestamp round trips, graceful no-op on storage errors.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  STORAGE_KEYS,
  loadCollapsedFlag,
  saveCollapsedFlag,
  loadSystemSuggestionsOn,
  saveSystemSuggestionsOn,
  loadLastUpload,
  rememberUpload,
} from "../workbenchPersistence";

// Minimal in-memory shim. Most vitest envs already have jsdom which
// provides localStorage — but we don't want these tests to fail in a
// node-env config. Reassign on every test for clean state.
function installShim() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true });
}

beforeEach(() => {
  installShim();
});

// ────────────────────────────────────────────────────────────────────────

describe("loadCollapsedFlag / saveCollapsedFlag", () => {
  it("defaults to false when key absent", () => {
    expect(loadCollapsedFlag("any-key")).toBe(false);
  });

  it("round trips true", () => {
    saveCollapsedFlag(STORAGE_KEYS.collapseSales, true);
    expect(loadCollapsedFlag(STORAGE_KEYS.collapseSales)).toBe(true);
  });

  it("round trips false (explicitly stores '0')", () => {
    saveCollapsedFlag(STORAGE_KEYS.collapseTotals, false);
    expect(localStorage.getItem(STORAGE_KEYS.collapseTotals)).toBe("0");
    expect(loadCollapsedFlag(STORAGE_KEYS.collapseTotals)).toBe(false);
  });

  it("treats any non-'1' value as false", () => {
    localStorage.setItem("foo", "true");
    expect(loadCollapsedFlag("foo")).toBe(false);
    localStorage.setItem("foo", "yes");
    expect(loadCollapsedFlag("foo")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("loadSystemSuggestionsOn / saveSystemSuggestionsOn", () => {
  it("defaults to ON when key absent", () => {
    expect(loadSystemSuggestionsOn()).toBe(true);
  });

  it("returns false only when explicitly disabled", () => {
    saveSystemSuggestionsOn(false);
    expect(loadSystemSuggestionsOn()).toBe(false);
  });

  it("saving ON removes the disabled flag (clean storage)", () => {
    saveSystemSuggestionsOn(false);
    expect(localStorage.getItem(STORAGE_KEYS.systemSuggestionsOff)).toBe("1");
    saveSystemSuggestionsOn(true);
    expect(localStorage.getItem(STORAGE_KEYS.systemSuggestionsOff)).toBe(null);
  });

  it("legacy garbage value defaults to ON unless exactly '1'", () => {
    localStorage.setItem(STORAGE_KEYS.systemSuggestionsOff, "yes");
    expect(loadSystemSuggestionsOn()).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("loadLastUpload / rememberUpload", () => {
  it("returns null when never uploaded", () => {
    expect(loadLastUpload("sales")).toBe(null);
    expect(loadLastUpload("master")).toBe(null);
  });

  it("rememberUpload writes ISO timestamp and returns it", () => {
    const iso = rememberUpload("sales");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(loadLastUpload("sales")).toBe(iso);
  });

  it("sales and master kinds use separate storage keys", () => {
    rememberUpload("sales");
    // Master is untouched after a sales write.
    expect(loadLastUpload("master")).toBe(null);
    expect(localStorage.getItem(STORAGE_KEYS.lastUploadSales)).not.toBe(null);
    expect(localStorage.getItem(STORAGE_KEYS.lastUploadMaster)).toBe(null);
    // And vice versa.
    rememberUpload("master");
    expect(localStorage.getItem(STORAGE_KEYS.lastUploadMaster)).not.toBe(null);
  });

  it("STORAGE_KEYS exposes the underlying keys", () => {
    rememberUpload("sales");
    expect(localStorage.getItem(STORAGE_KEYS.lastUploadSales)).not.toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("storage error tolerance", () => {
  it("loadCollapsedFlag returns false if storage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: () => { throw new Error("boom"); } },
      configurable: true,
    });
    expect(loadCollapsedFlag("x")).toBe(false);
  });

  it("rememberUpload still returns an ISO even if write throws (caller may still want the value)", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: { setItem: () => { throw new Error("quota"); }, getItem: () => null },
      configurable: true,
    });
    const iso = rememberUpload("sales");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("loadSystemSuggestionsOn defaults to ON on storage error", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: () => { throw new Error("boom"); } },
      configurable: true,
    });
    expect(loadSystemSuggestionsOn()).toBe(true);
  });
});
