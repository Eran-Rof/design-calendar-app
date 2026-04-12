import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { friendlyContactError } from "./useMSAuth";

interface UseTeamsOpsOpts {
  // Graph API helpers
  teamsGraph: (url: string) => Promise<any>;
  teamsGraphPost: (url: string, body: any) => Promise<any>;

  // State getters
  teamsToken: string | null;
  teamsTeamId: string;
  teamsChannelMap: any;
  teamsContacts: any[];
  teamsContactsLoading: boolean;
  teamsNewMsg: string;
  teamsDirectTo: string;
  teamsDirectMsg: string;
  dmSelectedName: string;
  dmActiveChatId: string | null;
  dmNewMsg: string;
  dmScrollRef: React.RefObject<HTMLDivElement | null>;

  // State setters
  setTeamsTeamId: (v: string) => void;
  setTeamsChannelMap: (v: any) => void;
  setTeamsContacts: (v: any) => void;
  setTeamsContactsLoading: (v: boolean) => void;
  setTeamsContactsError: (v: string | null) => void;
  setTeamsContactSearchResults: (v: any) => void;
  setTeamsContactSearch: (v: string) => void;
  setTeamsContactDropdown: (v: boolean) => void;
  setTeamsCreating: (v: string | null) => void;
  setTeamsLoading: (v: any) => void;
  setTeamsMessages: (v: any) => void;
  setTeamsNewMsg: (v: string) => void;
  setTeamsDirectTo: (v: string) => void;
  setTeamsDirectMsg: (v: string) => void;
  setTeamsDirectSending: (v: boolean) => void;
  setTeamsDirectErr: (v: string | null) => void;
  setDmConversations: (v: any) => void;
  setDmActiveChatId: (v: string | null) => void;
  setDmComposing: (v: boolean) => void;
  setDmSelectedName: (v: string) => void;
  setDmLoading: (v: boolean) => void;
  setDmError: (v: string | null) => void;
  setDmNewMsg: (v: string) => void;
  setDmSending: (v: boolean) => void;
  setDtlDMTo: (v: string) => void;
  setDtlDMContactSearch: (v: string) => void;
  setDtlDMContactDropdown: (v: boolean) => void;
  setDtlDMContactSearchResults: (v: any) => void;
  setToast: (v: string | null) => void;
}

