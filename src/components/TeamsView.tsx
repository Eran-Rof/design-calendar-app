import React, { useState, useEffect, useRef } from "react";
import { TEAMS_PURPLE, TEAMS_PURPLE_LT } from "../utils/theme";
import { msSignIn, msRefreshTokens, MS_CLIENT_ID, MS_TENANT_ID } from "../utils/msAuth";

const SB_URL = "https://qcvqvxxoperiurauoxmp.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdnF2eHhvcGVyaXVyYXVveG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODU4MjksImV4cCI6MjA4OTI2MTgyOX0.YoBmIdlqqPYt9roTsDPGSBegNnoupCYSsnyCHMo24Zw";

async function sbSave(key: string, value: any) {
  await fetch(`${SB_URL}/rest/v1/app_data`, {
    method: "POST",
    headers: {
      "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, value: JSON.stringify(value) }),
  });
}

async function sbLoad(key: string) {
  const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.${key}&select=value`, {
    headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
  });
  const rows = await res.json();
  return rows?.length ? JSON.parse(rows[0].value) : null;
}

// ─── MICROSOFT TEAMS VIEW ─────────────────────────────────────────────────────
function TeamsView({ collList, collMap, isAdmin, teamsToken, setTeamsToken, getBrand, currentUser }: {
  collList: any[];
  collMap: any;
  isAdmin: boolean;
  teamsToken: string | null;
  setTeamsToken: (t: string | null) => void;
  getBrand: (id: string) => any;
  currentUser: any;
}) {
  const [selectedCollKey, setSelectedCollKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [newMsg, setNewMsg] = useState("");
  const [authStatus, setAuthStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [authError, setAuthError] = useState("");
  const [teamsTab, setTeamsTab] = useState<"channels" | "direct">("channels");
  const [channelMap, setChannelMap] = useState<Record<string, { channelId: string; teamId: string }>>({});
  const [teamId, setTeamId] = useState("");
  const [creatingChannel, setCreatingChannel] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState(0);
  const [teamsDirectTo, setTeamsDirectTo] = useState("");
  const [teamsDirectMsg, setTeamsDirectMsg] = useState("");
  const [teamsDirectSending, setTeamsDirectSending] = useState(false);
  const [teamsDirectErr, setTeamsDirectErr] = useState<string | null>(null);
  const [dmChatId, setDmChatId] = useState<string | null>(null);
  const [dmRecipient, setDmRecipient] = useState("");
  const [dmMessages, setDmMessages] = useState<any[]>([]);
  const [dmLoading, setDmLoading] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  const [dmNewMsg, setDmNewMsg] = useState("");
  const [dmSending, setDmSending] = useState(false);
  const [contacts, setContacts] = useState<any[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [contactDropdown, setContactDropdown] = useState(false);
  const dmScrollRef = useRef<HTMLDivElement>(null);
  const refreshingRef = useRef(false);

  const token = teamsToken;
  const configured = !!MS_CLIENT_ID && !!MS_TENANT_ID;

  // ── Load channel map + team ID from Supabase on mount ──────────────────
  useEffect(() => {
    async function load() {
      try {
        const [cm, tid] = await Promise.all([
          sbLoad("teams_channel_map"),
          sbLoad("teams_team_id"),
        ]);
        if (cm) setChannelMap(cm);
        if (tid) setTeamId(tid);
      } catch(e) { console.error("Teams: load error", e); }
    }
    load();
  }, []);

  // ── Silently refresh token ~5 min before expiry ─────────────────────────
  useEffect(() => {
    if (!tokenExpiry || !token) return;
    const msUntilExpiry = tokenExpiry - Date.now();
    if (msUntilExpiry < 0) return;
    const refreshIn = Math.max(msUntilExpiry - 5 * 60 * 1000, 0);
    const t = setTimeout(async () => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      try {
        const key = refreshTokenKey(currentUser);
        if (!key) return;
        const rt = await sbLoad(key);
        if (!rt) return;
        const tokens = await msRefreshTokens(rt);
        setTeamsToken(tokens.accessToken);
        setTokenExpiry(tokens.expiresAt);
        await sbSave(key, tokens.refreshToken);
      } catch(e) { console.warn("Teams: silent refresh failed", e); }
      refreshingRef.current = false;
    }, refreshIn);
    return () => clearTimeout(t);
  }, [tokenExpiry, token]);

  // ── Load contacts when token becomes available ───────────────────────────
  useEffect(() => {
    if (token && contacts.length === 0 && !contactsLoading) loadContacts();
  }, [token]);

  // ── Load messages when selection changes ────────────────────────────────
  useEffect(() => {
    if (selectedCollKey && token && channelMap[selectedCollKey]) {
      loadMessages(selectedCollKey);
    }
  }, [selectedCollKey, token]);

  function refreshTokenKey(user: any) {
    if (!user?.name) return null;
    return `ms_refresh_${user.name.toLowerCase().replace(/\s+/g, "_")}`;
  }

  // ── Sign in via PKCE popup ───────────────────────────────────────────────
  async function authenticate() {
    if (!configured) { setAuthStatus("error"); setAuthError("Azure credentials not configured"); return; }
    setAuthStatus("loading");
    setAuthError("");
    try {
      const tokens = await msSignIn(currentUser?.teamsEmail || undefined);
      setTeamsToken(tokens.accessToken);
      setTokenExpiry(tokens.expiresAt);
      const key = refreshTokenKey(currentUser);
      if (key && tokens.refreshToken) await sbSave(key, tokens.refreshToken);
      setAuthStatus("ok");
    } catch(e: any) {
      console.error("Teams auth error:", e);
      setAuthError(e.message || "Sign-in failed");
      setAuthStatus("error");
    }
  }

  function signOut() {
    setTeamsToken(null);
    setTokenExpiry(0);
    setAuthStatus("idle");
    setAuthError("");
  }

  // ── Microsoft Graph helpers ──────────────────────────────────────────────
  async function graph(path: string) {
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, {
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Graph ${r.status}: ${body}`);
    }
    return r.json();
  }

  async function graphPost(path: string, body: any) {
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Graph ${r.status}: ${txt}`);
    }
    return r.json();
  }

  // ── Find RING OF FIRE team ───────────────────────────────────────────────
  async function findRofTeam(): Promise<string> {
    if (teamId) return teamId;
    const data = await graph("/me/joinedTeams");
    const rofTeam = (data.value || []).find((t: any) =>
      t.displayName?.toLowerCase().replace(/\s+/g, "").includes("ringoffire")
    );
    if (!rofTeam) throw new Error('Could not find "RING OF FIRE" in your joined Teams. Make sure your Microsoft account is a member of that team.');
    await sbSave("teams_team_id", rofTeam.id);
    setTeamId(rofTeam.id);
    return rofTeam.id as string;
  }

  // ── Auto-create / find channel then load messages ────────────────────────
  async function startChat(collKey: string) {
    setCreatingChannel(collKey);
    setErrors(e => ({ ...e, [collKey]: null }));
    try {
      const tid = await findRofTeam();
      const coll = collMap[collKey];
      const slug = (coll?.collection || collKey)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
      const chName = `dc-${slug}`;

      let channelId = "";
      try {
        const channels = await graph(`/teams/${tid}/channels`);
        const existing = (channels.value || []).find((c: any) => c.displayName === chName);
        if (existing) channelId = existing.id;
      } catch(_) {}

      if (!channelId) {
        const ch = await graphPost(`/teams/${tid}/channels`, {
          displayName: chName,
          description: `Design Calendar — ${coll?.collection || collKey}${coll?.season ? " · " + coll.season : ""}`,
          membershipType: "standard",
        });
        channelId = ch.id;
      }

      const newMap = { ...channelMap, [collKey]: { channelId, teamId: tid } };
      setChannelMap(newMap);
      await sbSave("teams_channel_map", newMap);
      await loadMessages(collKey, { channelId, teamId: tid });
    } catch(e: any) {
      setErrors(err => ({ ...err, [collKey]: e.message }));
    }
    setCreatingChannel(null);
  }

  async function loadMessages(collKey: string, mp?: { channelId: string; teamId: string }) {
    const mapping = mp || channelMap[collKey];
    if (!mapping || !token) return;
    setLoading(l => ({ ...l, [collKey]: true }));
    setErrors(e => ({ ...e, [collKey]: null }));
    try {
      const d = await graph(`/teams/${mapping.teamId}/channels/${mapping.channelId}/messages?$top=50`);
      setMessages(m => ({ ...m, [collKey]: (d.value || []).filter((m: any) => m.messageType === "message") }));
    } catch(e: any) {
      setErrors(err => ({ ...err, [collKey]: e.message }));
    }
    setLoading(l => ({ ...l, [collKey]: false }));
  }

  async function sendMessage(collKey: string) {
    const mp = channelMap[collKey];
    if (!mp || !newMsg.trim() || !token) return;
    try {
      const sent = await graphPost(`/teams/${mp.teamId}/channels/${mp.channelId}/messages`, {
        body: { content: newMsg.trim(), contentType: "text" },
      });
      setMessages(m => ({ ...m, [collKey]: [sent, ...(m[collKey] || [])] }));
      setNewMsg("");
    } catch(e: any) { alert("Failed to send: " + e.message); }
  }

  async function loadDmMessages(chatId: string) {
    setDmLoading(true);
    setDmError(null);
    try {
      const d = await graph(`/chats/${chatId}/messages?$top=50`);
      const msgs = ((d.value || []) as any[]).filter(m => m.messageType === "message").reverse();
      setDmMessages(msgs);
      setTimeout(() => { if (dmScrollRef.current) dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight; }, 50);
    } catch(e: any) {
      setDmError("Could not load messages: " + e.message);
    }
    setDmLoading(false);
  }

  async function teamsSendDirect() {
    if (!teamsDirectTo.trim() || !teamsDirectMsg.trim()) return;
    setTeamsDirectSending(true);
    setTeamsDirectErr(null);
    try {
      const me = await graph("/me");
      const chat = await graphPost("/chats", {
        chatType: "oneOnOne",
        members: [
          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${me.id}')` },
          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${teamsDirectTo.trim()}')` },
        ],
      });
      await graphPost(`/chats/${chat.id}/messages`, { body: { content: teamsDirectMsg.trim(), contentType: "text" } });
      setDmChatId(chat.id);
      setDmRecipient(teamsDirectTo.trim());
      setTeamsDirectMsg("");
      await loadDmMessages(chat.id);
    } catch(e: any) {
      setTeamsDirectErr("Failed to send: " + e.message);
    }
    setTeamsDirectSending(false);
  }

  async function sendDmReply() {
    if (!dmChatId || !dmNewMsg.trim()) return;
    setDmSending(true);
    setDmError(null);
    try {
      const sent = await graphPost(`/chats/${dmChatId}/messages`, { body: { content: dmNewMsg.trim(), contentType: "text" } });
      setDmMessages(prev => [...prev, sent]);
      setDmNewMsg("");
      setTimeout(() => { if (dmScrollRef.current) dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight; }, 50);
    } catch(e: any) {
      setDmError("Failed to send: " + e.message);
    }
    setDmSending(false);
  }

  async function loadContacts() {
    if (contactsLoading || !token) return;
    setContactsLoading(true);
    try {
      const d = await graph("/me/people?$top=50&$select=displayName,userPrincipalName,scoredEmailAddresses");
      setContacts(d.value || []);
    } catch(e: any) {
      console.warn("[Teams contacts] /me/people failed:", e?.message);
      try {
        const d2 = await graph("/users?$top=50&$select=displayName,userPrincipalName,mail");
        setContacts((d2.value || []).map((u: any) => ({ ...u, scoredEmailAddresses: u.mail ? [{ address: u.mail }] : [] })));
      } catch(_) {}
    }
    setContactsLoading(false);
  }

  const selectedColl = selectedCollKey ? collMap[selectedCollKey] : null;
  const brand = selectedColl ? getBrand(selectedColl.brand) : null;
  const mapping = selectedCollKey ? channelMap[selectedCollKey] : null;
  const msgs = (selectedCollKey ? messages[selectedCollKey] : null) || [];
  const isLoadingMsgs = selectedCollKey ? !!loading[selectedCollKey] : false;
  const msgError = selectedCollKey ? errors[selectedCollKey] : null;
  const isCreating = selectedCollKey ? creatingChannel === selectedCollKey : false;

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => { const ev = new CustomEvent("closeTeamsView"); window.dispatchEvent(ev); }}
        title="Close Teams"
        style={{ position: "absolute", top: 10, right: 10, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}15`, color: TEAMS_PURPLE, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
      >✕</button>

      <div style={{ display: "flex", height: "calc(100vh - 140px)", minHeight: 500, background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>

        {/* ── LEFT: collection list ────────────────────────────────────────── */}
        <div style={{ width: 280, flexShrink: 0, borderRight: "1px solid #334155", display: "flex", flexDirection: "column", background: "#0F172A" }}>
          <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #334155", flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6B7280" }}>Collections ({collList.length})</span>
          </div>

          {/* Sign-in status bar */}
          <div style={{ padding: "10px 16px", borderBottom: "1px solid #334155", background: token ? "#064E3B44" : "#78350F44", flexShrink: 0 }}>
            {token ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#34D399", fontWeight: 600 }}>✓ Connected to Microsoft Teams</span>
                <button onClick={signOut} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: "1px solid #34D39944", background: "none", color: "#34D399", cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 11, color: "#FBBF24", fontWeight: 600, marginBottom: 6 }}>
                  {authStatus === "error" ? (authError || "Authentication failed") : "Sign in to use Teams"}
                </div>
                {!configured ? (
                  <div style={{ fontSize: 11, color: "#D97706" }}>Azure credentials not configured — check Vercel env vars</div>
                ) : (
                  <button
                    onClick={authenticate}
                    disabled={authStatus === "loading"}
                    style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: authStatus === "loading" ? 0.6 : 1 }}
                  >
                    {authStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Tabs: Channels | Direct Message */}
          <div style={{ display: "flex", borderBottom: "1px solid #334155", flexShrink: 0 }}>
            {(["channels", "direct"] as const).map(t => (
              <button key={t} onClick={() => setTeamsTab(t)} style={{ flex: 1, padding: "9px 0", fontSize: 11, fontWeight: 700, fontFamily: "inherit", border: "none", borderBottom: teamsTab === t ? `2px solid ${TEAMS_PURPLE}` : "2px solid transparent", background: "none", color: teamsTab === t ? TEAMS_PURPLE_LT : "#6B7280", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {t === "channels" ? "DC Channels" : "Direct Message"}
              </button>
            ))}
          </div>

          {teamsTab === "channels" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {collList.map(c => {
                const b = getBrand(c.brand);
                const hasCh = !!channelMap[c.key];
                const isSelected = selectedCollKey === c.key;
                const msgCount = (messages[c.key] || []).length;
                return (
                  <div
                    key={c.key}
                    onClick={() => { setSelectedCollKey(c.key === selectedCollKey ? null : c.key); }}
                    style={{ padding: "11px 16px", borderBottom: "1px solid #1E293B", cursor: "pointer", background: isSelected ? `${TEAMS_PURPLE}22` : "transparent", borderLeft: isSelected ? `3px solid ${TEAMS_PURPLE}` : "3px solid transparent", transition: "all 0.12s" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: b ? b.color : "#6B7280", flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? TEAMS_PURPLE_LT : "#F1F5F9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.collection}</div>
                        <div style={{ fontSize: 11, color: "#6B7280" }}>{b ? b.short : ""} · {c.season}</div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 10, background: hasCh ? "#064E3B" : "#1E293B", color: hasCh ? "#34D399" : "#6B7280", border: hasCh ? "none" : "1px solid #334155", fontWeight: 700 }}>
                          {hasCh ? "ACTIVE" : "NO CHAT"}
                        </span>
                        {msgCount > 0 && (
                          <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 10, background: TEAMS_PURPLE, color: "#fff", fontWeight: 700 }}>{msgCount}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {collList.length === 0 && (
                <div style={{ padding: 24, fontSize: 13, color: "#6B7280", textAlign: "center" }}>No collections yet</div>
              )}
            </div>
          )}

          {teamsTab === "direct" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {!token ? (
                <div style={{ textAlign: "center", padding: "40px 20px" }}>
                  <div style={{ fontSize: 32, marginBottom: 10 }}>🔒</div>
                  <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 12 }}>Sign in with Microsoft</div>
                  <button onClick={authenticate} disabled={authStatus === "loading"} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 6, padding: "8px 18px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    {authStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}
                  </button>
                </div>
              ) : (
                <>
                  <div style={{ padding: "10px 12px 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: "#6B7280", fontWeight: 600 }}>Direct Messages</span>
                    {dmChatId && (
                      <button onClick={() => { setDmChatId(null); setDmMessages([]); setDmRecipient(""); setDmError(null); setTeamsDirectErr(null); setTeamsDirectTo(""); setTeamsDirectMsg(""); }}
                        style={{ fontSize: 10, padding: "3px 8px", borderRadius: 5, border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}15`, color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>
                        ✎ New
                      </button>
                    )}
                  </div>
                  {dmChatId ? (
                    <div onClick={() => {}} style={{ padding: "10px 16px", borderBottom: "1px solid #1E293B", background: `${TEAMS_PURPLE}22`, borderLeft: `3px solid ${TEAMS_PURPLE}`, cursor: "default" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 30, height: 30, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>
                          {dmRecipient.slice(0, 2).toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: TEAMS_PURPLE_LT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dmRecipient}</div>
                          <div style={{ fontSize: 10, color: "#6B7280" }}>Active conversation</div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: "12px 14px", fontSize: 12, color: "#6B7280" }}>No active conversations. Type a message on the right to start one.</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ── RIGHT: conversation panel ─────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {teamsTab === "direct" ? (
            !token ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#6B7280" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
                <div style={{ fontSize: 14, color: "#94A3B8", marginBottom: 12 }}>Sign in to use Direct Message</div>
                <button onClick={authenticate} disabled={authStatus === "loading"} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 6, padding: "9px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  {authStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}
                </button>
              </div>
            ) : !dmChatId ? (
              /* ── Compose form (full right panel) ── */
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ padding: "16px 24px 12px", borderBottom: "1px solid #334155", background: "#1E293B", flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9" }}>New Direct Message</div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>Send a Teams DM to any team member</div>
                </div>
                <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>
                  <div style={{ marginBottom: 14, position: "relative" as const }}>
                    <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 5, display: "flex", alignItems: "center", gap: 8 }}>
                      <span>To{contactsLoading ? " (loading contacts…)" : contacts.length > 0 ? ` — ${contacts.length} contacts` : " — type email"}</span>
                      {!contactsLoading && contacts.length === 0 && token && (
                        <button onClick={loadContacts} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, border: `1px solid ${TEAMS_PURPLE}44`, background: "none", color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>↻ Load</button>
                      )}
                    </div>
                    <input value={teamsDirectTo}
                      onChange={e => { setTeamsDirectTo(e.target.value); setContactSearch(e.target.value); setContactDropdown(true); setTeamsDirectErr(null); }}
                      onFocus={() => { setContactSearch(teamsDirectTo); setContactDropdown(true); }}
                      onBlur={() => setTimeout(() => setContactDropdown(false), 150)}
                      placeholder={contactsLoading ? "Loading contacts…" : contacts.length > 0 ? "Search name or type email…" : "colleague@ringoffire.com"}
                      style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 7, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                    {contactDropdown && contacts.length > 0 && (() => {
                      const q = (contactSearch || "").toLowerCase();
                      const filtered = contacts.filter((c: any) =>
                        !q ||
                        (c.displayName || "").toLowerCase().includes(q) ||
                        (c.userPrincipalName || "").toLowerCase().includes(q) ||
                        (c.scoredEmailAddresses?.[0]?.address || "").toLowerCase().includes(q)
                      );
                      if (filtered.length === 0) return null;
                      return (
                        <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, zIndex: 200, background: "#1E293B", border: "1px solid #475569", borderRadius: 8, maxHeight: 200, overflowY: "auto" as const, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", marginTop: 2 }}>
                          {filtered.slice(0, 10).map((c: any) => {
                            const email = c.userPrincipalName || c.scoredEmailAddresses?.[0]?.address || "";
                            return (
                              <div key={email || c.displayName}
                                onMouseDown={() => { setTeamsDirectTo(email); setContactDropdown(false); setContactSearch(""); setTeamsDirectErr(null); }}
                                style={{ padding: "9px 14px", cursor: "pointer", borderBottom: "1px solid #334155" }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "#F1F5F9" }}>{c.displayName}</div>
                                <div style={{ fontSize: 11, color: "#6B7280" }}>{email}</div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 5 }}>Message</div>
                    <textarea value={teamsDirectMsg} onChange={e => { setTeamsDirectMsg(e.target.value); setTeamsDirectErr(null); }}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); teamsSendDirect(); } }}
                      placeholder="Type your message… (Enter to send)" rows={6}
                      style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 7, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical" as const, boxSizing: "border-box" as const }} />
                  </div>
                  {teamsDirectErr && (
                    <div style={{ background: "#1E293B", border: "1px solid #EF444444", borderRadius: 8, padding: "10px 14px", color: "#EF4444", fontSize: 12, marginBottom: 12 }}>
                      ⚠ {teamsDirectErr}
                    </div>
                  )}
                  <button onClick={teamsSendDirect} disabled={teamsDirectSending || !teamsDirectTo.trim() || !teamsDirectMsg.trim()}
                    style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "11px 24px", fontSize: 13, fontWeight: 700, cursor: teamsDirectSending ? "wait" : "pointer", fontFamily: "inherit", opacity: (teamsDirectSending || !teamsDirectTo.trim() || !teamsDirectMsg.trim()) ? 0.6 : 1 }}>
                    {teamsDirectSending ? "Sending…" : "Send Direct Message ↗"}
                  </button>
                </div>
              </div>
            ) : (
              /* ── Conversation view ── */
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ padding: "14px 50px 14px 20px", borderBottom: "1px solid #334155", background: "#1E293B", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>
                    {dmRecipient.slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dmRecipient}</div>
                    <div style={{ fontSize: 11, color: "#6B7280" }}>Direct Message · Teams</div>
                  </div>
                  <button onClick={() => loadDmMessages(dmChatId)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
                </div>
                {/* Error bar */}
                {dmError && (
                  <div style={{ background: "#1E293B", borderBottom: "1px solid #EF444444", padding: "8px 20px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    <span style={{ fontSize: 12, color: "#EF4444", flex: 1 }}>⚠ {dmError}</span>
                    <button onClick={() => setDmError(null)} style={{ border: "none", background: "none", color: "#EF4444", cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}>✕</button>
                  </div>
                )}
                <div ref={dmScrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
                  {dmLoading ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
                  ) : dmMessages.length === 0 ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>No messages yet in this conversation</div>
                  ) : (
                    dmMessages.map((msg: any) => {
                      const author = msg.from?.user?.displayName || "Unknown";
                      const initials = author.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                      const clean = (msg.body?.content || "").replace(/<[^>]+>/g, "").trim();
                      const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                      return (
                        <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, padding: "12px 16px" }}>
                          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <div style={{ width: 32, height: 32, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{initials}</div>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                                <span style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9" }}>{author}</span>
                                <span style={{ fontSize: 11, color: "#6B7280" }}>{time}</span>
                              </div>
                              <div style={{ fontSize: 13, color: "#CBD5E1", lineHeight: 1.5, wordBreak: "break-word" }}>{clean || "[Attachment]"}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div style={{ padding: "12px 20px", borderTop: "1px solid #334155", background: "#1E293B", display: "flex", gap: 10, flexShrink: 0 }}>
                  <input value={dmNewMsg} onChange={e => setDmNewMsg(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDmReply(); }}}
                    placeholder={`Reply to ${dmRecipient}…`}
                    style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
                  <button onClick={sendDmReply} disabled={dmSending || !dmNewMsg.trim()}
                    style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 12, fontWeight: 700, cursor: (dmSending || !dmNewMsg.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (dmSending || !dmNewMsg.trim()) ? 0.5 : 1 }}>
                    {dmSending ? "…" : "Send"}
                  </button>
                </div>
              </div>
            )
          ) : !selectedCollKey ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#6B7280" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>💬</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#94A3B8", marginBottom: 6 }}>Select a collection to open its chat</div>
              <div style={{ fontSize: 13 }}>Each collection gets its own Teams channel in RING OF FIRE</div>
            </div>
          ) : (
            <>
              {/* Header */}
              <div style={{ padding: "14px 50px 14px 20px", borderBottom: "1px solid #334155", background: "#1E293B", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: brand ? brand.color : "#6B7280", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9" }}>{selectedColl?.collection || ""}</div>
                  <div style={{ fontSize: 12, color: "#6B7280" }}>
                    {brand ? brand.name : ""}{selectedColl ? " · " + selectedColl.season + " · " + selectedColl.category : ""}
                  </div>
                </div>
                {mapping && token && (
                  <button
                    onClick={() => loadMessages(selectedCollKey)}
                    style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}
                  >↻ Refresh</button>
                )}
              </div>

              {/* Message area */}
              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                {!token ? (
                  <div style={{ textAlign: "center", paddingTop: 60 }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 8 }}>Sign in to use Teams chat</div>
                    <button onClick={authenticate} disabled={authStatus === "loading"} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                      {authStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}
                    </button>
                  </div>
                ) : !mapping ? (
                  <div style={{ textAlign: "center", paddingTop: 60 }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>💬</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 6 }}>No Teams channel yet for this collection</div>
                    <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 20 }}>A channel will be created in the RING OF FIRE workspace</div>
                    {msgError && (
                      <div style={{ background: "#1E293B", border: "1px solid #EF444444", borderRadius: 8, padding: "10px 14px", color: "#EF4444", fontSize: 12, marginBottom: 16, textAlign: "left" }}>
                        ⚠ {msgError}
                      </div>
                    )}
                    <button
                      onClick={() => startChat(selectedCollKey)}
                      disabled={!!isCreating}
                      style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: isCreating ? "wait" : "pointer", opacity: isCreating ? 0.7 : 1 }}
                    >
                      {isCreating ? "Creating channel…" : "💬 Start Teams Chat"}
                    </button>
                  </div>
                ) : isLoadingMsgs ? (
                  <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
                ) : msgError ? (
                  <div style={{ background: "#1E293B", border: "1px solid #EF444444", borderRadius: 8, padding: "12px 16px", color: "#EF4444", fontSize: 13 }}>⚠ {msgError}</div>
                ) : msgs.length === 0 ? (
                  <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40 }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
                    <div style={{ fontSize: 13 }}>No messages yet — start the conversation!</div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {msgs.map((msg: any) => {
                      const author = msg.from?.user?.displayName || "Unknown";
                      const initials = author.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                      const clean = (msg.body?.content || "").replace(/<[^>]+>/g, "").trim();
                      const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                      return (
                        <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, padding: "12px 16px" }}>
                          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <div style={{ width: 34, height: 34, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{initials}</div>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                                <span style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9" }}>{author}</span>
                                <span style={{ fontSize: 11, color: "#6B7280" }}>{time}</span>
                              </div>
                              <div style={{ fontSize: 13, color: "#CBD5E1", lineHeight: 1.5, wordBreak: "break-word" }}>{clean || "[Attachment]"}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Send box */}
              {mapping && token && (
                <div style={{ padding: "12px 20px", borderTop: "1px solid #334155", background: "#1E293B", display: "flex", gap: 10, flexShrink: 0 }}>
                  <input
                    value={newMsg}
                    onChange={e => setNewMsg(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(selectedCollKey); }}}
                    placeholder={`Message ${selectedColl?.collection || ""}…`}
                    style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" }}
                  />
                  <button onClick={() => sendMessage(selectedCollKey)} disabled={!newMsg.trim()} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 12, fontWeight: 700, cursor: newMsg.trim() ? "pointer" : "not-allowed", fontFamily: "inherit", opacity: newMsg.trim() ? 1 : 0.5 }}>Send</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default TeamsView;
