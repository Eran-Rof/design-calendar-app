import React, { useState, useEffect, useRef } from "react";
import { OUTLOOK_BLUE, OUTLOOK_BLUE_LT } from "../utils/theme";
import { msSignIn, loadMsTokens, getMsAccessToken, MS_CLIENT_ID, MS_TENANT_ID } from "../utils/msAuth";
import { styledEmailHtml } from "../utils/emailHtml";

// ─── Dark theme tokens ────────────────────────────────────────────────────────
const C = {
  bg0: "#0F172A", bg1: "#1E293B", bg2: "#253347", bg3: "#2D3D52",
  border: "#334155", border2: "#3E4F66",
  text1: "#F1F5F9", text2: "#94A3B8", text3: "#6B7280",
  outlook: "#0078D4", outlookLt: "#106EBE", outlookDim: "rgba(0,120,212,0.15)",
  error: "#EF4444", errorDim: "rgba(239,68,68,0.15)",
  success: "#34D399", info: "#60A5FA", warning: "#FBBF24",
};

function Avatar({ initials, color, size = 32 }: { initials: string; color: string; size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: color + "33", border: "2px solid " + color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.35, fontWeight: 700, color, flexShrink: 0 }}>
      {initials}
    </div>
  );
}

function FolderIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 14" fill="none" style={{ flexShrink: 0 }}>
      <path d="M1 2.5C1 1.67 1.67 1 2.5 1H5.5L7 2.5H13.5C14.33 2.5 15 3.17 15 4V11.5C15 12.33 14.33 13 13.5 13H2.5C1.67 13 1 12.33 1 11.5V2.5Z" stroke={color} strokeWidth="1.2" fill="none"/>
    </svg>
  );
}

