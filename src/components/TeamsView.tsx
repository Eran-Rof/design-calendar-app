import React, { useState } from "react";
import { TH } from "../utils/theme";
import { TEAMS_PURPLE, TEAMS_PURPLE_LT } from "../utils/theme";
import { S } from "../utils/styles";
import { getBrand } from "../utils/dates";

// ─── MICROSOFT TEAMS VIEW ─────────────────────────────────────────────────────
function TeamsView({ collList, collMap, isAdmin, teamsConfig, setTeamsConfig, teamsToken, setTeamsToken, showTeamsConfig, setShowTeamsConfig, getBrand }) {
  const [selectedCollKey, setSelectedCollKey] = useState(null);
  const [messages, setMessages] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [replyText, setReplyText] = useState({});
  const [newMsg, setNewMsg] = useState("");
  const [configForm, setConfigForm] = useState({ ...teamsConfig });
  const [authStatus, setAuthStatus] = useState("idle");
  const [teams, setTeams] = useState([]);
  const [channels, setChannels] = useState({});
  const [expandedTeam, setExpandedTeam] = useState(null);
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [msgTab, setMsgTab] = useState("channel");
  const [selectedMsg, setSelectedMsg] = useState(null);
  const [replies, setReplies] = useState([]);
  const [loadingReplies, setLoadingReplies] = useState(false);
  const token = teamsToken;
  const cfg = teamsConfig;

  async function authenticate() {
    if (!cfg.clientId || !cfg.tenantId) { setAuthStatus("error"); return; }
    setAuthStatus("loading");
    try {
      const authUrl = "https://login.microsoftonline.com/" + cfg.tenantId + "/oauth2/v2.0/authorize?" +
        "client_id=" + cfg.clientId + "&response_type=token&redirect_uri=" + encodeURIComponent(window.location.origin + "/auth-callback") +
        "&scope=" + encodeURIComponent(["https://graph.microsoft.com/ChannelMessage.Read.All","https://graph.microsoft.com/Team.ReadBasic.All","https://graph.microsoft.com/Channel.ReadBasic.All","https://graph.microsoft.com/ChannelMessage.Send","https://graph.microsoft.com/Mail.Read","https://graph.microsoft.com/Mail.Send"].join(" ")) +
        "&response_mode=fragment&prompt=select_account";
      const popup = window.open(authUrl, "msauth", "width=500,height=700,left=400,top=100");
      const result = await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          try {
            if (popup.closed) { clearInterval(timer); reject(new Error("Popup closed")); return; }
            const hash = popup.location.hash;
            if (hash && hash.includes("access_token")) { clearInterval(timer); popup.close(); resolve(new URLSearchParams(hash.substring(1)).get("access_token")); }
          } catch (_) {}
        }, 300);
        setTimeout(() => { clearInterval(timer); if (!popup.closed) popup.close(); reject(new Error("Timeout")); }, 120000);
      });
      setTeamsToken(result); setAuthStatus("ok");
    } catch (e) { setAuthStatus("error"); }
  }

  async function graph(path) {
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  async function graphPost(path, body) {
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }

  async function loadTeams() {
    if (!token) return;
    setLoadingTeams(true);
    try { const d = await graph("/me/joinedTeams"); setTeams(d.value || []); } catch(e) { console.error(e); }
    setLoadingTeams(false);
  }
  async function loadChannels(teamId) {
    try { const d = await graph("/teams/" + teamId + "/channels"); setChannels(c => ({ ...c, [teamId]: d.value || [] })); setExpandedTeam(teamId === expandedTeam ? null : teamId); }
    catch(e) { console.error(e); }
  }
  function mapChannel(collKey, channelId, teamId) {
    const updated = { ...cfg, channelMap: { ...cfg.channelMap, [collKey]: { channelId, teamId } } };
    setTeamsConfig(updated); try { localStorage.setItem("teamsConfig", JSON.stringify(updated)); } catch(_) {}
  }
  function unmapChannel(collKey) {
    const nm = { ...cfg.channelMap }; delete nm[collKey];
    const updated = { ...cfg, channelMap: nm };
    setTeamsConfig(updated); try { localStorage.setItem("teamsConfig", JSON.stringify(updated)); } catch(_) {}
  }
  async function loadMessages(collKey) {
    const mapping = cfg.channelMap[collKey];
    if (!mapping || !token) return;
    setLoading(l => ({ ...l, [collKey]: true })); setErrors(e => ({ ...e, [collKey]: null }));
    try { const d = await graph("/teams/" + mapping.teamId + "/channels/" + mapping.channelId + "/messages?$top=50"); setMessages(m => ({ ...m, [collKey]: (d.value || []).filter(m => m.messageType === "message") })); }
    catch(e) { setErrors(err => ({ ...err, [collKey]: e.message })); }
    setLoading(l => ({ ...l, [collKey]: false }));
  }
  async function loadReplies(collKey, messageId) {
    const mapping = cfg.channelMap[collKey];
    if (!mapping || !token) return;
    setLoadingReplies(true); setSelectedMsg(messageId);
    try { const d = await graph("/teams/" + mapping.teamId + "/channels/" + mapping.channelId + "/messages/" + messageId + "/replies"); setReplies(d.value || []); }
    catch(e) { setReplies([]); }
    setLoadingReplies(false); setMsgTab("replies");
  }
  async function sendMessage(collKey) {
    const mapping = cfg.channelMap[collKey];
    if (!mapping || !newMsg.trim() || !token) return;
    try { const sent = await graphPost("/teams/" + mapping.teamId + "/channels/" + mapping.channelId + "/messages", { body: { content: newMsg.trim(), contentType: "text" } }); setMessages(m => ({ ...m, [collKey]: [sent, ...(m[collKey] || [])] })); setNewMsg(""); }
    catch(e) { alert("Failed to send: " + e.message); }
  }
  async function sendReply(collKey, messageId) {
    const mapping = cfg.channelMap[collKey];
    const text = replyText[messageId] || "";
    if (!mapping || !text.trim() || !token) return;
    try { const sent = await graphPost("/teams/" + mapping.teamId + "/channels/" + mapping.channelId + "/messages/" + messageId + "/replies", { body: { content: text.trim(), contentType: "text" } }); setReplies(r => [...r, sent]); setReplyText(r => ({ ...r, [messageId]: "" })); }
    catch(e) { alert("Failed to reply: " + e.message); }
  }
  function saveConfig() {
    setTeamsConfig(configForm); try { localStorage.setItem("teamsConfig", JSON.stringify(configForm)); } catch(_) {}
    setShowTeamsConfig(false);
  }

  useEffect(() => { if (token) loadTeams(); }, [token]);
  useEffect(() => { if (selectedCollKey && token) loadMessages(selectedCollKey); }, [selectedCollKey, token]);

  const selectedColl = selectedCollKey ? collMap[selectedCollKey] : null;
  const brand = selectedColl ? getBrand(selectedColl.brand) : null;
  const mapping = selectedCollKey ? (cfg.channelMap && cfg.channelMap[selectedCollKey]) : null;
  const msgs = (selectedCollKey ? messages[selectedCollKey] : null) || [];
  const isLoadingMsgs = selectedCollKey ? !!loading[selectedCollKey] : false;
  const msgError = selectedCollKey ? errors[selectedCollKey] : null;

  if (showTeamsConfig) return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "8px 0" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: TH.text, marginBottom: 18 }}>Microsoft Teams Configuration</div>
      <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "12px 16px", marginBottom: 18, fontSize: 12, color: "#1E40AF", lineHeight: 1.6 }}>
        <b>Azure AD Setup:</b> Register an app, enable implicit grant for Access tokens, add Graph API permissions
        (ChannelMessage.Read.All, Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Send),
        set redirect URI to <b>{window.location.origin}/auth-callback</b>.
      </div>
      <label style={S.lbl}>Azure AD Client ID</label>
      <input style={S.inp} value={configForm.clientId} onChange={e => setConfigForm(f => ({...f, clientId: e.target.value}))} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      <label style={S.lbl}>Tenant ID</label>
      <input style={S.inp} value={configForm.tenantId} onChange={e => setConfigForm(f => ({...f, tenantId: e.target.value}))} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
        <button onClick={() => setShowTeamsConfig(false)} style={{ padding: "9px 18px", borderRadius: 8, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button onClick={saveConfig} style={S.btn}>Save Configuration</button>
      </div>
    </div>
  );

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => { const ev = new CustomEvent("closeTeamsView"); window.dispatchEvent(ev); }} title="Close Teams"
        style={{ position: "absolute", top: 10, right: 10, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: "1px solid rgba(91,94,166,0.3)", background: "rgba(91,94,166,0.1)", color: TEAMS_PURPLE, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, transition: "all 0.15s" }}
        onMouseEnter={e => { e.currentTarget.style.background = TEAMS_PURPLE; e.currentTarget.style.color = "#fff"; }}
        onMouseLeave={e => { e.currentTarget.style.background = "rgba(91,94,166,0.1)"; e.currentTarget.style.color = TEAMS_PURPLE; }}>✕</button>
      <div style={{ display: "flex", height: "calc(100vh - 200px)", minHeight: 500, background: TH.surface, borderRadius: 12, border: "1px solid " + TH.border, overflow: "hidden" }}>

        {/* LEFT: project list */}
        <div style={{ width: 280, flexShrink: 0, borderRight: "1px solid " + TH.border, overflowY: "auto", background: TH.surfaceHi, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid " + TH.border, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: TH.textMuted }}>Projects ({collList.length})</span>
            {isAdmin && <button onClick={() => { setConfigForm({ ...cfg }); setShowTeamsConfig(true); }} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>⚙ Config</button>}
          </div>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid " + TH.border, background: token ? "#ECFDF5" : "#FFF7ED", flexShrink: 0 }}>
            {token ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#065F46", fontWeight: 600 }}>✓ Connected to Microsoft Teams</span>
                <button onClick={() => { setTeamsToken(null); setAuthStatus("idle"); }} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: "1px solid #6EE7B7", background: "none", color: "#065F46", cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 11, color: "#92400E", fontWeight: 600, marginBottom: 6 }}>{authStatus === "error" ? "Authentication failed — check config" : "Sign in to load conversations"}</div>
                {(!cfg.clientId || !cfg.tenantId) ? (
                  <div style={{ fontSize: 11, color: "#B45309" }}>{isAdmin ? 'Click "⚙ Config" to enter Azure AD credentials' : "Contact an admin to set up Teams integration"}</div>
                ) : (
                  <button onClick={authenticate} disabled={authStatus === "loading"} style={{ ...S.btn, fontSize: 11, padding: "5px 12px", opacity: authStatus === "loading" ? 0.6 : 1 }}>{authStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                )}
              </div>
            )}
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {collList.map(c => {
              const b = getBrand(c.brand);
              const hasCh = !!(cfg.channelMap && cfg.channelMap[c.key]);
              const isSelected = selectedCollKey === c.key;
              const msgCount = (messages[c.key] || []).length;
              return (
                <div key={c.key} onClick={() => { setSelectedCollKey(c.key === selectedCollKey ? null : c.key); setMsgTab("channel"); setSelectedMsg(null); }}
                  style={{ padding: "11px 16px", borderBottom: "1px solid " + TH.border, cursor: "pointer", background: isSelected ? TH.accent : "transparent", borderLeft: isSelected ? "3px solid " + TH.primary : "3px solid transparent", transition: "all 0.12s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: b ? b.color : TH.textMuted, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? TH.primary : TH.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.collection}</div>
                      <div style={{ fontSize: 11, color: TH.textMuted }}>{b ? b.short : ""} · {c.season}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 10, background: hasCh ? "#D1FAE5" : TH.surfaceHi, color: hasCh ? "#065F46" : TH.textMuted, border: hasCh ? "none" : "1px solid " + TH.border, fontWeight: 700 }}>{hasCh ? "LINKED" : "UNLINKED"}</span>
                      {msgCount > 0 && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 10, background: TH.primary, color: "#fff", fontWeight: 700 }}>{msgCount}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {collList.length === 0 && <div style={{ padding: 24, fontSize: 13, color: TH.textMuted, textAlign: "center" }}>No collections yet</div>}
          </div>
        </div>

        {/* RIGHT: conversation panel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!selectedCollKey ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: TH.textMuted }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>💬</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: TH.textSub, marginBottom: 6 }}>Select a project to view conversations</div>
              <div style={{ fontSize: 13 }}>Each collection maps to a Microsoft Teams channel</div>
            </div>
          ) : (
            <>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid " + TH.border, background: "#fff", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: brand ? brand.color : TH.textMuted, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: TH.text }}>{selectedColl ? selectedColl.collection : ""}</div>
                  <div style={{ fontSize: 12, color: TH.textMuted }}>{brand ? brand.name : ""}{selectedColl ? " · " + selectedColl.season + " · " + selectedColl.category : ""}</div>
                </div>
                {isAdmin && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    {mapping ? (
                      <>
                        <span style={{ fontSize: 11, color: "#065F46", background: "#D1FAE5", padding: "3px 8px", borderRadius: 6 }}>Channel linked</span>
                        <button onClick={() => loadMessages(selectedCollKey)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
                        <button onClick={() => unmapChannel(selectedCollKey)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit" }}>Unlink</button>
                      </>
                    ) : token ? (
                      <button onClick={() => { if (!teams.length) loadTeams(); setExpandedTeam(expandedTeam ? null : "__picker__"); }} style={{ ...S.btn, fontSize: 11, padding: "5px 12px" }}>+ Link Channel</button>
                    ) : null}
                  </div>
                )}
              </div>

              {isAdmin && !mapping && token && (
                <div style={{ padding: "12px 20px", background: "#FFFBEB", borderBottom: "1px solid #FCD34D", flexShrink: 0, overflowY: "auto", maxHeight: 240 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#92400E", marginBottom: 10 }}>Link this project to a Teams channel:</div>
                  {loadingTeams ? <div style={{ fontSize: 12, color: TH.textMuted }}>Loading teams…</div> :
                    teams.length === 0 ? <button onClick={loadTeams} style={{ ...S.btn, fontSize: 11, padding: "5px 12px" }}>Load My Teams</button> : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {teams.map(tm => (
                        <div key={tm.id}>
                          <div onClick={() => loadChannels(tm.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 7, background: expandedTeam === tm.id ? "#EFF6FF" : TH.surfaceHi, cursor: "pointer", border: "1px solid " + TH.border }}>
                            <span style={{ fontSize: 14 }}>👥</span>
                            <span style={{ fontSize: 12, fontWeight: 600, color: TH.text, flex: 1 }}>{tm.displayName}</span>
                            <span style={{ fontSize: 10, color: TH.textMuted }}>{expandedTeam === tm.id ? "▲" : "▼"}</span>
                          </div>
                          {expandedTeam === tm.id && channels[tm.id] && (
                            <div style={{ marginLeft: 16, marginTop: 4, display: "flex", flexDirection: "column", gap: 3 }}>
                              {channels[tm.id].map(ch => (
                                <div key={ch.id} onClick={() => mapChannel(selectedCollKey, ch.id, tm.id)}
                                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, cursor: "pointer", background: "#fff", border: "1px solid " + TH.border }}
                                  onMouseEnter={e => e.currentTarget.style.background = "#EFF6FF"}
                                  onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
                                  <span style={{ fontSize: 12, color: TH.textMuted }}>#</span>
                                  <span style={{ fontSize: 12, color: TH.text }}>{ch.displayName}</span>
                                  <span style={{ fontSize: 10, color: TH.primary, marginLeft: "auto", fontWeight: 600 }}>Link →</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {mapping && (
                <div style={{ display: "flex", borderBottom: "1px solid " + TH.border, background: "#fff", flexShrink: 0 }}>
                  {[["channel","Channel Messages"],["replies", selectedMsg ? "Thread" : "Thread Replies"]].map(([tab, label]) => (
                    <button key={tab} onClick={() => setMsgTab(tab)} style={{ padding: "9px 18px", border: "none", borderBottom: msgTab === tab ? "2px solid " + TH.primary : "2px solid transparent", background: "none", color: msgTab === tab ? TH.primary : TH.textMuted, fontWeight: msgTab === tab ? 700 : 500, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>{label}</button>
                  ))}
                </div>
              )}

              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                {!token ? (
                  <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div><div style={{ fontSize: 13 }}>Sign in with Microsoft to view conversations</div></div>
                ) : !mapping ? (
                  <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>🔗</div><div style={{ fontSize: 13 }}>{isAdmin ? 'Click "+ Link Channel" above to connect a Teams channel' : "No Teams channel linked for this project yet"}</div></div>
                ) : isLoadingMsgs ? (
                  <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
                ) : msgError ? (
                  <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: "12px 16px", color: "#B91C1C", fontSize: 13 }}>⚠ {msgError}</div>
                ) : msgTab === "channel" ? (
                  msgs.length === 0 ? (
                    <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>💬</div><div style={{ fontSize: 13 }}>No messages yet</div></div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {msgs.map(msg => {
                        const author = (msg.from && msg.from.user && msg.from.user.displayName) || "Unknown";
                        const initials = author.split(" ").map(w => w[0] || "").join("").toUpperCase().slice(0, 2);
                        const clean = ((msg.body && msg.body.content) || "").replace(/<[^>]+>/g, "").trim();
                        const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                        return (
                          <div key={msg.id} style={{ background: "#fff", border: "1px solid " + TH.border, borderRadius: 10, padding: "12px 16px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                              <div style={{ width: 34, height: 34, borderRadius: "50%", background: TH.primary + "22", border: "2px solid " + TH.primary, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TH.primary, flexShrink: 0 }}>{initials}</div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: TH.text }}>{author}</span>
                                  <span style={{ fontSize: 11, color: TH.textMuted }}>{time}</span>
                                </div>
                                <div style={{ fontSize: 13, color: TH.textSub, lineHeight: 1.5, wordBreak: "break-word" }}>{clean || "[Attachment or card]"}</div>
                                <button onClick={() => loadReplies(selectedCollKey, msg.id)} style={{ marginTop: 6, fontSize: 11, padding: "3px 9px", borderRadius: 6, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>💬 View Thread</button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                ) : (
                  <div>
                    {!selectedMsg ? (
                      <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40, fontSize: 13 }}>Click "View Thread" on a message to open its replies</div>
                    ) : loadingReplies ? (
                      <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 24, fontSize: 13 }}>Loading replies…</div>
                    ) : replies.length === 0 ? (
                      <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40, fontSize: 13 }}>No replies yet — be the first!</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                        {replies.map(r => {
                          const author = (r.from && r.from.user && r.from.user.displayName) || "Unknown";
                          const initials = author.split(" ").map(w => w[0] || "").join("").toUpperCase().slice(0, 2);
                          const clean = ((r.body && r.body.content) || "").replace(/<[^>]+>/g, "").trim();
                          const time = r.createdDateTime ? new Date(r.createdDateTime).toLocaleString() : "";
                          return (
                            <div key={r.id} style={{ background: TH.surfaceHi, border: "1px solid " + TH.border, borderRadius: 8, padding: "10px 14px" }}>
                              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#6D28D922", border: "2px solid #6D28D9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#6D28D9", flexShrink: 0 }}>{initials}</div>
                                <div style={{ flex: 1 }}>
                                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: TH.text }}>{author}</span>
                                    <span style={{ fontSize: 10, color: TH.textMuted }}>{time}</span>
                                  </div>
                                  <div style={{ fontSize: 12, color: TH.textSub, lineHeight: 1.5 }}>{clean || "[Attachment]"}</div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {selectedMsg && (
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <input value={(replyText[selectedMsg] || "")} onChange={e => setReplyText(r => ({...r, [selectedMsg]: e.target.value}))} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply(selectedCollKey, selectedMsg); }}} placeholder="Write a reply…" style={{ ...S.inp, flex: 1, marginBottom: 0 }} />
                        <button onClick={() => sendReply(selectedCollKey, selectedMsg)} style={S.btn}>Reply</button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {mapping && token && msgTab === "channel" && (
                <div style={{ padding: "12px 20px", borderTop: "1px solid " + TH.border, background: "#fff", display: "flex", gap: 10, flexShrink: 0 }}>
                  <input value={newMsg} onChange={e => setNewMsg(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(selectedCollKey); }}} placeholder={"Message " + (selectedColl ? selectedColl.collection : "") + "…"} style={{ ...S.inp, flex: 1, marginBottom: 0 }} />
                  <button onClick={() => sendMessage(selectedCollKey)} disabled={!newMsg.trim()} style={{ ...S.btn, opacity: newMsg.trim() ? 1 : 0.5 }}>Send</button>
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
