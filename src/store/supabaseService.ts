/**
 * Pure Supabase I/O functions — no React, no hooks, no closures.
 * Used by the Zustand store and can be called from anywhere.
 */
import { SB_URL, SB_KEY } from "../utils/supabase";

const HEADERS = {
  "apikey": SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};
const HEADERS_READ = { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` };
const UPSERT_PREFER = { ...HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" };

// ── Key-value store (app_data table) ──────────────────────────────────────

export async function sbSave(key: string, value: any): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/app_data`, {
    method: "POST",
    headers: UPSERT_PREFER,
    body: JSON.stringify({ key, value: JSON.stringify(value) }),
  });
  if (!res.ok) throw new Error(`sbSave("${key}") HTTP ${res.status}`);
}

export async function sbLoad(key: string): Promise<any> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.${key}&select=value`, {
      headers: HEADERS_READ,
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows.length ? JSON.parse(rows[0].value) : null;
  } catch { return null; }
}

// ── Tasks (individual row operations) ─────────────────────────────────────

export async function sbSaveTask(task: any, currentUserName: string): Promise<void> {
  // Conflict check
  const checkRes = await fetch(`${SB_URL}/rest/v1/tasks?id=eq.${task.id}&select=data`, {
    headers: HEADERS_READ,
  });
  if (checkRes.ok) {
    const rows = await checkRes.json();
    if (rows.length > 0) {
      const serverTask = rows[0].data;
      if (serverTask?.updatedAt && task.updatedAt && serverTask.updatedAt !== task.updatedAt && serverTask.updatedBy !== currentUserName) {
        console.warn(`[SB] Conflict on task ${task.id}: server=${serverTask.updatedAt} local=${task.updatedAt}`);
      }
    }
  }
  const res = await fetch(`${SB_URL}/rest/v1/tasks`, {
    method: "POST",
    headers: UPSERT_PREFER,
    body: JSON.stringify({ id: task.id, data: { ...task, updatedAt: new Date().toISOString(), updatedBy: currentUserName } }),
  });
  if (!res.ok) throw new Error(`sbSaveTask(${task.id}) HTTP ${res.status}`);
}

export async function sbDeleteTask(id: string): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/tasks?id=eq.${id}`, {
    method: "DELETE",
    headers: HEADERS_READ,
  });
  if (!res.ok) throw new Error(`sbDeleteTask(${id}) HTTP ${res.status}`);
}

export async function sbLoadTasks(): Promise<any[] | null> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/tasks?select=data`, { headers: HEADERS_READ });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows.map((r: any) => r.data);
  } catch { return null; }
}

// ── Collections ───────────────────────────────────────────────────────────

export async function sbSaveCollection(key: string, data: any, currentUserName: string): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/collections`, {
    method: "POST",
    headers: UPSERT_PREFER,
    body: JSON.stringify({ id: key, data: { ...data, _updatedAt: new Date().toISOString(), _updatedBy: currentUserName } }),
  });
  if (!res.ok) throw new Error(`sbSaveCollection("${key}") HTTP ${res.status}`);
}

export async function sbLoadCollections(): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/collections?select=id,data`, { headers: HEADERS_READ });
    if (!res.ok) return null;
    const rows = await res.json();
    const obj: Record<string, any> = {};
    rows.forEach((r: any) => { obj[r.id] = r.data; });
    return obj;
  } catch { return null; }
}
