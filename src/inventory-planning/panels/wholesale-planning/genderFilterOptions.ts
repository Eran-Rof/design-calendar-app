// Pure option-pool builder for the grid's Gender filter.
//
// Gender is a FREE, CASCADING filter — it offers the genders present under
// the currently selected Category (group_name) + Sub Cat (sub_category_name),
// drawn from BOTH the build's rows and the master styles (style_master
// gender_code, Tangerine truth). Merging master styles is what lets it work
// PRE-BUILD: an unbuilt run has no rows, so a rows-only pool showed "No
// matches" even though Category / Sub Cat populated from the master (the
// 2026-07-23 report). It is deliberately NOT "all genders all the time" —
// with a Category/Sub Cat chosen it narrows to that scope's genders.
//
// Empty selection arrays mean "no filter on that dimension" (offer all).
// The "—" sentinel mirrors the grid's null-bucket convention.

export interface GenderScopeItem {
  group_name?: string | null;
  sub_category_name?: string | null;
  gender?: string | null;
}

export function buildGenderOptions(
  rows: readonly GenderScopeItem[],
  masterStyles: readonly GenderScopeItem[] | null | undefined,
  filterCategory: readonly string[],
  filterSubCat: readonly string[],
): string[] {
  const s = new Set<string>();
  const inCatScope = (g: string | null | undefined) =>
    filterCategory.length === 0 || filterCategory.includes(g ?? "—");
  const inSubScope = (sub: string | null | undefined) =>
    filterSubCat.length === 0 || filterSubCat.includes(sub ?? "—");
  const collect = (items: readonly GenderScopeItem[]) => {
    for (const it of items) {
      if (!inCatScope(it.group_name) || !inSubScope(it.sub_category_name)) continue;
      const g = (it.gender ?? "").trim();
      if (g) s.add(g);
    }
  };
  collect(rows);
  collect(masterStyles ?? []);
  return Array.from(s).sort();
}
