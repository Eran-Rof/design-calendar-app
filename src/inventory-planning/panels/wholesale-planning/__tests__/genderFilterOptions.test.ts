import { describe, it, expect } from "vitest";
import { buildGenderOptions, type GenderScopeItem } from "../genderFilterOptions";

// Mirrors the CEO's DENIM SHORTS scenario (2026-07-23): Tangerine files
// DENIM SHORTS styles as M / B / G; a built run for Ross had Girls + Boys
// rows, and a separate UNBUILT run had zero rows.
const master: GenderScopeItem[] = [
  { group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "M" },
  { group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "B" },
  { group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "G" },
  { group_name: "SHORTS", sub_category_name: "CARGO SHORTS", gender: "M" },
  { group_name: "DENIM", sub_category_name: "SLIM", gender: "W" },
];

describe("buildGenderOptions", () => {
  it("cascades to the selected Category + Sub Cat scope (CEO case)", () => {
    // SHORTS / DENIM SHORTS → only the genders filed under that scope.
    expect(buildGenderOptions([], master, ["SHORTS"], ["DENIM SHORTS"])).toEqual(["B", "G", "M"]);
  });

  it("works PRE-BUILD from master styles alone (empty rows, unbuilt run)", () => {
    // The bug: a rows-only pool returned [] here → dropdown "No matches".
    expect(buildGenderOptions([], master, ["SHORTS"], ["DENIM SHORTS"]).length).toBe(3);
  });

  it("narrows by Category alone", () => {
    expect(buildGenderOptions([], master, ["DENIM"], [])).toEqual(["W"]);
  });

  it("offers every gender when nothing is selected (free filter, all scope)", () => {
    expect(buildGenderOptions([], master, [], [])).toEqual(["B", "G", "M", "W"]);
  });

  it("is NOT 'all genders' once a scope excludes some", () => {
    // CARGO SHORTS only has M in the master → W/B/G must not leak in.
    expect(buildGenderOptions([], master, ["SHORTS"], ["CARGO SHORTS"])).toEqual(["M"]);
  });

  it("unions rows with master styles under the same scope", () => {
    const rows: GenderScopeItem[] = [
      { group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "B" },
    ];
    // rows contribute B; master adds M/G under the same scope.
    expect(buildGenderOptions(rows, master, ["SHORTS"], ["DENIM SHORTS"])).toEqual(["B", "G", "M"]);
  });

  it("ignores rows/masters outside the selected scope", () => {
    const rows: GenderScopeItem[] = [
      { group_name: "DENIM", sub_category_name: "SLIM", gender: "W" }, // out of SHORTS scope
    ];
    expect(buildGenderOptions(rows, master, ["SHORTS"], ["DENIM SHORTS"])).toEqual(["B", "G", "M"]);
  });

  it("null group/sub map to the — bucket and only match the — selection", () => {
    const items: GenderScopeItem[] = [{ group_name: null, sub_category_name: null, gender: "M" }];
    expect(buildGenderOptions([], items, ["—"], [])).toEqual(["M"]);
    expect(buildGenderOptions([], items, ["SHORTS"], [])).toEqual([]);
  });

  it("trims blank genders and dedupes", () => {
    const items: GenderScopeItem[] = [
      { group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "  M  " },
      { group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "" },
      { group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: null },
    ];
    expect(buildGenderOptions([], items, [], [])).toEqual(["M"]);
  });

  it("tolerates a null/undefined masterStyles list", () => {
    const rows: GenderScopeItem[] = [{ group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "B" }];
    expect(buildGenderOptions(rows, null, [], [])).toEqual(["B"]);
    expect(buildGenderOptions(rows, undefined, [], [])).toEqual(["B"]);
  });
});
