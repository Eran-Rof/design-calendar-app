// ─── Microsoft OAuth2 PKCE helper ──────────────────────────────────────────
// Reads Azure credentials from Vite env vars set in Vercel + .env
export const MS_CLIENT_ID = (import.meta.env.VITE_AZURE_CLIENT_ID as string) || "";
export const MS_TENANT_ID = (import.meta.env.VITE_AZURE_TENANT_ID as string) || "";
export const MS_REDIRECT = window.location.origin + "/auth-callback";

export const MS_SCOPES = [
  "https://graph.microsoft.com/Channel.Create",
  "https://graph.microsoft.com/Channel.ReadBasic.All",
  "https://graph.microsoft.com/ChannelMessage.Read.All",
  "https://graph.microsoft.com/ChannelMessage.Send",
  "https://graph.microsoft.com/Chat.Create",
  "https://graph.microsoft.com/Chat.ReadWrite",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/People.Read",
  "https://graph.microsoft.com/Team.ReadBasic.All",
  "https://graph.microsoft.com/TeamMember.Read.All",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/User.ReadBasic.All",
  "offline_access",
].join(" ");

export interface MsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const LS_KEY = "ms_tokens_v1";

export function saveMsTokens(tokens: MsTokens): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(tokens)); } catch (_) {}
}

export function loadMsTokens(): MsTokens | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as MsTokens;
    if (!t.accessToken) return null;
    return t;
  } catch (_) { return null; }
}

export function clearMsTokens(): void {
  try { localStorage.removeItem(LS_KEY); } catch (_) {}
}

// Returns a valid access token, auto-refreshing if within 2 minutes of expiry.
// Returns null if not signed in.
export async function getMsAccessToken(): Promise<string | null> {
  const stored = loadMsTokens();
  if (!stored) return null;
  // If expires within 2 minutes, try to refresh
  if (stored.expiresAt - Date.now() < 2 * 60 * 1000) {
    if (!stored.refreshToken) { clearMsTokens(); return null; }
    try {
      const fresh = await msRefreshTokens(stored.refreshToken);
      saveMsTokens(fresh);
      return fresh.accessToken;
    } catch (_) {
      clearMsTokens();
      return null;
    }
  }
  return stored.accessToken;
}

async function genVerifier(): Promise<string> {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function genChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Open a popup to sign in and get an authorization code, then exchange it for tokens.
export async function msSignIn(loginHint?: string): Promise<MsTokens> {
  if (!MS_CLIENT_ID || !MS_TENANT_ID) throw new Error("Azure credentials not configured (check VITE_AZURE_CLIENT_ID / VITE_AZURE_TENANT_ID env vars)");

  const verifier = await genVerifier();
  const challenge = await genChallenge(verifier);

  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: MS_REDIRECT,
    scope: MS_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_mode: "query",
    ...(loginHint ? { login_hint: loginHint, prompt: "consent" } : { prompt: "consent" }),
  });

  const authUrl = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize?${params}`;
  const popup = window.open(authUrl, "msauth", "width=500,height=700,left=400,top=100");
  if (!popup) throw new Error("Popup blocked — please allow popups for this site");

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        if ((popup as any).closed) { clearInterval(timer); reject(new Error("Popup closed")); return; }
        const url = (popup as any).location.href || "";
        if (url.includes("/auth-callback") && (url.includes("code=") || url.includes("error="))) {
          clearInterval(timer);
          (popup as any).close();
          const parsed = new URL(url);
          const errMsg = parsed.searchParams.get("error_description") || parsed.searchParams.get("error");
          if (errMsg) { reject(new Error(errMsg)); return; }
          const code = parsed.searchParams.get("code");
          if (code) resolve(code); else reject(new Error("No code in callback URL"));
        }
      } catch (_) { /* cross-origin during navigation — ignore */ }
    }, 300);
    setTimeout(() => {
      clearInterval(timer);
      if (!(popup as any).closed) (popup as any).close();
      reject(new Error("Sign-in timed out (2 min)"));
    }, 120000);
  });

  const tokens = await exchangeCode(code, verifier);
  saveMsTokens(tokens);
  return tokens;
}

async function exchangeCode(code: string, verifier: string): Promise<MsTokens> {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: MS_REDIRECT,
    code_verifier: verifier,
    scope: MS_SCOPES,
  });
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || `Token exchange failed (${res.status})`);
  }
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

// Exchange a refresh token for a new access token + refresh token.
export async function msRefreshTokens(refreshToken: string): Promise<MsTokens> {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: MS_SCOPES,
  });
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || `Token refresh failed (${res.status})`);
  }
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}
