import React, { useState } from "react";
import { TH } from "../utils/theme";
import { OUTLOOK_BLUE, OUTLOOK_BLUE_LT } from "../utils/theme";
import { S } from "../utils/styles";
import { getBrand } from "../utils/dates";

// ─── MICROSOFT OUTLOOK EMAIL VIEW ─────────────────────────────────────────────
function OutlookView({ collList, collMap, collections, isAdmin, teamsConfig, setTeamsConfig, teamsToken, setTeamsToken, teamsTokenExpiry, setTeamsTokenExpiry, showEmailConfig, setShowEmailConfig, getBrand }) {
  const [selectedCollKey, setSelectedCollKey] = useState(null);
  const [collSearch, setCollSearch] = useState("");
  const [emails, setEmails] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [thread, setThread] = useState([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [emailTab, setEmailTab] = useState("inbox");
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [sendError, setSendError] = useState(null);
  const [nextLinks, setNextLinks] = useState({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [lastRefresh, setLastRefresh] = useState({});
  const [configForm, setConfigForm] = useState({ ...teamsConfig });
  const [authStatus, setAuthStatus] = useState("idle");
  const [prefixInput, setPrefixInput] = useState("");
  const iframeRef = useRef(null);
  const token = teamsToken;
  const cfg = teamsConfig;

  function tokenIsValid() {
    return !!token && (!teamsTokenExpiry || Date.now() < teamsTokenExpiry);
  }
  function handleTokenExpired() {
    setTeamsToken(null);
    setTeamsTokenExpiry(null);
    setAuthStatus("idle");
  }
  async function authenticate() {
    if (!cfg.clientId || !cfg.tenantId) { setAuthStatus("error"); return; }
    setAuthStatus("loading");
    try {
      const authUrl = "https://login.microsoftonline.com/" + cfg.tenantId + "/oauth2/v2.0/authorize?" +
        "client_id=" + cfg.clientId + "&response_type=token&redirect_uri=" + encodeURIComponent(window.location.origin + "/auth-callback") +
        "&scope=" + encodeURIComponent(["https://graph.microsoft.com/ChannelMessage.Read.All","https://graph.microsoft.com/Team.ReadBasic.All","https://graph.microsoft.com/Channel.ReadBasic.All","https://graph.microsoft.com/ChannelMessage.Send","https://graph.microsoft.com/Mail.Read","https://graph.microsoft.com/Mail.Send"].join(" ")) +
        "&response_mode=fragment&prompt=select_account";
      const popup = window.open(authUrl, "msauth", "width=500,height=700,left=400,top=100");
      const { accessToken, expiresIn } = await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          try {
            if (popup.closed) { clearInterval(timer); reject(new Error("Popup closed")); return; }
            const hash = popup.location.hash;
            if (hash && hash.includes("access_token")) {
              clearInterval(timer); popup.close();
              const params = new URLSearchParams(hash.substring(1));
              resolve({ accessToken: params.get("access_token"), expiresIn: parseInt(params.get("expires_in") || "3600", 10) });
            }
          } catch (_) {}
        }, 300);
        setTimeout(() => { clearInterval(timer); if (!popup.closed) popup.close(); reject(new Error("Timeout")); }, 120000);
      });
      setTeamsToken(accessToken);
      setTeamsTokenExpiry(Date.now() + expiresIn * 1000);
      setAuthStatus("ok");
    } catch (e) { setAuthStatus("error"); }
  }
  async function graph(path) {
    if (!tokenIsValid()) { handleTokenExpired(); throw new Error("Token expired — please sign in again"); }
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
    if (r.status === 401) { handleTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  async function graphPost(path, body) {
    if (!tokenIsValid()) { handleTokenExpired(); throw new Error("Token expired — please sign in again"); }
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { handleTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (r.status === 202 || r.status === 200) return r.status === 202 ? {} : r.json();
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }

  function getPrefix(collKey) {
    return (cfg.emailMap && cfg.emailMap[collKey]) || null;
  }
  function mapPrefix(collKey, prefix) {
    const updated = { ...cfg, emailMap: { ...cfg.emailMap, [collKey]: prefix } };
    setTeamsConfig(updated);
    try { localStorage.setItem("teamsConfig", JSON.stringify(updated)); } catch (_) {}
  }
  function unmapPrefix(collKey) {
    const nm = { ...(cfg.emailMap || {}) }; delete nm[collKey];
    const updated = { ...cfg, emailMap: nm };
    setTeamsConfig(updated);
    try { localStorage.setItem("teamsConfig", JSON.stringify(updated)); } catch (_) {}
  }

  async function loadEmails(collKey, olderUrl) {
    const prefix = getPrefix(collKey);
    if (!prefix || !token) return;
    if (olderUrl) { setLoadingOlder(true); } else { setLoading(l => ({ ...l, [collKey]: true })); }
    setErrors(e => ({ ...e, [collKey]: null }));
    try {
      const url = olderUrl || ("/me/messages?$filter=" + encodeURIComponent("contains(subject,'" + prefix + "')") + "&$top=25&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments");
      const d = await graph(url);
      const items = d.value || [];
      if (olderUrl) {
        setEmails(m => ({ ...m, [collKey]: [...(m[collKey] || []), ...items] }));
      } else {
        setEmails(m => ({ ...m, [collKey]: items }));
      }
      setNextLinks(nl => ({ ...nl, [collKey]: d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null }));
      setLastRefresh(lr => ({ ...lr, [collKey]: Date.now() }));
    } catch (e) { setErrors(err => ({ ...err, [collKey]: e.message })); }
    setLoading(l => ({ ...l, [collKey]: false }));
    setLoadingOlder(false);
  }

  async function loadFullEmail(id) {
    try {
      const d = await graph("/me/messages/" + id);
      setSelectedEmail(d);
    } catch (e) { console.error(e); }
  }

  async function loadThread(conversationId) {
    setLoadingThread(true);
    try {
      const d = await graph("/me/messages?$filter=" + encodeURIComponent("conversationId eq '" + conversationId + "'") + "&$orderby=receivedDateTime%20asc&$select=id,subject,from,receivedDateTime,body,conversationId,isRead,hasAttachments");
      setThread(d.value || []);
    } catch (e) { setThread([]); console.error(e); }
    setLoadingThread(false);
    setEmailTab("thread");
  }

  async function sendEmail() {
    if (!composeTo.trim() || !composeSubject.trim()) return;
    setSendError(null);
    try {
      await graphPost("/me/sendMail", {
        message: {
          subject: composeSubject,
          body: { contentType: "HTML", content: composeBody || " " },
          toRecipients: composeTo.split(",").map(e => ({ emailAddress: { address: e.trim() } })),
        },
      });
      setComposeTo(""); setComposeSubject(""); setComposeBody("");
      setEmailTab("inbox");
      if (selectedCollKey) setTimeout(() => loadEmails(selectedCollKey), 2000);
    } catch (e) { setSendError("Failed to send: " + e.message); }
  }

  async function replyToEmail(messageId, comment) {
    if (!comment.trim()) return;
    setSendError(null);
    try {
      await graphPost("/me/messages/" + messageId + "/reply", { comment });
      if (selectedEmail && selectedEmail.conversationId) loadThread(selectedEmail.conversationId);
    } catch (e) { setSendError("Failed to reply: " + e.message); }
  }

  function saveConfig() {
    setTeamsConfig(configForm);
    try { localStorage.setItem("teamsConfig", JSON.stringify(configForm)); } catch (_) {}
    setShowEmailConfig(false);
  }

  useEffect(() => {
    if (selectedCollKey && token && getPrefix(selectedCollKey)) loadEmails(selectedCollKey);
  }, [selectedCollKey, token]);

  // Auto-refresh every 2 minutes
  useEffect(() => {
    if (!selectedCollKey || !tokenIsValid() || !getPrefix(selectedCollKey)) return;
    const interval = setInterval(() => {
      if (tokenIsValid()) loadEmails(selectedCollKey);
    }, 120000);
    return () => clearInterval(interval);
  }, [selectedCollKey, token, teamsTokenExpiry]);

  const selectedColl = selectedCollKey ? collMap[selectedCollKey] : null;
  const brand = selectedColl ? getBrand(selectedColl.brand) : null;
  const prefix = selectedCollKey ? getPrefix(selectedCollKey) : null;
  const emailList = (selectedCollKey ? emails[selectedCollKey] : null) || [];
  const isLoadingEmails = selectedCollKey ? !!loading[selectedCollKey] : false;
  const emailError = selectedCollKey ? errors[selectedCollKey] : null;
  const [replyText, setReplyText] = useState("");

  if (showEmailConfig) return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "8px 0" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: TH.text, marginBottom: 18 }}>Outlook Email Configuration</div>
      <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "12px 16px", marginBottom: 18, fontSize: 12, color: "#1E40AF", lineHeight: 1.6 }}>
        <b>Azure AD Setup:</b> Uses the same Azure AD app as Teams. Ensure <b>Mail.Read</b> and <b>Mail.Send</b> delegated permissions are added and admin consent is granted.
        Redirect URI: <b>{window.location.origin}/auth-callback</b>.
      </div>
      <label style={S.lbl}>Azure AD Client ID</label>
      <input style={S.inp} value={configForm.clientId} onChange={e => setConfigForm(f => ({ ...f, clientId: e.target.value }))} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      <label style={S.lbl}>Tenant ID</label>
      <input style={S.inp} value={configForm.tenantId} onChange={e => setConfigForm(f => ({ ...f, tenantId: e.target.value }))} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
        <button onClick={() => setShowEmailConfig(false)} style={{ padding: "9px 18px", borderRadius: 8, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button onClick={saveConfig} style={S.btn}>Save Configuration</button>
      </div>
    </div>
  );

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => { const ev = new CustomEvent("closeEmailView"); window.dispatchEvent(ev); }} title="Close Email"
        style={{ position: "absolute", top: 10, right: 10, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: "1px solid rgba(0,120,212,0.3)", background: "rgba(0,120,212,0.1)", color: OUTLOOK_BLUE, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, transition: "all 0.15s" }}
        onMouseEnter={e => { e.currentTarget.style.background = OUTLOOK_BLUE; e.currentTarget.style.color = "#fff"; }}
        onMouseLeave={e => { e.currentTarget.style.background = "rgba(0,120,212,0.1)"; e.currentTarget.style.color = OUTLOOK_BLUE; }}>✕</button>
      <div style={{ display: "flex", height: "calc(100vh - 200px)", minHeight: 500, background: TH.surface, borderRadius: 12, border: "1px solid " + TH.border, overflow: "hidden" }}>

        {/* LEFT: collection list */}
        <div style={{ width: 280, flexShrink: 0, borderRight: "1px solid " + TH.border, overflowY: "auto", background: TH.surfaceHi, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid " + TH.border, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: TH.textMuted }}>Projects ({collList.length})</span>
            {isAdmin && <button onClick={() => { setConfigForm({ ...cfg }); setShowEmailConfig(true); }} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>⚙ Config</button>}
          </div>
          <div style={{ padding: "8px 16px", borderBottom: "1px solid " + TH.border, flexShrink: 0 }}>
            <input value={collSearch} onChange={e => setCollSearch(e.target.value)} placeholder="🔍 Collection, vendor, or SKU…" style={{ ...S.inp, marginBottom: 0, fontSize: 12, padding: "7px 10px" }} />
          </div>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid " + TH.border, background: token ? "#ECFDF5" : "#FFF7ED", flexShrink: 0 }}>
            {token ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#065F46", fontWeight: 600 }}>✓ Connected to Microsoft</span>
                <button onClick={() => { setTeamsToken(null); setTeamsTokenExpiry(null); setAuthStatus("idle"); }} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: "1px solid #6EE7B7", background: "none", color: "#065F46", cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 11, color: "#92400E", fontWeight: 600, marginBottom: 6 }}>{authStatus === "error" ? "Authentication failed — check config" : "Sign in to load emails"}</div>
                {(!cfg.clientId || !cfg.tenantId) ? (
                  <div style={{ fontSize: 11, color: "#B45309" }}>{isAdmin ? 'Click "⚙ Config" to enter Azure AD credentials' : "Contact an admin to set up Email integration"}</div>
                ) : (
                  <button onClick={authenticate} disabled={authStatus === "loading"} style={{ ...S.btn, fontSize: 11, padding: "5px 12px", opacity: authStatus === "loading" ? 0.6 : 1 }}>{authStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                )}
              </div>
            )}
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {(() => { const s = collSearch.toLowerCase(); return collList.filter(c => { if (!s) return true; const b = getBrand(c.brand); const skus = (collections[c.key] || {}).skus || []; return (c.collection || "").toLowerCase().includes(s) || (c.vendorName || "").toLowerCase().includes(s) || (b ? b.name : "").toLowerCase().includes(s) || (b ? b.short : "").toLowerCase().includes(s) || skus.some(sk => ((sk.styleNum || "") + " " + (sk.name || "")).toLowerCase().includes(s)); }); })().map(c => {
              const b = getBrand(c.brand);
              const hasPrefix = !!(cfg.emailMap && cfg.emailMap[c.key]);
              const isSelected = selectedCollKey === c.key;
              const unread = (emails[c.key] || []).filter(e => !e.isRead).length;
              return (
                <div key={c.key} onClick={() => { setSelectedCollKey(c.key === selectedCollKey ? null : c.key); setEmailTab("inbox"); setSelectedEmail(null); setThread([]); }}
                  style={{ padding: "11px 16px", borderBottom: "1px solid " + TH.border, cursor: "pointer", background: isSelected ? "#EFF6FF" : "transparent", borderLeft: isSelected ? "3px solid " + OUTLOOK_BLUE : "3px solid transparent", transition: "all 0.12s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: b ? b.color : TH.textMuted, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? OUTLOOK_BLUE : TH.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.collection}</div>
                      <div style={{ fontSize: 11, color: TH.textMuted }}>{b ? b.short : ""} · {c.season}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 10, background: hasPrefix ? "#DBEAFE" : TH.surfaceHi, color: hasPrefix ? "#1E40AF" : TH.textMuted, border: hasPrefix ? "none" : "1px solid " + TH.border, fontWeight: 700 }}>{hasPrefix ? "LINKED" : "UNLINKED"}</span>
                      {unread > 0 && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 10, background: OUTLOOK_BLUE, color: "#fff", fontWeight: 700 }}>{unread}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {collList.length === 0 && <div style={{ padding: 24, fontSize: 13, color: TH.textMuted, textAlign: "center" }}>No collections yet</div>}
          </div>
        </div>

        {/* RIGHT: email panel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!selectedCollKey ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: TH.textMuted }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📧</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: TH.textSub, marginBottom: 6 }}>Select a project to view emails</div>
              <div style={{ fontSize: 13 }}>Each collection maps to an email subject prefix for filtering</div>
            </div>
          ) : (
            <>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid " + TH.border, background: "#fff", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: brand ? brand.color : TH.textMuted, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: TH.text }}>{selectedColl ? selectedColl.collection : ""}</div>
                  <div style={{ fontSize: 12, color: TH.textMuted }}>{brand ? brand.name : ""}{selectedColl ? " · " + selectedColl.season + " · " + selectedColl.category : ""}{prefix ? " · Prefix: " + prefix : ""}</div>
                </div>
                {isAdmin && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    {prefix ? (
                      <>
                        <span style={{ fontSize: 11, color: "#1E40AF", background: "#DBEAFE", padding: "3px 8px", borderRadius: 6 }}>Prefix: {prefix}</span>
                        {lastRefresh[selectedCollKey] && <span style={{ fontSize: 10, color: TH.textMuted }}>Updated {Math.round((Date.now() - lastRefresh[selectedCollKey]) / 1000)}s ago</span>}
                        <button onClick={() => loadEmails(selectedCollKey)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
                        <button onClick={() => unmapPrefix(selectedCollKey)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit" }}>Unlink</button>
                      </>
                    ) : token ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input value={prefixInput} onChange={e => setPrefixInput(e.target.value)} placeholder={selectedColl ? "[" + selectedColl.collection + "]" : "[Prefix]"} style={{ ...S.inp, width: 180, marginBottom: 0, fontSize: 11 }} />
                        <button onClick={() => { const p = prefixInput.trim() || (selectedColl ? "[" + selectedColl.collection + "]" : ""); if (p) { mapPrefix(selectedCollKey, p); setPrefixInput(""); } }} style={{ ...S.btn, fontSize: 11, padding: "5px 12px" }}>Link</button>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              {prefix && (
                <div style={{ display: "flex", borderBottom: "1px solid " + TH.border, background: "#fff", flexShrink: 0 }}>
                  {[["inbox", "Inbox"], ["thread", "Thread"], ["compose", "Compose"]].map(([tab, label]) => (
                    <button key={tab} onClick={() => { setEmailTab(tab); if (tab === "compose" && prefix) { setComposeSubject(prefix + " "); } }}
                      style={{ padding: "9px 18px", border: "none", borderBottom: emailTab === tab ? "2px solid " + OUTLOOK_BLUE : "2px solid transparent", background: "none", color: emailTab === tab ? OUTLOOK_BLUE : TH.textMuted, fontWeight: emailTab === tab ? 700 : 500, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>{label}</button>
                  ))}
                </div>
              )}

              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                {!token ? (
                  <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div><div style={{ fontSize: 13 }}>Sign in with Microsoft to view emails</div></div>
                ) : !prefix ? (
                  <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>🏷️</div><div style={{ fontSize: 13 }}>{isAdmin ? 'Set a subject prefix above to filter emails for this collection' : "No email prefix set for this project yet"}</div></div>
                ) : isLoadingEmails && emailTab === "inbox" ? (
                  <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40, fontSize: 13 }}>Loading emails…</div>
                ) : emailError && emailTab === "inbox" ? (
                  <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: "12px 16px", color: "#B91C1C", fontSize: 13 }}>⚠ {emailError}</div>
                ) : emailTab === "inbox" ? (
                  emailList.length === 0 ? (
                    <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>📧</div><div style={{ fontSize: 13 }}>No emails matching "{prefix}"</div></div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {emailList.map(em => {
                        const sender = (em.from && em.from.emailAddress) ? em.from.emailAddress.name || em.from.emailAddress.address : "Unknown";
                        const initials = sender.split(" ").map(w => w[0] || "").join("").toUpperCase().slice(0, 2);
                        const time = em.receivedDateTime ? new Date(em.receivedDateTime).toLocaleString() : "";
                        return (
                          <div key={em.id} onClick={() => { loadFullEmail(em.id); if (em.conversationId) loadThread(em.conversationId); }}
                            style={{ background: em.isRead ? "#fff" : "#EFF6FF", border: "1px solid " + (em.isRead ? TH.border : OUTLOOK_BLUE + "44"), borderRadius: 10, padding: "12px 16px", cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", transition: "all 0.12s" }}>
                            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                              <div style={{ width: 34, height: 34, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                                  <span style={{ fontSize: 13, fontWeight: em.isRead ? 500 : 700, color: TH.text }}>{sender}</span>
                                  <span style={{ fontSize: 11, color: TH.textMuted }}>{time}</span>
                                  {em.hasAttachments && <span style={{ fontSize: 11, color: TH.textMuted }}>📎</span>}
                                  {!em.isRead && <span style={{ width: 8, height: 8, borderRadius: "50%", background: OUTLOOK_BLUE, flexShrink: 0 }} />}
                                </div>
                                <div style={{ fontSize: 13, fontWeight: em.isRead ? 400 : 600, color: TH.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{em.subject}</div>
                                <div style={{ fontSize: 12, color: TH.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{em.bodyPreview || ""}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {nextLinks[selectedCollKey] && (
                        <button onClick={() => loadEmails(selectedCollKey, nextLinks[selectedCollKey])} disabled={loadingOlder} style={{ ...S.btn, width: "100%", padding: "10px", opacity: loadingOlder ? 0.6 : 1, fontSize: 12, background: `linear-gradient(135deg,${OUTLOOK_BLUE},${OUTLOOK_BLUE_LT})` }}>{loadingOlder ? "Loading…" : "Load older emails"}</button>
                      )}
                    </div>
                  )
                ) : emailTab === "thread" ? (
                  <div>
                    {loadingThread ? (
                      <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 24, fontSize: 13 }}>Loading thread…</div>
                    ) : thread.length === 0 ? (
                      <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40, fontSize: 13 }}>Click an email to view its conversation thread</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                        {thread.map(msg => {
                          const sender = (msg.from && msg.from.emailAddress) ? msg.from.emailAddress.name || msg.from.emailAddress.address : "Unknown";
                          const initials = sender.split(" ").map(w => w[0] || "").join("").toUpperCase().slice(0, 2);
                          const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                          const htmlBody = (msg.body && msg.body.content) || "";
                          return (
                            <div key={msg.id} style={{ background: "#fff", border: "1px solid " + TH.border, borderRadius: 10, padding: "14px 18px" }}>
                              <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
                                <div style={{ width: 30, height: 30, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                                <div style={{ flex: 1 }}>
                                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                                    <span style={{ fontSize: 13, fontWeight: 700, color: TH.text }}>{sender}</span>
                                    <span style={{ fontSize: 11, color: TH.textMuted }}>{time}</span>
                                  </div>
                                  <div style={{ fontSize: 12, color: TH.textMuted }}>{msg.subject}</div>
                                </div>
                              </div>
                              <iframe sandbox="allow-same-origin" srcDoc={htmlBody} style={{ width: "100%", border: "none", minHeight: 100, borderRadius: 6, background: "#FAFAFA" }}
                                onLoad={e => { try { const h = e.target.contentDocument.body.scrollHeight; e.target.style.height = Math.min(h + 20, 400) + "px"; } catch (_) {} }} />
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {selectedEmail && (
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <input value={replyText} onChange={e => setReplyText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); replyToEmail(selectedEmail.id, replyText); setReplyText(""); } }} placeholder="Write a reply…" style={{ ...S.inp, flex: 1, marginBottom: 0 }} />
                        <button onClick={() => { replyToEmail(selectedEmail.id, replyText); setReplyText(""); }} style={{ ...S.btn, background: `linear-gradient(135deg,${OUTLOOK_BLUE},${OUTLOOK_BLUE_LT})` }}>Reply</button>
                      </div>
                    )}
                  </div>
                ) : emailTab === "compose" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div>
                      <label style={S.lbl}>To (comma-separated)</label>
                      <input value={composeTo} onChange={e => setComposeTo(e.target.value)} placeholder="email@example.com" style={{ ...S.inp, marginBottom: 0 }} />
                    </div>
                    <div>
                      <label style={S.lbl}>Subject</label>
                      <input value={composeSubject} onChange={e => setComposeSubject(e.target.value)} style={{ ...S.inp, marginBottom: 0 }} />
                    </div>
                    <div>
                      <label style={S.lbl}>Body</label>
                      <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} rows={10} style={{ ...S.inp, marginBottom: 0, resize: "vertical", minHeight: 150 }} placeholder="Type your message…" />
                    </div>
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                      <button onClick={() => setEmailTab("inbox")} style={{ padding: "9px 18px", borderRadius: 8, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                      <button onClick={sendEmail} disabled={!composeTo.trim() || !composeSubject.trim()} style={{ ...S.btn, background: `linear-gradient(135deg,${OUTLOOK_BLUE},${OUTLOOK_BLUE_LT})`, opacity: (!composeTo.trim() || !composeSubject.trim()) ? 0.5 : 1 }}>Send Email</button>
                    </div>
                  </div>
                ) : null}
              </div>

              {prefix && token && emailTab === "inbox" && (
                <div style={{ borderTop: "1px solid " + TH.border, background: "#fff", flexShrink: 0 }}>
                  {sendError && (
                    <div style={{ padding: "6px 20px", background: "#FEF2F2", borderBottom: "1px solid #FCA5A5", display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, color: "#B91C1C", flex: 1 }}>⚠ {sendError}</span>
                      <button onClick={() => setSendError(null)} style={{ fontSize: 11, border: "none", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>✕</button>
                    </div>
                  )}
                  <div style={{ padding: "10px 20px", display: "flex", gap: 8, alignItems: "center" }}>
                    <button onClick={() => { setEmailTab("compose"); setComposeSubject(prefix + " "); }} style={{ ...S.btn, fontSize: 11, padding: "7px 14px", background: `linear-gradient(135deg,${OUTLOOK_BLUE},${OUTLOOK_BLUE_LT})` }}>+ New Email</button>
                    <span style={{ fontSize: 11, color: TH.textMuted }}>{emailList.length} email{emailList.length !== 1 ? "s" : ""} matching "{prefix}"</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}


export default OutlookView;
