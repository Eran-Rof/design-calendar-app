// Client orchestrator for the planning Vendors screen. Talks to
// /api/internal/planning/vendors* (CRUD + seed) and reuses the existing
// /api/internal/planning/link-planning-vendor endpoint for linking (so the
// link mutation isn't duplicated). Auth follows the planning staff pattern:
// the x-user-email header carries identity (the server verifies it, or the
// SPA's global fetch interceptor swaps in a signed app-JWT).

import { currentUserEmail } from "../../governance/services/permissionService";
import type { PlanningVendor, SeedResult, TangerineVendorOption } from "../types/vendors";

function authHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "x-user-email": currentUserEmail() };
}

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export async function listPlanningVendors(): Promise<PlanningVendor[]> {
  const res = await fetch("/api/internal/planning/vendors", { headers: authHeaders() });
  const json = await readJson<{ vendors: PlanningVendor[] }>(res);
  return json.vendors || [];
}

export async function listTangerineVendorOptions(): Promise<TangerineVendorOption[]> {
  const res = await fetch("/api/internal/planning/vendors/tangerine-options", { headers: authHeaders() });
  const json = await readJson<{ options: TangerineVendorOption[] }>(res);
  return json.options || [];
}

export async function createPlanningVendor(args: { vendor_code: string; name: string }): Promise<PlanningVendor> {
  const res = await fetch("/api/internal/planning/vendors", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ vendor_code: args.vendor_code, name: args.name }),
  });
  const json = await readJson<{ vendor: PlanningVendor }>(res);
  return json.vendor;
}

// Update name / code / unlink. Linking goes through linkPlanningVendor (the
// dedicated endpoint) — pass portal_vendor_id: null here only to unlink.
export async function updatePlanningVendor(args: {
  id: string;
  name?: string;
  vendor_code?: string;
  portal_vendor_id?: string | null;
}): Promise<PlanningVendor> {
  const res = await fetch("/api/internal/planning/vendors", {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(args),
  });
  const json = await readJson<{ vendor: PlanningVendor }>(res);
  return json.vendor;
}

// Reuse the existing one-click link resolver (sets portal_vendor_id).
export async function linkPlanningVendor(args: { planningVendorId: string; tangerineVendorId: string }): Promise<string> {
  const res = await fetch("/api/internal/planning/link-planning-vendor", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ planning_vendor_id: args.planningVendorId, tangerine_vendor_id: args.tangerineVendorId }),
  });
  const json = await readJson<{ message: string }>(res);
  return json.message || "Linked.";
}

export async function unlinkPlanningVendor(id: string): Promise<PlanningVendor> {
  return updatePlanningVendor({ id, portal_vendor_id: null });
}

export async function seedFromTangerine(): Promise<SeedResult> {
  const res = await fetch("/api/internal/planning/vendors/seed", {
    method: "POST",
    headers: authHeaders(),
    body: "{}",
  });
  const json = await readJson<SeedResult>(res);
  return {
    created: json.created ?? 0,
    skipped: json.skipped ?? 0,
    vendors: json.vendors || [],
    message: json.message || "",
  };
}
