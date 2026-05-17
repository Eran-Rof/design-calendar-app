// Pure context-builders for the TBD editor cells inside the Wholesale
// Planning grid row. Extracted from WholesalePlanningGrid.tsx so the
// "is this a NEW style", "is this a NEW color for this style", and
// "is color editing blocked because this isn't the first row of a
// NEW-style family" rules can be unit-tested without React.
//
// The grid row body still does the rendering — these just compute the
// flags + helper sets it feeds to <TbdStyleCell /> and <TbdColorCell />.

import type { IpPlanningGridRow } from "../../types/wholesale";

export interface MasterStyle {
  style_code: string;
  group_name: string | null;
  sub_category_name: string | null;
}

export interface StyleCellContext {
  styleVal: string;
  /** "" or "TBD" never count as NEW. */
  isNewStyle: boolean;
  /** Master styles in this row's category + every planner-added NEW
   *  style currently in `rows`. The TbdStyleCell dropdown uses this. */
  categoryStyles: string[];
  /** Lowercased union of master styles + planner-added NEW styles.
   *  Used by TbdStyleCell to decide whether an operator-typed value
   *  needs the "Add as NEW" confirmation. */
  allStylesLower: Set<string>;
  /** Lowercased master styles only. */
  masterStylesLower: Set<string>;
}

/**
 * Build everything <TbdStyleCell /> needs for one row:
 *   - the current style value ("TBD" fallback)
 *   - whether it's a NEW style (not in masterStyles, not "TBD"/"")
 *   - the dropdown list (master styles in this category +
 *     planner-added NEW styles already in `rows`)
 *   - lowercased sets for the "Add as NEW" confirmation gate
 */
export function buildStyleCellContext(
  row: IpPlanningGridRow,
  rows: IpPlanningGridRow[],
  masterStyles: MasterStyle[],
): StyleCellContext {
  const styleVal = row.sku_style ?? "TBD";
  const styleLower = styleVal.trim().toLowerCase();

  const masterStylesLower = new Set(masterStyles.map(m => m.style_code.toLowerCase()));

  const userAddedStyles = new Set<string>();
  for (const x of rows) {
    if (x.is_tbd && x.sku_style && x.sku_style !== "TBD"
        && !masterStylesLower.has(x.sku_style.toLowerCase())) {
      userAddedStyles.add(x.sku_style);
    }
  }

  const allStylesLower = new Set([
    ...masterStylesLower,
    ...Array.from(userAddedStyles).map(s => s.toLowerCase()),
  ]);

  const isNewStyle = styleLower !== "" && styleLower !== "tbd"
    && !masterStylesLower.has(styleLower);

  // Filter master to this row's category, then append user-added.
  const masterCategoryStyles = masterStyles
    .filter(m => !row.group_name || m.group_name === row.group_name)
    .map(m => m.style_code);

  const categoryStyles = [
    ...masterCategoryStyles,
    ...Array.from(userAddedStyles),
  ];

  return { styleVal, isNewStyle, categoryStyles, allStylesLower, masterStylesLower };
}

export interface ColorCellContext {
  /** Display flag — green "NEW for this style" pill. Differs from
   *  `is_new_color` (orange pill, persisted at save time). */
  isNewForStyle: boolean;
  /**
   * Block color edits on every row of a NEW-style family except the
   * earliest by (period_start ASC, tbd_id ASC). Master-known styles
   * and orphan rows (family.length <= 1) edit freely. Mirrors the
   * workbench's save-side `isFirstRowOfNewStyle` so UI + save agree.
   */
  blockColorEdit: boolean;
}

export function buildColorCellContext(
  row: IpPlanningGridRow,
  rows: IpPlanningGridRow[],
  masterStyles: MasterStyle[],
  allKnownColorsLower: Set<string>,
  masterColorsLower: Set<string> | undefined,
  masterColorsByStyleLower: Map<string, Set<string>> | undefined,
): ColorCellContext {
  const colorLower = (row.sku_color ?? "").trim().toLowerCase();
  const styleColors = masterColorsByStyleLower?.get(row.sku_style ?? "");
  const inAnyMaster = colorLower !== "" && colorLower !== "tbd"
    && (allKnownColorsLower.has(colorLower) || (masterColorsLower?.has(colorLower) ?? false));
  const inThisStyleMaster = colorLower !== "" && (styleColors?.has(colorLower) ?? false);
  const isNewForStyle = !row.is_new_color && inAnyMaster && !inThisStyleMaster;

  const sLower = (row.sku_style ?? "").toLowerCase();
  let blockColorEdit = false;
  if (sLower && sLower !== "tbd") {
    const isMaster = masterStyles.some(m => m.style_code.toLowerCase() === sLower);
    if (!isMaster) {
      const family = rows.filter(x =>
        x.is_tbd && (x.sku_style ?? "").toLowerCase() === sLower,
      );
      if (family.length > 1) {
        const sorted = [...family].sort((a, b) => {
          const ps = a.period_start.localeCompare(b.period_start);
          if (ps !== 0) return ps;
          return (a.tbd_id ?? "").localeCompare(b.tbd_id ?? "");
        });
        blockColorEdit = sorted[0].forecast_id !== row.forecast_id;
      }
    }
  }

  return { isNewForStyle, blockColorEdit };
}
