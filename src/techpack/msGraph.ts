// Thin MS Graph REST helpers for the TechPack app. Wraps the
// fetch + token + 401-handling that was duplicated across tpGraph
// and tpGraphPost inside TechPack.tsx.
//
// The caller passes a GraphSession with two callbacks: how to get
// (or refresh) the bearer token, and what to do when Graph returns
// 401 (clear local tokens + reset the panel display name). This
// keeps the helper pure JS while letting React state setters live
// in the component.

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface GraphSession {
  /** Returns a current Graph bearer token (refresh if needed). */
  getToken: () => Promise<string>;
  /** Invoked on 401 — caller should clear local tokens + reset UI state. */
  onSessionExpired: () => void;
}

/** Generic Graph request. Throws on 401 (after invoking the session
 *  expiry handler) and on any other non-2xx with the response text. */
async function graphFetch(
  path: string,
  init: RequestInit,
  session: GraphSession,
): Promise<any> {
  const tok = await session.getToken();
  const r = await fetch(GRAPH_BASE + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + tok,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (r.status === 401) {
    session.onSessionExpired();
    throw new Error("Session expired");
  }
  if (!r.ok) {
    throw new Error("Graph " + r.status + ": " + await r.text());
  }
  return r.json();
}

export function graphGet(path: string, session: GraphSession): Promise<any> {
  return graphFetch(path, { method: "GET" }, session);
}

export function graphPost(path: string, body: unknown, session: GraphSession): Promise<any> {
  return graphFetch(path, { method: "POST", body: JSON.stringify(body) }, session);
}
