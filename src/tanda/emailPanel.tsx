import React, { useRef, useEffect, useState } from "react";
import { styledEmailHtml } from "../utils/emailHtml";

const FONT_CHOICES = [
  { label: "Segoe UI", value: "'Segoe UI', system-ui, sans-serif" },
  { label: "Aptos", value: "'Aptos', 'Segoe UI', sans-serif" },
  { label: "Calibri", value: "'Calibri', sans-serif" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Helvetica", value: "Helvetica, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Courier New", value: "'Courier New', monospace" },
  { label: "Verdana", value: "Verdana, sans-serif" },
];

/** Small contenteditable rich-text editor — bold, italic, underline, lists,
 *  link, font family, font color. Outputs HTML via onChange. Toolbar buttons
 *  reflect the current selection state. */
function RichTextEditor({ value, onChange, placeholder, minHeight = 140 }: { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const colorRef = useRef<HTMLInputElement | null>(null);
  const [active, setActive] = useState<{ bold: boolean; italic: boolean; underline: boolean; ul: boolean; ol: boolean }>({ bold: false, italic: false, underline: false, ul: false, ol: false });
  const [currentFont, setCurrentFont] = useState<string>("");

  // Sync upstream changes only when not focused
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) return;
    if (el.innerHTML !== (value || "")) el.innerHTML = value || "";
  }, [value]);

  // Listen for selection changes to update active button state
  useEffect(() => {
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      if (!node || !el.contains(node)) return;
      updateActive();
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const updateActive = () => {
    try {
      setActive({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        ul: document.queryCommandState("insertUnorderedList"),
        ol: document.queryCommandState("insertOrderedList"),
      });
      const f = document.queryCommandValue("fontName") || "";
      setCurrentFont(f.replace(/['"]/g, ""));
    } catch {}
  };
  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    if (ref.current) onChange(ref.current.innerHTML);
    // Immediately reflect the new state on the toolbar buttons
    updateActive();
  };

  const btnBase: React.CSSProperties = { width: 26, height: 26, background: "#1E293B", border: "1px solid #334155", borderRadius: 4, color: "#94A3B8", cursor: "pointer", fontSize: 12, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 };
  const btnActive: React.CSSProperties = { background: "#1D4ED8", border: "1px solid #3B82F6", color: "#ffffff" };
  const sty = (isActive: boolean, extra: React.CSSProperties = {}) => ({ ...btnBase, ...(isActive ? btnActive : {}), ...extra });

  return (
    <div style={{ border: "1px solid #334155", borderRadius: 6, background: "#0F172A", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 4, padding: 6, borderBottom: "1px solid #334155", background: "#1E293B", flexWrap: "wrap", alignItems: "center" }}>
        <select
          title="Font"
          value={FONT_CHOICES.find(f => currentFont && f.value.toLowerCase().includes(currentFont.toLowerCase()))?.value || ""}
          onChange={e => exec("fontName", e.target.value)}
          style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 4, color: "#94A3B8", fontSize: 11, padding: "3px 4px", height: 26, cursor: "pointer" }}
        >
          <option value="">Font…</option>
          {FONT_CHOICES.map(f => <option key={f.label} value={f.value}>{f.label}</option>)}
        </select>
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button type="button" title="Bold (Ctrl+B)" style={sty(active.bold, { fontWeight: 700 })} onMouseDown={e => { e.preventDefault(); exec("bold"); }}>B</button>
        <button type="button" title="Italic (Ctrl+I)" style={sty(active.italic, { fontStyle: "italic" })} onMouseDown={e => { e.preventDefault(); exec("italic"); }}>I</button>
        <button type="button" title="Underline (Ctrl+U)" style={sty(active.underline, { textDecoration: "underline" })} onMouseDown={e => { e.preventDefault(); exec("underline"); }}>U</button>
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        {/* Font color: hidden native picker triggered by the swatch button */}
        <button
          type="button"
          title="Font color"
          onMouseDown={e => { e.preventDefault(); ref.current?.focus(); colorRef.current?.click(); }}
          style={{ ...btnBase, position: "relative", flexDirection: "column", gap: 0 }}
        >
          <span style={{ fontSize: 10, lineHeight: 1, color: "#F1F5F9" }}>A</span>
          <span style={{ width: 14, height: 3, background: "#3B82F6", borderRadius: 1, marginTop: 1 }} />
        </button>
        <input ref={colorRef} type="color" style={{ position: "absolute", visibility: "hidden", width: 0, height: 0 }}
          onChange={e => exec("foreColor", e.target.value)} />
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button type="button" title="Bulleted list" style={sty(active.ul)} onMouseDown={e => { e.preventDefault(); exec("insertUnorderedList"); }}>•</button>
        <button type="button" title="Numbered list" style={sty(active.ol)} onMouseDown={e => { e.preventDefault(); exec("insertOrderedList"); }}>1.</button>
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button type="button" title="Insert link" style={btnBase} onMouseDown={e => { e.preventDefault(); const url = window.prompt("URL:"); if (url) exec("createLink", url); }}>🔗</button>
        <button type="button" title="Clear formatting" style={btnBase} onMouseDown={e => { e.preventDefault(); exec("removeFormat"); }}>✕</button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder || ""}
        onInput={e => onChange((e.target as HTMLDivElement).innerHTML)}
        onPaste={e => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/html") || e.clipboardData.getData("text/plain");
          const cleaned = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
          document.execCommand("insertHTML", false, cleaned);
        }}
        style={{
          minHeight,
          padding: "10px 12px",
          color: "#F1F5F9",
          fontSize: 13,
          fontFamily: "'Segoe UI', system-ui, sans-serif",
          lineHeight: 1.55,
          outline: "none",
          overflowY: "auto" as const,
          maxHeight: 300,
        }}
      />
      <style>{`[contenteditable][data-placeholder]:empty::before{content:attr(data-placeholder);color:#475569;pointer-events:none}`}</style>
    </div>
  );
}

