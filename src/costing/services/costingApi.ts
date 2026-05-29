// Costing Module — API client
// Thin fetch wrappers against /api/internal/costing/* (handlers in
// api/_handlers/internal/costing/, registered in routes.js as h475–h488).
// All return Promise<T>; throw on !response.ok.

import type {
  CostingProject,
  CostingProjectDetail,
  CostingProjectDraft,
  CostingProjectPatch,
} from "../types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const body = await res.json(); if (body?.error) msg = body.error; } catch { /* noop */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export interface ListProjectsFilters {
  entity_id?: string;
  status?: string;
  customer_id?: string;
  sales_rep_id?: string;
  brand?: string;
}

export async function listProjects(filters: ListProjectsFilters = {}): Promise<CostingProject[]> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) sp.set(k, String(v));
  const qs = sp.toString();
  return json<CostingProject[]>(await fetch(`/api/internal/costing/projects${qs ? `?${qs}` : ""}`));
}

export async function getProject(id: string): Promise<CostingProjectDetail> {
  return json<CostingProjectDetail>(await fetch(`/api/internal/costing/projects/${id}`));
}

export async function createProject(draft: CostingProjectDraft): Promise<CostingProject> {
  return json<CostingProject>(await fetch(`/api/internal/costing/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  }));
}

export async function updateProject(id: string, patch: CostingProjectPatch): Promise<CostingProject> {
  return json<CostingProject>(await fetch(`/api/internal/costing/projects/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteProject(id: string): Promise<void> {
  return json<void>(await fetch(`/api/internal/costing/projects/${id}`, { method: "DELETE" }));
}