export function useTeamsOps(opts: UseTeamsOpsOpts) {
  const {
    teamsGraph, teamsGraphPost,
    teamsToken, teamsTeamId, teamsChannelMap, teamsContacts, teamsContactsLoading,
    teamsNewMsg, teamsDirectTo, teamsDirectMsg, dmSelectedName, dmActiveChatId, dmNewMsg, dmScrollRef,
    setTeamsTeamId, setTeamsChannelMap, setTeamsContacts, setTeamsContactsLoading, setTeamsContactsError,
    setTeamsContactSearchResults, setTeamsContactSearch, setTeamsContactDropdown,
    setTeamsCreating, setTeamsLoading, setTeamsMessages, setTeamsNewMsg,
    setTeamsDirectTo, setTeamsDirectMsg, setTeamsDirectSending, setTeamsDirectErr,
    setDmConversations, setDmActiveChatId, setDmComposing, setDmSelectedName,
    setDmLoading, setDmError, setDmNewMsg, setDmSending,
    setDtlDMTo, setDtlDMContactSearch, setDtlDMContactDropdown, setDtlDMContactSearchResults,
    setToast,
  } = opts;

  async function loadTeamsContacts() {
    if (teamsContactsLoading) return;
    setTeamsContactsLoading(true);
    setTeamsContactsError(null);
    try {
      // Load Ring of Fire team members directly
      let tid = teamsTeamId;
      if (!tid) {
        const stored = await (async () => { try { const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.teams_team_id&select=value`, { headers: SB_HEADERS }); const rows = await res.json(); return rows?.length ? JSON.parse(rows[0].value) : null; } catch(_) { return null; } })();
        if (stored) { tid = stored; setTeamsTeamId(stored); } else throw new Error("No team ID — open a PO channel first");
      }
      const d = await teamsGraph(`/teams/${tid}/members?$top=999`);
      const members = (d.value || [])
        .filter((m: any) => m.displayName)
        .map((m: any) => ({
          displayName: m.displayName,
          userPrincipalName: m.email || "",
          scoredEmailAddresses: m.email ? [{ address: m.email }] : [],
        }))
        .sort((a: any, b: any) => a.displayName.localeCompare(b.displayName));
      setTeamsContacts(members);
    } catch(e: any) {
      console.warn("[Teams contacts] team members failed:", e?.message);
      try {
        const d2 = await teamsGraph("/me/people?$top=100&$select=displayName,userPrincipalName,scoredEmailAddresses,mail");
        setTeamsContacts(d2.value || []);
      } catch(e2: any) {
        setTeamsContactsError(friendlyContactError(e2 || e));
      }
    }
    setTeamsContactsLoading(false);
  }

  function searchTeamsContacts(q: string, target: "main" | "dtl") {
    if (!q.trim()) {
      if (target === "main") setTeamsContactSearchResults([]);
      else setDtlDMContactSearchResults([]);
      return;
    }
    const lower = q.toLowerCase();
    const results = teamsContacts.filter(c =>
      c.displayName?.toLowerCase().includes(lower) ||
      c.userPrincipalName?.toLowerCase().includes(lower) ||
      (c.scoredEmailAddresses?.[0]?.address || "").toLowerCase().includes(lower)
    ).slice(0, 25);
    if (target === "main") setTeamsContactSearchResults(results);
    else setDtlDMContactSearchResults(results);
  }

  function handleTeamsContactInput(val: string, target: "main" | "dtl") {
    if (target === "main") { setTeamsDirectTo(val); setTeamsContactSearch(val); setTeamsContactDropdown(true); setTeamsDirectErr(null); }
    else { setDtlDMTo(val); setDtlDMContactSearch(val); setDtlDMContactDropdown(true); }
    if (val.trim().length >= 2) {
      searchTeamsContacts(val.trim(), target);
    } else {
      if (target === "main") setTeamsContactSearchResults([]);
      else setDtlDMContactSearchResults([]);
    }
  }

  async function teamsLoadChannelMap() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.po_teams_channel_map&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      if (rows?.length) setTeamsChannelMap(JSON.parse(rows[0].value) || {});
      const res2 = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.teams_team_id&select=value`, { headers: SB_HEADERS });
      const rows2 = await res2.json();
      if (rows2?.length) setTeamsTeamId(JSON.parse(rows2[0].value) || "");
    } catch(e) { console.error("Teams: load channel map error", e); }
  }

  async function teamsSbSave(key: string, value: any) {
    await fetch(`${SB_URL}/rest/v1/app_data`, { method: "POST", headers: SB_HEADERS, body: JSON.stringify({ key, value: JSON.stringify(value) }) });
  }

  async function teamsFindRofTeam(): Promise<string> {
    if (teamsTeamId) return teamsTeamId;
    const data = await teamsGraph("/me/joinedTeams");
    const rofTeam = (data.value || []).find((t: any) => t.displayName?.toLowerCase().replace(/\s+/g, "").includes("ringoffire"));
    if (!rofTeam) throw new Error('Could not find "RING OF FIRE" team');
    await teamsSbSave("teams_team_id", rofTeam.id);
    setTeamsTeamId(rofTeam.id);
    return rofTeam.id as string;
  }

  async function teamsStartChat(poNum: string) {
    setTeamsCreating(poNum);
    try {
      const tid = await teamsFindRofTeam();
      const slug = poNum.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
      const chName = `po-${slug}`;
      let channelId = "";
      try {
        const channels = await teamsGraph(`/teams/${tid}/channels`);
        const existing = (channels.value || []).find((c: any) => c.displayName === chName);
        if (existing) channelId = existing.id;
      } catch(_) {}
      if (!channelId) {
        const ch = await teamsGraphPost(`/teams/${tid}/channels`, { displayName: chName, description: `PO WIP — PO# ${poNum}`, membershipType: "standard" });
        channelId = ch.id;
      }
      const newMap = { ...teamsChannelMap, [poNum]: { channelId, teamId: tid } };
      setTeamsChannelMap(newMap);
      await teamsSbSave("po_teams_channel_map", newMap);
      await teamsLoadPOMessages(poNum, { channelId, teamId: tid });
    } catch(e: any) { setToast("Could not start Teams chat: " + e.message); }
    setTeamsCreating(null);
  }

  async function teamsLoadPOMessages(poNum: string, mp?: { channelId: string; teamId: string }) {
    const mapping = mp || teamsChannelMap[poNum];
    if (!mapping || !teamsToken) return;
    setTeamsLoading((l: any) => ({ ...l, [poNum]: true }));
    try {
      const d = await teamsGraph(`/teams/${mapping.teamId}/channels/${mapping.channelId}/messages?$top=50`);
      setTeamsMessages((m: any) => ({ ...m, [poNum]: (d.value || []).filter((m: any) => m.messageType === "message") }));
    } catch(e) { console.error("Teams load msgs error", e); }
    setTeamsLoading((l: any) => ({ ...l, [poNum]: false }));
  }

  async function teamsSendMessage(poNum: string) {
    const mp = teamsChannelMap[poNum];
    if (!mp || !teamsNewMsg.trim() || !teamsToken) return;
    try {
      const sent = await teamsGraphPost(`/teams/${mp.teamId}/channels/${mp.channelId}/messages`, { body: { content: teamsNewMsg.trim(), contentType: "text" } });
      setTeamsMessages((m: any) => ({ ...m, [poNum]: [sent, ...(m[poNum] || [])] }));
      setTeamsNewMsg("");
    } catch(e: any) { setToast("Failed to send message: " + e.message); }
  }

  async function loadDmMessages(chatId: string, silent = false) {
    if (!silent) { setDmLoading(true); setDmError(null); }
    try {
      const d = await teamsGraph(`/chats/${chatId}/messages?$top=50`);
      const msgs = ((d.value || []) as any[]).filter((m: any) => m.messageType === "message").reverse();
      setDmConversations((prev: any) => {
        const existing = prev.find((c: any) => c.chatId === chatId);
        if (silent && existing && existing.messages.length === msgs.length &&
            existing.messages[existing.messages.length - 1]?.id === msgs[msgs.length - 1]?.id) return prev;
        if (!silent || (existing && existing.messages.length !== msgs.length)) {
          setTimeout(() => { if (dmScrollRef.current) dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight; }, 50);
        }
        const found = prev.find((c: any) => c.chatId === chatId);
        if (found) return prev.map((c: any) => c.chatId === chatId ? { ...c, messages: msgs } : c);
        // Conversation was just created but not yet in state — add it
        return [...prev, { chatId, recipient: "", recipientName: "", messages: msgs }];
      });
    } catch(e: any) {
      if (!silent) setDmError("Could not load messages: " + e.message);
    }
    if (!silent) setDmLoading(false);
  }

  async function teamsSendDirect() {
    if (!teamsDirectTo.trim() || !teamsDirectMsg.trim()) return;
    setTeamsDirectSending(true);
    setTeamsDirectErr(null);
    try {
      const me = await teamsGraph("/me");
      const chat = await teamsGraphPost("/chats", {
        chatType: "oneOnOne",
        members: [
          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${me.id}')` },
          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${teamsDirectTo.trim()}')` },
        ],
      });
      await teamsGraphPost(`/chats/${chat.id}/messages`, { body: { content: teamsDirectMsg.trim(), contentType: "text" } });
      const recipientName = dmSelectedName || teamsDirectTo.trim();
      setDmConversations((prev: any) => {
        const existing = prev.find((c: any) => c.chatId === chat.id);
        if (existing) return prev.map((c: any) => c.chatId === chat.id ? { ...c, recipientName } : c);
        return [...prev, { chatId: chat.id, recipient: teamsDirectTo.trim(), recipientName, messages: [] }];
      });
      setDmActiveChatId(chat.id);
      setDmComposing(false);
      setTeamsDirectMsg("");
      setTeamsDirectTo("");
      setDmSelectedName("");
      await loadDmMessages(chat.id);
    } catch(e: any) {
      setTeamsDirectErr("Failed to send: " + e.message);
    }
    setTeamsDirectSending(false);
  }

  async function sendDmReply() {
    if (!dmActiveChatId || !dmNewMsg.trim()) return;
    setDmSending(true);
    setDmError(null);
    try {
      const sent = await teamsGraphPost(`/chats/${dmActiveChatId}/messages`, { body: { content: dmNewMsg.trim(), contentType: "text" } });
      setDmConversations((prev: any) => prev.map((c: any) => c.chatId === dmActiveChatId ? { ...c, messages: [...c.messages, sent] } : c));
      setDmNewMsg("");
      setTimeout(() => { if (dmScrollRef.current) dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight; }, 50);
    } catch(e: any) {
      setDmError("Failed to send: " + e.message);
    }
    setDmSending(false);
  }

  return {
    loadTeamsContacts,
    searchTeamsContacts,
    handleTeamsContactInput,
    teamsLoadChannelMap,
    teamsSbSave,
    teamsFindRofTeam,
    teamsStartChat,
    teamsLoadPOMessages,
    teamsSendMessage,
    loadDmMessages,
    teamsSendDirect,
    sendDmReply,
  };
}
