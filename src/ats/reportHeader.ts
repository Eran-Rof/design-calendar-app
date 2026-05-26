// Shared 3-row "report metadata" header prepended to every ATS Excel
// export. Per operator request:
//
//   Row 0: Report name      (16pt bold navy, centered, merged across all cols)
//   Row 1: Run: YYYY-MM-DD HH:MM   (11pt italic gray, left-aligned, merged)
//   Row 2: Filters: chip, chip, chip   (11pt navy, left-aligned, merged, wraps)
//
// Each report builds its own filter-chip list from its own scope (Aged
// Inven shows age threshold + category; the main ATS Grid shows toolbar
// state; etc.) — the helper just renders the chips into the banner.

export interface ReportHeaderInput {
  reportName: string;
  filterChips: string[];
  totalColumns: number;
  now?: Date;
}

export interface ReportHeaderResult {
  rows: any[][];
  merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>;
  rowHeights: Array<{ hpt: number }>;
}

export const REPORT_HEADER_ROW_COUNT = 3;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Exported so each exporter's ReportPayload.runStamp uses the SAME format
// as the xlsx banner — preview header + downloaded workbook show one
// timestamp, no drift between them.
export function fmtRunStamp(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

export function buildReportHeader(input: ReportHeaderInput): ReportHeaderResult {
  const TC = Math.max(1, input.totalColumns);
  const now = input.now ?? new Date();
  const filtersText = input.filterChips.length === 0
    ? "Filters: None"
    : `Filters: ${input.filterChips.join(", ")}`;

  const nameStyle: any = {
    font:      { sz: 16, bold: true, color: { rgb: "1F497D" }, name: "Calibri" },
    alignment: { horizontal: "center", vertical: "center" },
  };
  const dateStyle: any = {
    font:      { sz: 11, italic: true, color: { rgb: "6B7280" }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
  };
  const filtersStyle: any = {
    font:      { sz: 11, color: { rgb: "1F497D" }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center", wrapText: true },
  };

  const blank = (style: any) => ({ v: "", t: "s" as const, s: style });
  const rowOf = (head: any, style: any) => {
    const r: any[] = new Array(TC);
    r[0] = head;
    for (let i = 1; i < TC; i++) r[i] = blank(style);
    return r;
  };

  const rows: any[][] = [
    rowOf({ v: input.reportName, t: "s" as const, s: nameStyle }, nameStyle),
    rowOf({ v: `Run: ${fmtRunStamp(now)}`, t: "s" as const, s: dateStyle }, dateStyle),
    rowOf({ v: filtersText, t: "s" as const, s: filtersStyle }, filtersStyle),
  ];

  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: TC - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: TC - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: TC - 1 } },
  ];

  // Filter row grows when many chips wrap onto multiple lines. Rough
  // heuristic: ~90 chars fits one line at 11pt across a typical
  // 20-column report; bump height for additional ~90-char bands.
  const filtersLen = filtersText.length;
  const filterRowHpt = filtersLen <= 90 ? 18 : (filtersLen <= 180 ? 32 : 48);

  const rowHeights: Array<{ hpt: number }> = [
    { hpt: 26 },
    { hpt: 18 },
    { hpt: filterRowHpt },
  ];

  return { rows, merges, rowHeights };
}
