// Supabase REST access for Phase 3 supply reconciliation tables. Same
// SB_URL + SB_HEADERS convention as the wholesale + ecom repos.
// Only read/write ip_* tables Phase 3 owns; cross-lane reads reuse the
// Phase 1/2 repos.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type {
  IpAllocationRule,
  IpInventoryRecommendation,
  IpProjectedInventory,
  IpSupplyException,
  IpVendorTimingSignal,
} from "../types/supply";

function assertSupabase(): void {
  if (!SB_URL) throw new Error("Supabase URL not configured");
}
async function sbGet<T>(path: string): Promise<T[]> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`Supabase GET ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbPost<T>(path: string, body: unknown, prefer = "return=representation"): Promise<T[]> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase POST ${path} failed: ${r.status} ${await r.text()}`);
  return prefer.includes("return=minimal") ? ([] as T[]) : r.json();
}
async function sbPatch<T>(path: string, body: unknown): Promise<T[]> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase PATCH ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
// Chunked insert with 57014-retry. Same pattern as
// wholesalePlanningRepository.upsertForecast — initial chunk 200,
// halve on Postgres statement-timeout, floor 25.
async function chunkedInsertWithRetry<T>(path: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return;
  const INITIAL_CHUNK = 200;
  const MIN_CHUNK = 25;
  const postChunk = async (chunk: T[]): Promise<void> => {
    try {
      await sbPost(path, chunk, "return=minimal");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("57014") && chunk.length > MIN_CHUNK) {
        const half = Math.max(MIN_CHUNK, Math.floor(chunk.length / 2));
        for (let j = 0; j < chunk.length; j += half) {
          await postChunk(chunk.slice(j, j + half));
        }
        return;
      }
      throw e;
    }
  };
  for (let i = 0; i < rows.length; i += INITIAL_CHUNK) {
    await postChunk(rows.slice(i, i + INITIAL_CHUNK));
  }
}

async function sbDelete(path: string): Promise<void> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method: "DELETE", headers: SB_HEADERS });
  if (!r.ok) throw new Error(`Supabase DELETE ${path} failed: ${r.status} ${await r.text()}`);
}

export const supplyRepo = {
  // ── Allocation rules ─────────────────────────────────────────────────────
  async listActiveRules(): Promise<IpAllocationRule[]> {
    return sbGet<IpAllocationRule>(
      `ip_allocation_rules?select=*&active=eq.true&order=priority_rank.asc&limit=5000`,
    );
  },
  async createRule(row: Omit<IpAllocationRule, "id" | "created_at" | "updated_at">): Promise<IpAllocationRule> {
    const [created] = await sbPost<IpAllocationRule>("ip_allocation_rules", [row]);
    return created;
  },
  async updateRule(id: string, patch: Partial<IpAllocationRule>): Promise<IpAllocationRule> {
    const [updated] = await sbPatch<IpAllocationRule>(`ip_allocation_rules?id=eq.${id}`, patch);
    return updated;
  },
  async deleteRule(id: string): Promise<void> {
    await sbDelete(`ip_allocation_rules?id=eq.${id}`);
  },
  async listAllRules(): Promise<IpAllocationRule[]> {
    return sbGet<IpAllocationRule>(`ip_allocation_rules?select=*&order=priority_rank.asc&limit=5000`);
  },

  // ── Projected inventory ──────────────────────────────────────────────────
  async listProjected(runId: string): Promise<IpProjectedInventory[]> {
    return sbGet<IpProjectedInventory>(
      `ip_projected_inventory?select=*&planning_run_id=eq.${runId}&order=period_start.asc,sku_id.asc&limit=200000`,
    );
  },
  async replaceProjected(
    runId: string,
    rows: Array<Omit<IpProjectedInventory, "id" | "created_at">>,
  ): Promise<void> {
    await sbDelete(`ip_projected_inventory?planning_run_id=eq.${runId}`);
    if (rows.length === 0) return;
    await chunkedInsertWithRetry("ip_projected_inventory", rows);
  },

  // ── Recommendations ──────────────────────────────────────────────────────
  async listRecommendations(runId: string): Promise<IpInventoryRecommendation[]> {
    // Stable ORDER BY so the row sequence doesn't shuffle between
    // recon passes (the table is replace-mode, so heap order can
    // change after a rebuild). Same pattern as listExceptions /
    // listProjected. Priority drives the visible "what to do first"
    // order; created_at + id break ties deterministically.
    return sbGet<IpInventoryRecommendation>(
      `ip_inventory_recommendations?select=*&planning_run_id=eq.${runId}&order=priority_level.asc,created_at.asc,id.asc&limit=200000`,
    );
  },
  async replaceRecommendations(
    runId: string,
    rows: Array<Omit<IpInventoryRecommendation, "id" | "created_at">>,
  ): Promise<void> {
    await sbDelete(`ip_inventory_recommendations?planning_run_id=eq.${runId}`);
    if (rows.length === 0) return;
    await chunkedInsertWithRetry("ip_inventory_recommendations", rows);
  },

  // ── Exceptions ───────────────────────────────────────────────────────────
  async listExceptions(runId: string): Promise<IpSupplyException[]> {
    return sbGet<IpSupplyException>(
      `ip_supply_exceptions?select=*&planning_run_id=eq.${runId}&order=severity.asc,created_at.desc&limit=200000`,
    );
  },
  async replaceExceptions(
    runId: string,
    rows: Array<Omit<IpSupplyException, "id" | "created_at">>,
  ): Promise<void> {
    await sbDelete(`ip_supply_exceptions?planning_run_id=eq.${runId}`);
    if (rows.length === 0) return;
    await chunkedInsertWithRetry("ip_supply_exceptions", rows);
  },

  // ── Vendor timing signals ────────────────────────────────────────────────
  async listVendorTiming(): Promise<IpVendorTimingSignal[]> {
    return sbGet<IpVendorTimingSignal>(`ip_vendor_timing_signals?select=*&limit=50000`);
  },
};

export type SupplyRepo = typeof supplyRepo;
