import React from "react";
import { styledEmailHtml } from "../utils/emailHtml";
import { STATUS_COLORS } from "../utils/tandaTypes";
import { MS_CLIENT_ID, MS_TENANT_ID } from "../utils/msAuth";
import type { XoroPO } from "../utils/tandaTypes";
import type { EmailState, EmailAction } from "./state/email/emailTypes";

export interface EmailPanelCtx {
  // Email state (from useEmailState)
  em: EmailState;
  emD: React.Dispatch<EmailAction>;
  // Core reads
  pos: XoroPO[];
  setView: (v: any) => void;
  // External functions
  emailGraph: (path: string) => Promise<any>;
  emailGraphPost: (path: string, body: any) => Promise<any>;
  loadEmailAttachments: (messageId: string) => void;
  authenticateEmail: () => void;
  loadPOEmails: (poNum: string, olderUrl?: string, autoSelect?: boolean) => void;
  loadFullEmail: (id: string) => void;
  loadEmailThread: (conversationId: string) => void;
  emailGetPrefix: (poNum: string) => string;
  emailMarkAsRead: (id: string) => void;
  deleteMainEmail: (id: string) => void;
  msSignOut: () => void;
}

export function emailViewPanel(ctx: EmailPanelCtx): React.ReactElement | null {
  const { em, emD, pos, setView, emailGraph, emailGraphPost, loadEmailAttachments, authenticateEmail, loadPOEmails, loadFullEmail, loadEmailThread, emailGetPrefix, emailMarkAsRead, deleteMainEmail, msSignOut } = ctx;

  // Helper to set email state fields
  const emSet = (field: keyof EmailState, value: any) => emD({ type: "SET", field, value });
  const emSetFn = (field: keyof EmailState, fn: (prev: any) => any) => emD({ type: "SET", field, value: fn((em as any)[field]) });

  const C = {
    bg0: "#0F172A", bg1: "#1E293B", bg2: "#253347", bg3: "#2D3D52",
    border: "#334155", border2: "#3E4F66",
    text1: "#F1F5F9", text2: "#94A3B8", text3: "#6B7280",
    outlook: "#0078D4", outlookLt: "#106EBE", outlookDim: "rgba(0,120,212,0.15)",
    error: "#EF4444", errorDim: "rgba(239,68,68,0.15)",
    success: "#34D399", info: "#60A5FA", warning: "#FBBF24",
  };

  const poList = pos;
  const emailToken = em.msToken;
  const { emailSelPO, emailsMap, emailLoadingMap, emailErrorsMap, emailSelMsg, emailThreadMsgs, emailThreadLoading, emailSentMap, emailSentLoading, emailComposeTo, emailComposeSubject, emailComposeBody, emailSendErr, emailNextLinks, emailLoadingOlder, emailReplyText, emailPOSearch, emailActiveFolder, emailSearchQuery, emailFilterUnread, emailFilterFlagged, emailFlaggedSet, emailCollapsedMsgs, emailComposeOpen, emailDeleteConfirm, emailSelectedId, emailCtxMenu, emailAttachments, emailAttachmentsLoading, showEmailConfig, msDisplayName } = em;

  const iconBtn: React.CSSProperties = { width: 28, height: 28, borderRadius: 6, border: "none", background: "transparent", color: C.text3, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" };

  async function loadPOSentEmails(poNum: string) {
    if (!emailToken) return;
    const prefix = emailGetPrefix(poNum);
    emSetFn("emailSentLoading", (l: any) => ({ ...l, [poNum]: true }));
    try {
      const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const d = await emailGraph("/me/mailFolders/SentItems/messages?$search=" + encodeURIComponent('"' + searchTerm + '"') + "&$top=25&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview,conversationId,hasAttachments");
      emSetFn("emailSentMap", (m: any) => ({ ...m, [poNum]: d.value || [] }));
      emSetFn("dtlSentEmails", (m: any) => ({ ...m, [poNum]: d.value || [] }));
    } catch (e: any) { emSetFn("emailSentErr", (err: any) => ({ ...err, [poNum]: e.message })); }
    emSetFn("emailSentLoading", (l: any) => ({ ...l, [poNum]: false }));
  }

  async function doSendEmail() {
    if (!emailComposeTo.trim() || !emailComposeSubject.trim()) return;
    emSet("emailSendErr", null);
    try {
      await emailGraphPost("/me/sendMail", {
        message: {
          subject: emailComposeSubject,
          body: { contentType: "HTML", content: emailComposeBody || " " },
          toRecipients: emailComposeTo.split(",").map(e => ({ emailAddress: { address: e.trim() } })),
        },
      });
      emSet("emailComposeTo", ""); emSet("emailComposeSubject", ""); emSet("emailComposeBody", "");
      emSet("emailComposeOpen", false);
      if (emailSelPO) setTimeout(() => loadPOEmails(emailSelPO), 2000);
    } catch (e: any) { emSet("emailSendErr", "Failed to send: " + e.message); }
  }

  async function doReply(messageId: string, comment: string) {
    if (!comment.trim()) return;
    emSet("emailSendErr", null);
    try {
      await emailGraphPost("/me/messages/" + messageId + "/reply", { comment });
      if (emailSelMsg?.conversationId) loadEmailThread(emailSelMsg.conversationId);
      emSet("emailReplyText", "");
    } catch (e: any) { emSet("emailSendErr", "Failed to reply: " + e.message); }
  }

  const inboxEmails = emailSelPO ? (emailsMap[emailSelPO] || []) : [];
  const sentEmailList = emailSelPO ? (emailSentMap[emailSelPO] || []) : [];
  const activeList = emailActiveFolder === "inbox" ? inboxEmails : sentEmailList;
  const isLoadingE = emailSelPO ? !!emailLoadingMap[emailSelPO] : false;
  const eError = emailSelPO ? emailErrorsMap[emailSelPO] : null;

  const visibleEmails = [...activeList]
    .filter((e: any) => {
      if (emailFilterUnread && e.isRead) return false;
      if (emailFilterFlagged && !emailFlaggedSet.has(e.id)) return false;
      if (emailSearchQuery) {
        const q = emailSearchQuery.toLowerCase();
        const sender = e.from?.emailAddress?.name || e.from?.emailAddress?.address || "";
        if (!(e.subject || "").toLowerCase().includes(q) && !sender.toLowerCase().includes(q) && !(e.bodyPreview || "").toLowerCase().includes(q)) return false;
      }
      return true;
    })
    .sort((a: any, b: any) => {
      if (!a.isRead && b.isRead) return -1;
      if (a.isRead && !b.isRead) return 1;
      const ta = new Date(a.receivedDateTime || a.sentDateTime || 0).getTime();
      const tb = new Date(b.receivedDateTime || b.sentDateTime || 0).getTime();
      return tb - ta;
    });

  const selEmailObj = emailSelectedId ? (activeList.find((e: any) => e.id === emailSelectedId) || emailSelMsg) : emailSelMsg;

  // Config view
  if (showEmailConfig) return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 0" }}>
      <h2 style={{ color: C.text1, fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Outlook Email</h2>
      <div style={{ background: "#1E3A5F", border: "1px solid #2563EB44", borderRadius: 10, padding: "12px 16px", marginBottom: 18, fontSize: 12, color: "#93C5FD", lineHeight: 1.6 }}>
        Azure AD credentials are configured automatically via Vercel environment variables.
        Redirect URI: <b>{window.location.origin}/auth-callback</b>.{" "}
        {MS_CLIENT_ID ? <span style={{ color: C.success, fontWeight: 700 }}>✓ Credentials configured</span> : <span style={{ color: C.error, fontWeight: 700 }}>✗ Credentials missing — check Vercel env vars</span>}
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
        <button onClick={() => emSet("showEmailConfig", false)} style={{ background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 8, padding: "8px 16px", fontSize: 13, cursor: "pointer" }}>Close</button>
      </div>
    </div>
  );

  return (
    <div style={{ position: "relative" }} onClick={() => emailCtxMenu && emSet("emailCtxMenu", null)}>
      <button onClick={() => setView("dashboard")} title="Close Email"
        style={{ position: "absolute", top: 10, right: 14, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: `1px solid ${C.outlook}44`, background: `${C.outlook}15`, color: C.outlook, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>✕</button>

      <div style={{ display: "flex", height: "calc(100vh - 140px)", minHeight: 500, background: C.bg0, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden", position: "relative", fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: 13, color: C.text1 }}>

        {/* ── SIDEBAR (220px) */}
        <div style={{ width: 220, minWidth: 220, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "14px 12px 10px", borderBottom: `1px solid ${C.border}` }}>
            <button
              onClick={() => { emSet("emailComposeOpen", true); emSet("emailComposeSubject", emailSelPO ? emailGetPrefix(emailSelPO) + " " : ""); emSet("emailSendErr", null); }}
              disabled={!emailToken}
              style={{ width: "100%", padding: "8px 12px", background: emailToken ? `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})` : C.bg2, border: "none", borderRadius: 8, color: emailToken ? "#fff" : C.text3, fontSize: 13, fontWeight: 500, cursor: emailToken ? "pointer" : "default", display: "flex", alignItems: "center", gap: 8, justifyContent: "center", fontFamily: "inherit" }}>
              ✎ New Message
            </button>
          </div>

          <div style={{ padding: "10px 12px 4px", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: C.text3, fontWeight: 600 }}>POs ({poList.length})</div>
          <div style={{ padding: "4px 8px 6px" }}>
            <input value={emailPOSearch} onChange={e => emSet("emailPOSearch", e.target.value)} placeholder="🔍 Search…"
              style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text1, fontSize: 11, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {(() => {
              const s = emailPOSearch.toLowerCase();
              return poList.filter((p: any) => !s || (p.PoNumber ?? "").toLowerCase().includes(s) || (p.VendorName ?? "").toLowerCase().includes(s) || (p.Memo ?? "").toLowerCase().includes(s) || (p.Tags ?? "").toLowerCase().includes(s) || (p.StatusName ?? "").toLowerCase().includes(s))
                .sort((a: any, b: any) => {
                  const ua = (emailsMap[a.PoNumber ?? ""] || []).filter((e: any) => !e.isRead).length;
                  const ub = (emailsMap[b.PoNumber ?? ""] || []).filter((e: any) => !e.isRead).length;
                  return ub - ua;
                });
            })().map((po: any) => {
              const poNum = po.PoNumber ?? "";
              const isSelected = emailSelPO === poNum;
              const unread = (emailsMap[poNum] || []).filter((e: any) => !e.isRead).length;
              const color = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
              return (
                <div key={poNum}
                  onClick={() => { emSet("emailSelPO", poNum === emailSelPO ? null : poNum); emSet("emailSelectedId", null); emSet("emailSelMsg", null); emSet("emailThreadMsgs", []); emSet("emailDeleteConfirm", null); emSet("emailActiveFolder", "inbox"); if (poNum !== emailSelPO && emailToken) loadPOEmails(poNum, undefined, true); }}
                  style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", borderRadius: 7, margin: "1px 6px", cursor: "pointer", fontSize: 12, background: isSelected ? C.outlookDim : "transparent", color: isSelected ? C.info : C.text2, border: isSelected ? "1px solid rgba(96,165,250,0.2)" : "1px solid transparent", transition: "all 0.1s" }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "monospace" }}>{poNum}</span>
                  {unread > 0 && <span style={{ background: C.outlook, color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 10, minWidth: 16, textAlign: "center" as const }}>{unread}</span>}
                </div>
              );
            })}
            {poList.length === 0 && <div style={{ padding: 16, fontSize: 12, color: C.text3, textAlign: "center" }}>No POs loaded — sync first</div>}
          </div>

          <div style={{ height: 1, background: C.border, margin: "4px 10px" }} />
          <div style={{ padding: "6px 12px 2px", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: C.text3, fontWeight: 600 }}>Folders</div>
          {(["inbox", "sent"] as const).map(f => {
            const label = f === "inbox" ? "Inbox" : "Sent";
            const count = f === "inbox" ? inboxEmails.filter((e: any) => !e.isRead).length : 0;
            return (
              <div key={f} onClick={() => { emSet("emailActiveFolder", f); emSet("emailSelectedId", null); emSet("emailSelMsg", null); emSet("emailThreadMsgs", []); if (f === "sent" && emailSelPO && emailToken) loadPOSentEmails(emailSelPO); }}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, margin: "1px 6px", cursor: "pointer", fontSize: 12, background: emailActiveFolder === f ? "rgba(200,33,10,0.15)" : "transparent", color: emailActiveFolder === f ? "#E87060" : C.text2, transition: "all 0.1s" }}>
                <svg width={14} height={14} viewBox="0 0 16 14" fill="none" style={{ flexShrink: 0 }}><path d="M1 2.5C1 1.67 1.67 1 2.5 1H5.5L7 2.5H13.5C14.33 2.5 15 3.17 15 4V11.5C15 12.33 14.33 13 13.5 13H2.5C1.67 13 1 12.33 1 11.5V2.5Z" stroke={emailActiveFolder === f ? "#E87060" : C.text3} strokeWidth="1.2" fill="none"/></svg>
                <span style={{ flex: 1 }}>{label}</span>
                {count > 0 && <span style={{ background: C.bg3, color: C.text2, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 10, minWidth: 18, textAlign: "center" as const }}>{count}</span>}
              </div>
            );
          })}

          <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            {emailToken ? (
              <>
                <div style={{ width: 26, height: 26, borderRadius: "50%", background: C.outlook + "33", border: "2px solid " + C.outlook, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: C.outlook, flexShrink: 0 }}>{(msDisplayName || "Me").slice(0, 2).toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 500, color: C.text1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{msDisplayName || "Microsoft Account"}</div>
                </div>
                <div style={{ background: "#064E3B", border: "1px solid #34D39944", borderRadius: 5, padding: "2px 6px", fontSize: 9, color: C.success, whiteSpace: "nowrap", cursor: "pointer" }}
                  onClick={msSignOut} title="Click to sign out">● Live</div>
              </>
            ) : (
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.warning, fontWeight: 600, marginBottom: 5 }}>Sign in to load emails</div>
                {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                  <div style={{ fontSize: 10, color: "#D97706" }}>Azure credentials not configured</div>
                ) : (
                  <button onClick={authenticateEmail}
                    style={{ background: `linear-gradient(135deg,${C.outlook},${C.outlookLt})`, color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%" }}>
                    Sign in with Microsoft
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── EMAIL LIST (295px) */}
        <div style={{ width: 295, minWidth: 295, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "12px 12px 8px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.text1 }}>
              {emailActiveFolder === "inbox" ? "Inbox" : "Sent"}
              {emailSelPO && <span style={{ fontSize: 11, color: C.text3, marginLeft: 6, fontWeight: 400 }}>· PO {emailSelPO}</span>}
            </span>
            <button style={iconBtn} title="Refresh"
              onClick={() => { if (emailSelPO) { if (emailActiveFolder === "inbox") loadPOEmails(emailSelPO); else loadPOSentEmails(emailSelPO); } }}>↻</button>
          </div>

          <div style={{ position: "relative" as const, margin: "8px 10px" }}>
            <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: C.text3, fontSize: 13, pointerEvents: "none" }}>⌕</span>
            <input style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 10px 6px 28px", color: C.text1, fontSize: 12, outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit" }}
              placeholder="Search…" value={emailSearchQuery} onChange={e => emSet("emailSearchQuery", e.target.value)} />
          </div>

          <div style={{ display: "flex", gap: 4, padding: "6px 8px", borderBottom: `1px solid ${C.border}` }}>
            {(["All", "Unread", "Flagged"] as const).map(label => {
              const isActive = label === "All" ? (!emailFilterUnread && !emailFilterFlagged) : label === "Unread" ? emailFilterUnread : emailFilterFlagged;
              return (
                <div key={label} onClick={() => { if (label === "All") { emSet("emailFilterUnread", false); emSet("emailFilterFlagged", false); } else if (label === "Unread") { emSet("emailFilterUnread", !emailFilterUnread); emSet("emailFilterFlagged", false); } else { emSet("emailFilterFlagged", !emailFilterFlagged); emSet("emailFilterUnread", false); } }}
                  style={{ padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 500, cursor: "pointer", background: isActive ? C.outlookDim : "transparent", color: isActive ? C.info : C.text3, border: isActive ? "1px solid rgba(96,165,250,0.3)" : "1px solid transparent" }}>
                  {label}
                </div>
              );
            })}
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {!emailToken ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 12 }}>Sign in to load emails</div>
            ) : !emailSelPO ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 12 }}>Select a PO from the left</div>
            ) : (isLoadingE && emailActiveFolder === "inbox") ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>Loading emails…</div>
            ) : (emailSentLoading[emailSelPO] && emailActiveFolder === "sent") ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>Loading sent emails…</div>
            ) : (eError && emailActiveFolder === "inbox") ? (
              <div style={{ margin: 10, background: C.bg0, border: `1px solid ${C.error}44`, borderRadius: 8, padding: "10px 14px", color: C.error, fontSize: 12 }}>⚠ {eError}</div>
            ) : visibleEmails.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>No messages</div>
            ) : (
              <>
                {visibleEmails.map((mail: any) => {
                  const sender = emailActiveFolder === "inbox"
                    ? (mail.from?.emailAddress?.name || mail.from?.emailAddress?.address || "Unknown")
                    : "To: " + ((mail.toRecipients || []).map((r: any) => r.emailAddress?.name || r.emailAddress?.address || "").filter(Boolean).join(", ") || "—");
                  const time = mail.receivedDateTime
                    ? new Date(mail.receivedDateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : mail.sentDateTime
                    ? new Date(mail.sentDateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : "";
                  const isFlagged = emailFlaggedSet.has(mail.id);
                  const isUnread = !mail.isRead && emailActiveFolder === "inbox";
                  return (
                    <div key={mail.id}
                      onClick={() => { emSet("emailSelectedId", mail.id); emSet("emailDeleteConfirm", null); emSet("emailReplyText", ""); if (emailActiveFolder === "inbox" && !mail.isRead) { emailMarkAsRead(mail.id); const markRead = (arr: any[]) => arr.map((e: any) => e.id === mail.id ? { ...e, isRead: true } : e); emSetFn("emailsMap", (m: any) => ({ ...m, [emailSelPO!]: markRead(m[emailSelPO!] || []) })); emSetFn("dtlEmails", (m: any) => ({ ...m, [emailSelPO!]: markRead(m[emailSelPO!] || []) })); } loadFullEmail(mail.id); if (mail.conversationId) loadEmailThread(mail.conversationId); if (mail.hasAttachments) loadEmailAttachments(mail.id); }}
                      onContextMenu={e => { e.preventDefault(); emSet("emailCtxMenu", { x: e.clientX, y: e.clientY, em: mail }); }}
                      style={{ padding: "11px 12px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative" as const, background: emailSelectedId === mail.id ? C.bg3 : "transparent", transition: "background 0.1s" }}>
                      {isUnread && <div style={{ position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)", width: 5, height: 5, borderRadius: "50%", background: C.outlook }} />}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                        <span style={{ fontSize: 12, fontWeight: isUnread ? 600 : 400, color: isUnread ? C.text1 : C.text2, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {sender}
                          {isFlagged && <span style={{ color: C.warning, marginLeft: 4, fontSize: 11 }}>★</span>}
                        </span>
                        <span style={{ fontSize: 11, color: C.text3, flexShrink: 0, marginLeft: 6 }}>{time}</span>
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 500, color: C.text1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{mail.subject}</div>
                      <div style={{ fontSize: 11, color: C.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {mail.hasAttachments && <span style={{ marginRight: 4 }}>📎</span>}
                        {mail.bodyPreview || ""}
                      </div>
                    </div>
                  );
                })}
                {emailActiveFolder === "inbox" && emailNextLinks[emailSelPO!] && (
                  <button onClick={() => loadPOEmails(emailSelPO!, emailNextLinks[emailSelPO!]!)} disabled={emailLoadingOlder}
                    style={{ background: `linear-gradient(135deg,${C.outlook},${C.outlookLt})`, color: "#fff", border: "none", borderRadius: 0, padding: "10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%", opacity: emailLoadingOlder ? 0.6 : 1 }}>
                    {emailLoadingOlder ? "Loading…" : "Load older"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── EMAIL DETAIL (flex-1) */}
        <div style={{ flex: 1, background: C.bg0, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {!emailSelectedId ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: C.text3 }}>
              <span style={{ fontSize: 48, opacity: 0.25 }}>✉</span>
              <span style={{ fontSize: 14 }}>{emailSelPO ? "Select a message to read" : "Select a PO from the left"}</span>
            </div>
          ) : (
            <>
              <div style={{ padding: "12px 50px 10px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: C.text1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selEmailObj?.subject || "Loading…"}
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button style={iconBtn} title="Flag"
                    onClick={() => emD({ type: "TOGGLE_FLAGGED", id: emailSelectedId })}>
                    <span style={{ color: emailFlaggedSet.has(emailSelectedId) ? C.warning : C.text3 }}>{emailFlaggedSet.has(emailSelectedId) ? "★" : "☆"}</span>
                  </button>
                  <button style={{ ...iconBtn, color: C.error }} title="Delete" onClick={() => emSet("emailDeleteConfirm", emailSelectedId)}>🗑️</button>
                </div>
              </div>

              {emailDeleteConfirm === emailSelectedId && (
                <div style={{ background: C.errorDim, borderBottom: `1px solid rgba(239,68,68,0.3)`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 13, color: C.error, flex: 1 }}>Permanently delete this message? This cannot be undone.</span>
                  <button onClick={() => deleteMainEmail(emailSelectedId)}
                    style={{ padding: "7px 14px", background: C.errorDim, border: `1px solid rgba(239,68,68,0.3)`, borderRadius: 7, color: C.error, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>Delete</button>
                  <button style={{ ...iconBtn, color: C.text2 }} onClick={() => emSet("emailDeleteConfirm", null)}>✕</button>
                </div>
              )}

              {emailSendErr && (
                <div style={{ background: C.bg1, borderBottom: `1px solid ${C.error}44`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 13, color: C.error, flex: 1 }}>⚠ {emailSendErr}</span>
                  <button style={{ ...iconBtn, color: C.text2 }} onClick={() => emSet("emailSendErr", null)}>✕</button>
                </div>
              )}

              <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
                {emailThreadLoading ? (
                  <div style={{ textAlign: "center", color: C.text3, paddingTop: 40, fontSize: 13 }}>Loading conversation…</div>
                ) : emailThreadMsgs.length > 0 ? (
                  emailThreadMsgs.map((msg: any, i: number) => {
                    const isLast = i === emailThreadMsgs.length - 1;
                    const collapsed = !isLast && emailCollapsedMsgs.has(msg.id);
                    const sender = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown";
                    const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2) || "??";
                    const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                    const htmlBody = msg.body?.content || "";
                    return (
                      <div key={msg.id} style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 10, overflow: "hidden" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: !isLast ? "pointer" : "default" }}
                          onClick={() => { if (!isLast) emD({ type: "TOGGLE_COLLAPSED_MSG", id: msg.id }); }}>
                          <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.outlook + "33", border: "2px solid " + C.outlook, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: C.outlook, flexShrink: 0 }}>{initials}</div>
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
                ) : selEmailObj ? (
                  <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.text3 }}>
                      From: {selEmailObj.from?.emailAddress?.name || selEmailObj.from?.emailAddress?.address || "Unknown"}
                    </div>
                    <div style={{ padding: "0 14px 14px" }}>
                      <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(selEmailObj.body?.content || selEmailObj.bodyPreview || "")}
                        style={{ width: "100%", border: "none", minHeight: 100, borderRadius: 6, background: "#F8FAFC" }}
                        onLoad={e => { try { const h = (e.target as HTMLIFrameElement).contentDocument?.body.scrollHeight || 0; (e.target as HTMLIFrameElement).style.height = Math.min(h + 20, 400) + "px"; } catch {} }} />
                    </div>
                  </div>
                ) : null}
              </div>

              {emailSelectedId && (emailAttachments[emailSelectedId] || []).length > 0 && (
                <div style={{ borderTop: `1px solid ${C.border}`, padding: "8px 18px", background: C.bg1, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: C.text3, marginRight: 4 }}>📎 Attachments:</span>
                  {emailAttachments[emailSelectedId].map((att: any) => {
                    const href = att.contentBytes ? `data:${att.contentType || "application/octet-stream"};base64,${att.contentBytes}` : "#";
                    return (
                      <a key={att.id} href={href} download={att.name}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 9px", fontSize: 11, color: C.info, textDecoration: "none", cursor: "pointer", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        📄 {att.name}{att.size ? ` (${(att.size / 1024).toFixed(0)}KB)` : ""}
                      </a>
                    );
                  })}
                  {emailAttachmentsLoading[emailSelectedId] && <span style={{ fontSize: 11, color: C.text3 }}>Loading…</span>}
                </div>
              )}

              <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 18px", background: C.bg1 }}>
                <div style={{ fontSize: 12, color: C.text3, marginBottom: 6 }}>
                  Reply to <span style={{ color: C.info }}>{emailThreadMsgs.length > 0 ? (emailThreadMsgs[emailThreadMsgs.length - 1].from?.emailAddress?.address || "") : (selEmailObj?.from?.emailAddress?.address || "")}</span>
                </div>
                <textarea
                  style={{ width: "100%", minHeight: 72, background: "transparent", border: "none", color: C.text1, fontSize: 13, fontFamily: "inherit", resize: "none" as const, outline: "none", lineHeight: 1.6, boxSizing: "border-box" as const }}
                  placeholder="Write a reply…" value={emailReplyText} onChange={e => emSet("emailReplyText", e.target.value)} />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
                  <button onClick={() => emSet("emailReplyText", "")} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Discard</button>
                  <button onClick={() => { if (selEmailObj) doReply(selEmailObj.id, emailReplyText); }}
                    disabled={!emailReplyText.trim() || !selEmailObj}
                    style={{ padding: "7px 16px", background: `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})`, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", opacity: (!emailReplyText.trim() || !selEmailObj) ? 0.5 : 1 }}>
                    Send ↗
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── COMPOSE MODAL */}
        {emailComposeOpen && (
          <div style={{ position: "absolute", inset: 0, zIndex: 100, pointerEvents: "none" }}>
            <div style={{ position: "absolute", bottom: 0, right: 0, width: 520, background: C.bg1, border: `1px solid ${C.border2}`, borderRadius: "12px 12px 0 0", boxShadow: "0 -8px 32px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", pointerEvents: "all" }}>
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg2, borderRadius: "12px 12px 0 0" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.text1 }}>New Message</span>
                <button onClick={() => { emSet("emailComposeOpen", false); emSet("emailSendErr", null); }} style={{ ...iconBtn, color: C.text2 }}>✕</button>
              </div>
              <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                {emailSendErr && (
                  <div style={{ background: C.bg0, border: `1px solid ${C.error}44`, borderRadius: 7, padding: "8px 12px", color: C.error, fontSize: 12 }}>
                    ⚠ {emailSendErr}
                    <button onClick={() => emSet("emailSendErr", null)} style={{ marginLeft: 8, border: "none", background: "none", color: C.error, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>✕</button>
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>To (comma-separated)</div>
                  <input value={emailComposeTo} onChange={e => emSet("emailComposeTo", e.target.value)} placeholder="name@domain.com"
                    style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text1, fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>Subject</div>
                  <input value={emailComposeSubject} onChange={e => emSet("emailComposeSubject", e.target.value)}
                    style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text1, fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>Body</div>
                  <textarea value={emailComposeBody} onChange={e => emSet("emailComposeBody", e.target.value)} rows={8}
                    style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text1, fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical" as const, minHeight: 140, boxSizing: "border-box" as const }}
                    placeholder="Type your message…" />
                </div>
              </div>
              <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => { emD({ type: "EMAIL_RESET_COMPOSE" }); emSet("emailComposeOpen", false); }}
                  style={{ padding: "7px 16px", borderRadius: 7, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit" }}>Discard</button>
                <button onClick={doSendEmail} disabled={!emailComposeTo.trim() || !emailComposeSubject.trim()}
                  style={{ padding: "7px 18px", background: `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})`, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: (!emailComposeTo.trim() || !emailComposeSubject.trim()) ? 0.5 : 1 }}>
                  Send ↗
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── CONTEXT MENU */}
        {emailCtxMenu && (
          <div style={{ position: "fixed", top: emailCtxMenu.y, left: emailCtxMenu.x, zIndex: 2000, background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 8, padding: "4px 0", boxShadow: "0 8px 24px rgba(0,0,0,0.5)", minWidth: 170 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: "8px 16px", fontSize: 12, color: C.text1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
              onClick={() => { emSet("emailSelectedId", emailCtxMenu.em.id); loadFullEmail(emailCtxMenu.em.id); if (emailCtxMenu.em.conversationId) loadEmailThread(emailCtxMenu.em.conversationId); emSet("emailCtxMenu", null); }}>
              ↩ Reply
            </div>
            <div style={{ padding: "8px 16px", fontSize: 12, color: C.text1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
              onClick={() => { emSet("emailSelectedId", emailCtxMenu.em.id); loadFullEmail(emailCtxMenu.em.id); if (emailCtxMenu.em.conversationId) loadEmailThread(emailCtxMenu.em.conversationId); emSet("emailCtxMenu", null); }}>
              ↩↩ Reply All
            </div>
            <div style={{ height: 1, background: C.border, margin: "3px 0" }} />
            <div style={{ padding: "8px 16px", fontSize: 12, color: C.error, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
              onClick={() => { emSet("emailDeleteConfirm", emailCtxMenu.em.id); emSet("emailSelectedId", emailCtxMenu.em.id); emSet("emailCtxMenu", null); }}>
              🗑️ Delete
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
