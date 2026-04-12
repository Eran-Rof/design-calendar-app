import React from "react";
import { STATUS_COLORS } from "../utils/tandaTypes";
import { MS_CLIENT_ID, MS_TENANT_ID } from "../utils/msAuth";
import type { XoroPO } from "../utils/tandaTypes";
import type { TeamsState } from "./state/teams/teamsTypes";
import S from "./styles";
import { useTandaStore } from "./store";

export interface TeamsPanelCtx {
  // Email state reads (shared MS auth)
  msToken: string | null;
  msDisplayName: string;
  // Core reads
  pos: XoroPO[];
  setView: (v: any) => void;
  dmScrollRef: React.RefObject<HTMLDivElement | null>;
  // External functions
  teamsLoadPOMessages: (poNum: string, mp?: any) => void;
  teamsStartChat: (poNum: string) => void;
  teamsSendMessage: (poNum: string) => void;
  teamsSendDirect: () => void;
  sendDmReply: () => void;
  loadDmMessages: (chatId: string, silent?: boolean) => void;
  handleTeamsContactInput: (val: string, target: "main" | "dtl") => void;
  loadTeamsContacts: () => void;
  authenticateTeams: () => void;
  msSignOut: () => void;
}

const TEAMS_PURPLE = "#5b5ea6";
const TEAMS_PURPLE_LT = "#7b83eb";

