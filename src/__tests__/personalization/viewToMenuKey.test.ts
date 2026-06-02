// Cross-cutter T4-5 — Unit tests for the per-app view-string → menu_key
// mappers introduced in close-out. Asserts that every navigable view
// string in each non-Tanda shell (DC, ATS, GS1, Tech Pack) resolves to
// a known menu_key in the central registry, and that unknown / null
// inputs return null (the contract that lets call sites silently no-op).
//
// Catches drift in either direction:
//   • adding a view string without registering its menu_key
//   • renaming a registry key without bumping the per-app map
//
// The Tanda mapper has its own coverage at the call sites in
// TandA.tsx (T4-3 chunk) — this file rounds out the other four shells.

import { describe, it, expect } from "vitest";
import { isKnownMenuKey } from "../../lib/menuKeys";
import { dcViewToMenuKey } from "../../lib/dcViewToMenuKey";
import { atsViewToMenuKey } from "../../lib/atsViewToMenuKey";
import { gs1ViewToMenuKey } from "../../lib/gs1ViewToMenuKey";
import { techpackViewToMenuKey } from "../../lib/techpackViewToMenuKey";

// The canonical view strings each shell exposes. Sourced from:
//   DC:        src/App.tsx top-nav buttons (lines ~566 + 1262/1284)
//   ATS:       src/ats/panels/Toolbar.tsx viewMode select (3 pivots)
//   GS1:       src/gs1/panels/NavBar.tsx TABS list
//   Tech Pack: src/TechPack.tsx top-nav buttons (excluding `detail` —
//              that view is reached by row click, not nav, and is
//              deliberately not in the registry)
const DC_VIEWS = [
  "dashboard",
  "timeline",
  "calendar",
  "trend-briefs",
  "teams",
  "email",
  "notifications",
] as const;

const ATS_VIEWS = ["ats", "so", "po"] as const;

const GS1_VIEWS = [
  "company",
  "upc",
  "scale",
  "gtins",
  "upload",
  "pa_unpacker",
  "labels",
  "templates",
  "cartons",
  "receiving",
  "exceptions",
  "notifications",
] as const;

const TECHPACK_VIEWS = [
  "dashboard",
  "list",
  "libraries",
  "samples",
  "teams",
  "email",
  "notifications",
] as const;

describe("dcViewToMenuKey", () => {
  it("returns null for null / undefined / empty / unknown", () => {
    expect(dcViewToMenuKey(null)).toBeNull();
    expect(dcViewToMenuKey(undefined)).toBeNull();
    expect(dcViewToMenuKey("")).toBeNull();
    expect(dcViewToMenuKey("this-view-does-not-exist")).toBeNull();
  });
  it.each(DC_VIEWS)("maps DC view %s to a known menu_key", (v) => {
    const mk = dcViewToMenuKey(v);
    expect(mk).not.toBeNull();
    expect(isKnownMenuKey(mk!)).toBe(true);
    expect(mk!.startsWith("dc/")).toBe(true);
  });
});

describe("atsViewToMenuKey", () => {
  it("returns null for null / undefined / unknown", () => {
    expect(atsViewToMenuKey(null)).toBeNull();
    expect(atsViewToMenuKey(undefined)).toBeNull();
    expect(atsViewToMenuKey("not-a-view")).toBeNull();
  });
  it.each(ATS_VIEWS)("maps ATS viewMode %s to a known menu_key", (v) => {
    const mk = atsViewToMenuKey(v);
    expect(mk).not.toBeNull();
    expect(isKnownMenuKey(mk!)).toBe(true);
    expect(mk!.startsWith("ats/")).toBe(true);
  });
});

describe("gs1ViewToMenuKey", () => {
  it("returns null for null / undefined / unknown", () => {
    expect(gs1ViewToMenuKey(null)).toBeNull();
    expect(gs1ViewToMenuKey(undefined)).toBeNull();
    expect(gs1ViewToMenuKey("not-a-tab")).toBeNull();
  });
  it.each(GS1_VIEWS)("maps GS1 tab %s to a known menu_key", (v) => {
    const mk = gs1ViewToMenuKey(v);
    expect(mk).not.toBeNull();
    expect(isKnownMenuKey(mk!)).toBe(true);
    expect(mk!.startsWith("gs1/")).toBe(true);
  });
});

describe("techpackViewToMenuKey", () => {
  it("returns null for null / undefined / unknown", () => {
    expect(techpackViewToMenuKey(null)).toBeNull();
    expect(techpackViewToMenuKey(undefined)).toBeNull();
    expect(techpackViewToMenuKey("not-a-view")).toBeNull();
  });
  it("returns null for the instance-only `detail` view (not in registry)", () => {
    // `detail` is reached by row click, not nav — intentionally unmapped
    // so click telemetry doesn't pollute the top-N "Most Used" list with
    // a generic detail view.
    expect(techpackViewToMenuKey("detail")).toBeNull();
  });
  it.each(TECHPACK_VIEWS)("maps Tech Pack view %s to a known menu_key", (v) => {
    const mk = techpackViewToMenuKey(v);
    expect(mk).not.toBeNull();
    expect(isKnownMenuKey(mk!)).toBe(true);
    expect(mk!.startsWith("techpack/")).toBe(true);
  });
});
