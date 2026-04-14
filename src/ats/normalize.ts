import type { ExcelData } from "./types";
import { normalizeSku } from "./helpers";

export interface NormChange {
  original: string;
  normalized: string;
  sources: ("inventory" | "purchases" | "orders")[];
  accepted: boolean;
}

// Persisted per-SKU normalization decisions. Key: the original (raw) SKU
// string. Value: "accept" means the user okayed the normalize, "reject"
// means they chose to keep the raw form. Stored in Supabase under
// ats_norm_decisions so re-uploads only prompt for never-seen SKUs.
export type NormDecisions = Record<string, "accept" | "reject">;

// Split the detected changes by whether the user has already made a decision
// for that original SKU. Known decisions apply silently; unknowns go to the
// review modal. Accepted state on known changes is pre-filled from history so
// if the modal does open (because of the unknowns), rendering it with the
// full list still looks consistent.
export function partitionNormChanges(
  changes: NormChange[],
  decisions: NormDecisions,
): { known: NormChange[]; unknown: NormChange[] } {
  const known: NormChange[] = [];
  const unknown: NormChange[] = [];
  for (const c of changes) {
    const d = decisions[c.original];
    if (d === "accept") known.push({ ...c, accepted: true });
    else if (d === "reject") known.push({ ...c, accepted: false });
    else unknown.push(c);
  }
  return { known, unknown };
}

// Merge a batch of user-made decisions into the stored map. Per-call
// overwrites (user can change their mind by rejecting something they once
// accepted — next upload flow would then skip it).
export function mergeNormDecisions(
  existing: NormDecisions,
  changes: NormChange[],
): NormDecisions {
  const next = { ...existing };
  for (const c of changes) next[c.original] = c.accepted ? "accept" : "reject";
  return next;
}

/** Detect all SKU normalization changes without applying them. */
export function detectNormChanges(data: ExcelData): NormChange[] {
  const map: Record<string, NormChange> = {};
  const add = (orig: string, source: NormChange["sources"][number]) => {
    const norm = normalizeSku(orig);
    if (norm === orig) return;
    if (!map[orig]) map[orig] = { original: orig, normalized: norm, sources: [], accepted: true };
    if (!map[orig].sources.includes(source)) map[orig].sources.push(source);
  };
  data.skus.forEach(s => add(s.sku, "inventory"));
  data.pos.forEach(p => add(p.sku, "purchases"));
  data.sos.forEach(s => add(s.sku, "orders"));
  return Object.values(map).sort((a, b) => a.original.localeCompare(b.original));
}

/** Apply only accepted normalization changes to ExcelData. */
export function applyNormChanges(data: ExcelData, changes: NormChange[]): ExcelData {
  const acceptedMap: Record<string, string> = {};
  for (const c of changes) {
    if (c.accepted) acceptedMap[c.original] = c.normalized;
  }
  const apply = (sku: string) => acceptedMap[sku] ?? sku;
  return {
    ...data,
    skus: data.skus.map(s => ({ ...s, sku: apply(s.sku) })),
    pos: data.pos.map(p => ({ ...p, sku: apply(p.sku) })),
    sos: data.sos.map(s => ({ ...s, sku: apply(s.sku) })),
  };
}

/** Normalize all SKU strings in ExcelData so inventory, POs, and SOs match.
 *  Fixes: double spaces, dash spacing, casing differences. */
export function normalizeExcelData(data: ExcelData): ExcelData {
  return {
    ...data,
    skus: data.skus.map(s => ({ ...s, sku: normalizeSku(s.sku) })),
    pos: data.pos.map(p => ({ ...p, sku: normalizeSku(p.sku) })),
    sos: data.sos.map(s => ({ ...s, sku: normalizeSku(s.sku) })),
  };
}
