// REST access for Phase 6 execution tables.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type {
  IpActionTemplate,
  IpErpWritebackConfig,
  IpExecutionAction,
  IpExecutionAuditEntry,
  IpExecutionBatch,
} from "../types/execution";

function assertSupabase(): void { if (!SB_URL) throw new Error("Supabase URL not configured"); }
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

export const executionRepo = {
  // batches
  async listBatches(): Promise<IpExecutionBatch[]> {
    return sbGet<IpExecutionBatch>("ip_execution_batches?select=*&order=created_at.desc&limit=500");
  },
  async getBatch(id: string): Promise<IpExecutionBatch | null> {
    const r = await sbGet<IpExecutionBatch>(`ip_execution_batches?select=*&id=eq.${id}`);
    return r[0] ?? null;
  },
  async createBatch(row: Omit<IpExecutionBatch, "id" | "created_at" | "updated_at">): Promise<IpExecutionBatch> {
    const [c] = await sbPost<IpExecutionBatch>("ip_execution_batches", [row]);
    if (!c) throw new Error("createBatch: no row returned from Supabase");
    return c;
  },
  async updateBatch(id: string, patch: Partial<IpExecutionBatch>): Promise<IpExecutionBatch> {
    const [u] = await sbPatch<IpExecutionBatch>(`ip_execution_batches?id=eq.${id}`, patch);
    if (!u) throw new Error(`updateBatch(${id}): no row returned from Supabase`);
    return u;
  },

  // actions
  async listActions(batchId: string): Promise<IpExecutionAction[]> {
    return sbGet<IpExecutionAction>(`ip_execution_actions?select=*&execution_batch_id=eq.${batchId}&order=created_at.asc&limit=5000`);
  },
  async insertActions(rows: Array<Omit<IpExecutionAction, "id" | "created_at" | "updated_at">>): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += 500) {
      await sbPost("ip_execution_actions", rows.slice(i, i + 500), "return=minimal");
    }
  },
  async updateAction(id: string, patch: Partial<IpExecutionAction>): Promise<IpExecutionAction> {
    const [u] = await sbPatch<IpExecutionAction>(`ip_execution_actions?id=eq.${id}`, patch);
    if (!u) throw new Error(`updateAction(${id}): no row returned from Supabase`);
    return u;
  },
  async deleteAction(id: string): Promise<void> {
    await sbDelete(`ip_execution_actions?id=eq.${id}`);
  },

  // audit
  async listAudit(batchId: string): Promise<IpExecutionAuditEntry[]> {
    return sbGet<IpExecutionAuditEntry>(`ip_execution_audit_log?select=*&execution_batch_id=eq.${batchId}&order=created_at.desc&limit=5000`);
  },
  async insertAudit(row: Omit<IpExecutionAuditEntry, "id" | "created_at">): Promise<void> {
    try {
      await sbPost("ip_execution_audit_log", [row], "return=minimal");
    } catch {
      // advisory; swallow so the parent write doesn't fail on audit
    }
  },

  // writeback config
  async listWritebackConfig(systemName = "xoro"): Promise<IpErpWritebackConfig[]> {
    return sbGet<IpErpWritebackConfig>(`ip_erp_writeback_config?select=*&system_name=eq.${systemName}&limit=200`);
  },
  async updateWritebackConfig(id: string, patch: Partial<IpErpWritebackConfig>): Promise<IpErpWritebackConfig> {
    const [u] = await sbPatch<IpErpWritebackConfig>(`ip_erp_writeback_config?id=eq.${id}`, patch);
    if (!u) throw new Error(`updateWritebackConfig(${id}): no row returned from Supabase`);
    return u;
  },

  // templates (optional — MVP just lists)
  async listTemplates(): Promise<IpActionTemplate[]> {
    return sbGet<IpActionTemplate>("ip_action_templates?select=*&active=eq.true&limit=500");
  },
};

export type ExecutionRepo = typeof executionRepo;
