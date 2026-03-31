import type { XoroPO } from "../utils/tandaTypes";

const AUTO_ARCHIVE_STATUSES = ["Closed", "Received", "Cancelled"];
const isPartial = (s: string) => (s || "").toLowerCase().includes("partial");

export function shouldArchive(statusName: string): boolean {
  return AUTO_ARCHIVE_STATUSES.includes(statusName) && !isPartial(statusName);
}

export function getPOsToArchive(
  xoroPos: XoroPO[],
  cachedRows: Array<{ po_number: string; data: XoroPO }>,
  isFullSync: boolean
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

  // Archive POs that no longer exist in Xoro (deleted) — only safe on full unfiltered syncs
  if (isFullSync) {
    const xoroPoNums = new Set(xoroPos.map(po => po.PoNumber ?? "").filter(Boolean));
    for (const row of cachedRows) {
      if (!xoroPoNums.has(row.po_number) && !row.data?._archived) {
        toArchive.add(row.po_number);
      }
    }
  }

  return toArchive;
}
