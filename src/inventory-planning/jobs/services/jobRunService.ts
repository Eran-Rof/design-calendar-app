// Generic job tracker. Any service can call startJob / succeed / fail /
// partialSuccess. The admin dashboard reads recent rows.
//
// Retries: retrying inserts a NEW row with retry_of pointing at the
// failed one. Retry_count on the new row increments. No automatic
// retries — the planner clicks.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type { IpJobRun, IpJobStatus } from "../types/jobs";

async function sbGet<T>(path: string): Promise<T[]> {
  if (!SB_URL) return [];
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbPost<T>(path: string, body: unknown, prefer = "return=representation"): Promise<T[]> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} failed: ${r.status} ${await r.text()}`);
  return prefer.includes("return=minimal") ? ([] as T[]) : r.json();
}
async function sbPatch<T>(path: string, body: unknown): Promise<T[]> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ── State machine ────────────────────────────────────────────────────────
const TRANSITIONS: Record<IpJobStatus, IpJobStatus[]> = {
  queued:          ["running", "cancelled"],
  running:         ["succeeded", "failed", "partial_success", "cancelled"],
  succeeded:       [],
  failed:          [],
  cancelled:       [],
  partial_success: [],
};

export function canJobTransition(from: IpJobStatus, to: IpJobStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Public API ───────────────────────────────────────────────────────────
export async function listRecentJobs(filter?: {
  status?: IpJobStatus; job_type?: string; limit?: number;
}): Promise<IpJobRun[]> {
  const params: string[] = ["select=*", "order=created_at.desc"];
  if (filter?.status) params.push(`status=eq.${filter.status}`);
  if (filter?.job_type) params.push(`job_type=eq.${filter.job_type}`);
  params.push(`limit=${filter?.limit ?? 200}`);
  return sbGet<IpJobRun>(`ip_job_runs?${params.join("&")}`);
}

export async function getJob(id: string): Promise<IpJobRun | null> {
  const r = await sbGet<IpJobRun>(`ip_job_runs?select=*&id=eq.${id}`);
  return r[0] ?? null;
}

export async function startJob(args: {
  job_type: string;
  job_scope?: string | null;
  initiated_by?: string | null;
  input?: Record<string, unknown>;
}): Promise<IpJobRun> {
  const [created] = await sbPost<IpJobRun>("ip_job_runs", [{
    job_type: args.job_type,
    job_scope: args.job_scope ?? null,
    status: "running",
    started_at: new Date().toISOString(),
    initiated_by: args.initiated_by ?? null,
    input_json: args.input ?? {},
    retry_count: 0,
  }]);
  return created;
}

export async function succeed(jobId: string, output: Record<string, unknown> = {}): Promise<IpJobRun> {
  const [u] = await sbPatch<IpJobRun>(`ip_job_runs?id=eq.${jobId}`, {
    status: "succeeded",
    completed_at: new Date().toISOString(),
    output_json: output,
    error_message: null,
  });
  return u;
}

export async function fail(jobId: string, errorMessage: string, output: Record<string, unknown> = {}): Promise<IpJobRun> {
  const [u] = await sbPatch<IpJobRun>(`ip_job_runs?id=eq.${jobId}`, {
    status: "failed",
    completed_at: new Date().toISOString(),
    output_json: output,
    error_message: errorMessage,
  });
  return u;
}

export async function partialSuccess(jobId: string, output: Record<string, unknown>, note: string): Promise<IpJobRun> {
  const [u] = await sbPatch<IpJobRun>(`ip_job_runs?id=eq.${jobId}`, {
    status: "partial_success",
    completed_at: new Date().toISOString(),
    output_json: output,
    error_message: note,
  });
  return u;
}

export async function cancel(jobId: string): Promise<IpJobRun> {
  const [u] = await sbPatch<IpJobRun>(`ip_job_runs?id=eq.${jobId}`, {
    status: "cancelled",
    completed_at: new Date().toISOString(),
  });
  return u;
}

// Retry — inserts a NEW row that references the failed one.
export async function retry(job: IpJobRun, initiated_by?: string | null): Promise<IpJobRun> {
  const [created] = await sbPost<IpJobRun>("ip_job_runs", [{
    job_type: job.job_type,
    job_scope: job.job_scope,
    status: "queued",
    started_at: null,
    initiated_by: initiated_by ?? job.initiated_by,
    input_json: job.input_json,
    retry_count: (job.retry_count ?? 0) + 1,
    retry_of: job.id,
  }]);
  return created;
}

// Convenience: wrap an async fn in a job row. Auto-succeeds / auto-fails.
export async function withJob<T>(
  args: { job_type: string; job_scope?: string | null; initiated_by?: string | null; input?: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const job = await startJob(args);
  try {
    const out = await fn();
    await succeed(job.id, { result: summarizeForAudit(out) });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await fail(job.id, msg);
    throw e;
  }
}

function summarizeForAudit(x: unknown): unknown {
  if (x == null) return null;
  if (typeof x === "number" || typeof x === "string" || typeof x === "boolean") return x;
  if (Array.isArray(x)) return { length: x.length };
  if (typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
      else if (Array.isArray(v)) out[k] = { length: v.length };
    }
    return out;
  }
  return String(x);
}
