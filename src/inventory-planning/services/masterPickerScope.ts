// Master-derived option pools for the planner's cascading pickers.
// Two call sites on the request panel need almost-identical pools:
//   • The filter strip (Cat → Sub Cat → Style → Color, Description)
//   • The new-request form (same chain, slightly different scope on
//     Color: form scopes by category, filter strip scopes by style).
//
// Pre-extraction this lived as ten near-identical useMemo blocks
// across the panel; pulling them here keeps the JSONB attribute
// keys + the TBD-pin convention in one place.

import type { IpItem } from "../types/entities";
import { readGroupName, readSubCategoryName } from "../types/itemAttributes";

export interface MasterScope {
  /** Category (group_name). Empty/null = no scope on this dim. */
  category?: string | null;
  /** Sub-category (category_name). */
  subCategory?: string | null;
  /** Style code (or sku_code when style is null). */
  style?: string | null;
}

export interface MasterPools {
  groups: string[];
  subCategories: string[];
  styles: string[];
  /** Colors filtered by category + sub-category. */
  colorsByCategory: string[];
  /** Colors filtered by style. */
  colorsByStyle: string[];
  /** Descriptions filtered by style. */
  descriptions: string[];
}

const isTbd = (s: string | null | undefined) => !!s && s.toUpperCase() === "TBD";

// Empty/null/all-sentinel are all treated as "no filter on this dim"
// so callers can stay on whichever sentinel convention they already
// use ("all" for filter strips, "" for form pickers).
const isWild = (s: string | null | undefined) => !s || s === "all";

export function buildMasterPools(items: IpItem[], scope: MasterScope = {}): MasterPools {
  const groups = new Set<string>();
  const subCats = new Set<string>();
  const styles = new Set<string>();
  const colorsByCat = new Set<string>();
  const colorsByStyle = new Set<string>();
  const descriptions = new Set<string>();
  const styleScopeIsTbd = isTbd(scope.style);
  for (const i of items) {
    const g = readGroupName(i);
    const sc = readSubCategoryName(i);
    const styleCode = i.style_code ?? i.sku_code ?? "";
    if (g) groups.add(g);
    // Sub-cats scoped by category.
    if (sc && (isWild(scope.category) || g === scope.category)) subCats.add(sc);
    // Styles scoped by category + sub-category.
    const styleScopeOk = (isWild(scope.category) || g === scope.category)
      && (isWild(scope.subCategory) || sc === scope.subCategory);
    if (styleScopeOk && styleCode && !isTbd(styleCode)) styles.add(styleCode);
    // Colors-by-category: scope by sub-cat first, fall back to cat
    // (matches the form's "Cat OR Sub Cat narrows" behavior).
    const catColorOk = !isWild(scope.subCategory)
      ? sc === scope.subCategory
      : (isWild(scope.category) || g === scope.category);
    if (catColorOk && i.color && !isTbd(i.color)) colorsByCat.add(i.color);
    // Colors-by-style: scope strictly by style. TBD style means "any
    // style" so the planner can still see every color when style is
    // unknown.
    const styleColorOk = isWild(scope.style) || styleScopeIsTbd || styleCode === scope.style;
    if (styleColorOk && i.color && !isTbd(i.color)) colorsByStyle.add(i.color);
    // Descriptions scoped by style.
    const descScopeOk = isWild(scope.style) || styleScopeIsTbd || styleCode === scope.style;
    if (descScopeOk && i.description && !isTbd(i.description)) descriptions.add(i.description);
  }
  const sorted = (s: Set<string>) => Array.from(s).sort();
  return {
    groups: sorted(groups),
    subCategories: sorted(subCats),
    styles: sorted(styles),
    colorsByCategory: sorted(colorsByCat),
    colorsByStyle: sorted(colorsByStyle),
    descriptions: sorted(descriptions),
  };
}
