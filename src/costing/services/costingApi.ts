// Costing Module — API client
// Thin fetch wrappers against /api/internal/costing/* (handlers in
// api/_handlers/internal/costing/, registered in routes.js as h475–h488).
// All return Promise<T>; throw on !response.ok.

import type {
  CostingProject,
  CostingProjectDetail,
  CostingProjectDraft,
  CostingProjectPatch,
  CostingLine,
  CostingLineVendor,
  CostingLineCompliance,
  CostingComplianceStatus,
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

// ── Lines ───────────────────────────────────────────────────────────────────

export async function listLines(projectId: string): Promise<CostingLine[]> {
  return json<CostingLine[]>(await fetch(`/api/internal/costing/projects/${projectId}/lines`));
}

export interface LineUpsertRow extends Partial<CostingLine> {
  id?: string;
}

/** Bulk upsert: rows with id are UPDATEd, rows without id are INSERTed. */
export async function upsertLines(projectId: string, lines: LineUpsertRow[]): Promise<CostingLine[]> {
  return json<CostingLine[]>(await fetch(`/api/internal/costing/projects/${projectId}/lines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines }),
  }));
}

export async function updateLine(lineId: string, patch: Partial<CostingLine>): Promise<CostingLine> {
  return json<CostingLine>(await fetch(`/api/internal/costing/lines/${lineId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteLine(lineId: string): Promise<void> {
  return json<void>(await fetch(`/api/internal/costing/lines/${lineId}`, { method: "DELETE" }));
}

// ── Vendor quotes ───────────────────────────────────────────────────────────

export async function listQuotes(lineId: string): Promise<CostingLineVendor[]> {
  return json<CostingLineVendor[]>(await fetch(`/api/internal/costing/lines/${lineId}/quotes`));
}

export interface QuoteDraft {
  vendor_id: string;
  quoted_cost: number;
  currency?: string;
  lead_time_days?: number | null;
  moq?: number | null;
  quoted_date?: string | null;
  valid_until?: string | null;
  status?: string;
  notes?: string | null;
}

export async function createQuote(lineId: string, draft: QuoteDraft): Promise<CostingLineVendor> {
  return json<CostingLineVendor>(await fetch(`/api/internal/costing/lines/${lineId}/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  }));
}

export async function updateQuote(
  lineId: string,
  quoteId: string,
  patch: Partial<QuoteDraft>,
): Promise<CostingLineVendor> {
  return json<CostingLineVendor>(await fetch(`/api/internal/costing/lines/${lineId}/quotes/${quoteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteQuote(lineId: string, quoteId: string): Promise<void> {
  return json<void>(await fetch(`/api/internal/costing/lines/${lineId}/quotes/${quoteId}`, {
    method: "DELETE",
  }));
}

// ── Compliance checklist ────────────────────────────────────────────────────

export interface ComplianceDraft {
  requirement_code: string;
  status?: CostingComplianceStatus;
  notes?: string | null;
  attachment_url?: string | null;
  completed_at?: string | null;
}

export async function listCompliance(lineId: string): Promise<CostingLineCompliance[]> {
  return json<CostingLineCompliance[]>(await fetch(`/api/internal/costing/lines/${lineId}/compliance`));
}

export async function createCompliance(lineId: string, draft: ComplianceDraft): Promise<CostingLineCompliance> {
  return json<CostingLineCompliance>(await fetch(`/api/internal/costing/lines/${lineId}/compliance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  }));
}

export async function updateCompliance(lineId: string, reqId: string, patch: Partial<ComplianceDraft>): Promise<CostingLineCompliance> {
  return json<CostingLineCompliance>(await fetch(`/api/internal/costing/lines/${lineId}/compliance/${reqId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteCompliance(lineId: string, reqId: string): Promise<void> {
  return json<void>(await fetch(`/api/internal/costing/lines/${lineId}/compliance/${reqId}`, {
    method: "DELETE",
  }));
}

export async function selectQuote(lineId: string, quoteId: string): Promise<{
  line: CostingLine;
  selected_quote_id: string;
}> {
  return json<{ line: CostingLine; selected_quote_id: string }>(await fetch(
    `/api/internal/costing/lines/${lineId}/select-quote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote_id: quoteId }),
    },
  ));
}

// ── Autocomplete searches ───────────────────────────────────────────────────

export interface StyleHit {
  id: string;
  entity_id: string;
  style_code: string | null;
  style_name: string | null;
  description: string | null;
  gender_code: string | null;
  category_id: string | null;
  season: string | null;
  base_fabric: string | null;
  lifecycle_status: string | null;
}

export interface VendorHit {
  id: string;
  code: string | null;
  legal_name: string | null;
  country: string | null;
  default_currency: string | null;
  status: string | null;
}

export interface FabricHit {
  id: string;
  code: string | null;
  name: string | null;
  composition_text: string | null;
}

export async function searchStyles(q: string, signal?: AbortSignal): Promise<StyleHit[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  const res = await fetch(`/api/internal/costing/search/styles?${sp.toString()}`, { signal });
  const out = await json<{ rows: StyleHit[] }>(res);
  return out.rows || [];
}

export async function searchVendors(q: string, signal?: AbortSignal): Promise<VendorHit[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  const res = await fetch(`/api/internal/costing/search/vendors?${sp.toString()}`, { signal });
  const out = await json<{ rows: VendorHit[] }>(res);
  return out.rows || [];
}

export async function searchFabrics(q: string, signal?: AbortSignal): Promise<FabricHit[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  const res = await fetch(`/api/internal/costing/search/fabrics?${sp.toString()}`, { signal });
  const out = await json<{ rows: FabricHit[] }>(res);
  return out.rows || [];
}

export async function searchColors(q: string, signal?: AbortSignal): Promise<string[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  const res = await fetch(`/api/internal/costing/search/colors?${sp.toString()}`, { signal });
  const out = await json<{ rows: string[] }>(res);
  return out.rows || [];
}

export async function addVendor(name: string, opts?: { code?: string; country?: string }): Promise<VendorHit> {
  return json<VendorHit>(await fetch(`/api/internal/costing/add-vendor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...opts }),
  }));
}

// ── Style → SKU / target-cost seed helper ───────────────────────────────────
//
// Given a style code, returns a representative SKU + its avg cost (from
// ip_item_avg_cost). Used by the style picker to seed target_cost on the new
// row via resolveCost(). This is a small Supabase REST fetch — the costing
// frontend is otherwise REST-only, so this matches the rest of the chunk.
//
// NOTE: We rely on PostgREST being publicly reachable via VITE_SUPABASE_URL
// (the same channel the rest of the app uses for read queries). If the
// environment locks that down later, this can switch to a dedicated
// /api/internal/costing/style/:code/cost-seed handler in a follow-up.

export interface StyleSkuSeed {
  sku_code: string;
  avg_cost: number | null;
}

export async function fetchStyleSeedSku(styleCode: string): Promise<StyleSkuSeed | null> {
  try {
    const SB_URL = (typeof import.meta !== "undefined" && (import.meta as { env?: { VITE_SUPABASE_URL?: string } }).env?.VITE_SUPABASE_URL) || "";
    const SB_ANON = (typeof import.meta !== "undefined" && (import.meta as { env?: { VITE_SUPABASE_ANON_KEY?: string } }).env?.VITE_SUPABASE_ANON_KEY) || "";
    if (!SB_URL) return null;
    const headers: Record<string, string> = {};
    if (SB_ANON) {
      headers.apikey = SB_ANON;
      headers.Authorization = `Bearer ${SB_ANON}`;
    }
    // Pull first SKU under this style + its avg cost (LEFT JOIN equivalent).
    const url = `${SB_URL}/rest/v1/ip_item_master?style_code=eq.${encodeURIComponent(styleCode)}&select=sku_code&limit=1`;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ sku_code: string | null }>;
    const sku = rows[0]?.sku_code;
    if (!sku) return null;

    const cUrl = `${SB_URL}/rest/v1/ip_item_avg_cost?sku_code=eq.${encodeURIComponent(sku)}&select=avg_cost&limit=1`;
    const cr = await fetch(cUrl, { headers });
    if (!cr.ok) return { sku_code: sku, avg_cost: null };
    const crows = (await cr.json()) as Array<{ avg_cost: number | null }>;
    const avg = crows[0]?.avg_cost ?? null;
    return { sku_code: sku, avg_cost: typeof avg === "number" ? avg : (avg ? Number(avg) : null) };
  } catch {
    return null;
  }
}
