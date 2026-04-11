import React from "react";
import { styledEmailHtml } from "../../utils/emailHtml";
import { RichTextEditor } from "../richTextEditor";
import { MS_CLIENT_ID, MS_TENANT_ID } from "../../utils/msAuth";
import S from "../styles";
import type { DetailPanelCtx } from "../detailPanel";

const TEAMS_PURPLE = "#5b5ea6";
const TEAMS_PURPLE_LT = "#7b83eb";
const OUTLOOK_BLUE = "#0078D4";

/**
 * Email/Teams tab body for the PO detail panel. Renders nothing unless
 * `detailMode` is "email" or "all". Extracted from detailPanel.tsx so the
 * orchestrator stays manageable.
 */
export function EmailTab({ ctx }: { ctx: DetailPanelCtx }): React.ReactElement | null {
  const {
    selected, detailMode, dtlEmails, dtlEmailLoading, dtlEmailErr,
    emailToken, authenticateEmail, dtlEmailTab, setDtlEmailTab,
    setDtlComposeSubject, loadDtlSentEmails, teamsToken, teamsChannelMap,
    teamsMessages, teamsLoadPOMessages, loadDtlEmails, loadDtlFullEmail,
    loadDtlThread, loadEmailAttachments, emailMarkAsRead, deleteMainEmail,
    dtlNextLink, dtlLoadingOlder, dtlSentLoading, dtlSentEmails,
    dtlThreadLoading, dtlEmailThread, emailAttachments, emailAttachmentsLoading,
    dtlEmailSel, dtlReply, setDtlReply, dtlReplyToEmail,
    dtlComposeTo, setDtlComposeTo, dtlComposeSubject, dtlComposeBody,
    setDtlComposeBody, dtlSendEmail, dtlSendErr, setDtlSendErr,
    setSelected, setView, setTeamsSelPO, setTeamsTab, teamsLoading,
    teamsNewMsg, setTeamsNewMsg, teamsGraphPost, setTeamsMessages,
    teamsContactsLoading, teamsContactsError, teamsContacts, loadTeamsContacts,
    dtlDMTo, setDtlDMTo, handleTeamsContactInput, dtlDMContactSearch,
    setDtlDMContactSearch, dtlDMContactDropdown, setDtlDMContactDropdown,
    dtlDMContactSearchResults, setDtlDMContactSearchResults,
    dtlDMContactSearchLoading, dtlDMMsg, setDtlDMMsg, dtlDMErr, setDtlDMErr,
    dtlDMSending, setDtlDMSending, teamsGraph, loadDmMessages, setDmConversations,
  } = ctx;

  if (!selected) return null;
  if (!(detailMode === "email" || detailMode === "all")) return null;

  const pn = selected.PoNumber ?? "";
  const prefix = "[PO-" + pn + "]";
  const dtlList = dtlEmails[pn] || [];
  const isLoading = !!dtlEmailLoading[pn];
  const err = dtlEmailErr[pn];

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={S.sectionLabel}>Emails for {prefix}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {emailToken && <button onClick={() => loadDtlEmails(pn)} style={{ ...S.btnSecondary, fontSize: 11, padding: "4px 10px" }}>↻ Refresh</button>}
        </div>
      </div>

      {!emailToken ? (
        <div style={{ textAlign: "center", padding: "30px 0" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
          <div style={{ color: "#6B7280", fontSize: 13, marginBottom: 12 }}>Sign in with Microsoft to view emails</div>
          {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
            <div style={{ color: "#D97706", fontSize: 12 }}>Azure credentials not configured — check Vercel env vars</div>
          ) : (
            <button onClick={authenticateEmail} style={{ ...S.btnPrimary, width: "auto", fontSize: 12, padding: "8px 18px" }}>Sign in with Microsoft</button>
          )}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 2, marginBottom: 12, flexWrap: "wrap" as const }}>
            {(["inbox", "sent", "thread", "compose", "teams"] as const).map(tab => (
              <button key={tab} onClick={() => { setDtlEmailTab(tab); if (tab === "compose") setDtlComposeSubject(prefix + " "); if (tab === "sent") loadDtlSentEmails(pn); if (tab === "teams" && teamsToken && teamsChannelMap[pn] && !teamsMessages[pn]?.length) teamsLoadPOMessages(pn); }}
                style={{ padding: "8px 14px", border: "1px solid #334155", borderBottom: dtlEmailTab === tab ? "none" : "1px solid #334155", background: dtlEmailTab === tab ? "#1E293B" : "#0F172A", color: dtlEmailTab === tab ? (tab === "teams" ? TEAMS_PURPLE_LT : OUTLOOK_BLUE) : "#6B7280", fontWeight: dtlEmailTab === tab ? 700 : 500, cursor: "pointer", fontFamily: "inherit", fontSize: 12, borderRadius: "8px 8px 0 0" }}>
                {tab === "teams" ? "💬 Teams" : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {dtlEmailTab === "inbox" && (
            <>
              {isLoading ? (
                <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Loading emails…</div>
              ) : err ? (
                <div style={{ background: "#7F1D1D", border: "1px solid #EF4444", borderRadius: 8, padding: "12px 16px", color: "#FCA5A5", fontSize: 13 }}>⚠ {err}</div>
              ) : dtlList.length === 0 ? (
                <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0" }}>
                  <div style={{ fontSize: 24, marginBottom: 6 }}>📧</div>
                  <div style={{ fontSize: 13 }}>No emails matching "{prefix}"</div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {dtlList.map((em: any) => {
                    const sender = em.from?.emailAddress ? em.from.emailAddress.name || em.from.emailAddress.address : "Unknown";
                    const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                    const time = em.receivedDateTime ? new Date(em.receivedDateTime).toLocaleString() : "";
                    return (
                      <div key={em.id} onClick={() => {
                        loadDtlFullEmail(em.id);
                        if (em.conversationId) loadDtlThread(em.conversationId);
                        loadEmailAttachments(em.id);
                        if (!em.isRead) emailMarkAsRead(em.id);
                      }}
                        style={{ background: em.isRead ? "#0F172A" : OUTLOOK_BLUE + "15", border: "1px solid " + (em.isRead ? "#334155" : OUTLOOK_BLUE + "44"), borderRadius: 8, padding: "10px 14px", cursor: "pointer", transition: "all 0.12s", position: "relative" as const }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                          <div style={{ width: 30, height: 30, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                              <span style={{ fontSize: 12, fontWeight: em.isRead ? 500 : 700, color: "#F1F5F9" }}>{sender}</span>
                              <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                              {em.hasAttachments && <span style={{ fontSize: 10, color: "#6B7280" }}>📎</span>}
                              {!em.isRead && <span style={{ width: 7, height: 7, borderRadius: "50%", background: OUTLOOK_BLUE, flexShrink: 0 }} />}
                            </div>
                            <div style={{ fontSize: 12, fontWeight: em.isRead ? 400 : 600, color: "#E2E8F0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{em.subject}</div>
                            <div style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{em.bodyPreview || ""}</div>
                          </div>
                          <button onClick={(ev) => { ev.stopPropagation(); deleteMainEmail(em.id); }} title="Delete" style={{ background: "none", border: "none", cursor: "pointer", color: "#6B7280", fontSize: 14, padding: 2, flexShrink: 0, opacity: 0.6 }}>🗑</button>
                        </div>
                      </div>
                    );
                  })}
                  {dtlNextLink[pn] && (
                    <button onClick={() => loadDtlEmails(pn, dtlNextLink[pn]!)} disabled={dtlLoadingOlder} style={{ ...S.btnPrimary, opacity: dtlLoadingOlder ? 0.6 : 1, fontSize: 12 }}>{dtlLoadingOlder ? "Loading…" : "Load older emails"}</button>
                  )}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                <button onClick={() => { setDtlEmailTab("compose"); setDtlComposeSubject(prefix + " "); }} style={{ ...S.btnPrimary, width: "auto", fontSize: 11, padding: "7px 14px" }}>+ New Email</button>
                <span style={{ fontSize: 11, color: "#6B7280" }}>{dtlList.length} email{dtlList.length !== 1 ? "s" : ""}</span>
              </div>
            </>
          )}

          {dtlEmailTab === "sent" && (
            <div>
              {dtlSentLoading[pn] ? (
                <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Loading sent emails…</div>
              ) : (dtlSentEmails[pn] || []).length === 0 ? (
                <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0" }}><div style={{ fontSize: 24, marginBottom: 6 }}>📤</div><div style={{ fontSize: 13 }}>No sent emails for "{prefix}"</div></div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(dtlSentEmails[pn] || []).map((em: any) => {
                    const toList = (em.toRecipients || []).map((r: any) => r.emailAddress?.name || r.emailAddress?.address || "").filter(Boolean).join(", ") || "—";
                    const time = em.sentDateTime ? new Date(em.sentDateTime).toLocaleString() : "";
                    return (
                      <div key={em.id} onClick={() => { loadDtlFullEmail(em.id); if (em.conversationId) loadDtlThread(em.conversationId); }}
                        style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", cursor: "pointer" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                          <div style={{ width: 30, height: 30, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>→</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                              <span style={{ fontSize: 11, color: "#94A3B8" }}>To: {toList}</span>
                              <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                              {em.hasAttachments && <span style={{ fontSize: 10, color: "#6B7280" }}>📎</span>}
                            </div>
                            <div style={{ fontSize: 12, fontWeight: 500, color: "#E2E8F0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{em.subject}</div>
                            <div style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{em.bodyPreview || ""}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {dtlEmailTab === "thread" && (
            <div>
              {dtlThreadLoading ? (
                <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Loading thread…</div>
              ) : dtlEmailThread.length === 0 ? (
                <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Click an email to view its thread</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  {dtlEmailThread.map((msg: any) => {
                    const sender = msg.from?.emailAddress ? msg.from.emailAddress.name || msg.from.emailAddress.address : "Unknown";
                    const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                    const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                    const htmlBody = msg.body?.content || "";
                    return (
                      <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "12px 16px" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
                          <div style={{ width: 28, height: 28, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: "#F1F5F9" }}>{sender}</span>
                              <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                            </div>
                            <div style={{ fontSize: 11, color: "#6B7280" }}>{msg.subject}</div>
                          </div>
                        </div>
                        <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(htmlBody, (emailAttachments[msg.id] || []).filter((a: any) => a.isInline))} style={{ width: "100%", border: "none", minHeight: 80, borderRadius: 6, background: "#ffffff" }}
                          onLoad={e => { try { const f = e.target as HTMLIFrameElement; const h = f.contentDocument!.body.scrollHeight; f.style.height = (h + 24) + "px"; } catch (_) {} }} />
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Attachments for selected email */}
              {dtlEmailSel && (() => {
                const fileAtts = (emailAttachments[dtlEmailSel.id] || []).filter((a: any) => !a.isInline);
                if (fileAtts.length === 0 && !emailAttachmentsLoading[dtlEmailSel.id]) return null;
                return (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "8px 0", borderTop: "1px solid #334155", marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: "#6B7280", marginRight: 4 }}>📎</span>
                    {fileAtts.map((att: any) => {
                      const href = att.contentBytes ? `data:${att.contentType || "application/octet-stream"};base64,${att.contentBytes}` : "#";
                      return (
                        <a key={att.id} href={href} download={att.name}
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#1E293B", border: "1px solid #334155", borderRadius: 6, padding: "3px 9px", fontSize: 11, color: "#60A5FA", textDecoration: "none", cursor: "pointer" }}>
                          📄 {att.name}{att.size ? ` (${(att.size / 1024).toFixed(0)}KB)` : ""}
                        </a>
                      );
                    })}
                    {emailAttachmentsLoading[dtlEmailSel.id] && <span style={{ fontSize: 11, color: "#6B7280" }}>Loading…</span>}
                  </div>
                );
              })()}
              {dtlEmailSel && (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <input value={dtlReply} onChange={e => setDtlReply(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); dtlReplyToEmail(dtlEmailSel.id); } }} placeholder="Write a reply…" style={{ ...S.input, flex: 1 }} />
                  <button onClick={() => dtlReplyToEmail(dtlEmailSel.id)} style={{ ...S.btnPrimary, width: "auto", padding: "10px 20px" }}>Reply</button>
                </div>
              )}
            </div>
          )}

          {dtlEmailTab === "compose" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={S.label}>To (comma-separated)</label>
                <input value={dtlComposeTo} onChange={e => setDtlComposeTo(e.target.value)} placeholder="email@example.com" style={S.input} />
              </div>
              <div>
                <label style={S.label}>Subject</label>
                <input value={dtlComposeSubject} onChange={e => setDtlComposeSubject(e.target.value)} style={S.input} />
              </div>
              <div>
                <label style={S.label}>Body</label>
                <RichTextEditor
                  value={dtlComposeBody}
                  onChange={html => setDtlComposeBody(html)}
                  placeholder="Type your message…"
                  minHeight={120}
                />
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button onClick={() => setDtlEmailTab("inbox")} style={S.btnSecondary}>Cancel</button>
                <button onClick={() => dtlSendEmail(pn)} disabled={!dtlComposeTo.trim() || !dtlComposeSubject.trim()} style={{ ...S.btnPrimary, width: "auto", opacity: (!dtlComposeTo.trim() || !dtlComposeSubject.trim()) ? 0.5 : 1 }}>Send Email</button>
              </div>
            </div>
          )}

          {dtlSendErr && (
            <div style={{ marginTop: 8, background: "#7F1D1D", border: "1px solid #EF4444", borderRadius: 8, padding: "8px 14px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "#FCA5A5", flex: 1 }}>⚠ {dtlSendErr}</span>
              <button onClick={() => setDtlSendErr(null)} style={{ border: "none", background: "none", color: "#FCA5A5", cursor: "pointer", fontFamily: "inherit", fontWeight: 700, fontSize: 11 }}>✕</button>
            </div>
          )}

          {dtlEmailTab === "teams" && (
            <div>
              {!teamsToken ? (
                <div style={{ textAlign: "center", padding: "30px 0" }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
                  <div style={{ color: "#6B7280", fontSize: 13, marginBottom: 12 }}>Sign in with Microsoft to use Teams</div>
                  {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                    <div style={{ color: "#D97706", fontSize: 12 }}>Azure credentials not configured</div>
                  ) : (
                    <button onClick={authenticateEmail} style={{ ...S.btnPrimary, width: "auto", fontSize: 12, padding: "8px 18px" }}>Sign in with Microsoft</button>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {/* Channel Messages */}
                  <div style={{ background: "#0F172A", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ padding: "10px 14px", background: `${TEAMS_PURPLE}22`, borderBottom: `1px solid ${TEAMS_PURPLE}44`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT }}>💬 Channel: {pn}</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        {teamsChannelMap[pn] && <button onClick={() => teamsLoadPOMessages(pn)} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: `1px solid ${TEAMS_PURPLE}44`, background: "none", color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>}
                        <button onClick={() => { setSelected(null); setView("teams"); setTeamsSelPO(pn); setTeamsTab("channels"); }} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}22`, color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>Open Teams ↗</button>
                      </div>
                    </div>
                    {!teamsChannelMap[pn] ? (
                      <div style={{ padding: "14px 16px", fontSize: 12, color: "#6B7280", textAlign: "center" }}>
                        No Teams channel for this PO.{" "}
                        <button onClick={() => { setSelected(null); setView("teams"); setTeamsSelPO(pn); }} style={{ color: TEAMS_PURPLE_LT, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, textDecoration: "underline" }}>Go to Teams to create one</button>
                      </div>
                    ) : teamsLoading[pn] ? (
                      <div style={{ padding: "14px 16px", fontSize: 12, color: "#6B7280", textAlign: "center" }}>Loading messages…</div>
                    ) : (teamsMessages[pn] || []).length === 0 ? (
                      <div style={{ padding: "14px 16px", fontSize: 12, color: "#6B7280", textAlign: "center" }}>No messages yet in this channel</div>
                    ) : (
                      <div style={{ maxHeight: 200, overflowY: "auto" as const, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                        {(teamsMessages[pn] || []).slice(-5).map((msg: any) => {
                          const author = msg.from?.user?.displayName || "Unknown";
                          const clean = (msg.body?.content || "").replace(/<[^>]+>/g, "").trim();
                          const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                          return (
                            <div key={msg.id} style={{ background: "#1E293B", borderRadius: 8, padding: "8px 12px" }}>
                              <div style={{ display: "flex", gap: 6, alignItems: "baseline", marginBottom: 3 }}>
                                <span style={{ fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT }}>{author}</span>
                                <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                              </div>
                              <div style={{ fontSize: 12, color: "#CBD5E1", wordBreak: "break-word" as const }}>{clean || "[Attachment]"}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {teamsChannelMap[pn] && (
                      <div style={{ padding: "10px 12px", borderTop: `1px solid ${TEAMS_PURPLE}33`, display: "flex", gap: 8 }}>
                        <input value={teamsNewMsg} onChange={e => setTeamsNewMsg(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (async () => { const mp = teamsChannelMap[pn]; if (!mp || !teamsNewMsg.trim() || !teamsToken) return; try { const sent = await teamsGraphPost(`/teams/${mp.teamId}/channels/${mp.channelId}/messages`, { body: { content: teamsNewMsg.trim(), contentType: "text" } }); setTeamsMessages(m => ({ ...m, [pn]: [...(m[pn] || []), sent] })); setTeamsNewMsg(""); } catch(e: any) {} })(); } }}
                          placeholder="Message channel…"
                          style={{ flex: 1, background: "#0F172A", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 7, padding: "8px 12px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit" }} />
                        <button disabled={!teamsNewMsg.trim()} onClick={() => { (async () => { const mp = teamsChannelMap[pn]; if (!mp || !teamsNewMsg.trim() || !teamsToken) return; try { const sent = await teamsGraphPost(`/teams/${mp.teamId}/channels/${mp.channelId}/messages`, { body: { content: teamsNewMsg.trim(), contentType: "text" } }); setTeamsMessages(m => ({ ...m, [pn]: [...(m[pn] || []), sent] })); setTeamsNewMsg(""); } catch(e: any) {} })(); }}
                          style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 7, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: !teamsNewMsg.trim() ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: !teamsNewMsg.trim() ? 0.5 : 1 }}>Send</button>
                      </div>
                    )}
                  </div>

                  {/* Quick DM */}
                  <div style={{ background: "#0F172A", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 10, overflow: "visible" as const }}>
                    <div style={{ padding: "10px 14px", background: `${TEAMS_PURPLE}22`, borderBottom: `1px solid ${TEAMS_PURPLE}44` }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT }}>↗ Quick Direct Message</span>
                    </div>
                    <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ position: "relative" as const }}>
                        <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>
                          {teamsContactsLoading
                            ? "Loading contacts…"
                            : teamsContactsError
                              ? <span style={{ color: "#F87171" }}>⚠ Failed — <button onClick={loadTeamsContacts} style={{ background: "none", border: "none", color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit", fontSize: 11, padding: 0, textDecoration: "underline" }}>retry</button></span>
                              : teamsContacts.length > 0
                                ? `To (${teamsContacts.length} contacts)`
                                : "To"}
                        </div>
                        <input value={dtlDMTo}
                          onChange={e => handleTeamsContactInput(e.target.value, "dtl")}
                          onFocus={() => { setDtlDMContactSearch(dtlDMTo); setDtlDMContactDropdown(true); }}
                          onBlur={() => setTimeout(() => setDtlDMContactDropdown(false), 150)}
                          placeholder="Search name or type email…"
                          style={{ width: "100%", background: "#1E293B", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 7, padding: "8px 12px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                        {dtlDMContactDropdown && (() => {
                          const q = (dtlDMContactSearch || "").toLowerCase();
                          const list = dtlDMContactSearchResults.length > 0
                            ? dtlDMContactSearchResults
                            : teamsContacts.filter((c: any) => !q || (c.displayName || "").toLowerCase().includes(q) || (c.userPrincipalName || "").toLowerCase().includes(q) || (c.scoredEmailAddresses?.[0]?.address || "").toLowerCase().includes(q) || (c.mail || "").toLowerCase().includes(q));
                          if (list.length === 0 && !dtlDMContactSearchLoading) return null;
                          return (
                            <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, zIndex: 200, background: "#1E293B", border: `1px solid ${TEAMS_PURPLE}66`, borderRadius: 8, maxHeight: 160, overflowY: "auto" as const, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", marginTop: 2 }}>
                              {dtlDMContactSearchLoading && <div style={{ padding: "6px 12px", fontSize: 11, color: "#6B7280" }}>Searching…</div>}
                              {list.slice(0, 10).map((c: any) => {
                                const email = c.userPrincipalName || c.mail || c.scoredEmailAddresses?.[0]?.address || "";
                                return (
                                  <div key={email || c.displayName} onMouseDown={() => { setDtlDMTo(email); setDtlDMContactDropdown(false); setDtlDMContactSearch(""); setDtlDMContactSearchResults([]); }}
                                    style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${TEAMS_PURPLE}33` }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: "#F1F5F9" }}>{c.displayName}</div>
                                    <div style={{ fontSize: 11, color: "#6B7280" }}>{email}</div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                      <textarea value={dtlDMMsg} onChange={e => { setDtlDMMsg(e.target.value); setDtlDMErr(null); }} rows={3}
                        placeholder="Type your message…"
                        style={{ width: "100%", background: "#1E293B", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 7, padding: "8px 12px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", resize: "vertical" as const, boxSizing: "border-box" as const }} />
                      {dtlDMErr && <div style={{ fontSize: 11, color: "#EF4444" }}>⚠ {dtlDMErr}</div>}
                      <button disabled={dtlDMSending || !dtlDMTo.trim() || !dtlDMMsg.trim()}
                        onClick={async () => {
                          if (!dtlDMTo.trim() || !dtlDMMsg.trim()) return;
                          setDtlDMSending(true); setDtlDMErr(null);
                          try {
                            const me = await teamsGraph("/me");
                            const chat = await teamsGraphPost("/chats", { chatType: "oneOnOne", members: [
                              { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${me.id}')` },
                              { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${dtlDMTo.trim()}')` },
                            ]});
                            const sentMsg = await teamsGraphPost(`/chats/${chat.id}/messages`, { body: { content: dtlDMMsg.trim(), contentType: "text" } });
                            const recipientName = dtlDMTo.trim().split("@")[0] || dtlDMTo.trim();
                            setDmConversations((prev: any) => {
                              const existing = prev.find((c: any) => c.chatId === chat.id);
                              if (existing) {
                                return prev.map((c: any) => c.chatId === chat.id ? { ...c, messages: [...c.messages, sentMsg] } : c);
                              }
                              return [...prev, { chatId: chat.id, recipient: dtlDMTo.trim(), recipientName, messages: [sentMsg] }];
                            });
                            setDtlDMMsg(""); setDtlDMTo("");
                            if (loadDmMessages) await loadDmMessages(chat.id);
                          } catch(e: any) { setDtlDMErr("Failed: " + e.message); }
                          setDtlDMSending(false);
                        }}
                        style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 12, fontWeight: 700, cursor: (dtlDMSending || !dtlDMTo.trim() || !dtlDMMsg.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (dtlDMSending || !dtlDMTo.trim() || !dtlDMMsg.trim()) ? 0.5 : 1, alignSelf: "flex-end" as const }}>
                        {dtlDMSending ? "Sending…" : "Send DM ↗"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
