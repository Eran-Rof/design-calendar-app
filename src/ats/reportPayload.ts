// Shared payload shape every ATS report exporter returns so the
// preview modal can render it. The modal walks `aoa` for the on-screen
// preview (remapping Excel hex colors to the app's theme palette so
// the preview matches the rest of the app's UI) and hands `wb` to
// XLSXStyle.writeFile when the operator clicks Download — so the
// downloaded .xlsx is byte-for-byte the legacy output.

export interface ReportPayload {
  /** Display title shown in the preview modal header (e.g. "Negative Inventory"). */
  title: string;
  /** Cell-level array-of-arrays the workbook was built from. */
  aoa: any[][];
  /** Pre-styled (logo'd) ExcelJS workbook ready to flush. */
  wb: any;
  /** Suggested download filename. */
  filename: string;
  /** Non-main worksheet AOAs (e.g. "By Size Matrix" + per-period tabs) so the
   *  preview can render them without reaching into the workbook internals. */
  extraSheets?: Array<{ name: string; aoa: any[][] }>;
}
