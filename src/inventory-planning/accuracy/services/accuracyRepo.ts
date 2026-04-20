// Supabase REST access for Phase 5 accuracy + intelligence tables.
// Same conventions as the Phase 1/2/3 repos.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type {
  IpForecastAccuracy,
  IpForecastActual,
  IpOverrideEffectiveness,
} from "../types/accuracy";
import type {
  IpAiSuggestion,
  IpPlanningAnomaly,
} from "../../intelligence/types/intelligence";

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
async function sbDelete(path: string): Promise<void> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method: "DELETE", headers: SB_HEADERS });
  if (!r.ok) throw new Error(`Supabase DELETE ${path} failed: ${r.status} ${await r.text()}`);
}

export const accuracyRepo = {
  // actuals
  async listActuals(sinceIso?: string): Promise<IpForecastActual[]> {
    const filter = sinceIso ? `&period_start=gte.${sinceIso}` : "";
    return sbGet<IpForecastActual>(`ip_forecast_actuals?select=*${filter}&limit=200000`);
  },
  async upsertActuals(rows: Array<Omit<IpForecastActual, "id" | "created_at">>): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += 500) {
      await sbPost(
        "ip_forecast_actuals?on_conflict=forecast_type,sku_id,period_start,customer_id,channel_id",
        rows.slice(i, i + 500),
        "return=minimal,resolution=merge-duplicates",
      );
    }
  },

  // accuracy
  async listAccuracy(filter?: { planning_run_id?: string; forecast_type?: string; since?: string }): Promise<IpForecastAccuracy[]> {
    const params: string[] = ["select=*"];
    if (filter?.planning_run_id) params.push(`planning_run_id=eq.${filter.planning_run_id}`);
    if (filter?.forecast_type)   params.push(`forecast_type=eq.${filter.forecast_type}`);
    if (filter?.since)           params.push(`period_start=gte.${filter.since}`);
    params.push("limit=200000");
    return sbGet<IpForecastAccuracy>(`ip_forecast_accuracy?${params.join("&")}`);
  },
  async replaceAccuracy(rows: Array<Omit<IpForecastAccuracy, "id" | "created_at">>): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += 500) {
      await sbPost(
        "ip_forecast_accuracy?on_conflict=forecast_type,sku_id,period_start,customer_id,channel_id,planning_run_id",
        rows.slice(i, i + 500),
        "return=minimal,resolution=merge-duplicates",
      );
    }
  },

  // override effectiveness
  async listOverrideEffectiveness(filter?: { planning_run_id?: string }): Promise<IpOverrideEffectiveness[]> {
    const f = filter?.planning_run_id ? `&planning_run_id=eq.${filter.planning_run_id}` : "";
    return sbGet<IpOverrideEffectiveness>(`ip_override_effectiveness?select=*${f}&limit=200000`);
  },
  async replaceOverrideEffectiveness(
    planning_run_id: string | null,
    rows: Array<Omit<IpOverrideEffectiveness, "id" | "created_at">>,
  ): Promise<void> {
    if (planning_run_id) {
      await sbDelete(`ip_override_effectiveness?planning_run_id=eq.${planning_run_id}`);
    } else {
      await sbDelete(`ip_override_effectiveness?planning_run_id=is.null`);
    }
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += 500) {
      await sbPost("ip_override_effectiveness", rows.slice(i, i + 500), "return=minimal");
    }
  },

  // anomalies
  async listAnomalies(filter?: { planning_run_id?: string }): Promise<IpPlanningAnomaly[]> {
    const f = filter?.planning_run_id ? `&planning_run_id=eq.${filter.planning_run_id}` : "";
    return sbGet<IpPlanningAnomaly>(`ip_planning_anomalies?select=*${f}&order=created_at.desc&limit=20000`);
  },
  async replaceAnomalies(
    planning_run_id: string | null,
    rows: Array<Omit<IpPlanningAnomaly, "id" | "created_at">>,
  ): Promise<void> {
    if (planning_run_id) {
      await sbDelete(`ip_planning_anomalies?planning_run_id=eq.${planning_run_id}`);
    } else {
      await sbDelete(`ip_planning_anomalies?planning_run_id=is.null`);
    }
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += 500) {
      await sbPost("ip_planning_anomalies", rows.slice(i, i + 500), "return=minimal");
    }
  },

  // AI suggestions
  async listSuggestions(filter?: { planning_run_id?: string; onlyOpen?: boolean }): Promise<IpAiSuggestion[]> {
    const params: string[] = ["select=*"];
    if (filter?.planning_run_id) params.push(`planning_run_id=eq.${filter.planning_run_id}`);
    if (filter?.onlyOpen)        params.push(`accepted_flag=is.null`);
    params.push("order=created_at.desc");
    params.push("limit=20000");
    return sbGet<IpAiSuggestion>(`ip_ai_suggestions?${params.join("&")}`);
  },
  async replaceSuggestions(
    planning_run_id: string | null,
    rows: Array<Omit<IpAiSuggestion, "id" | "created_at">>,
  ): Promise<void> {
    if (planning_run_id) {
      await sbDelete(`ip_ai_suggestions?planning_run_id=eq.${planning_run_id}&accepted_flag=is.null`);
    } else {
      await sbDelete(`ip_ai_suggestions?planning_run_id=is.null&accepted_flag=is.null`);
    }
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += 500) {
      await sbPost("ip_ai_suggestions", rows.slice(i, i + 500), "return=minimal");
    }
  },
  async markSuggestion(id: string, accepted: boolean, by?: string | null): Promise<void> {
    await sbPatch(`ip_ai_suggestions?id=eq.${id}`, {
      accepted_flag: accepted,
      accepted_by: by ?? null,
      accepted_at: new Date().toISOString(),
    });
  },
};

export type AccuracyRepo = typeof accuracyRepo;
