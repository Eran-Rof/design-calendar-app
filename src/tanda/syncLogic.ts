import type { XoroPO } from "../utils/tandaTypes";

const AUTO_ARCHIVE_STATUSES = ["Closed", "Received", "Cancelled"];
const isPartial = (s: string) => (s || "").toLowerCase().includes("partial");

export function shouldArchive(statusName: string): boolean {
  return AUTO_ARCHIVE_STATUSES.includes(statusName) && !isPartial(statusName);
}

export interface ArchiveDecision {
  poNumber: string;
  /** Fresh Xoro data to archive with — gives correct status label in the archive.
   *  Absent for cache-only decisions (DB data already has correct status). */
  freshData?: XoroPO;
  /** Last known status from DB — used to guard the "deleted from Xoro" archivePO fallback.
   *  Only set for source-3 (missing-from-Xoro) decisions. */
  lastKnownStatus?: string;
}

/**
 * Determine which POs to archive and whether fresh Xoro data is available.
 *
 * Three sources:
 * 1. Xoro returned the PO as Closed/Received/Cancelled  → archive with fresh data (correct label)
 * 2. Cached PO already has a Closed/Received/Cancelled status → archive (DB data is correct)
 * 3. PO is absent from Xoro results (likely deleted) → archive only when it's safe to do so:
 *    - statusesWithResults must be provided (full unfiltered sync)
 *    - Xoro must have returned ≥1 result for that PO's last known status
 *      (if 0 results for that status, the fetch may have silently failed)
 *
 * Pass null for statusesWithResults to skip check #3 entirely.
 */
export function getArchiveDecisions(
  xoroPos: XoroPO[],
  cachedRows: Array<{ po_number: string; data: XoroPO }>,
  statusesWithResults: Set<string> | null
): ArchiveDecision[] {
  const decisions = new Map<string, ArchiveDecision>();

  // 1. POs Xoro returned as closed — archive with fresh data so the label is correct
  for (const po of xoroPos) {
    if (shouldArchive(po.StatusName ?? "")) {
      decisions.set(po.PoNumber ?? "", { poNumber: po.PoNumber ?? "", freshData: po });
    }
  }

  // 2. Cached POs whose stored status is closed but not yet archived
  for (const row of cachedRows) {
    if (shouldArchive(row.data?.StatusName ?? "") && !row.data?._archived) {
      if (!decisions.has(row.po_number)) {
        decisions.set(row.po_number, { poNumber: row.po_number });
      }
    }
  }

  // 3. POs missing from Xoro (deleted from Xoro entirely)
  // We fetch ALL statuses in the bulk sync, so any PO absent from xoroPoNums is
  // genuinely gone from Xoro.  Guards:
  //   - statusesWithResults !== null  → allStatusesSucceeded (no network errors)
  //   - !isPartial(lastStatus)        → skip "Partially Received" POs: Xoro's API
  //     may not reliably filter by this multi-word status, so 0 results could be a
  //     fetch artefact rather than a true deletion. Partially Received POs that are
  //     genuinely closed will be caught by source 1 or 2 once their status changes.
  if (statusesWithResults !== null) {
    const xoroPoNums = new Set(xoroPos.map(po => po.PoNumber ?? "").filter(Boolean));
    for (const row of cachedRows) {
      if (decisions.has(row.po_number) || row.data?._archived) continue;
      if (!xoroPoNums.has(row.po_number)) {
        const lastStatus = row.data?.StatusName ?? "";
        // Only archive missing POs if their last known status was already terminal
        // Never archive POs that were Open/Released/Pending/Draft — they may just be
        // missing from Xoro due to pagination or API inconsistency
        if (shouldArchive(lastStatus)) {
          decisions.set(row.po_number, { poNumber: row.po_number, lastKnownStatus: lastStatus });
        }
      }
    }
  }

  return Array.from(decisions.values()).filter(d => d.poNumber);
}
