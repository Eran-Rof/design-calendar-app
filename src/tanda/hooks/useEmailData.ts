import { useTandaStore } from "../store";

interface UseEmailDataOpts {
  emailGraph: (path: string) => Promise<any>;
  getGraphToken: () => Promise<string>;
  msToken: string | null;
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
  loadEmailAttachments: (messageId: string) => void;
  loadPOEmailsRef: React.MutableRefObject<((poNum: string) => void) | undefined>;
}

export function useEmailData(opts: UseEmailDataOpts) {
  // All functions read opts/store at call time (not memoized) to avoid
  // useCallback dep arrays that change every render and cause re-render loops.
  const getStore = () => useTandaStore.getState();

  function emailGetPrefix(poNum: string) { return "[PO-" + poNum + "]"; }

  async function loadFullEmail(id: string) {
    try { const d = await opts.emailGraph("/me/messages/" + id); opts.setEmailSelMsg(d); } catch (e) { console.error(e); }
  }

  async function loadEmailThread(conversationId: string) {
    opts.setEmailThreadLoading(true);
    try {
      const d = await opts.emailGraph("/me/messages?$filter=" + encodeURIComponent("conversationId eq '" + conversationId + "'") + "&$orderby=receivedDateTime%20asc&$select=id,subject,from,receivedDateTime,body,conversationId,isRead,hasAttachments");
      opts.setEmailThreadMsgs(d.value || []);
    } catch (e) { opts.setEmailThreadMsgs([]); }
    opts.setEmailThreadLoading(false);
  }

  async function loadPOEmails(poNum: string, olderUrl?: string, autoSelect?: boolean) {
    opts.loadPOEmailsRef.current = loadPOEmails;
    if (!opts.msToken) return;
    const prefix = emailGetPrefix(poNum);
    if (olderUrl) { opts.setEmailLoadingOlder(true); } else { opts.setEmailLoadingMap((l: any) => ({ ...l, [poNum]: true })); }
    opts.setEmailErrorsMap((e: any) => ({ ...e, [poNum]: null }));
    try {
      const searchTermPO = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const url = olderUrl || ("/me/mailFolders/Inbox/messages?$search=" + encodeURIComponent('"' + searchTermPO + '"') + "&$top=25&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments");
      const d = await opts.emailGraph(url);
      const items = d.value || [];
      if (olderUrl) {
        opts.setEmailsMap((m: any) => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
        opts.setDtlEmails((m: any) => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
      } else {
        opts.setEmailsMap((m: any) => ({ ...m, [poNum]: items }));
        opts.setDtlEmails((m: any) => ({ ...m, [poNum]: items }));
        if (autoSelect && items.length > 0) {
          const sorted = [...items].sort((a: any, b: any) => {
            if (!a.isRead && b.isRead) return -1;
            if (a.isRead && !b.isRead) return 1;
            return new Date(b.receivedDateTime || 0).getTime() - new Date(a.receivedDateTime || 0).getTime();
          });
          const first = sorted[0];
          opts.setEmailSelectedId(first.id);
          opts.setEmailSelMsg(null);
          loadFullEmail(first.id);
          if (first.conversationId) loadEmailThread(first.conversationId);
          if (first.hasAttachments) opts.loadEmailAttachments(first.id);
        }
      }
      const nextLink = d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null;
      opts.setEmailNextLinks((nl: any) => ({ ...nl, [poNum]: nextLink }));
      opts.setDtlNextLink((nl: any) => ({ ...nl, [poNum]: nextLink }));
      opts.setEmailLastRefresh((lr: any) => ({ ...lr, [poNum]: Date.now() }));
    } catch (e: any) { opts.setEmailErrorsMap((err: any) => ({ ...err, [poNum]: e.message })); }
    opts.setEmailLoadingMap((l: any) => ({ ...l, [poNum]: false }));
    opts.setEmailLoadingOlder(false);
  }

  async function loadDeletedFolder() {
    if (!opts.msToken) return;
    getStore().setEmailField("emailDeletedLoading", true);
    getStore().setEmailField("emailDeletedError", null);
    try {
      const url = "/me/mailFolders/DeletedItems/messages?$top=200&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments";
      const d = await opts.emailGraph(url);
      const raw = Array.isArray(d?.value) ? d.value : [];
      const items: any[] = raw.map((m: any) => {
        const match = (m.subject || "").match(/\[PO-([^\]]+)\]/);
        return match ? { ...m, _poNumber: match[1] } : m;
      });
      getStore().setEmailField("emailDeletedMessages", items);
    } catch (e: any) {
      getStore().setEmailField("emailDeletedError", e?.message || "Failed to load deleted folder");
    } finally {
      getStore().setEmailField("emailDeletedLoading", false);
    }
  }

  async function emptyDeletedFolder() {
    if (!opts.msToken) return;
    const messages: any[] = (getStore() as any).emailDeletedMessages || [];
    if (messages.length === 0) return;
    getStore().setEmailField("emailDeletedLoading", true);
    try {
      for (const m of messages) {
        try {
          const tok = await opts.getGraphToken();
          await fetch(`https://graph.microsoft.com/v1.0/me/messages/${m.id}`, {
            method: "DELETE",
            headers: { Authorization: "Bearer " + tok },
          });
        } catch (e) {
          console.warn("emptyDeletedFolder: failed for", m.id, e);
        }
      }
      getStore().setEmailField("emailDeletedMessages", []);
    } finally {
      getStore().setEmailField("emailDeletedLoading", false);
    }
  }

  async function loadAllPOEmailStats() {
    if (!opts.msToken) return;
    getStore().setEmailField("emailAllStatsLoading", true);
    getStore().setEmailField("emailAllStatsError", null);
    try {
      const url = `/me/mailFolders/Inbox/messages?$search=${encodeURIComponent('"[PO-"')}&$top=500&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId`;
      const d = await opts.emailGraph(url);
      const items: any[] = Array.isArray(d?.value) ? d.value : [];
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
        tagged.push({ ...m, _poNumber: poNum });
      }
      getStore().setEmailField("emailAllStats", stats);
      getStore().setEmailField("emailAllMessages", tagged);
    } catch (e: any) {
      getStore().setEmailField("emailAllStatsError", e?.message || "Failed to load email stats");
    } finally {
      getStore().setEmailField("emailAllStatsLoading", false);
    }
  }

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
