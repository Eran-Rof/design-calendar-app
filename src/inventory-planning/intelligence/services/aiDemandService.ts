import type { AIDemandResult } from "../types/aiDemand";

export async function runAIDemandPrediction(
  planningRunId: string,
  topNSkus = 40,
): Promise<AIDemandResult> {
  const res = await fetch("/api/internal/ip-ai-demand", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planning_run_id: planningRunId, top_n_skus: topNSkus }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<AIDemandResult>;
}
