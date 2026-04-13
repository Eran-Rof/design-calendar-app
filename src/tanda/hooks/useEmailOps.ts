import { buildEmailHtml } from "../richTextEditor";

interface UseEmailOpsOpts {
  getGraphToken: () => Promise<string>;
  handleEmailTokenExpired: () => void;
  msToken: string | null;
  // Email attachment state
  emailAttachments: Record<string, any[]>;
  setEmailAttachments: (v: any) => void;
  setEmailAttachmentsLoading: (v: any) => void;
  // Email selection state
  emailSelPO: string | null;
  setEmailSelectedId: (v: string | null) => void;
  setEmailSelMsg: (v: any) => void;
  setEmailDeleteConfirm: (v: string | null) => void;
  setEmailThreadMsgs: (v: any) => void;
  setEmailsMap: (v: any) => void;
  setEmailSentMap: (v: any) => void;
  setEmailAllMessages: (v: any) => void;
  setEmailNextLinks: (v: any) => void;
  setEmailLastRefresh: (v: any) => void;
  // Detail panel email state
  setDtlEmails: (v: any) => void;
  setDtlSentEmails: (v: any) => void;
  setDtlEmailLoading: (v: any) => void;
  setDtlEmailErr: (v: any) => void;
  setDtlLoadingOlder: (v: boolean) => void;
  setDtlSentLoading: (v: any) => void;
  setDtlNextLink: (v: any) => void;
  setDtlEmailSel: (v: any) => void;
  setDtlEmailThread: (v: any) => void;
  setDtlThreadLoading: (v: boolean) => void;
  setDtlEmailTab: (v: string) => void;
  // Compose state
  dtlComposeTo: string;
  setDtlComposeTo: (v: string) => void;
  dtlComposeSubject: string;
  setDtlComposeSubject: (v: string) => void;
  dtlComposeBody: string;
  setDtlComposeBody: (v: string) => void;
  setDtlSendErr: (v: string | null) => void;
  dtlReply: string;
  setDtlReply: (v: string) => void;
  dtlEmailSel: any;
  // Ref to loadPOEmails — breaks a circular dependency (loadPOEmails
  // uses emailGraph from this hook, but this hook hasn't returned yet
  // when loadPOEmails is defined). The ref is set by the parent after
  // the hook call.
  loadPOEmailsRef: React.MutableRefObject<((poNum: string) => void) | undefined>;
}

