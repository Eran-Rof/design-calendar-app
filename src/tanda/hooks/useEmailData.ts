import { useCallback } from "react";
import { useTandaStore } from "../store";

interface UseEmailDataOpts {
  emailGraph: (path: string) => Promise<any>;
  getGraphToken: () => Promise<string>;
  msToken: string | null;
  // State setters passed from TandA
  setEmailSelMsg: (v: any) => void;
  setEmailThreadLoading: (v: boolean) => void;
  setEmailThreadMsgs: (v: any) => void;
  setEmailLoadingOlder: (v: boolean) => void;
  setEmailLoadingMap: (v: any) => void;
  setEmailErrorsMap: (v: any) => void;
  setEmailsMap: (v: any) => void;
  setDtlEmails: (v: any) => void;
  setEmailSelectedId: (v: string | null) => void;
  setEmailNextLinks: (v: any) => void;
  setDtlNextLink: (v: any) => void;
  setEmailLastRefresh: (v: any) => void;
  // Downstream helpers
  loadEmailAttachments: (messageId: string) => void;
  loadPOEmailsRef: React.MutableRefObject<((poNum: string) => void) | undefined>;
}

export function useEmailData(opts: UseEmailDataOpts) {
  const {
    emailGraph, getGraphToken, msToken,
    setEmailSelMsg, setEmailThreadLoading, setEmailThreadMsgs,
    setEmailLoadingOlder, setEmailLoadingMap, setEmailErrorsMap,
    setEmailsMap, setDtlEmails, setEmailSelectedId,
    setEmailNextLinks, setDtlNextLink, setEmailLastRefresh,
    loadEmailAttachments, loadPOEmailsRef,
  } = opts;

  const store = useTandaStore();

  const emailGetPrefix = useCallback((poNum: string) => {
    return "[PO-" + poNum + "]";
  }, []);

  const loadFullEmail = useCallback(async (id: string) => {
    try { const d = await emailGraph("/me/messages/" + id); setEmailSelMsg(d); } catch (e) { console.error(e); }
  }, [emailGraph, setEmailSelMsg]);

  const loadEmailThread = useCallback(async (conversationId: string) => {
    setEmailThreadLoading(true);
    try {
      const d = await emailGraph("/me/messages?$filter=" + encodeURIComponent("conversationId eq '" + conversationId + "'") + "&$orderby=receivedDateTime%20asc&$select=id,subject,from,receivedDateTime,body,conversationId,isRead,hasAttachments");
      setEmailThreadMsgs(d.value || []);
    } catch (e) { setEmailThreadMsgs([]); }
    setEmailThreadLoading(false);
  }, [emailGraph, setEmailThreadMsgs, setEmailThreadLoading]);

  const loadPOEmails = useCallback(async (poNum: string, olderUrl?: string, autoSelect?: boolean) => {
    // Keep the ref in sync so useEmailOps can call us after send.
    loadPOEmailsRef.current = loadPOEmails;
    if (!msToken) return;
    const prefix = emailGetPrefix(poNum);
    if (olderUrl) { setEmailLoadingOlder(true); } else { setEmailLoadingMap((l: any) => ({ ...l, [poNum]: true })); }
    setEmailErrorsMap((e: any) => ({ ...e, [poNum]: null }));
    try {
      const searchTermPO = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const url = olderUrl || ("/me/mailFolders/Inbox/messages?$search=" + encodeURIComponent('"' + searchTermPO + '"') + "&$top=25&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments");
      const d = await emailGraph(url);
      const items = d.value || [];
      if (olderUrl) {
        setEmailsMap((m: any) => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
        setDtlEmails((m: any) => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
      } else {
        setEmailsMap((m: any) => ({ ...m, [poNum]: items }));
        setDtlEmails((m: any) => ({ ...m, [poNum]: items }));
        if (autoSelect && items.length > 0) {
          const sorted = [...items].sort((a: any, b: any) => {
            if (!a.isRead && b.isRead) return -1;
            if (a.isRead && !b.isRead) return 1;
            return new Date(b.receivedDateTime || 0).getTime() - new Date(a.receivedDateTime || 0).getTime();
          });
          const first = sorted[0];
          setEmailSelectedId(first.id);
          setEmailSelMsg(null);
          loadFullEmail(first.id);
          if (first.conversationId) loadEmailThread(first.conversationId);
          if (first.hasAttachments) loadEmailAttachments(first.id);
        }
      }
      const nextLink = d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null;
      setEmailNextLinks((nl: any) => ({ ...nl, [poNum]: nextLink }));
      setDtlNextLink((nl: any) => ({ ...nl, [poNum]: nextLink }));
      setEmailLastRefresh((lr: any) => ({ ...lr, [poNum]: Date.now() }));
    } catch (e: any) { setEmailErrorsMap((err: any) => ({ ...err, [poNum]: e.message })); }
    setEmailLoadingMap((l: any) => ({ ...l, [poNum]: false }));
    setEmailLoadingOlder(false);
  }, [msToken, emailGetPrefix, emailGraph, setEmailLoadingOlder, setEmailLoadingMap, setEmailErrorsMap, setEmailsMap, setDtlEmails, setEmailSelectedId, setEmailSelMsg, loadFullEmail, loadEmailThread, loadEmailAttachments, setEmailNextLinks, setDtlNextLink, setEmailLastRefresh, loadPOEmailsRef]);

  // Fetch all messages currently in the Outlook Deleted Items folder so the
  // user can review/restore/empty them. Limited to 200 most recent.
  const loadDeletedFolder = useCallback(async () => {
    if (!msToken) return;
    store.setEmailField("emailDeletedLoading", true);
    store.setEmailField("emailDeletedError", null);
    try {
      const url = "/me/mailFolders/DeletedItems/messages?$top=200&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments";
      const d = await emailGraph(url);
      const raw = Array.isArray(d?.value) ? d.value : [];
      const items: any[] = raw.map((m: any) => {
        const match = (m.subject || "").match(/\[PO-([^\]]+)\]/);
        return match ? { ...m, _poNumber: match[1] } : m;
      });
      store.setEmailField("emailDeletedMessages", items);
    } catch (e: any) {
      store.setEmailField("emailDeletedError", e?.message || "Failed to load deleted folder");
    } finally {
      store.setEmailField("emailDeletedLoading", false);
    }
  }, [msToken, emailGraph, store]);

  // Permanently delete every message currently in Deleted Items.
  const emptyDeletedFolder = useCallback(async () => {
    if (!msToken) return;
    const messages: any[] = (useTandaStore.getState() as any).emailDeletedMessages || [];
    if (messages.length === 0) return;
    store.setEmailField("emailDeletedLoading", true);
    try {
      // Best-effort: serial deletes (Graph batch is more code than it's worth here)
      for (const m of messages) {
        try {
          const tok = await getGraphToken();
          await fetch(`https://graph.microsoft.com/v1.0/me/messages/${m.id}`, {
            method: "DELETE",
            headers: { Authorization: "Bearer " + tok },
          });
        } catch (e) {
          console.warn("emptyDeletedFolder: failed for", m.id, e);
        }
      }
      store.setEmailField("emailDeletedMessages", []);
    } finally {
      store.setEmailField("emailDeletedLoading", false);
    }
  }, [msToken, getGraphToken, store]);

  // Pre-fetches a single batch of inbox messages tagged with a [PO-...] prefix,
  // groups them by PO number, and stores per-PO stats + a flat list for the
  // "All POs" / "Unread" global views. Cheaper than per-PO fetches and means
  // unread badges + counts appear without the user having to click each PO.
  const loadAllPOEmailStats = useCallback(async () => {
    if (!msToken) return;
    store.setEmailField("emailAllStatsLoading", true);
    store.setEmailField("emailAllStatsError", null);
    try {
      const url = `/me/mailFolders/Inbox/messages?$search=${encodeURIComponent('"[PO-"')}&$top=500&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId`;
      const d = await emailGraph(url);
      const items: any[] = Array.isArray(d?.value) ? d.value : [];
      // Group by extracted PO number — subject must contain "[PO-...]"
      const stats: Record<string, { total: number; unread: number; latestDate: string; latestSubject: string; latestSender: string }> = {};
      const re = /\[PO-([^\]]+)\]/;
      const tagged: any[] = [];
      for (const m of items) {
        const subj = m.subject || "";
        const match = subj.match(re);
        if (!match) continue;
        const poNum = match[1];
        const dateStr = m.receivedDateTime || "";
        if (!stats[poNum]) stats[poNum] = { total: 0, unread: 0, latestDate: dateStr, latestSubject: subj, latestSender: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "" };
        stats[poNum].total += 1;
        if (!m.isRead) stats[poNum].unread += 1;
        if (dateStr > stats[poNum].latestDate) {
          stats[poNum].latestDate = dateStr;
          stats[poNum].latestSubject = subj;
          stats[poNum].latestSender = m.from?.emailAddress?.name || m.from?.emailAddress?.address || "";
        }
        // Tag the message so the global views know which PO it belongs to
        tagged.push({ ...m, _poNumber: poNum });
      }
      store.setEmailField("emailAllStats", stats);
      store.setEmailField("emailAllMessages", tagged);
    } catch (e: any) {
      store.setEmailField("emailAllStatsError", e?.message || "Failed to load email stats");
    } finally {
      store.setEmailField("emailAllStatsLoading", false);
    }
  }, [msToken, emailGraph, store]);

  return {
    emailGetPrefix,
    loadFullEmail,
    loadEmailThread,
    loadPOEmails,
    loadDeletedFolder,
    emptyDeletedFolder,
    loadAllPOEmailStats,
  };
}
