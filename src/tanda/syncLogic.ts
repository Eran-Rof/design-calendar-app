import type { XoroPO } from "../utils/tandaTypes";

const AUTO_ARCHIVE_STATUSES = ["Closed", "Received", "Cancelled"];
const isPartial = (s: string) => (s || "").toLowerCase().includes("partial");

export function shouldArchive(statusName: string): boolean {
  return AUTO_ARCHIVE_STATUSES.includes(statusName) && !isPartial(statusName);
}

export function getPOsToArchive(
  xoroPos: XoroPO[],
  cachedRows: Array<{ po_number: string; data: XoroPO }>
): Set<string> {
  const toArchive = new Set<string>();

  // Archive POs returned from Xoro with a closed/received/cancelled status
  for (const po of xoroPos) {
    if (shouldArchive(po.StatusName ?? "")) toArchive.add(po.PoNumber ?? "");
  }

  // Archive cached POs with a closed/received/cancelled status not already archived
  for (const row of cachedRows) {
    if (shouldArchive(row.data?.StatusName ?? "") && !row.data?._archived) {
      toArchive.add(row.po_number);
    }
  }

  return toArchive;
}
