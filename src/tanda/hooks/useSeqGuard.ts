import { useRef } from "react";

/**
 * Fetch-race guard (the proven `loadSeqRef` pattern from InternalSalesOrders).
 *
 * Rapidly changing a filter/date fires several overlapping load()s; without
 * sequencing, a SLOWER earlier response can land LAST and clobber the newest
 * state (e.g. a fresh date range briefly showing, then reverting). Only the
 * latest request's result may be applied.
 *
 * Usage inside a panel's load():
 *
 *   const seqGuard = useSeqGuard();
 *   async function load() {
 *     const seq = seqGuard.begin();          // claim the latest sequence number
 *     ...await fetch()...
 *     if (!seqGuard.isCurrent(seq)) return;  // superseded — drop stale result
 *     setRows(data);
 *   }
 *
 * Every setState AFTER an await (including catch/finally) must be gated on
 * isCurrent(seq). The returned object is referentially stable, so it is safe
 * to omit from (or include in) hook dependency arrays.
 */
export interface SeqGuard {
  /** Start a new load: bumps the sequence and returns this load's ticket. */
  begin(): number;
  /** True while `seq` is still the newest load (no later begin() happened). */
  isCurrent(seq: number): boolean;
}

export function useSeqGuard(): SeqGuard {
  const seqRef = useRef(0);
  const guardRef = useRef<SeqGuard | null>(null);
  if (!guardRef.current) {
    guardRef.current = {
      begin: () => ++seqRef.current,
      isCurrent: (seq: number) => seq === seqRef.current,
    };
  }
  return guardRef.current;
}
