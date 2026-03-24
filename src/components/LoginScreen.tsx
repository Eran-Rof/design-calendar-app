import React, { useState } from "react";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";
import { ROFLogoFull } from "../utils/styles";

function LoginScreen({ users, onLogin, teamsConfig, onTeamsToken }: {
  users: any[];
  onLogin: (user: any) => void;
  teamsConfig: any;
  onTeamsToken: (token: string) => void;
}) {
  const [username, setUsername] = useState(() => {
    try { return localStorage.getItem("last_username") || ""; } catch { return ""; }
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [teamsAuthStatus, setTeamsAuthStatus] = useState("idle"); // idle|loading|ok|skipped

  async function doTeamsAuth(user: any) {
    const cfg = teamsConfig;
    if (!cfg || !cfg.clientId || !cfg.tenantId || !user.teamsEmail) {
      onLogin(user);
      return;
    }
    setTeamsAuthStatus("loading");
    try {
      const scopes = [
        "https://graph.microsoft.com/ChannelMessage.Read.All",
        "https://graph.microsoft.com/Team.ReadBasic.All",
        "https://graph.microsoft.com/Channel.ReadBasic.All",
        "https://graph.microsoft.com/ChannelMessage.Send",
        "https://graph.microsoft.com/Mail.Read",
        "https://graph.microsoft.com/Mail.Send",
      ];
      const authUrl =
        "https://login.microsoftonline.com/" + cfg.tenantId + "/oauth2/v2.0/authorize?" +
        "client_id=" + cfg.clientId +
        "&response_type=token" +
        "&redirect_uri=" + encodeURIComponent(window.location.origin + "/auth-callback") +
        "&scope=" + encodeURIComponent(scopes.join(" ")) +
        "&login_hint=" + encodeURIComponent(user.teamsEmail) +
        "&response_mode=fragment";
      const popup = window.open(authUrl, "msauth", "width=500,height=700,left=400,top=100");
      const token = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          try {
            if ((popup as any).closed) { clearInterval(timer); reject(new Error("Closed")); return; }
            const hash = (popup as any).location.hash;
            if (hash && hash.includes("access_token")) {
              clearInterval(timer); (popup as any).close();
              resolve(new URLSearchParams(hash.substring(1)).get("access_token") as string);
            }
          } catch (_) {}
        }, 300);
        setTimeout(() => { clearInterval(timer); if (!(popup as any).closed) (popup as any).close(); reject(new Error("Timeout")); }, 120000);
      });
      onTeamsToken(token);
      setTeamsAuthStatus("ok");
    } catch (e) {
      setTeamsAuthStatus("skipped");
    }
    onLogin(user);
  }

  function handleLogin() {
    const allUsers = users;
    const user = allUsers.find(
      (u: any) =>
        u.username.toLowerCase() === username.trim().toLowerCase() && u.password === password
    );
    if (user) {
      setError("");
      try { localStorage.setItem("last_username", username.trim()); localStorage.setItem("plm_last_user", username.trim()); } catch {}
      doTeamsAuth(user);
    } else setError("Invalid username or password.");
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: TH.header,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'DM Sans',sans-serif",
      }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;}`}</style>
      <div style={{ width: "100%", maxWidth: 400, padding: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <ROFLogoFull height={52} />
          </div>
          <div
            style={{
              marginTop: 14,
              fontSize: 20,
              fontWeight: 800,
              color: "#fff",
              letterSpacing: "-0.01em",
            }}
          >
            Design Calendar
          </div>
          <div
            style={{
              fontSize: 12,
              color: "rgba(255,255,255,0.4)",
              marginTop: 4,
            }}
          >
            Sign In to Continue
          </div>
        </div>
        <div
          style={{
            background: TH.surface,
            borderRadius: 16,
            padding: 32,
            boxShadow: `0 20px 60px rgba(0,0,0,0.35)`,
          }}
        >
          <div style={{ marginBottom: 18 }}>
            <label style={S.lbl}>Username</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              placeholder="Enter username"
              autoFocus
            />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={S.lbl}>Password</label>
            <div style={{ position: "relative" }}>
              <input
                type={showPassword ? "text" : "password"}
                style={{ ...S.inp, marginBottom: 0, paddingRight: 40 }}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                placeholder="Enter password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                style={{
                  position: "absolute",
                  right: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 4,
                  color: TH.textMuted,
                  fontSize: 16,
                  lineHeight: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                tabIndex={-1}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "🙈" : "👁"}
              </button>
            </div>
          </div>
          {error && (
            <div
              style={{
                padding: "8px 12px",
                background: "#FEF2F2",
                border: "1px solid #FCA5A5",
                borderRadius: 8,
                color: "#B91C1C",
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}
          {teamsAuthStatus === "loading" && (
            <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "#1E40AF" }}>
              <span style={{ fontSize: 16 }}>💬</span>
              <span>Signing in to Microsoft Teams… <b>Please complete the popup.</b></span>
            </div>
          )}
          <button
            onClick={handleLogin}
            disabled={teamsAuthStatus === "loading"}
            style={{ ...S.btn, width: "100%", padding: "12px", fontSize: 15, opacity: teamsAuthStatus === "loading" ? 0.6 : 1 }}
          >
            {teamsAuthStatus === "loading" ? "Signing in…" : "Sign In →"}
          </button>
          {teamsConfig && teamsConfig.clientId && (
            <div style={{ marginTop: 12, textAlign: "center", fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
              💬 Microsoft Teams will be connected automatically
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default LoginScreen;