export function teamsViewPanel(ctx: TeamsPanelCtx): React.ReactElement {
  const { msToken, msDisplayName, pos, setView, dmScrollRef, teamsLoadPOMessages, teamsStartChat, teamsSendMessage, teamsSendDirect, sendDmReply, loadDmMessages, handleTeamsContactInput, loadTeamsContacts, authenticateTeams, msSignOut } = ctx;

  const store = useTandaStore.getState();
  const tmSet = <K extends keyof TeamsState>(field: K, value: TeamsState[K]) => useTandaStore.getState().setTeamsField(field, value);

  const { teamsSearchPO, teamsSelPO, teamsChannelMap, teamsMessages, teamsLoading, teamsCreating, teamsNewMsg, teamsAuthStatus, teamsTab, dmConversations, dmActiveChatId, dmComposing, dmSelectedName, dmLoading, dmError, dmNewMsg, dmSending, teamsContacts, teamsContactsLoading, teamsContactSearch, teamsContactDropdown, teamsContactSearchResults, teamsContactSearchLoading, teamsContactsError, teamsDirectTo, teamsDirectMsg, teamsDirectSending, teamsDirectErr } = store;

  const teamsToken = msToken;
  const poList2 = pos.filter(p => {
    const s = teamsSearchPO.toLowerCase();
    return !s || (p.PoNumber ?? "").toLowerCase().includes(s) || (p.VendorName ?? "").toLowerCase().includes(s);
  }).sort((a, b) => {
    const aNum = a.PoNumber ?? "";
    const bNum = b.PoNumber ?? "";
    const aMsg = (teamsMessages[aNum] || []).length;
    const bMsg = (teamsMessages[bNum] || []).length;
    const aActive = !!teamsChannelMap[aNum];
    const bActive = !!teamsChannelMap[bNum];
    // Unread (has messages) first
    if (aMsg > 0 && bMsg === 0) return -1;
    if (aMsg === 0 && bMsg > 0) return 1;
    // Then active channels
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    // Within same tier, sort by message count desc
    return bMsg - aMsg;
  });
  const mp = teamsSelPO ? teamsChannelMap[teamsSelPO] : null;
  const msgs = (teamsSelPO ? teamsMessages[teamsSelPO] : null) || [];
  const isLoadingMsgs = teamsSelPO ? !!teamsLoading[teamsSelPO] : false;
  const isCreating = teamsSelPO ? teamsCreating === teamsSelPO : false;
  const selPO = teamsSelPO ? pos.find(p => p.PoNumber === teamsSelPO) : null;

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setView("dashboard")} title="Close Teams"
        style={{ position: "absolute", top: 10, right: 10, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}15`, color: TEAMS_PURPLE, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>✕</button>
      {teamsTab !== "direct" && teamsSelPO && mp && teamsToken && (
        <button onClick={() => teamsLoadPOMessages(teamsSelPO)} title="Refresh messages"
          style={{ position: "absolute", top: 10, right: 46, zIndex: 10, height: 28, padding: "0 10px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#6B7280", cursor: "pointer", fontFamily: "inherit", fontSize: 11, display: "flex", alignItems: "center" }}>↻ Refresh</button>
      )}
      <div style={{ display: "flex", height: "calc(100vh - 140px)", minHeight: 500, background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>
        {/* LEFT: PO list */}
        <div style={{ width: 280, flexShrink: 0, borderRight: "1px solid #334155", display: "flex", flexDirection: "column", background: "#0F172A" }}>
          <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #334155", flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6B7280" }}>Purchase Orders</span>
          </div>
          <div style={{ padding: "8px 16px", borderBottom: "1px solid #334155", flexShrink: 0 }}>
            <input value={teamsSearchPO} onChange={e => tmSet("teamsSearchPO", e.target.value)} placeholder="🔍 Search PO#, vendor…" style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "7px 10px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
          </div>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid #334155", background: teamsToken ? "#064E3B44" : "#78350F44", flexShrink: 0 }}>
            {teamsToken ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#34D399", fontWeight: 600 }}>✓ {msDisplayName || "Connected to Microsoft"}</span>
                <button onClick={msSignOut} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: "1px solid #34D39944", background: "none", color: "#34D399", cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 11, color: "#FBBF24", fontWeight: 600, marginBottom: 6 }}>{teamsAuthStatus === "error" ? "Sign-in failed" : "Sign in to use Teams"}</div>
                {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                  <div style={{ fontSize: 11, color: "#D97706" }}>Azure credentials not configured</div>
                ) : (
                  <button onClick={authenticateTeams} disabled={teamsAuthStatus === "loading"} style={{ ...S.btnPrimary, fontSize: 11, padding: "5px 12px", width: "auto" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", borderBottom: "1px solid #334155", flexShrink: 0 }}>
            {(["channels","direct"] as const).map(t => (
              <button key={t} onClick={() => tmSet("teamsTab", t)} style={{ flex: 1, padding: "9px 0", fontSize: 11, fontWeight: 700, fontFamily: "inherit", border: "none", borderBottom: teamsTab === t ? `2px solid ${TEAMS_PURPLE}` : "2px solid transparent", background: "none", color: teamsTab === t ? TEAMS_PURPLE_LT : "#6B7280", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {t === "channels" ? "PO Channels" : "Direct Message"}
              </button>
            ))}
          </div>
          {teamsTab === "channels" && (
          <div style={{ flex: 1, overflowY: "auto" }}>
            {poList2.map(po => {
              const poNum = po.PoNumber ?? "";
              const isSelected = teamsSelPO === poNum;
              const hasCh = !!teamsChannelMap[poNum];
              const msgCount = (teamsMessages[poNum] || []).length;
              const color = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
              return (
                <div key={poNum} onClick={() => tmSet("teamsSelPO", poNum === teamsSelPO ? null : poNum)}
                  style={{ padding: "11px 16px", borderBottom: "1px solid #1E293B", cursor: "pointer", background: isSelected ? `${TEAMS_PURPLE}22` : "transparent", borderLeft: isSelected ? `3px solid ${TEAMS_PURPLE}` : "3px solid transparent", transition: "all 0.12s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? TEAMS_PURPLE_LT : "#F1F5F9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>PO# {poNum}</div>
                      <div style={{ fontSize: 11, color: "#6B7280" }}>{po.VendorName ?? ""}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 10, background: hasCh ? "#064E3B" : "#1E293B", color: hasCh ? "#34D399" : "#6B7280", border: hasCh ? "none" : "1px solid #334155", fontWeight: 700 }}>{hasCh ? "ACTIVE" : "NO CHAT"}</span>
                      {msgCount > 0 && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 10, background: TEAMS_PURPLE, color: "#fff", fontWeight: 700 }}>{msgCount}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {poList2.length === 0 && <div style={{ padding: 24, fontSize: 13, color: "#6B7280", textAlign: "center" }}>No POs found</div>}
          </div>
          )}
          {teamsTab === "direct" && (
          <div style={{ flex: 1, overflowY: "auto" }}>
            {!teamsToken ? (
              <div style={{ textAlign: "center", padding: "40px 20px" }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>🔒</div>
                <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 12 }}>Sign in with Microsoft</div>
                <button onClick={authenticateTeams} disabled={teamsAuthStatus === "loading"} style={{ ...S.btnPrimary, fontSize: 12, padding: "8px 18px", width: "auto" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
              </div>
            ) : (
              <>
                <div style={{ padding: "10px 12px 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: "#6B7280", fontWeight: 600 }}>Direct Messages</span>
                  <button onClick={() => { tmSet("dmActiveChatId", null); tmSet("dmComposing", true); tmSet("teamsDirectTo", ""); tmSet("teamsDirectMsg", ""); tmSet("dmSelectedName", ""); tmSet("dmError", null); tmSet("teamsDirectErr", null); }}
                    style={{ fontSize: 10, padding: "3px 8px", borderRadius: 5, border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}15`, color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>
                    ✎ New
                  </button>
                </div>
                {dmConversations.length === 0 && (
                  <div style={{ padding: "12px 14px", fontSize: 12, color: "#6B7280" }}>No conversations yet. Use ✎ New to start one.</div>
                )}
                {[...dmConversations].sort((a, b) => {
                  // Sort by last message time descending (most recent first)
                  const aLast = a.messages.length > 0 ? new Date(a.messages[a.messages.length - 1]?.createdDateTime || 0).getTime() : 0;
                  const bLast = b.messages.length > 0 ? new Date(b.messages[b.messages.length - 1]?.createdDateTime || 0).getTime() : 0;
                  // Conversations with messages first
                  if (a.messages.length > 0 && b.messages.length === 0) return -1;
                  if (a.messages.length === 0 && b.messages.length > 0) return 1;
                  return bLast - aLast;
                }).map(conv => (
                  <div key={conv.chatId}
                    onClick={() => { tmSet("dmActiveChatId", conv.chatId); tmSet("dmComposing", false); }}
                    style={{ padding: "8px 12px", cursor: "pointer", background: conv.chatId === dmActiveChatId && !dmComposing ? `${TEAMS_PURPLE}22` : "transparent", borderLeft: conv.chatId === dmActiveChatId && !dmComposing ? `3px solid ${TEAMS_PURPLE}` : "3px solid transparent", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #1E293B" }}>
                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>
                      {(conv.recipientName || conv.recipient).slice(0, 2).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: conv.chatId === dmActiveChatId && !dmComposing ? TEAMS_PURPLE_LT : "#F1F5F9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{conv.recipientName || conv.recipient}</div>
                      <div style={{ fontSize: 10, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{conv.messages.length > 0 ? (conv.messages[conv.messages.length - 1]?.body?.content || "").replace(/<[^>]+>/g, "").trim() || "Message" : "No messages yet"}</div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
          )}
        </div>
        {/* RIGHT: chat panel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {teamsTab === "direct" ? (
            !teamsToken ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#6B7280" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
                <div style={{ fontSize: 14, color: "#94A3B8", marginBottom: 12 }}>Sign in to use Direct Message</div>
                <button onClick={authenticateTeams} disabled={teamsAuthStatus === "loading"} style={{ ...S.btnPrimary, fontSize: 13, padding: "9px 20px", width: "auto" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
              </div>
            ) : dmComposing || !dmActiveChatId ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ padding: "16px 24px 12px", borderBottom: "1px solid #334155", background: "#1E293B", flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9" }}>New Direct Message</div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>Send a Teams DM to any team member</div>
                </div>
                <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>
                  <div style={{ marginBottom: 14, position: "relative" as const }}>
                    <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 5 }}>
                      {teamsContactsLoading
                        ? "Loading contacts…"
                        : teamsContactsError
                          ? <span style={{ color: "#F87171" }}>⚠ {teamsContactsError} — <button onClick={loadTeamsContacts} style={{ background: "none", border: "none", color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit", fontSize: 12, padding: 0, textDecoration: "underline" }}>retry</button> or sign out &amp; back in</span>
                          : teamsContacts.length > 0
                            ? `To — ${teamsContacts.length} contacts loaded · type to search all`
                            : "To — type name or email"}
                    </div>
                    <input value={teamsDirectTo}
                      onChange={e => handleTeamsContactInput(e.target.value, "main")}
                      onFocus={() => { tmSet("teamsContactSearch", teamsDirectTo); tmSet("teamsContactDropdown", true); }}
                      onBlur={() => setTimeout(() => tmSet("teamsContactDropdown", false), 150)}
                      placeholder={teamsContactsLoading ? "Loading contacts…" : "Search name or type email…"}
                      style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 7, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                    {teamsContactDropdown && (() => {
                      const q = (teamsContactSearch || "").toLowerCase();
                      const list = teamsContactSearchResults.length > 0
                        ? teamsContactSearchResults
                        : teamsContacts.filter((c: any) =>
                            !q ||
                            (c.displayName || "").toLowerCase().includes(q) ||
                            (c.userPrincipalName || "").toLowerCase().includes(q) ||
                            (c.scoredEmailAddresses?.[0]?.address || "").toLowerCase().includes(q) ||
                            (c.mail || "").toLowerCase().includes(q)
                          );
                      if (list.length === 0 && !teamsContactSearchLoading) return null;
                      return (
                        <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, zIndex: 200, background: "#1E293B", border: "1px solid #475569", borderRadius: 8, maxHeight: 220, overflowY: "auto" as const, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", marginTop: 2 }}>
                          {teamsContactSearchLoading && <div style={{ padding: "8px 14px", fontSize: 12, color: "#6B7280" }}>Searching…</div>}
                          {list.slice(0, 15).map((c: any) => {
                            const email = c.userPrincipalName || c.mail || c.scoredEmailAddresses?.[0]?.address || "";
                            return (
                              <div key={email || c.displayName}
                                onMouseDown={() => {
                                  const existing = dmConversations.find(conv => conv.recipient.toLowerCase() === email.toLowerCase());
                                  if (existing) { tmSet("dmActiveChatId", existing.chatId); tmSet("dmComposing", false); tmSet("teamsDirectTo", ""); }
                                  else { tmSet("teamsDirectTo", email); tmSet("dmSelectedName", c.displayName || email); }
                                  tmSet("teamsContactDropdown", false); tmSet("teamsContactSearch", ""); tmSet("teamsContactSearchResults", []); tmSet("teamsDirectErr", null);
                                }}
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
                    <textarea value={teamsDirectMsg} onChange={e => { tmSet("teamsDirectMsg", e.target.value); tmSet("teamsDirectErr", null); }}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); teamsSendDirect(); } }}
                      placeholder="Type your message… (Enter to send)" rows={6}
                      style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 7, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical" as const, boxSizing: "border-box" as const }} />
                  </div>
                  {teamsDirectErr && (
                    <div style={{ background: "#1E293B", border: "1px solid #EF444444", borderRadius: 8, padding: "10px 14px", color: "#EF4444", fontSize: 12, marginBottom: 12 }}>⚠ {teamsDirectErr}</div>
                  )}
                  <button onClick={teamsSendDirect} disabled={teamsDirectSending || !teamsDirectTo.trim() || !teamsDirectMsg.trim()}
                    style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "11px 24px", fontSize: 13, fontWeight: 700, cursor: teamsDirectSending ? "wait" : "pointer", fontFamily: "inherit", opacity: (teamsDirectSending || !teamsDirectTo.trim() || !teamsDirectMsg.trim()) ? 0.6 : 1 }}>
                    {teamsDirectSending ? "Sending…" : "Send Direct Message ↗"}
                  </button>
                </div>
              </div>
            ) : (() => {
              const activeConv = dmConversations.find(c => c.chatId === dmActiveChatId) ?? null;
              const dmRecipientDisplay = activeConv?.recipientName || activeConv?.recipient || "";
              const dmMsgs = activeConv?.messages ?? [];
              return (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ padding: "14px 50px 14px 20px", borderBottom: "1px solid #334155", background: "#1E293B", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{dmRecipientDisplay.slice(0, 2).toUpperCase()}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dmRecipientDisplay}</div>
                    <div style={{ fontSize: 11, color: "#6B7280" }}>Direct Message · Teams</div>
                  </div>
                  <button onClick={() => dmActiveChatId && loadDmMessages(dmActiveChatId)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
                </div>
                {dmError && (
                  <div style={{ background: "#1E293B", borderBottom: "1px solid #EF444444", padding: "8px 20px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    <span style={{ fontSize: 12, color: "#EF4444", flex: 1 }}>⚠ {dmError}</span>
                    <button onClick={() => tmSet("dmError", null)} style={{ border: "none", background: "none", color: "#EF4444", cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}>✕</button>
                  </div>
                )}
                <div ref={dmScrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
                  {dmLoading ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
                  ) : dmMsgs.length === 0 ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>No messages yet in this conversation</div>
                  ) : dmMsgs.map((msg: any) => {
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
                  })}
                </div>
                <div style={{ padding: "12px 20px", borderTop: "1px solid #334155", background: "#1E293B", display: "flex", gap: 10, flexShrink: 0 }}>
                  <input value={dmNewMsg} onChange={e => tmSet("dmNewMsg", e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDmReply(); }}}
                    placeholder={`Reply to ${dmRecipientDisplay}…`}
                    style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
                  <button onClick={sendDmReply} disabled={dmSending || !dmNewMsg.trim()}
                    style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 12, fontWeight: 700, cursor: (dmSending || !dmNewMsg.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (dmSending || !dmNewMsg.trim()) ? 0.5 : 1 }}>
                    {dmSending ? "…" : "Send"}
                  </button>
                </div>
              </div>
              );
            })()
          ) : !teamsSelPO ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#6B7280" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>💬</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#94A3B8", marginBottom: 6 }}>Select a PO to open its chat</div>
              <div style={{ fontSize: 13 }}>Each PO gets its own Teams channel in RING OF FIRE</div>
            </div>
          ) : (
            <>
              <div style={{ padding: "14px 90px 14px 20px", borderBottom: "1px solid #334155", background: "#1E293B", flexShrink: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9" }}>PO# {teamsSelPO}</div>
                <div style={{ fontSize: 12, color: "#6B7280" }}>{selPO?.VendorName ?? ""}{selPO?.StatusName ? " · " + selPO.StatusName : ""}</div>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                {!teamsToken ? (
                  <div style={{ textAlign: "center", paddingTop: 60 }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 8 }}>Sign in to use Teams chat</div>
                    <button onClick={authenticateTeams} disabled={teamsAuthStatus === "loading"} style={{ ...S.btnPrimary, fontSize: 12, padding: "8px 18px", width: "auto" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                  </div>
                ) : !mp ? (
                  <div style={{ textAlign: "center", paddingTop: 60 }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>💬</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 6 }}>No Teams channel yet for this PO</div>
                    <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 20 }}>A channel will be created in RING OF FIRE</div>
                    <button onClick={() => teamsStartChat(teamsSelPO!)} disabled={!!isCreating}
                      style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: isCreating ? "wait" : "pointer", opacity: isCreating ? 0.7 : 1 }}>
                      {isCreating ? "Creating channel…" : "💬 Start Teams Chat"}
                    </button>
                  </div>
                ) : isLoadingMsgs ? (
                  <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
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
              {mp && teamsToken && (
                <div style={{ padding: "12px 20px", borderTop: "1px solid #334155", background: "#1E293B", display: "flex", gap: 10, flexShrink: 0 }}>
                  <input value={teamsNewMsg} onChange={e => tmSet("teamsNewMsg", e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); teamsSendMessage(teamsSelPO!); }}} placeholder={`Message PO# ${teamsSelPO}…`}
                    style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
                  <button onClick={() => teamsSendMessage(teamsSelPO!)} disabled={!teamsNewMsg.trim()} style={{ ...S.btnPrimary, opacity: teamsNewMsg.trim() ? 1 : 0.5, width: "auto" }}>Send</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
