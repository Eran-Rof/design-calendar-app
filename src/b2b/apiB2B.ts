import { supabaseB2B } from "./supabaseB2B";

// Token-attaching fetch for the B2B portal. Pulls the buyer's CURRENT Supabase
// access token from the dedicated /b2b GoTrue client (the same session B2BApp
// authorized) and sends it as `Authorization: Bearer <jwt>` — exactly what every
// /api/b2b/* endpoint expects for resolveB2BSession(). Never sends a customer_id;
// the server derives it from the verified session.
export async function apiB2B<T>(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const { data } = await supabaseB2B.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired. Please sign in again.");

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const res = await fetch(path, {
    method: init?.method || "GET",
    headers,
    body,
    signal: init?.signal,
  });

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  // 204 / empty body tolerance.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}
