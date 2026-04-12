import { useState, useEffect, useCallback } from "react";
import { msSignIn, getMsAccessToken, clearMsTokens, MS_CLIENT_ID, MS_TENANT_ID } from "../../utils/msAuth";

// Centralised Microsoft authentication for Email + Teams surfaces.
// Returns the shared access token, display name, Graph helpers, and
// the sign-in / sign-out / token-refresh flows.
export function useMSAuth() {
  const [msToken, setMsToken]               = useState<string | null>(null);
  const [msDisplayName, setMsDisplayName]   = useState("");
  const [teamsAuthStatus, setTeamsAuthStatus] = useState<"idle" | "loading" | "error">("idle");

  // On mount: restore token from localStorage
  useEffect(() => {
    (async () => {
      const tok = await getMsAccessToken();
      if (tok) {
        setMsToken(tok);
        try {
          const me = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName", { headers: { Authorization: "Bearer " + tok } });
          const meData = await me.json();
          if (meData.displayName) setMsDisplayName(meData.displayName);
        } catch {}
      }
    })();
  }, []);

  const emailTokenIsValid = useCallback(() => !!msToken, [msToken]);

  const handleEmailTokenExpired = useCallback(() => {
    clearMsTokens();
    setMsToken(null);
    setMsDisplayName("");
  }, []);

  const authenticateMS = useCallback(async () => {
    if (!MS_CLIENT_ID || !MS_TENANT_ID) return;
    setTeamsAuthStatus("loading");
    try {
      const tokens = await msSignIn();
      setMsToken(tokens.accessToken);
      setTeamsAuthStatus("idle");
      try {
        const me = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName", { headers: { Authorization: "Bearer " + tokens.accessToken } });
        const meData = await me.json();
        if (meData.displayName) setMsDisplayName(meData.displayName);
      } catch {}
    } catch (e) {
      console.error("MS auth failed:", e);
      setTeamsAuthStatus("error");
    }
  }, []);

  // Auto-refresh or fall back to current state token.
  const getGraphToken = useCallback(async (): Promise<string> => {
    const tok = await getMsAccessToken();
    if (tok) { if (tok !== msToken) setMsToken(tok); return tok; }
    if (msToken) return msToken;
    throw new Error("Not signed in to Microsoft");
  }, [msToken]);

  // Generic Graph GET/POST helpers — consumed by Teams + Email hooks.
  const graphGet = useCallback(async (path: string, extraHeaders?: Record<string, string>) => {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, {
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json", ...extraHeaders },
    });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }, [getGraphToken, handleEmailTokenExpired]);

  const graphPost = useCallback(async (path: string, body: any) => {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }, [getGraphToken, handleEmailTokenExpired]);

  const msSignOut = useCallback(() => {
    clearMsTokens();
    setMsToken(null);
    setMsDisplayName("");
    setTeamsAuthStatus("idle");
  }, []);

  return {
    msToken,
    msDisplayName,
    teamsAuthStatus,
    authenticateMS,
    authenticateEmail: authenticateMS,
    authenticateTeams: authenticateMS,
    emailTokenIsValid,
    handleEmailTokenExpired,
    getGraphToken,
    graphGet,
    graphPost,
    msSignOut,
  };
}

// Shared helper for human-readable Graph contact errors.
export function friendlyContactError(e: any): string {
  const msg: string = e?.message || "";
  if (msg.includes("403") || msg.toLowerCase().includes("insufficient")) return "Permission denied — sign out and sign back in";
  if (msg.includes("401") || msg.toLowerCase().includes("expired")) return "Session expired — sign out and sign back in";
  if (msg.includes("404")) return "Contacts not available on this account";
  return "Could not load contacts — sign out and sign back in";
}
