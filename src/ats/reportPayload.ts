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
  /** Pre-styled XLSXStyle workbook ready to flush. */
  wb: any;
  /** Suggested download filename. */
  filename: string;
  /** Filter chips for the preview header — same list that gets joined
   *  into "Filters: …" in the xlsx's report-metadata banner. The modal
   *  renders these as small chips next to the Run timestamp instead of
   *  duplicating the banner as a wide column-spanning table row. */
  filterChips?: string[];
  /** Run timestamp ("YYYY-MM-DD HH:MM") that matches the xlsx banner's
   *  Row 1, so the preview shows the same stamp the operator sees on
   *  the downloaded file. Optional — modal falls back to omitting the
   *  stamp when the payload predates this field. */
  runStamp?: string;
}
