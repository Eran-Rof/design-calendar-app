import { useEffect } from "react";
import { msSignIn, getMsAccessToken, clearMsTokens, MS_CLIENT_ID, MS_TENANT_ID } from "../../utils/msAuth";

interface UseMSAuthOpts {
  msToken: string | null;
  setMsToken: (v: string | null) => void;
  msDisplayName: string;
  setMsDisplayName: (v: string) => void;
  teamsAuthStatus: "idle" | "loading" | "error";
  setTeamsAuthStatus: (v: "idle" | "loading" | "error") => void;
}

export function useMSAuth(opts: UseMSAuthOpts) {
  const { msToken, setMsToken, setMsDisplayName, setTeamsAuthStatus } = opts;

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

  function emailTokenIsValid() { return !!msToken; }

  function handleEmailTokenExpired() {
    clearMsTokens();
    setMsToken(null);
    setMsDisplayName("");
  }

  async function authenticateMS() {
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
  }

  async function getGraphToken(): Promise<string> {
    const tok = await getMsAccessToken();
    if (tok) { if (tok !== msToken) setMsToken(tok); return tok; }
    if (msToken) return msToken;
    throw new Error("Not signed in to Microsoft");
  }

  async function graphGet(path: string, extraHeaders?: Record<string, string>) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, {
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json", ...extraHeaders },
    });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }

  async function graphPost(path: string, body: any) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }

  function msSignOut() {
    clearMsTokens();
    setMsToken(null);
    setMsDisplayName("");
    setTeamsAuthStatus("idle");
  }

  return {
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

export function friendlyContactError(e: any): string {
  const msg: string = e?.message || "";
  if (msg.includes("403") || msg.toLowerCase().includes("insufficient")) return "Permission denied — sign out and sign back in";
  if (msg.includes("401") || msg.toLowerCase().includes("expired")) return "Session expired — sign out and sign back in";
  if (msg.includes("404")) return "Contacts not available on this account";
  return "Could not load contacts — sign out and sign back in";
}