/** Wrap raw contenteditable HTML in a complete HTML document with default
 *  styling so the recipient's mail client (Outlook etc.) renders it as
 *  rich HTML rather than treating it as a fragment. */
function buildEmailHtml(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:'Segoe UI','Aptos','Calibri',sans-serif;font-size:11pt;color:#1f2328;line-height:1.4}
    p{margin:0 0 10px}
    a{color:#0078D4}
    ul,ol{margin:0 0 10px;padding-left:24px}
    blockquote{border-left:2px solid #0078D4;margin:10px 0;padding:4px 12px;color:#475569}
  </style></head><body>${bodyHtml || "&nbsp;"}</body></html>`;
}
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
  loadAllPOEmailStats: () => void;
  loadDeletedFolder: () => void;
  emptyDeletedFolder: () => void;
}

export function emailViewPanel(ctx: EmailPanelCtx): React.ReactElement | null {
  const { em, emD, pos, setView, emailGraph, emailGraphPost, loadEmailAttachments, authenticateEmail, loadPOEmails, loadFullEmail, loadEmailThread, emailGetPrefix, emailMarkAsRead, deleteMainEmail, msSignOut, loadAllPOEmailStats, loadDeletedFolder, emptyDeletedFolder } = ctx;

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
  const { emailSelPO, emailsMap, emailLoadingMap, emailErrorsMap, emailSelMsg, emailThreadMsgs, emailThreadLoading, emailSentMap, emailSentLoading, emailComposeTo, emailComposeSubject, emailComposeBody, emailSendErr, emailNextLinks, emailLoadingOlder, emailReplyText, emailPOSearch, emailActiveFolder, emailSearchQuery, emailFilterUnread, emailFilterFlagged, emailFlaggedSet, emailCollapsedMsgs, emailComposeOpen, emailDeleteConfirm, emailSelectedId, emailCtxMenu, emailAttachments, emailAttachmentsLoading, showEmailConfig, msDisplayName, emailAllStats, emailAllStatsLoading, emailAllMessages, emailGlobalView, emailComposeAttachments, emailComposeAttachLoading, emailDeletedMessages, emailDeletedLoading, emailFolderCtxMenu } = em;

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
      const message: any = {
        subject: emailComposeSubject,
        body: { contentType: "HTML", content: buildEmailHtml(emailComposeBody) },
        toRecipients: emailComposeTo.split(",").map(e => ({ emailAddress: { address: e.trim() } })),
      };
      if (emailComposeAttachments.length > 0) {
        message.attachments = emailComposeAttachments.map(a => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: a.name,
          contentType: a.contentType || "application/octet-stream",
          contentBytes: a.contentBytes,
        }));
      }
      await emailGraphPost("/me/sendMail", { message });
      emSet("emailComposeTo", ""); emSet("emailComposeSubject", ""); emSet("emailComposeBody", "");
      emSet("emailComposeAttachments", []);
      emSet("emailComposeOpen", false);
      if (emailSelPO) setTimeout(() => loadPOEmails(emailSelPO), 2000);
    } catch (e: any) { emSet("emailSendErr", "Failed to send: " + e.message); }
  }

  // Convert a File to {name, size, contentType, contentBytes(base64)}.
  // Graph's fileAttachment limit per message is ~3MB total for sendMail.
  async function pickComposeAttachments(files: FileList | null) {
    if (!files || files.length === 0) return;
    emSet("emailComposeAttachLoading", true);
    try {
      const TOTAL_LIMIT = 3 * 1024 * 1024; // 3 MB safe limit for /me/sendMail
      const existingSize = emailComposeAttachments.reduce((s, a) => s + a.size, 0);
      const newOnes: Array<{ name: string; size: number; contentType: string; contentBytes: string }> = [];
      let runningSize = existingSize;
      for (const f of Array.from(files)) {
        if (runningSize + f.size > TOTAL_LIMIT) {
          emSet("emailSendErr", `"${f.name}" skipped — would exceed 3 MB attachment limit`);
          continue;
        }
        const buf = await f.arrayBuffer();
        // base64 encode
        let binary = "";
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        const b64 = btoa(binary);
        newOnes.push({ name: f.name, size: f.size, contentType: f.type || "application/octet-stream", contentBytes: b64 });
        runningSize += f.size;
      }
      emSet("emailComposeAttachments", [...emailComposeAttachments, ...newOnes]);
    } catch (e: any) {
      emSet("emailSendErr", "Failed to read file: " + (e?.message || e));
    } finally {
      emSet("emailComposeAttachLoading", false);
    }
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

  // When a specific PO is selected we use that PO's emailsMap entry; otherwise the
  // middle pane is in a global mode (All POs / Unread) and we use the pre-fetched
  // emailAllMessages list, optionally filtered to unread.
  const isGlobal = !emailSelPO && (emailGlobalView === "all" || emailGlobalView === "unread" || emailGlobalView === "deleted");
  const inboxEmails = isGlobal
    ? (emailGlobalView === "unread"
        ? emailAllMessages.filter((m: any) => !m.isRead)
        : emailGlobalView === "deleted"
          ? emailDeletedMessages
          : emailAllMessages)
    : (emailSelPO ? (emailsMap[emailSelPO] || []) : []);
  const sentEmailList = emailSelPO ? (emailSentMap[emailSelPO] || []) : [];
  const activeList = emailActiveFolder === "inbox" ? inboxEmails : sentEmailList;
  const isLoadingE = isGlobal
    ? (emailGlobalView === "deleted" ? emailDeletedLoading : emailAllStatsLoading)
    : (emailSelPO ? !!emailLoadingMap[emailSelPO] : false);
  const eError = isGlobal
    ? (emailGlobalView === "deleted" ? em.emailDeletedError : em.emailAllStatsError)
    : (emailSelPO ? emailErrorsMap[emailSelPO] : null);

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
    <div style={{ position: "relative" }} onClick={() => { if (emailCtxMenu) emSet("emailCtxMenu", null); if (emailFolderCtxMenu) emSet("emailFolderCtxMenu", null); }}>
      <button onClick={() => setView("dashboard")} title="Close Email"
        style={{ position: "absolute", top: 10, right: 14, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: `1px solid ${C.outlook}44`, background: `${C.outlook}15`, color: C.outlook, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>✕</button>

      <div style={{ display: "flex", height: "calc(100vh - 140px)", minHeight: 500, background: C.bg0, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden", position: "relative", fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: 13, color: C.text1 }}>

        {/* ── SIDEBAR (220px) */}
        <div style={{ width: 220, minWidth: 220, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Row 1: New Message — matches middle-panel header row */}
          <div style={{ padding: "0 10px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", height: 46 }}>
            <button
              onClick={() => { emSet("emailComposeOpen", true); emSet("emailComposeSubject", emailSelPO ? emailGetPrefix(emailSelPO) + " " : ""); emSet("emailSendErr", null); }}
              disabled={!emailToken}
              style={{ width: "100%", padding: "7px 0", background: emailToken ? `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})` : C.bg2, border: "none", borderRadius: 8, color: emailToken ? "#fff" : C.text3, fontSize: 13, fontWeight: 500, cursor: emailToken ? "pointer" : "default", display: "flex", alignItems: "center", gap: 8, justifyContent: "center", fontFamily: "inherit" }}>
              ✎ New Message
            </button>
          </div>
          {/* Row 2: Search POs — matches middle-panel search row */}
          <div style={{ padding: "0 10px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", height: 48 }}>
            <div style={{ position: "relative", width: "100%" }}>
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: C.text3, fontSize: 13, pointerEvents: "none" }}>⌕</span>
              <input value={emailPOSearch} onChange={e => emSet("emailPOSearch", e.target.value)} placeholder="Search POs…"
                style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 10px 6px 28px", color: C.text1, fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, height: 32 }} />
            </div>
          </div>

          {/* ── Folders: Inbox / Unread / Sent / Deleted / All POs ── */}
          {emailToken && (() => {
            const totalUnread = emailAllMessages.filter((m: any) => !m.isRead).length;
            const inboxUnreadForPO = emailSelPO ? (emailsMap[emailSelPO] || []).filter((e: any) => !e.isRead).length : 0;
            const SZ = 18;
            // Outlook 365-style SVG icons, all 18×18
            const iconInbox = (c: string) => <svg width={SZ} height={SZ} viewBox="0 0 20 20" fill="none"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5V10h-3.5a1 1 0 0 0-.8.4L11.5 12h-3l-1.2-1.6a1 1 0 0 0-.8-.4H3V4.5Z" stroke={c} strokeWidth="1.3" fill="none"/><path d="M3 10v5.5A1.5 1.5 0 0 0 4.5 17h11a1.5 1.5 0 0 0 1.5-1.5V10" stroke={c} strokeWidth="1.3" fill="none"/></svg>;
            const iconUnread = (c: string) => <svg width={SZ} height={SZ} viewBox="0 0 20 20" fill="none"><rect x="2" y="4" width="16" height="12" rx="1.5" stroke={c} strokeWidth="1.3" fill="none"/><path d="M2 5.5l8 5 8-5" stroke={c} strokeWidth="1.3" fill="none"/><circle cx="16" cy="5" r="3" fill={C.outlook} stroke={C.bg1} strokeWidth="1"/></svg>;
            const iconSent = (c: string) => <svg width={SZ} height={SZ} viewBox="0 0 20 20" fill="none"><path d="M3 10l14-6-4 14-3-5.5L3 10Z" stroke={c} strokeWidth="1.3" fill="none" strokeLinejoin="round"/><path d="M10 12.5L17 4" stroke={c} strokeWidth="1" fill="none"/></svg>;
            const iconDeleted = (c: string) => <svg width={SZ} height={SZ} viewBox="0 0 20 20" fill="none"><path d="M5 6h10l-1 11H6L5 6Z" stroke={c} strokeWidth="1.3" fill="none" strokeLinejoin="round"/><path d="M3 6h14" stroke={c} strokeWidth="1.3"/><path d="M8 3h4v2H8z" stroke={c} strokeWidth="1" fill="none"/></svg>;
            const iconFolder = (c: string) => <svg width={SZ} height={SZ} viewBox="0 0 20 20" fill="none"><path d="M2 5a1.5 1.5 0 0 1 1.5-1.5H7L9 5.5h8.5A1.5 1.5 0 0 1 19 7v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 1 15V5Z" stroke={c} strokeWidth="1.3" fill="none"/></svg>;
            type FolderRow = { key: string; label: string; icon: (c: string) => React.ReactNode; count: number; active: boolean; onClick: () => void; canEmpty?: boolean };
            const rows: FolderRow[] = [
              {
                key: "inbox", label: "Inbox", icon: iconInbox, count: inboxUnreadForPO,
                active: !isGlobal && emailActiveFolder === "inbox",
                onClick: () => { emSet("emailGlobalView", "po"); emSet("emailActiveFolder", "inbox"); emSet("emailSelectedId", null); emSet("emailSelMsg", null); emSet("emailThreadMsgs", []); },
              },
              {
                key: "unread", label: "Unread", icon: iconUnread, count: totalUnread,
                active: emailGlobalView === "unread",
                onClick: () => { emSet("emailGlobalView", "unread"); emSet("emailSelPO", null); emSet("emailSelectedId", null); emSet("emailSelMsg", null); emSet("emailThreadMsgs", []); emSet("emailActiveFolder", "inbox"); },
              },
              {
                key: "sent", label: "Sent", icon: iconSent, count: 0,
                active: !isGlobal && emailActiveFolder === "sent",
                onClick: () => { emSet("emailGlobalView", "po"); emSet("emailActiveFolder", "sent"); emSet("emailSelectedId", null); emSet("emailSelMsg", null); emSet("emailThreadMsgs", []); if (emailSelPO) loadPOSentEmails(emailSelPO); },
              },
              {
                key: "deleted", label: "Deleted", icon: iconDeleted, count: emailDeletedMessages.length,
                active: emailGlobalView === "deleted", canEmpty: true,
                onClick: () => { emSet("emailGlobalView", "deleted"); emSet("emailSelPO", null); emSet("emailSelectedId", null); emSet("emailSelMsg", null); emSet("emailThreadMsgs", []); emSet("emailActiveFolder", "inbox"); loadDeletedFolder(); },
              },
              {
                key: "all", label: "All POs", icon: iconFolder, count: emailAllMessages.length,
                active: emailGlobalView === "all",
                onClick: () => { emSet("emailGlobalView", "all"); emSet("emailSelPO", null); emSet("emailSelectedId", null); emSet("emailSelMsg", null); emSet("emailThreadMsgs", []); emSet("emailActiveFolder", "inbox"); },
              },
            ];
            return (
              <div style={{ padding: "4px 6px" }}>
                {rows.map(r => (
                  <div key={r.key}
                    onClick={r.onClick}
                    onContextMenu={r.canEmpty ? (e => { e.preventDefault(); emSet("emailFolderCtxMenu", { x: e.clientX, y: e.clientY, folder: r.key }); }) : undefined}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, margin: "1px 0", cursor: "pointer", fontSize: 12, background: r.active ? C.outlookDim : "transparent", color: r.active ? C.info : C.text2, border: r.active ? "1px solid rgba(96,165,250,0.2)" : "1px solid transparent", transition: "all 0.1s" }}>
                    <span style={{ width: 18, height: 18, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>{r.icon(r.active ? C.info : C.text3)}</span>
                    <span style={{ flex: 1 }}>{r.label}</span>
                    {r.count > 0 && (
                      <span style={{ background: r.key === "unread" ? C.outlook : C.bg3, color: r.key === "unread" ? "#fff" : C.text2, fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 10, minWidth: 16, textAlign: "center" as const }}>
                        {r.count}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}

          <div style={{ padding: "8px 12px 4px", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: C.text3, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>POs ({poList.length})</span>
            {emailToken && (
              <button onClick={loadAllPOEmailStats} disabled={emailAllStatsLoading}
                title="Refresh email counts"
                style={{ background: "none", border: "none", color: C.text3, cursor: "pointer", fontSize: 11, padding: 0, opacity: emailAllStatsLoading ? 0.4 : 1 }}>↻</button>
            )}
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {(() => {
              const s = emailPOSearch.toLowerCase();
              const statFor = (poNum: string) => {
                if (emailAllStats[poNum]) return emailAllStats[poNum];
                // Fallback to whatever's already in emailsMap
                const arr = emailsMap[poNum] || [];
                if (!arr.length) return null;
                return { total: arr.length, unread: arr.filter((e: any) => !e.isRead).length, latestDate: arr[0]?.receivedDateTime || "", latestSubject: "", latestSender: "" };
              };
              return poList.filter((p: any) => !s || (p.PoNumber ?? "").toLowerCase().includes(s) || (p.VendorName ?? "").toLowerCase().includes(s) || (p.Memo ?? "").toLowerCase().includes(s) || (p.Tags ?? "").toLowerCase().includes(s) || (p.StatusName ?? "").toLowerCase().includes(s))
                .sort((a: any, b: any) => {
                  const ua = statFor(a.PoNumber ?? "")?.unread ?? 0;
                  const ub = statFor(b.PoNumber ?? "")?.unread ?? 0;
                  if (ub !== ua) return ub - ua;
                  // Then by latest email date desc
                  const da = statFor(a.PoNumber ?? "")?.latestDate ?? "";
                  const db = statFor(b.PoNumber ?? "")?.latestDate ?? "";
                  return db.localeCompare(da);
                });
            })().map((po: any) => {
              const poNum = po.PoNumber ?? "";
              const isSelected = emailSelPO === poNum && emailGlobalView === "po";
              const stat = emailAllStats[poNum];
              const fallbackUnread = (emailsMap[poNum] || []).filter((e: any) => !e.isRead).length;
              const unread = stat?.unread ?? fallbackUnread;
              const total = stat?.total ?? (emailsMap[poNum] || []).length;
              const color = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
              return (
                <div key={poNum}
                  onClick={() => { emSet("emailGlobalView", "po"); emSet("emailSelPO", poNum === emailSelPO ? null : poNum); emSet("emailSelectedId", null); emSet("emailSelMsg", null); emSet("emailThreadMsgs", []); emSet("emailDeleteConfirm", null); emSet("emailActiveFolder", "inbox"); if (poNum !== emailSelPO && emailToken) loadPOEmails(poNum, undefined, true); }}
                  style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", borderRadius: 7, margin: "1px 6px", cursor: "pointer", fontSize: 12, background: isSelected ? C.outlookDim : "transparent", color: isSelected ? C.info : C.text2, border: isSelected ? "1px solid rgba(96,165,250,0.2)" : "1px solid transparent", transition: "all 0.1s" }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "monospace" }}>{poNum}</span>
                  {total > 0 && (
                    <span style={{ fontSize: 9, color: C.text3, fontFamily: "monospace" }}>{total}</span>
                  )}
                  {unread > 0 && <span style={{ background: C.outlook, color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 10, minWidth: 16, textAlign: "center" as const }}>{unread}</span>}
                </div>
              );
            })}
            {poList.length === 0 && <div style={{ padding: 16, fontSize: 12, color: C.text3, textAlign: "center" }}>No POs loaded — sync first</div>}
          </div>

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
          <div style={{ padding: "0 12px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", height: 46 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.text1 }}>
              {isGlobal
                ? (emailGlobalView === "unread" ? "Unread" : emailGlobalView === "deleted" ? "Deleted Items" : "All POs")
                : (emailActiveFolder === "inbox" ? "Inbox" : "Sent")}
              {emailSelPO && !isGlobal && <span style={{ fontSize: 11, color: C.text3, marginLeft: 6, fontWeight: 400 }}>· PO {emailSelPO}</span>}
              {isGlobal && <span style={{ fontSize: 11, color: C.text3, marginLeft: 6, fontWeight: 400 }}>· {inboxEmails.length}</span>}
            </span>
            <button style={iconBtn} title="Refresh"
              onClick={() => { if (isGlobal) loadAllPOEmailStats(); else if (emailSelPO) { if (emailActiveFolder === "inbox") loadPOEmails(emailSelPO); else loadPOSentEmails(emailSelPO); } }}>↻</button>
          </div>

          <div style={{ padding: "0 10px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", height: 48 }}>
            <div style={{ position: "relative", width: "100%" }}>
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: C.text3, fontSize: 13, pointerEvents: "none" }}>⌕</span>
              <input style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 10px 6px 28px", color: C.text1, fontSize: 12, outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit", height: 32 }}
                placeholder="Search…" value={emailSearchQuery} onChange={e => emSet("emailSearchQuery", e.target.value)} />
            </div>
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
            ) : !emailSelPO && !isGlobal ? (
              <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 12 }}>Select a PO from the left, or pick "All POs" / "Unread"</div>
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
                    ? new Date(mail.receivedDateTime).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                    : mail.sentDateTime
                    ? new Date(mail.sentDateTime).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                    : "";
                  const isFlagged = emailFlaggedSet.has(mail.id);
                  const isUnread = !mail.isRead && emailActiveFolder === "inbox";
                  const ownerPO = mail._poNumber as string | undefined;
                  return (
                    <div key={mail.id}
                      onClick={() => {
                        emSet("emailSelectedId", mail.id);
                        emSet("emailDeleteConfirm", null);
                        emSet("emailReplyText", "");
                        if (emailActiveFolder === "inbox" && !mail.isRead) {
                          emailMarkAsRead(mail.id);
                          const markReadArr = (arr: any[]) => arr.map((e: any) => e.id === mail.id ? { ...e, isRead: true } : e);
                          if (emailSelPO) {
                            emSetFn("emailsMap", (m: any) => ({ ...m, [emailSelPO]: markReadArr(m[emailSelPO] || []) }));
                            emSetFn("dtlEmails", (m: any) => ({ ...m, [emailSelPO]: markReadArr(m[emailSelPO] || []) }));
                          }
                          // Always update the global cache + per-PO stats so the count drops everywhere
                          emSetFn("emailAllMessages", (arr: any[]) => markReadArr(arr || []));
                          if (ownerPO) {
                            emSetFn("emailAllStats", (s: any) => {
                              const cur = s?.[ownerPO];
                              if (!cur) return s;
                              return { ...s, [ownerPO]: { ...cur, unread: Math.max(0, (cur.unread || 0) - 1) } };
                            });
                          }
                        }
                        loadFullEmail(mail.id);
                        if (mail.conversationId) loadEmailThread(mail.conversationId);
                        // Always try to load attachments — search-result hasAttachments
                        // can be unreliable, so don't gate on it
                        loadEmailAttachments(mail.id);
                      }}
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
                      <div style={{ fontSize: 12, fontWeight: 500, color: C.text1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
                        {isGlobal && ownerPO && (
                          <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: C.outlookDim, color: C.info, fontFamily: "monospace", flexShrink: 0 }}>{ownerPO}</span>
                        )}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mail.subject}</span>
                      </div>
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
                  <button style={{ ...iconBtn, color: C.error }} title="Move to Deleted Items" onClick={() => {
                    // Move immediately — no confirmation. Add to deleted folder state dynamically.
                    const msg = selEmailObj;
                    if (msg) {
                      emSetFn("emailDeletedMessages", (arr: any[]) => [msg, ...(arr || [])]);
                    }
                    deleteMainEmail(emailSelectedId);
                  }}>🗑️</button>
                </div>
              </div>

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
                    const inline = (emailAttachments[msg.id] || []).filter((a: any) => a.isInline);
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
                            <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(htmlBody, inline)}
                              style={{ width: "100%", border: "none", minHeight: 80, borderRadius: 6, background: "#ffffff" }}
                              onLoad={e => { try { const f = e.target as HTMLIFrameElement; const h = f.contentDocument?.body.scrollHeight || 0; f.style.height = (h + 24) + "px"; } catch {} }} />
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : selEmailObj ? (
                  (() => {
                    const inline = (emailAttachments[selEmailObj.id] || []).filter((a: any) => a.isInline);
                    return (
                      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.text3 }}>
                          From: {selEmailObj.from?.emailAddress?.name || selEmailObj.from?.emailAddress?.address || "Unknown"}
                        </div>
                        <div style={{ padding: "0 14px 14px" }}>
                          <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(selEmailObj.body?.content || selEmailObj.bodyPreview || "", inline)}
                            style={{ width: "100%", border: "none", minHeight: 100, borderRadius: 6, background: "#ffffff" }}
                            onLoad={e => { try { const f = e.target as HTMLIFrameElement; const h = f.contentDocument?.body.scrollHeight || 0; f.style.height = (h + 24) + "px"; } catch {} }} />
                        </div>
                      </div>
                    );
                  })()
                ) : null}
              </div>

              {emailSelectedId && (() => {
                const fileAtts = (emailAttachments[emailSelectedId] || []).filter((a: any) => !a.isInline);
                if (fileAtts.length === 0 && !emailAttachmentsLoading[emailSelectedId]) return null;
                return (
                  <div style={{ borderTop: `1px solid ${C.border}`, padding: "8px 18px", background: C.bg1, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: C.text3, marginRight: 4 }}>📎 Attachments:</span>
                    {fileAtts.map((att: any) => {
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
                );
              })()}

              <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 18px", background: C.bg1 }}>
                <div style={{ fontSize: 12, color: C.text3, marginBottom: 6 }}>
                  Reply to <span style={{ color: C.info }}>{emailThreadMsgs.length > 0 ? (emailThreadMsgs[emailThreadMsgs.length - 1].from?.emailAddress?.address || "") : (selEmailObj?.from?.emailAddress?.address || "")}</span>
                </div>
                <textarea
                  style={{ width: "100%", minHeight: 72, background: "transparent", border: "none", color: C.text1, fontSize: 13, fontFamily: "inherit", resize: "none" as const, outline: "none", lineHeight: 1.6, boxSizing: "border-box" as const }}
                  data-reply-box placeholder="Write a reply…" value={emailReplyText} onChange={e => emSet("emailReplyText", e.target.value)} />
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
                  <RichTextEditor
                    value={emailComposeBody}
                    onChange={html => emSet("emailComposeBody", html)}
                    placeholder="Type your message…"
                  />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.text3, marginBottom: 3, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>Attachments {emailComposeAttachments.length > 0 && <span style={{ color: C.text2 }}>({emailComposeAttachments.length}, {(emailComposeAttachments.reduce((s, a) => s + a.size, 0) / 1024).toFixed(0)} KB / 3 MB)</span>}</span>
                    <label style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", color: C.info, fontSize: 11, cursor: "pointer" }}>
                      📎 Add files
                      <input type="file" multiple style={{ display: "none" }}
                        onChange={e => { pickComposeAttachments(e.target.files); (e.target as HTMLInputElement).value = ""; }}
                        disabled={emailComposeAttachLoading} />
                    </label>
                  </div>
                  {emailComposeAttachLoading && <div style={{ fontSize: 11, color: C.text3 }}>Encoding…</div>}
                  {emailComposeAttachments.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                      {emailComposeAttachments.map((a, i) => (
                        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 8px", fontSize: 11, color: C.text1 }}>
                          📄 {a.name} <span style={{ color: C.text3 }}>({(a.size / 1024).toFixed(0)} KB)</span>
                          <button onClick={() => emSet("emailComposeAttachments", emailComposeAttachments.filter((_, j) => j !== i))}
                            style={{ background: "none", border: "none", color: C.text3, cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1 }}>✕</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => { emD({ type: "EMAIL_RESET_COMPOSE" }); emSet("emailComposeAttachments", []); emSet("emailComposeOpen", false); }}
                  style={{ padding: "7px 16px", borderRadius: 7, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit" }}>Discard</button>
                <button onClick={doSendEmail} disabled={!emailComposeTo.trim() || !emailComposeSubject.trim()}
                  style={{ padding: "7px 18px", background: `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})`, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: (!emailComposeTo.trim() || !emailComposeSubject.trim()) ? 0.5 : 1 }}>
                  Send ↗
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── FOLDER CONTEXT MENU (right-click on Deleted folder) */}
        {emailFolderCtxMenu && (
          <div
            style={{ position: "fixed", top: emailFolderCtxMenu.y, left: emailFolderCtxMenu.x, zIndex: 2000, background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 8, padding: "4px 0", boxShadow: "0 8px 24px rgba(0,0,0,0.5)", minWidth: 190 }}
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}>
            <div style={{ padding: "8px 16px", fontSize: 12, color: C.error, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
              onClick={() => {
                emSet("emailFolderCtxMenu", null);
                if (emailDeletedMessages.length > 0) emSet("emailDeleteConfirm", "__empty_deleted__");
              }}>
              🗑 Empty folder
            </div>
          </div>
        )}

        {/* ── EMPTY DELETED CONFIRM MODAL ── */}
        {emailDeleteConfirm === "__empty_deleted__" && (
          <div style={{ position: "absolute", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }}
            onClick={() => emSet("emailDeleteConfirm", null)}>
            <div style={{ background: C.bg1, border: `1px solid ${C.border2}`, borderRadius: 12, padding: "24px 28px", boxShadow: "0 12px 40px rgba(0,0,0,0.6)", maxWidth: 360, textAlign: "center" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>🗑</div>
              <h3 style={{ color: C.text1, margin: "0 0 8px", fontSize: 16, fontWeight: 600 }}>Empty Deleted Items?</h3>
              <p style={{ color: C.text2, fontSize: 13, margin: "0 0 18px", lineHeight: 1.5 }}>
                Permanently delete {emailDeletedMessages.length > 1 ? `all ${emailDeletedMessages.length} messages` : "this message"} in Deleted Items. This cannot be undone.
              </p>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <button onClick={() => emSet("emailDeleteConfirm", null)}
                  style={{ padding: "8px 18px", borderRadius: 8, border: `1px solid ${C.border}`, background: "none", color: C.text2, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Cancel</button>
                <button onClick={() => { emptyDeletedFolder(); emSet("emailDeleteConfirm", null); }}
                  style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: C.error, color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>Delete All</button>
              </div>
            </div>
          </div>
        )}

        {/* ── CONTEXT MENU */}
        {emailCtxMenu && (() => {
          const ctxMail = emailCtxMenu.em;
          const selectAndLoad = () => {
            emSet("emailSelectedId", ctxMail.id);
            loadFullEmail(ctxMail.id);
            if (ctxMail.conversationId) loadEmailThread(ctxMail.conversationId);
            if (ctxMail.hasAttachments) loadEmailAttachments(ctxMail.id);
          };
          const ctxItemStyle: React.CSSProperties = { padding: "8px 16px", fontSize: 12, color: C.text1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 };
          return (
            <div style={{ position: "fixed", top: emailCtxMenu.y, left: emailCtxMenu.x, zIndex: 2000, background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 8, padding: "4px 0", boxShadow: "0 8px 24px rgba(0,0,0,0.5)", minWidth: 170 }}
              onClick={e => e.stopPropagation()}>
              <div style={ctxItemStyle}
                onClick={() => { selectAndLoad(); emSet("emailReplyText", ""); emSet("emailCtxMenu", null); setTimeout(() => { document.querySelector<HTMLTextAreaElement>("[data-reply-box]")?.focus(); }, 100); }}>
                ↩ Reply
              </div>
              <div style={ctxItemStyle}
                onClick={() => { selectAndLoad(); emSet("emailReplyText", ""); emSet("emailCtxMenu", null); setTimeout(() => { document.querySelector<HTMLTextAreaElement>("[data-reply-box]")?.focus(); }, 100); }}>
                ↩↩ Reply All
              </div>
              <div style={ctxItemStyle}
                onClick={() => {
                  const sender = ctxMail.from?.emailAddress?.name || ctxMail.from?.emailAddress?.address || "";
                  const date = ctxMail.receivedDateTime ? new Date(ctxMail.receivedDateTime).toLocaleString() : "";
                  const origSubject = ctxMail.subject || "";
                  const fwSubject = origSubject.startsWith("Fw:") || origSubject.startsWith("FW:") ? origSubject : `Fw: ${origSubject}`;
                  const fwBody = `<br/><hr/><p style="font-size:12px;color:#475569"><b>From:</b> ${sender}<br/><b>Date:</b> ${date}<br/><b>Subject:</b> ${origSubject}</p><p>${ctxMail.bodyPreview || ""}</p>`;
                  emSet("emailComposeOpen", true);
                  emSet("emailComposeSubject", fwSubject);
                  emSet("emailComposeBody", fwBody);
                  emSet("emailComposeTo", "");
                  emSet("emailSendErr", null);
                  emSet("emailCtxMenu", null);
                }}>
                ↪ Forward
              </div>
              <div style={{ height: 1, background: C.border, margin: "3px 0" }} />
              <div style={{ ...ctxItemStyle, color: C.error }}
                onClick={() => {
                  // Move to Deleted Items immediately (no confirmation)
                  emSetFn("emailDeletedMessages", (arr: any[]) => [ctxMail, ...(arr || [])]);
                  deleteMainEmail(ctxMail.id);
                  emSet("emailCtxMenu", null);
                }}>
                🗑 Delete
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
