// Reads the existing ip_change_audit_log + ip_execution_audit_log and
// surfaces unified entries to the governance audit explorer.
//
// Keeps the two logs separate at the source but presents a consistent
// `IpAuditRow` shape so the UI can filter/search without caring which
// table a row came from.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";

export interface IpAuditRow {
  source: "planning" | "execution";
  id: string;
  created_at: string;
  actor: string | null;
  entity_type: string;
  entity_id: string | null;
  event_or_field: string;
  old_value: string | null;
  new_value: string | null;
  message: string | null;
  planning_run_id?: string | null;
  scenario_id?: string | null;
  execution_batch_id?: string | null;
}

export interface AuditSearchFilter {
  from?: string;                // ISO date (inclusive)
  to?: string;                  // ISO date (inclusive)
  actor?: string;
  entity_type?: string;
  search?: string;              // matches on message/field/old/new
  limit?: number;               // default 500
}

async function sbGet<T>(path: string): Promise<T[]> {
  if (!SB_URL) return [];
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) return [];
  return r.json();
}

function qp(key: string, value: string): string {
  return `${key}=${encodeURIComponent(value)}`;
}

export async function searchAudit(filter: AuditSearchFilter = {}): Promise<IpAuditRow[]> {
  const limit = filter.limit ?? 500;
  const params: string[] = ["select=*", "order=created_at.desc", `limit=${limit}`];
  if (filter.from) params.push(`created_at=gte.${filter.from}`);
  if (filter.to) params.push(`created_at=lte.${filter.to}T23:59:59`);
  if (filter.actor) params.push(qp("changed_by", `eq.${filter.actor}`));
  if (filter.entity_type) params.push(qp("entity_type", `eq.${filter.entity_type}`));

  const planning = await sbGet<{
    id: string; created_at: string;
    entity_type: string; entity_id: string | null;
    changed_field: string | null; old_value: string | null; new_value: string | null;
    changed_by: string | null; change_reason: string | null;
    planning_run_id: string | null; scenario_id: string | null;
  }>(`ip_change_audit_log?${params.join("&")}`);

  // Execution audit has a slightly different column shape — query it
  // with a tailored set of filters (event_type / actor).
  const execParams: string[] = ["select=*", "order=created_at.desc", `limit=${limit}`];
  if (filter.from) execParams.push(`created_at=gte.${filter.from}`);
  if (filter.to) execParams.push(`created_at=lte.${filter.to}T23:59:59`);
  if (filter.actor) execParams.push(qp("actor", `eq.${filter.actor}`));
  if (filter.entity_type === "execution" || filter.entity_type === "batch" || filter.entity_type === "action") {
    // no further filter — execution entries don't have entity_type
  }
  const exec = await sbGet<{
    id: string; created_at: string;
    execution_batch_id: string; execution_action_id: string | null;
    event_type: string; old_status: string | null; new_status: string | null;
    event_message: string | null; actor: string | null;
  }>(`ip_execution_audit_log?${execParams.join("&")}`);

  const rows: IpAuditRow[] = [];
  for (const p of planning) {
    rows.push({
      source: "planning",
      id: p.id,
      created_at: p.created_at,
      actor: p.changed_by,
      entity_type: p.entity_type,
      entity_id: p.entity_id,
      event_or_field: p.changed_field ?? "",
      old_value: p.old_value,
      new_value: p.new_value,
      message: p.change_reason,
      planning_run_id: p.planning_run_id,
      scenario_id: p.scenario_id,
    });
  }
  for (const e of exec) {
    rows.push({
      source: "execution",
      id: e.id,
      created_at: e.created_at,
      actor: e.actor,
      entity_type: e.execution_action_id ? "action" : "batch",
      entity_id: e.execution_action_id ?? e.execution_batch_id,
      event_or_field: e.event_type,
      old_value: e.old_status,
      new_value: e.new_status,
      message: e.event_message,
      execution_batch_id: e.execution_batch_id,
    });
  }

  // Search filter (client-side) — keeps the query params simple.
  const q = filter.search?.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => {
        const hay = `${r.actor ?? ""} ${r.entity_type} ${r.event_or_field} ${r.old_value ?? ""} ${r.new_value ?? ""} ${r.message ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
    : rows;

  filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return filtered.slice(0, limit);
}
