// Pure column-width compute extracted from WholesalePlanningGrid's
// dynamicColWidths useMemo. Given the longest content string for a
// column (measured in characters), returns the px width to use:
//
//   px = ceil((contentChars + PADDING_CHARS) * CHAR_PX)
//   then clamped: max(FLOOR, min(CAP, px))   if CAP/FLOOR defined
//   then floored: max(FLOOR_PX, px)
//
// Kept side-effect-free so unit tests can run without rendering.

import {
  COL_WIDTH_CAP,
  COL_WIDTH_FLOOR,
  COL_WIDTH_FLOOR_PX,
  COL_WIDTH_CHAR_PX,
  COL_WIDTH_PADDING_CHARS,
} from "./columns";

export function computeColumnWidth(key: string, contentChars: number): number {
  let px = Math.ceil((contentChars + COL_WIDTH_PADDING_CHARS) * COL_WIDTH_CHAR_PX);
  if (key in COL_WIDTH_CAP)   px = Math.min(px, COL_WIDTH_CAP[key]);
  if (key in COL_WIDTH_FLOOR) px = Math.max(px, COL_WIDTH_FLOOR[key]);
  px = Math.max(px, COL_WIDTH_FLOOR_PX);
  return px;
}
