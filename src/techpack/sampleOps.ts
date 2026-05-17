// Pure data helpers for the Samples tab. Extracted from TechPack.tsx
// so the non-obvious status-transition rule (auto-set receiveDate
// when status flips to Received / Approved / Rejected) can be
// pinned into a test, instead of living inline inside an onChange
// handler where it's easy to break by accident.

import type { Sample } from "./types";
import { uid } from "./utils";

/** Statuses that imply the sample has actually arrived at HQ. */
const RECEIVED_STATUSES = new Set<Sample["status"]>(["Received", "Approved", "Rejected"]);

/**
 * Fresh blank sample seeded with today's date as the request date.
 * `today` is injected so tests can pin a deterministic date.
 */
export function createEmptySample(today: () => string): Sample {
  return {
    id: uid(),
    type: "Proto",
    status: "Requested",
    requestDate: today(),
    receiveDate: null,
    vendor: "",
    comments: "",
    images: [],
  };
}

/**
 * Transition a sample to a new status. If the new status is one of
 * `Received` / `Approved` / `Rejected` AND the sample has no
 * `receiveDate` yet, stamp today's date. If receiveDate is already
 * set, it's preserved. Other statuses leave receiveDate alone.
 *
 * `today` is injected so tests don't depend on the wall clock.
 */
export function updateSampleStatus(
  sample: Sample,
  newStatus: Sample["status"],
  today: () => string,
): Sample {
  const next: Sample = { ...sample, status: newStatus };
  if (RECEIVED_STATUSES.has(newStatus) && !sample.receiveDate) {
    next.receiveDate = today();
  }
  return next;
}
