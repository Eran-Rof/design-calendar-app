// Supabase REST access for Phase 4 tables.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type {
  IpChangeAuditLog,
  IpExportJob,
  IpPlanningApproval,
  IpScenario,
  IpScenarioAssumption,
} from "../types/scenarios";

function assertSupabase(): void {
  if (!SB_URL) throw new Error("Supabase URL not configured");
}
async function sbGet<T>(path: string): Promise<T[]> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbPost<T>(path: string, body: unknown, prefer = "return=representation"): Promise<T[]> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} failed: ${r.status} ${await r.text()}`);
  return prefer.includes("return=minimal") ? ([] as T[]) : r.json();
}
async function sbPatch<T>(path: string, body: unknown): Promise<T[]> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbDelete(path: string): Promise<void> {
  assertSupabase();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method: "DELETE", headers: SB_HEADERS });
  if (!r.ok) throw new Error(`DELETE ${path} failed: ${r.status} ${await r.text()}`);
}

export const scenarioRepo = {
  // scenarios
  async listScenarios(): Promise<IpScenario[]> {
    return sbGet<IpScenario>("ip_scenarios?select=*&order=created_at.desc&limit=2000");
  },
  async getScenario(id: string): Promise<IpScenario | null> {
    const r = await sbGet<IpScenario>(`ip_scenarios?select=*&id=eq.${id}`);
    return r[0] ?? null;
  },
  async createScenario(row: Omit<IpScenario, "id" | "created_at" | "updated_at">): Promise<IpScenario> {
    const [created] = await sbPost<IpScenario>("ip_scenarios", [row]);
    return created;
  },
  async updateScenario(id: string, patch: Partial<IpScenario>): Promise<IpScenario> {
    const [u] = await sbPatch<IpScenario>(`ip_scenarios?id=eq.${id}`, patch);
    return u;
  },
  async deleteScenario(id: string): Promise<void> {
    await sbDelete(`ip_scenarios?id=eq.${id}`);
  },

  // assumptions
  async listAssumptions(scenarioId: string): Promise<IpScenarioAssumption[]> {
    return sbGet<IpScenarioAssumption>(`ip_scenario_assumptions?select=*&scenario_id=eq.${scenarioId}&order=created_at.asc&limit=5000`);
  },
  async createAssumption(row: Omit<IpScenarioAssumption, "id" | "created_at" | "updated_at">): Promise<IpScenarioAssumption> {
    const [c] = await sbPost<IpScenarioAssumption>("ip_scenario_assumptions", [row]);
    return c;
  },
  async updateAssumption(id: string, patch: Partial<IpScenarioAssumption>): Promise<IpScenarioAssumption> {
    const [u] = await sbPatch<IpScenarioAssumption>(`ip_scenario_assumptions?id=eq.${id}`, patch);
    return u;
  },
  async deleteAssumption(id: string): Promise<void> {
    await sbDelete(`ip_scenario_assumptions?id=eq.${id}`);
  },

  // approvals
  async listApprovals(filter: { planning_run_id?: string; scenario_id?: string }): Promise<IpPlanningApproval[]> {
    const ps: string[] = ["select=*"];
    if (filter.planning_run_id) ps.push(`planning_run_id=eq.${filter.planning_run_id}`);
    if (filter.scenario_id)     ps.push(`scenario_id=eq.${filter.scenario_id}`);
    ps.push("order=created_at.desc");
    ps.push("limit=2000");
    return sbGet<IpPlanningApproval>(`ip_planning_approvals?${ps.join("&")}`);
  },
  async createApproval(row: Omit<IpPlanningApproval, "id" | "created_at" | "updated_at">): Promise<IpPlanningApproval> {
    const [c] = await sbPost<IpPlanningApproval>("ip_planning_approvals", [row]);
    return c;
  },

  // audit log
  async listAudit(filter: { scenario_id?: string; planning_run_id?: string; entity_id?: string }): Promise<IpChangeAuditLog[]> {
    const ps: string[] = ["select=*"];
    if (filter.scenario_id)     ps.push(`scenario_id=eq.${filter.scenario_id}`);
    if (filter.planning_run_id) ps.push(`planning_run_id=eq.${filter.planning_run_id}`);
    if (filter.entity_id)       ps.push(`entity_id=eq.${filter.entity_id}`);
    ps.push("order=created_at.desc");
    ps.push("limit=2000");
    return sbGet<IpChangeAuditLog>(`ip_change_audit_log?${ps.join("&")}`);
  },
  async createAudit(row: Omit<IpChangeAuditLog, "id" | "created_at">): Promise<void> {
    await sbPost("ip_change_audit_log", [row], "return=minimal");
  },

  // export jobs
  async listExports(filter: { planning_run_id?: string; scenario_id?: string }): Promise<IpExportJob[]> {
    const ps: string[] = ["select=*"];
    if (filter.planning_run_id) ps.push(`planning_run_id=eq.${filter.planning_run_id}`);
    if (filter.scenario_id)     ps.push(`scenario_id=eq.${filter.scenario_id}`);
    ps.push("order=created_at.desc");
    ps.push("limit=1000");
    return sbGet<IpExportJob>(`ip_export_jobs?${ps.join("&")}`);
  },
  async createExport(row: Omit<IpExportJob, "id" | "created_at">): Promise<IpExportJob> {
    const [c] = await sbPost<IpExportJob>("ip_export_jobs", [row]);
    return c;
  },
};

export type ScenarioRepo = typeof scenarioRepo;