// ─── MICROSOFT OUTLOOK EMAIL VIEW ─────────────────────────────────────────────
function OutlookView({ collList, collMap, collections, isAdmin, teamsConfig, setTeamsConfig, teamsToken, setTeamsToken, teamsTokenExpiry, setTeamsTokenExpiry, showEmailConfig, setShowEmailConfig, getBrand }) {
  // Core state
  const [selectedCollKey, setSelectedCollKey] = useState<string | null>(null);
  const [collSearch, setCollSearch] = useState("");
  const [emails, setEmails] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [selectedEmail, setSelectedEmail] = useState<any>(null);
  const [thread, setThread] = useState<any[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [nextLinks, setNextLinks] = useState<Record<string, string | null>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Record<string, number>>({});
  const [sentEmails, setSentEmails] = useState<Record<string, any[]>>({});
  const [sentLoading, setSentLoading] = useState<Record<string, boolean>>({});
  const [sentErrors, setSentErrors] = useState<Record<string, string | null>>({});
  const [sentNextLinks, setSentNextLinks] = useState<Record<string, string | null>>({});
  const [sentLoadingOlder, setSentLoadingOlder] = useState(false);
  const [configForm, setConfigForm] = useState({ ...teamsConfig });
  const [authStatus, setAuthStatus] = useState("idle");
  const [replyText, setReplyText] = useState("");
  // 3-panel UI state
  const [activeFolder, setActiveFolder] = useState<"inbox" | "sent">("inbox");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterUnread, setFilterUnread] = useState(false);
  const [filterFlagged, setFilterFlagged] = useState(false);
  const [flaggedSet, setFlaggedSet] = useState(new Set<string>());
  const [collapsedMsgs, setCollapsedMsgs] = useState(new Set<string>());
  const [composeOpen, setComposeOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [msDisplayName, setMsDisplayName] = useState("");
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; em: any } | null>(null);
  const [attachments, setAttachments] = useState<Record<string, any[]>>({});
  const [attachmentsLoading, setAttachmentsLoading] = useState<Record<string, boolean>>({});
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const token = teamsToken;
  const cfg = teamsConfig;

  // ── Auth ─────────────────────────────────────────────────────────────────────
  function tokenIsValid() { return !!token && (!teamsTokenExpiry || Date.now() < teamsTokenExpiry); }
  function handleTokenExpired() { setTeamsToken(null); setTeamsTokenExpiry(null); setAuthStatus("idle"); }
  async function authenticate() {
    if (!MS_CLIENT_ID || !MS_TENANT_ID) { setAuthStatus("error"); return; }
    setAuthStatus("loading");
    try {
      const tokens = await msSignIn();
      setTeamsToken(tokens.accessToken);
      setTeamsTokenExpiry(tokens.expiresAt);
      setAuthStatus("ok");
    } catch { setAuthStatus("error"); }
  }

  // ── Graph helpers ─────────────────────────────────────────────────────────────
  async function graph(path: string) {
    if (!tokenIsValid()) { handleTokenExpired(); throw new Error("Token expired — please sign in again"); }
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
    if (r.status === 401) { handleTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  async function graphPost(path: string, body: any) {
    if (!tokenIsValid()) { handleTokenExpired(); throw new Error("Token expired — please sign in again"); }
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { handleTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (r.status === 202 || r.status === 200) return r.status === 202 ? {} : r.json();
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  async function graphDelete(path: string) {
    if (!tokenIsValid()) { handleTokenExpired(); return; }
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "DELETE", headers: { Authorization: "Bearer " + token } });
    if (r.status === 401) { handleTokenExpired(); throw new Error("Session expired"); }
  }

  // ── Prefix helpers ────────────────────────────────────────────────────────────
  function getPrefix(collKey: string) { return (cfg.emailMap && cfg.emailMap[collKey]) || null; }
  function mapPrefix(collKey: string, prefix: string) {
    const updated = { ...cfg, emailMap: { ...cfg.emailMap, [collKey]: prefix } };
    setTeamsConfig(updated);
    try { localStorage.setItem("teamsConfig", JSON.stringify(updated)); } catch {}
  }

  // ── Data loading ──────────────────────────────────────────────────────────────
  async function loadEmails(collKey: string, olderUrl?: string, overridePrefix?: string) {
    const prefix = overridePrefix || getPrefix(collKey);
    if (!prefix || !token) return;
    if (olderUrl) { setLoadingOlder(true); } else { setLoading(l => ({ ...l, [collKey]: true })); }
    setErrors(e => ({ ...e, [collKey]: null }));
    try {
      const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const url = olderUrl || ("/me/mailFolders/Inbox/messages?$search=" + encodeURIComponent('"' + searchTerm + '"') + "&$top=25&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments");
      const d = await graph(url);
      const items = d.value || [];
      if (olderUrl) { setEmails(m => ({ ...m, [collKey]: [...(m[collKey] || []), ...items] })); }
      else { setEmails(m => ({ ...m, [collKey]: items })); }
      setNextLinks(nl => ({ ...nl, [collKey]: d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null }));
      setLastRefresh(lr => ({ ...lr, [collKey]: Date.now() }));
    } catch (e: any) { setErrors(err => ({ ...err, [collKey]: e.message })); }
    setLoading(l => ({ ...l, [collKey]: false }));
    setLoadingOlder(false);
  }

  async function loadSentEmails(collKey: string, olderUrl?: string) {
    const prefix = getPrefix(collKey);
    if (!prefix || !token) return;
    if (olderUrl) { setSentLoadingOlder(true); } else { setSentLoading(l => ({ ...l, [collKey]: true })); }
    setSentErrors(e => ({ ...e, [collKey]: null }));
    try {
      const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const url = olderUrl || ("/me/mailFolders/SentItems/messages?$search=" + encodeURIComponent('"' + searchTerm + '"') + "&$top=25&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview,conversationId,hasAttachments");
      const d = await graph(url);
      const items = d.value || [];
      if (olderUrl) { setSentEmails(m => ({ ...m, [collKey]: [...(m[collKey] || []), ...items] })); }
      else { setSentEmails(m => ({ ...m, [collKey]: items })); }
      setSentNextLinks(nl => ({ ...nl, [collKey]: d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null }));
    } catch (e: any) { setSentErrors(err => ({ ...err, [collKey]: e.message })); }
    setSentLoading(l => ({ ...l, [collKey]: false }));
    setSentLoadingOlder(false);
  }

  async function loadFullEmail(id: string) {
    try { const d = await graph("/me/messages/" + id); setSelectedEmail(d); } catch (e) { console.error(e); }
  }

  async function markAsRead(id: string) {
    try {
      await fetch("https://graph.microsoft.com/v1.0/me/messages/" + id, {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      });
    } catch {}
  }

  async function loadThread(conversationId: string) {
    setLoadingThread(true);
    try {
      const d = await graph("/me/messages?$filter=" + encodeURIComponent("conversationId eq '" + conversationId + "'") + "&$orderby=receivedDateTime%20asc&$select=id,subject,from,receivedDateTime,body,conversationId,isRead,hasAttachments");
      setThread(d.value || []);
    } catch (e) { setThread([]); console.error(e); }
    setLoadingThread(false);
  }

  async function sendEmail() {
    if (!composeTo.trim() || !composeSubject.trim()) return;
    const invalidAddr = composeTo.split(",").map(a => a.trim()).filter(a => a && !a.includes("@"));
    if (invalidAddr.length > 0) { setSendError("Invalid email address: \"" + invalidAddr[0] + "\" — must be a full address like name@domain.com"); return; }
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
      setComposeOpen(false);
      if (selectedCollKey) setTimeout(() => loadEmails(selectedCollKey), 2000);
    } catch (e: any) { setSendError("Failed to send: " + e.message); }
  }

  async function replyToEmail(messageId: string, comment: string) {
    if (!comment.trim()) return;
    setSendError(null);
    try {
      await graphPost("/me/messages/" + messageId + "/reply", { comment });
      if (selectedEmail && selectedEmail.conversationId) loadThread(selectedEmail.conversationId);
      setReplyText("");
    } catch (e: any) { setSendError("Failed to reply: " + e.message); }
  }

  async function replyAllToEmail(messageId: string, comment: string) {
    if (!comment.trim()) return;
    setSendError(null);
    try {
      await graphPost("/me/messages/" + messageId + "/replyAll", { comment });
      if (selectedEmail && selectedEmail.conversationId) loadThread(selectedEmail.conversationId);
      setReplyText("");
    } catch (e: any) { setSendError("Failed to reply all: " + e.message); }
  }

  async function loadAttachments(messageId: string) {
    if (attachments[messageId] !== undefined) return; // already loaded
    setAttachmentsLoading(a => ({ ...a, [messageId]: true }));
    try {
      const d = await graph("/me/messages/" + messageId + "/attachments");
      setAttachments(a => ({ ...a, [messageId]: d.value || [] }));
    } catch { setAttachments(a => ({ ...a, [messageId]: [] })); }
    setAttachmentsLoading(a => ({ ...a, [messageId]: false }));
  }

  async function deleteEmail(messageId: string) {
    try {
      await graphDelete("/me/messages/" + messageId);
      setSelectedEmailId(null); setSelectedEmail(null); setDeleteConfirm(null); setThread([]);
      if (selectedCollKey) {
        setEmails(m => ({ ...m, [selectedCollKey]: (m[selectedCollKey] || []).filter(e => e.id !== messageId) }));
        setSentEmails(m => ({ ...m, [selectedCollKey]: (m[selectedCollKey] || []).filter(e => e.id !== messageId) }));
      }
    } catch (e) { console.error(e); }
  }

  function selectEmail(em: any) {
    setSelectedEmailId(em.id);
    setDeleteConfirm(null);
    setReplyText("");
    if (activeFolder === "inbox" && !em.isRead) {
      // Mark as read on the server so re-fetches reflect the correct read state
      markAsRead(em.id);
      setEmails(m => ({ ...m, [selectedCollKey!]: (m[selectedCollKey!] || []).map(e => e.id === em.id ? { ...e, isRead: true } : e) }));
    }
    if (em.hasAttachments) loadAttachments(em.id);
    loadFullEmail(em.id);
    if (em.conversationId) loadThread(em.conversationId);
  }

  // ── Effects ───────────────────────────────────────────────────────────────────
  // Auto-restore stored MS token on mount (same as PO WIP / Tech Pack)
  useEffect(() => {
    if (token) return;
    getMsAccessToken().then(t => {
      if (t) {
        const stored = loadMsTokens();
        setTeamsToken(t);
        if (stored?.expiresAt) setTeamsTokenExpiry(stored.expiresAt);
        setAuthStatus("ok");
      }
    }).catch(() => {});
  }, []);

  // Dismiss context menu on click-outside
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => setCtxMenu(null);
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [ctxMenu]);

  useEffect(() => {
    if (!selectedCollKey || !token) return;
    let p = getPrefix(selectedCollKey);
    if (!p && collMap[selectedCollKey]) {
      p = "[" + collMap[selectedCollKey].collection + "]";
      mapPrefix(selectedCollKey, p);
    }
    if (p) loadEmails(selectedCollKey, undefined, p);
  }, [selectedCollKey, token]);

  useEffect(() => {
    if (activeFolder === "sent" && selectedCollKey && token) loadSentEmails(selectedCollKey);
  }, [activeFolder, selectedCollKey, token]);

  useEffect(() => {
    if (!selectedCollKey || !tokenIsValid() || !getPrefix(selectedCollKey)) return;
    const interval = setInterval(() => { if (tokenIsValid()) loadEmails(selectedCollKey!); }, 120000);
    return () => clearInterval(interval);
  }, [selectedCollKey, token, teamsTokenExpiry]);

  useEffect(() => {
    if (!token) { setMsDisplayName(""); return; }
    graph("/me?$select=displayName,mail").then(d => setMsDisplayName(d.displayName || d.mail || "")).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (thread.length > 1) setCollapsedMsgs(new Set(thread.slice(0, -1).map(m => m.id)));
    else setCollapsedMsgs(new Set());
  }, [thread]);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const selectedColl = selectedCollKey ? collMap[selectedCollKey] : null;
  const brand = selectedColl ? getBrand(selectedColl.brand) : null;
  const prefix = selectedCollKey ? getPrefix(selectedCollKey) : null;
  const emailList = (selectedCollKey ? emails[selectedCollKey] : null) || [];
  const sentList = (selectedCollKey ? sentEmails[selectedCollKey] : null) || [];
  const isLoadingEmails = selectedCollKey ? !!loading[selectedCollKey] : false;
  const isSentLoading = selectedCollKey ? !!sentLoading[selectedCollKey] : false;
  const emailError = selectedCollKey ? errors[selectedCollKey] : null;
  const sentErr = selectedCollKey ? sentErrors[selectedCollKey] : null;

  const activeList = activeFolder === "inbox" ? emailList : sentList;
  const visibleEmails = activeList.filter(em => {
    if (filterUnread && em.isRead) return false;
    if (filterFlagged && !flaggedSet.has(em.id)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const sender = em.from?.emailAddress?.name || em.from?.emailAddress?.address || "";
      const toStr = (em.toRecipients || []).map((r: any) => r.emailAddress?.name || r.emailAddress?.address || "").join(" ");
      if (!(em.subject || "").toLowerCase().includes(q) && !sender.toLowerCase().includes(q) && !(em.bodyPreview || "").toLowerCase().includes(q) && !toStr.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const iconBtn: React.CSSProperties = { width: 28, height: 28, borderRadius: 6, border: "none", background: "transparent", color: C.text3, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" };

  if (showEmailConfig) return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "8px 0" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.text1, marginBottom: 18 }}>Outlook Email Configuration</div>
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px", marginBottom: 18, fontSize: 12, color: C.text2, lineHeight: 1.6 }}>
        <b>Azure AD credentials</b> are configured via Vercel environment variables (VITE_AZURE_CLIENT_ID / VITE_AZURE_TENANT_ID).
        Redirect URI: <b>{window.location.origin}/auth-callback</b>.
        {MS_CLIENT_ID ? <span style={{ marginLeft: 8, color: C.success, fontWeight: 700 }}>✓ Credentials configured</span> : <span style={{ marginLeft: 8, color: C.error, fontWeight: 700 }}>✗ Credentials missing</span>}
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
        <button onClick={() => setShowEmailConfig(false)} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit" }}>Close</button>
      </div>
    </div>
  );

  return (
    <div style={{ position: "relative" }}>
      {/* Close button */}
      <button onClick={() => { const ev = new CustomEvent("closeEmailView"); window.dispatchEvent(ev); }} title="Close Email"
        style={{ position: "absolute", top: 10, right: 14, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: `1px solid ${C.outlook}44`, background: `${C.outlook}15`, color: C.outlook, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>✕</button>

      <div style={{ display: "flex", height: "calc(100vh - 140px)", minHeight: 500, background: C.bg0, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden", position: "relative", fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: 13, color: C.text1 }}>

        {/* ── SIDEBAR (220px) ──────────────────────────────────────────────────── */}
        <div style={{ width: 220, minWidth: 220, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Compose button */}
          <div style={{ padding: "14px 12px 10px", borderBottom: `1px solid ${C.border}` }}>
            <button
              onClick={() => { setComposeOpen(true); setComposeSubject((prefix || "") + " "); setSendError(null); }}
              disabled={!token}
              style={{ width: "100%", padding: "8px 12px", background: token ? `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})` : C.bg2, border: "none", borderRadius: 8, color: token ? "#fff" : C.text3, fontSize: 13, fontWeight: 500, cursor: token ? "pointer" : "default", display: "flex", alignItems: "center", gap: 8, justifyContent: "center", fontFamily: "inherit" }}>
              ✎ New Message
            </button>
          </div>

          {/* Projects label + search */}
          <div style={{ padding: "10px 12px 4px", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: C.text3, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Projects ({collList.length})</span>
            {isAdmin && <button onClick={() => { setConfigForm({ ...cfg }); setShowEmailConfig(true); }} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit" }}>⚙</button>}
          </div>
          <div style={{ padding: "4px 8px 6px" }}>
            <input value={collSearch} onChange={e => setCollSearch(e.target.value)} placeholder="🔍 Search…"
              style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text1, fontSize: 11, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
          </div>

          {/* Collection list */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {(() => {
              const s = collSearch.toLowerCase();
              return collList.filter((c: any) => {
                if (!s) return true;
                const b = getBrand(c.brand);
                const skus = (collections[c.key] || {}).skus || [];
                return (c.collection || "").toLowerCase().includes(s) || (c.vendorName || "").toLowerCase().includes(s)
                  || (b ? b.name : "").toLowerCase().includes(s)
                  || skus.some((sk: any) => ((sk.styleNum || "") + " " + (sk.name || "")).toLowerCase().includes(s));
              }).sort((a: any, b: any) => {
                const ua = (emails[a.key] || []).filter((e: any) => !e.isRead).length;
                const ub = (emails[b.key] || []).filter((e: any) => !e.isRead).length;
                return ub - ua;
              });
            })().map((c: any) => {
              const b = getBrand(c.brand);
              const hasPrefix = !!(cfg.emailMap && cfg.emailMap[c.key]);
              const isSelected = selectedCollKey === c.key;
              const unread = (emails[c.key] || []).filter(e => !e.isRead).length;
              return (
                <div key={c.key}
                  onClick={() => { setSelectedCollKey(c.key === selectedCollKey ? null : c.key); setActiveFolder("inbox"); setSelectedEmail(null); setSelectedEmailId(null); setThread([]); setDeleteConfirm(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", borderRadius: 7, margin: "1px 6px", cursor: "pointer", fontSize: 12, background: isSelected ? C.outlookDim : "transparent", color: isSelected ? C.info : C.text2, border: isSelected ? "1px solid rgba(96,165,250,0.2)" : "1px solid transparent", transition: "all 0.1s" }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: b ? b.color : "#6B7280", flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.collection}</span>
                  {unread > 0 && <span style={{ background: C.outlook, color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 10, minWidth: 16, textAlign: "center" as const }}>{unread}</span>}
                  {!hasPrefix && <span style={{ fontSize: 9, color: C.text3 }} title="Not linked">—</span>}
                </div>
              );
            })}
            {collList.length === 0 && <div style={{ padding: 16, fontSize: 12, color: C.text3, textAlign: "center" }}>No collections yet</div>}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: C.border, margin: "4px 10px" }} />

          {/* Folders */}
          <div style={{ padding: "6px 12px 2px", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: C.text3, fontWeight: 600 }}>Folders</div>
          {(["inbox", "sent"] as const).map(f => {
            const label = f === "inbox" ? "Inbox" : "Sent";
            const count = f === "inbox" ? emailList.filter(e => !e.isRead).length : 0;
            return (
              <div key={f} onClick={() => { setActiveFolder(f); setSelectedEmailId(null); setSelectedEmail(null); setThread([]); }}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, margin: "1px 6px", cursor: "pointer", fontSize: 12, background: activeFolder === f ? "rgba(200,33,10,0.15)" : "transparent", color: activeFolder === f ? "#E87060" : C.text2, transition: "all 0.1s" }}>
                <FolderIcon size={13} color={activeFolder === f ? "#E87060" : C.text3} />
                <span style={{ flex: 1 }}>{label}</span>
                {count > 0 && <span style={{ background: C.bg3, color: C.text2, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 10, minWidth: 18, textAlign: "center" as const }}>{count}</span>}
              </div>
            );
          })}

          {/* Account footer */}
          <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            {token ? (
              <>
                <Avatar initials={(msDisplayName || "Me").slice(0, 2).toUpperCase()} color={C.outlook} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 500, color: C.text1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{msDisplayName || "Microsoft Account"}</div>
                </div>
                <div style={{ background: "#064E3B", border: "1px solid #34D39944", borderRadius: 5, padding: "2px 6px", fontSize: 9, color: C.success, whiteSpace: "nowrap", cursor: "pointer" }}
                  onClick={() => { setTeamsToken(null); setTeamsTokenExpiry(null); setAuthStatus("idle"); setMsDisplayName(""); }}
                  title="Click to sign out">● Live</div>
              </>
            ) : (
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.warning, fontWeight: 600, marginBottom: 5 }}>{authStatus === "error" ? "Auth failed — check config" : "Sign in to load emails"}</div>
                {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                  <div style={{ fontSize: 10, color: "#D97706" }}>Azure credentials not configured</div>
                ) : (
                  <button onClick={authenticate} disabled={authStatus === "loading"}
                    style={{ background: `linear-gradient(135deg,${C.outlook},${C.outlookLt})`, color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: authStatus === "loading" ? 0.6 : 1, width: "100%" }}>
                    {authStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── EMAIL LIST (295px) ───────────────────────────────────────────────── */}
        <div style={{ width: 295, minWidth: 295, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column" }}>

          {/* List header */}
          <div style={{ padding: "12px 12px 8px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.text1 }}>
              {activeFolder === "inbox" ? "Inbox" : "Sent"}
              {selectedColl && <span style={{ fontSize: 11, color: C.text3, marginLeft: 6, fontWeight: 400 }}>· {selectedColl.collection}</span>}
            </span>
            <button style={iconBtn} title="Refresh"
              onClick={() => { if (selectedCollKey) { if (activeFolder === "inbox") loadEmails(selectedCollKey); else loadSentEmails(selectedCollKey); } }}>↻</button>
          </div>

          {/* Search */}
          <div style={{ position: "relative" as const, margin: "8px 10px" }}>
            <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: C.text3, fontSize: 13, pointerEvents: "none" }}>⌕</span>
            <input style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 10px 6px 28px", color: C.text1, fontSize: 12, outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit" }}
              placeholder="Search…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>

          {/* Filter pills */}
          <div style={{ display: "flex", gap: 4, padding: "6px 8px", borderBottom: `1px solid ${C.border}` }}>
            {(["All", "Unread", "Flagged"] as const).map(label => {
              const isActive = label === "All" ? (!filterUnread && !filterFlagged) : label === "Unread" ? filterUnread : filterFlagged;
              return (
                <div key={label} onClick={() => { if (label === "All") { setFilterUnread(false); setFilterFlagged(false); } else if (label === "Unread") { setFilterUnread(v => !v); setFilterFlagged(false); } else { setFilterFlagged(v => !v); setFilterUnread(false); } }}
                  style={{ padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 500, cursor: "pointer", background: isActive ? C.outlookDim : "transparent", color: isActive ? C.info : C.text3, border: isActive ? "1px solid rgba(96,165,250,0.3)" : "1px solid transparent" }}>
                  {label}
                </div>
              );
            })}
          </div>

          {/* Email rows */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {!token ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 12 }}>Sign in to load emails</div>
            ) : !selectedCollKey ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 12 }}>Select a collection from the left</div>
            ) : !prefix ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 12 }}>Setting up email filter…</div>
            ) : (isLoadingEmails && activeFolder === "inbox") || (isSentLoading && activeFolder === "sent") ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>Loading emails…</div>
            ) : (emailError && activeFolder === "inbox") || (sentErr && activeFolder === "sent") ? (
              <div style={{ margin: 10, background: C.bg0, border: `1px solid ${C.error}44`, borderRadius: 8, padding: "10px 14px", color: C.error, fontSize: 12 }}>⚠ {emailError || sentErr}</div>
            ) : visibleEmails.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>No messages</div>
            ) : (
              <>
                {visibleEmails.map((em: any) => {
                  const sender = activeFolder === "inbox"
                    ? (em.from?.emailAddress?.name || em.from?.emailAddress?.address || "Unknown")
                    : "To: " + ((em.toRecipients || []).map((r: any) => r.emailAddress?.name || r.emailAddress?.address || "").filter(Boolean).join(", ") || "—");
                  const time = em.receivedDateTime
                    ? new Date(em.receivedDateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : em.sentDateTime
                    ? new Date(em.sentDateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : "";
                  const isFlagged = flaggedSet.has(em.id);
                  const isUnread = !em.isRead && activeFolder === "inbox";
                  return (
                    <div key={em.id} onClick={() => selectEmail(em)}
                      onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, em }); }}
                      style={{ padding: "11px 12px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative" as const, background: selectedEmailId === em.id ? C.bg3 : "transparent", transition: "background 0.1s" }}>
                      {isUnread && <div style={{ position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)", width: 5, height: 5, borderRadius: "50%", background: C.outlook }} />}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                        <span style={{ fontSize: 12, fontWeight: isUnread ? 600 : 400, color: isUnread ? C.text1 : C.text2, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {sender}
                          {isFlagged && <span style={{ color: C.warning, marginLeft: 4, fontSize: 11 }}>★</span>}
                        </span>
                        <span style={{ fontSize: 11, color: C.text3, flexShrink: 0, marginLeft: 6 }}>{time}</span>
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 500, color: C.text1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{em.subject}</div>
                      <div style={{ fontSize: 11, color: C.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {em.hasAttachments && <span style={{ marginRight: 4 }}>📎</span>}
                        {em.bodyPreview || ""}
                      </div>
                    </div>
                  );
                })}
                {activeFolder === "inbox" && nextLinks[selectedCollKey!] && (
                  <button onClick={() => loadEmails(selectedCollKey!, nextLinks[selectedCollKey!]!)} disabled={loadingOlder}
                    style={{ background: `linear-gradient(135deg,${C.outlook},${C.outlookLt})`, color: "#fff", border: "none", borderRadius: 0, padding: "10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%", opacity: loadingOlder ? 0.6 : 1 }}>
                    {loadingOlder ? "Loading…" : "Load older"}
                  </button>
                )}
                {activeFolder === "sent" && sentNextLinks[selectedCollKey!] && (
                  <button onClick={() => loadSentEmails(selectedCollKey!, sentNextLinks[selectedCollKey!]!)} disabled={sentLoadingOlder}
                    style={{ background: `linear-gradient(135deg,${C.outlook},${C.outlookLt})`, color: "#fff", border: "none", borderRadius: 0, padding: "10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%", opacity: sentLoadingOlder ? 0.6 : 1 }}>
                    {sentLoadingOlder ? "Loading…" : "Load older"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── EMAIL DETAIL (flex-1) ─────────────────────────────────────────────── */}
        <div style={{ flex: 1, background: C.bg0, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {!selectedEmailId ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: C.text3 }}>
              <span style={{ fontSize: 48, opacity: 0.25 }}>✉</span>
              <span style={{ fontSize: 14 }}>{selectedCollKey ? "Select a message to read" : "Select a collection from the left"}</span>
            </div>
          ) : (
            <>
              {/* Detail header */}
              <div style={{ padding: "12px 50px 10px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: C.text1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedEmail?.subject || "Loading…"}
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button style={iconBtn} title="Flag"
                    onClick={() => setFlaggedSet(prev => { const s = new Set(prev); if (s.has(selectedEmailId)) s.delete(selectedEmailId); else s.add(selectedEmailId); return s; })}>
                    <span style={{ color: flaggedSet.has(selectedEmailId) ? C.warning : C.text3 }}>{flaggedSet.has(selectedEmailId) ? "★" : "☆"}</span>
                  </button>
                  <button style={iconBtn} title="Reply" onClick={() => { replyRef.current?.focus(); replyRef.current?.scrollIntoView({ behavior: "smooth" }); }}>↩</button>
                  <button style={iconBtn} title="Reply All" onClick={() => { replyRef.current?.focus(); replyRef.current?.scrollIntoView({ behavior: "smooth" }); }}>↩↩</button>
                  <button style={{ ...iconBtn, color: C.error }} title="Delete" onClick={() => setDeleteConfirm(selectedEmailId)}>🗑️</button>
                </div>
              </div>

              {/* Delete confirm bar */}
              {deleteConfirm === selectedEmailId && (
                <div style={{ background: C.errorDim, borderBottom: `1px solid rgba(239,68,68,0.3)`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 13, color: C.error, flex: 1 }}>Permanently delete this message? This cannot be undone.</span>
                  <button onClick={() => deleteEmail(selectedEmailId)}
                    style={{ padding: "7px 14px", background: C.errorDim, border: `1px solid rgba(239,68,68,0.3)`, borderRadius: 7, color: C.error, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>
                    Delete
                  </button>
                  <button style={{ ...iconBtn, color: C.text2 }} onClick={() => setDeleteConfirm(null)}>✕</button>
                </div>
              )}

              {/* Error bar */}
              {sendError && (
                <div style={{ background: C.bg1, borderBottom: `1px solid ${C.error}44`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 13, color: C.error, flex: 1 }}>⚠ {sendError}</span>
                  <button style={{ ...iconBtn, color: C.text2 }} onClick={() => setSendError(null)}>✕</button>
                </div>
              )}

              {/* Thread */}
              <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
                {loadingThread ? (
                  <div style={{ textAlign: "center", color: C.text3, paddingTop: 40, fontSize: 13 }}>Loading conversation…</div>
                ) : thread.length > 0 ? (
                  thread.map((msg: any, i: number) => {
                    const isLast = i === thread.length - 1;
                    const collapsed = !isLast && collapsedMsgs.has(msg.id);
                    const sender = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown";
                    const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2) || "??";
                    const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                    const htmlBody = msg.body?.content || "";
                    return (
                      <div key={msg.id} style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 10, overflow: "hidden" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: !isLast ? "pointer" : "default" }}
                          onClick={() => { if (!isLast) setCollapsedMsgs(prev => { const s = new Set(prev); if (s.has(msg.id)) s.delete(msg.id); else s.add(msg.id); return s; }); }}>
                          <Avatar initials={initials} color={C.outlook} size={32} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: C.text1 }}>{sender}</div>
                            <div style={{ fontSize: 11, color: C.text3 }}>{msg.from?.emailAddress?.address || ""}</div>
                          </div>
                          <div style={{ fontSize: 11, color: C.text3, flexShrink: 0 }}>{time}</div>
                          {!isLast && <span style={{ color: C.text3, fontSize: 12, marginLeft: 8 }}>{collapsed ? "▼" : "▲"}</span>}
                        </div>
                        {!collapsed && (
                          <div style={{ padding: "0 14px 14px" }}>
                            <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(htmlBody)}
                              style={{ width: "100%", border: "none", minHeight: 80, borderRadius: 6, background: "#F8FAFC" }}
                              onLoad={e => { try { const h = (e.target as HTMLIFrameElement).contentDocument?.body.scrollHeight || 0; (e.target as HTMLIFrameElement).style.height = Math.min(h + 20, 400) + "px"; } catch {} }} />
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : selectedEmail ? (
                  <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.text3 }}>
                      From: {selectedEmail.from?.emailAddress?.name || selectedEmail.from?.emailAddress?.address || "Unknown"}
                    </div>
                    <div style={{ padding: "0 14px 14px" }}>
                      <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(selectedEmail.body?.content || "")}
                        style={{ width: "100%", border: "none", minHeight: 100, borderRadius: 6, background: "#F8FAFC" }}
                        onLoad={e => { try { const h = (e.target as HTMLIFrameElement).contentDocument?.body.scrollHeight || 0; (e.target as HTMLIFrameElement).style.height = Math.min(h + 20, 400) + "px"; } catch {} }} />
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Attachments */}
              {selectedEmailId && (attachments[selectedEmailId] || []).length > 0 && (
                <div style={{ borderTop: `1px solid ${C.border}`, padding: "8px 18px", background: C.bg1, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: C.text3, marginRight: 4 }}>📎 Attachments:</span>
                  {attachments[selectedEmailId].map((att: any) => {
                    const href = att.contentBytes
                      ? `data:${att.contentType || "application/octet-stream"};base64,${att.contentBytes}`
                      : "#";
                    return (
                      <a key={att.id} href={href} download={att.name}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 9px", fontSize: 11, color: C.info, textDecoration: "none", cursor: "pointer", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        📄 {att.name}
                        <span style={{ fontSize: 10, color: C.text3, flexShrink: 0 }}>
                          {att.size ? ` (${(att.size / 1024).toFixed(0)}KB)` : ""}
                        </span>
                      </a>
                    );
                  })}
                  {attachmentsLoading[selectedEmailId] && <span style={{ fontSize: 11, color: C.text3 }}>Loading…</span>}
                </div>
              )}

              {/* Reply area */}
              <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 18px", background: C.bg1 }}>
                <div style={{ fontSize: 12, color: C.text3, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>Reply to <span style={{ color: C.info }}>{thread.length > 0 ? (thread[thread.length - 1].from?.emailAddress?.address || "") : (selectedEmail?.from?.emailAddress?.address || "")}</span></span>
                </div>
                <textarea
                  ref={replyRef}
                  style={{ width: "100%", minHeight: 72, background: "transparent", border: "none", color: C.text1, fontSize: 13, fontFamily: "inherit", resize: "none" as const, outline: "none", lineHeight: 1.6, boxSizing: "border-box" as const }}
                  placeholder="Write a reply…"
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
                  <button onClick={() => setReplyText("")} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Discard</button>
                  <button onClick={() => { if (selectedEmail) replyAllToEmail(selectedEmail.id, replyText); }}
                    disabled={!replyText.trim() || !selectedEmail}
                    style={{ padding: "7px 14px", background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text2, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", opacity: (!replyText.trim() || !selectedEmail) ? 0.5 : 1 }}>
                    Reply All ↗
                  </button>
                  <button onClick={() => { if (selectedEmail) replyToEmail(selectedEmail.id, replyText); }}
                    disabled={!replyText.trim() || !selectedEmail}
                    style={{ padding: "7px 16px", background: `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})`, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", opacity: (!replyText.trim() || !selectedEmail) ? 0.5 : 1 }}>
                    Reply ↗
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── RIGHT-CLICK CONTEXT MENU ─────────────────────────────────────────── */}
        {ctxMenu && (
          <div style={{ position: "fixed", top: ctxMenu.y, left: ctxMenu.x, zIndex: 2000, background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 8, minWidth: 180, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>
            <div onClick={() => { selectEmail(ctxMenu.em); setCtxMenu(null); }} style={{ padding: "9px 14px", cursor: "pointer", fontSize: 12, color: C.text1, display: "flex", alignItems: "center", gap: 8 }}>
              <span>↩</span> Reply
            </div>
            <div onClick={() => { selectEmail(ctxMenu.em); setCtxMenu(null); setTimeout(() => replyRef.current?.focus(), 100); }} style={{ padding: "9px 14px", cursor: "pointer", fontSize: 12, color: C.text1, display: "flex", alignItems: "center", gap: 8 }}>
              <span>↩↩</span> Reply All
            </div>
            <div style={{ height: 1, background: C.border }} />
            <div onClick={() => { setFlaggedSet(prev => { const s = new Set(prev); if (s.has(ctxMenu.em.id)) s.delete(ctxMenu.em.id); else s.add(ctxMenu.em.id); return s; }); setCtxMenu(null); }}
              style={{ padding: "9px 14px", cursor: "pointer", fontSize: 12, color: C.warning, display: "flex", alignItems: "center", gap: 8 }}>
              <span>{flaggedSet.has(ctxMenu.em.id) ? "★" : "☆"}</span> {flaggedSet.has(ctxMenu.em.id) ? "Unflag" : "Flag"}
            </div>
            <div style={{ height: 1, background: C.border }} />
            <div onClick={() => { selectEmail(ctxMenu.em); setDeleteConfirm(ctxMenu.em.id); setCtxMenu(null); }}
              style={{ padding: "9px 14px", cursor: "pointer", fontSize: 12, color: C.error, display: "flex", alignItems: "center", gap: 8 }}>
              <span>🗑️</span> Delete
            </div>
          </div>
        )}

        {/* ── COMPOSE MODAL (floating bottom-right) ────────────────────────────── */}
        {composeOpen && (
          <div style={{ position: "absolute", inset: 0, zIndex: 100, pointerEvents: "none" }}>
            <div style={{ position: "absolute", bottom: 0, right: 0, width: 520, background: C.bg1, border: `1px solid ${C.border2}`, borderRadius: "12px 12px 0 0", boxShadow: "0 -8px 32px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", pointerEvents: "all" }}>
              {/* Modal header */}
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg2, borderRadius: "12px 12px 0 0" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.text1 }}>New Message</span>
                <button onClick={() => { setComposeOpen(false); setSendError(null); }} style={{ ...iconBtn, color: C.text2 }}>✕</button>
              </div>
              {/* Fields */}
              <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                {sendError && (
                  <div style={{ background: C.bg0, border: `1px solid ${C.error}44`, borderRadius: 7, padding: "8px 12px", color: C.error, fontSize: 12 }}>
                    ⚠ {sendError}
                    <button onClick={() => setSendError(null)} style={{ marginLeft: 8, border: "none", background: "none", color: C.error, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>✕</button>
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>To (comma-separated)</div>
                  <input value={composeTo} onChange={e => setComposeTo(e.target.value)} placeholder="name@domain.com"
                    style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text1, fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>Subject</div>
                  <input value={composeSubject} onChange={e => setComposeSubject(e.target.value)}
                    style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text1, fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>Body</div>
                  <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} rows={8}
                    style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text1, fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical" as const, minHeight: 140, boxSizing: "border-box" as const }}
                    placeholder="Type your message…" />
                </div>
              </div>
              {/* Modal footer */}
              <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => { setComposeOpen(false); setSendError(null); setComposeTo(""); setComposeSubject(""); setComposeBody(""); }}
                  style={{ padding: "7px 16px", borderRadius: 7, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit" }}>Discard</button>
                <button onClick={sendEmail} disabled={!composeTo.trim() || !composeSubject.trim()}
                  style={{ padding: "7px 18px", background: `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})`, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: (!composeTo.trim() || !composeSubject.trim()) ? 0.5 : 1 }}>
                  Send ↗
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

export default OutlookView;
