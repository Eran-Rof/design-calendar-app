// Shared report primitives for the Planning Reports suite.
//
// A "report" is a pure function: it takes already-loaded rows + a small set
// of filter params and returns a ReportResult (columns + rows + summary
// stat cards). The hub UI renders the result on screen and feeds the same
// columns/rows to the universal <ExportButton> for an Excel download — so
// what you see is exactly what you export.

import type { ExportColumn } from "../../tanda/exports/useTableExport";

export type ReportCellFormat = NonNullable<ExportColumn["format"]>;

// Superset of ExportColumn: adds on-screen alignment. Because it carries
// every ExportColumn field, a ReportColumn[] is assignable straight to the
// ExportButton `columns` prop with no mapping.
export interface ReportColumn {
  key: string;
  header: string;
  format?: ReportCellFormat;
  digits?: number;
  align?: "left" | "right";
}

export interface ReportStat {
  label: string;
  value: string;
  tone?: "default" | "good" | "warn" | "bad";
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  summary: ReportStat[];
  /** Optional note shown under the toolbar (e.g. data caveats). */
  note?: string;
}