export function useEmailOps(opts: UseEmailOpsOpts) {
  const {
    getGraphToken, handleEmailTokenExpired, msToken,
    emailAttachments, setEmailAttachments, setEmailAttachmentsLoading,
    emailSelPO, setEmailSelectedId, setEmailSelMsg, setEmailDeleteConfirm,
    setEmailThreadMsgs, setEmailsMap, setEmailSentMap, setEmailAllMessages,
    setEmailNextLinks, setEmailLastRefresh,
    setDtlEmails, setDtlSentEmails, setDtlEmailLoading, setDtlEmailErr,
    setDtlLoadingOlder, setDtlSentLoading, setDtlNextLink,
    setDtlEmailSel, setDtlEmailThread, setDtlThreadLoading, setDtlEmailTab,
    dtlComposeTo, setDtlComposeTo, dtlComposeSubject, setDtlComposeSubject,
    dtlComposeBody, setDtlComposeBody, setDtlSendErr,
    dtlReply, setDtlReply, dtlEmailSel, loadPOEmailsRef,
  } = opts;

  const emailToken = msToken;

  async function emailGraph(path: string) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" } });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }

  async function emailGraphPost(path: string, body: any) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired"); }
    if (r.status === 202 || r.status === 200) return r.status === 202 ? {} : r.json();
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }

  async function emailGraphDelete(path: string) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "DELETE", headers: { Authorization: "Bearer " + tok } });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired"); }
  }

  async function loadEmailAttachments(messageId: string, force = false) {
    if (!force && emailAttachments[messageId] !== undefined && emailAttachments[messageId].length > 0) return;
    setEmailAttachmentsLoading((a: any) => ({ ...a, [messageId]: true }));
    try {
      const tok = await getGraphToken();
      const r = await fetch("https://graph.microsoft.com/v1.0/me/messages/" + messageId + "/attachments?$top=20", { headers: { Authorization: "Bearer " + tok } });
      if (!r.ok) {
        console.warn(`loadEmailAttachments(${messageId}) failed:`, r.status);
        setEmailAttachments((a: any) => ({ ...a, [messageId]: [] }));
      } else {
        const d = await r.json();
        setEmailAttachments((a: any) => ({ ...a, [messageId]: (d.value || []) }));
      }
    } catch (e) {
      console.warn(`loadEmailAttachments(${messageId}) error:`, e);
      setEmailAttachments((a: any) => ({ ...a, [messageId]: [] }));
    }
    setEmailAttachmentsLoading((a: any) => ({ ...a, [messageId]: false }));
  }

  async function emailMarkAsRead(id: string) {
    try {
      const tok = await getGraphToken();
      await fetch("https://graph.microsoft.com/v1.0/me/messages/" + id, {
        method: "PATCH",
        headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      });
    } catch {}
  }

  async function deleteMainEmail(messageId: string) {
    try {
      await emailGraphPost("/me/messages/" + messageId + "/move", { destinationId: "deleteditems" });
      setEmailSelectedId(null);
      setEmailSelMsg(null);
      setEmailDeleteConfirm(null);
      setEmailThreadMsgs([]);
      const filterOut = (arr: any[]) => arr.filter((e: any) => e.id !== messageId);
      if (emailSelPO) {
        setEmailsMap((m: any) => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
        setEmailSentMap((m: any) => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
        setDtlEmails((m: any) => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
        setDtlSentEmails((m: any) => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
      }
      setEmailAllMessages((arr: any[]) => (arr || []).filter((e: any) => e.id !== messageId));
    } catch (e) { console.error("Delete email error", e); }
  }

  async function loadDtlEmails(poNum: string, olderUrl?: string) {
    if (!emailToken) return;
    const prefix = "[PO-" + poNum + "]";
    if (olderUrl) { setDtlLoadingOlder(true); } else { setDtlEmailLoading((l: any) => ({ ...l, [poNum]: true })); }
    setDtlEmailErr((e: any) => ({ ...e, [poNum]: null }));
    try {
      const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const url = olderUrl || ("/me/mailFolders/Inbox/messages?$search=" + encodeURIComponent('"' + searchTerm + '"') + "&$top=25&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments");
      const d = await emailGraph(url);
      const items = d.value || [];
      if (olderUrl) {
        setDtlEmails((m: any) => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
        setEmailsMap((m: any) => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
      } else {
        setDtlEmails((m: any) => ({ ...m, [poNum]: items }));
        setEmailsMap((m: any) => ({ ...m, [poNum]: items }));
      }
      const nextLink = d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null;
      setDtlNextLink((nl: any) => ({ ...nl, [poNum]: nextLink }));
      setEmailNextLinks((nl: any) => ({ ...nl, [poNum]: nextLink }));
      setEmailLastRefresh((lr: any) => ({ ...lr, [poNum]: Date.now() }));
    } catch (e: any) { setDtlEmailErr((err: any) => ({ ...err, [poNum]: e.message })); }
    setDtlEmailLoading((l: any) => ({ ...l, [poNum]: false }));
    setDtlLoadingOlder(false);
  }

  async function loadDtlSentEmails(poNum: string) {
    if (!emailToken) return;
    const prefix = "[PO-" + poNum + "]";
    setDtlSentLoading((l: any) => ({ ...l, [poNum]: true }));
    try {
      const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const d = await emailGraph("/me/mailFolders/SentItems/messages?$search=" + encodeURIComponent('"' + searchTerm + '"') + "&$top=25&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview,conversationId,hasAttachments");
      setDtlSentEmails((m: any) => ({ ...m, [poNum]: d.value || [] }));
      setEmailSentMap((m: any) => ({ ...m, [poNum]: d.value || [] }));
    } catch (e) { console.error(e); }
    setDtlSentLoading((l: any) => ({ ...l, [poNum]: false }));
  }

  async function loadDtlFullEmail(id: string) {
    try { const d = await emailGraph("/me/messages/" + id); setDtlEmailSel(d); } catch (e) { console.error(e); }
  }

  async function loadDtlThread(conversationId: string) {
    setDtlThreadLoading(true);
    try {
      const d = await emailGraph("/me/messages?$filter=" + encodeURIComponent("conversationId eq '" + conversationId + "'") + "&$orderby=receivedDateTime%20asc&$select=id,subject,from,receivedDateTime,body,conversationId,isRead,hasAttachments");
      setDtlEmailThread(d.value || []);
    } catch { setDtlEmailThread([]); }
    setDtlThreadLoading(false);
    setDtlEmailTab("thread");
  }

  async function dtlSendEmail(poNum: string) {
    if (!dtlComposeTo.trim() || !dtlComposeSubject.trim()) return;
    setDtlSendErr(null);
    try {
      await emailGraphPost("/me/sendMail", {
        message: { subject: dtlComposeSubject, body: { contentType: "HTML", content: buildEmailHtml(dtlComposeBody) }, toRecipients: dtlComposeTo.split(",").map(e => ({ emailAddress: { address: e.trim() } })) },
      });
      setDtlComposeTo(""); setDtlComposeSubject(""); setDtlComposeBody("");
      setDtlEmailTab("inbox");
      setTimeout(() => { loadDtlEmails(poNum); loadPOEmailsRef.current?.(poNum); }, 2000);
    } catch (e: any) { setDtlSendErr("Failed to send: " + e.message); }
  }

  async function dtlReplyToEmail(messageId: string) {
    if (!dtlReply.trim()) return;
    setDtlSendErr(null);
    try {
      await emailGraphPost("/me/messages/" + messageId + "/reply", { comment: dtlReply });
      setDtlReply("");
      if (dtlEmailSel?.conversationId) loadDtlThread(dtlEmailSel.conversationId);
    } catch (e: any) { setDtlSendErr("Failed to reply: " + e.message); }
  }

  return {
    emailGraph,
    emailGraphPost,
    emailGraphDelete,
    loadEmailAttachments,
    emailMarkAsRead,
    deleteMainEmail,
    loadDtlEmails,
    loadDtlSentEmails,
    loadDtlFullEmail,
    loadDtlThread,
    dtlSendEmail,
    dtlReplyToEmail,
  };
}
