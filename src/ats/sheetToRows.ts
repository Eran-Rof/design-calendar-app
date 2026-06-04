// Reconstruct a dense Cell[][] display grid from an xlsx-js-style
// worksheet. The export builds every sheet via aoa_to_sheet, which
// stores cells in A1-addressed objects carrying .v (value), .t (type)
// and .s (style). The View preview (ExportPreviewModal) renders the
// MAIN sheet straight from the payload's `aoa`, but the optional "By
// Size Matrix" + per-period tabs only exist inside payload.wb — so to
// preview those we walk the worksheet back into rows here, preserving
// each cell's style so the preview keeps the report's fills/fonts.
//
// Kept as a pure, framework-free helper so it can be unit-tested
// without mounting React.

import XLSXStyle from "xlsx-js-style";

export interface SheetCell {
  v?: string | number;
  t?: string;
  s?: any;
  f?: string;
}

// Walk the worksheet's !ref range into a dense grid. Cells absent from
// the worksheet (e.g. the blank spacer rows between style blocks, which
// aoa_to_sheet writes as empty rows) come back as `undefined` — the
// renderer treats those as blank, matching the workbook. Returns [] for
// an empty / range-less sheet.
export function sheetToCellRows(ws: any): SheetCell[][] {
  if (!ws || !ws["!ref"]) return [];
  const range = XLSXStyle.utils.decode_range(ws["!ref"]);
  const rows: SheetCell[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: SheetCell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSXStyle.utils.encode_cell({ r, c });
      const cell = ws[addr];
      row.push(cell ? { v: cell.v, t: cell.t, s: cell.s, f: cell.f } : (undefined as any));
    }
    rows.push(row);
  }
  return rows;
}
