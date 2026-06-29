// Costing Module — RFQ Messages inbox.
//
// A global inbox of every SENT RFQ×vendor conversation, so the buyer can read
// vendor replies AND start a new private message — without opening each RFQ.
// Threads are PRIVATE per vendor (1:1), so the list has one row per
// (rfq, invited vendor). Rows appear even with ZERO messages, which is how the
// buyer STARTS a conversation: select the row and send the first message.
//
// LEFT  — flat list of conversations (project · RFQ · vendor), unread + newest
//         first, with a search box (project / RFQ / vendor name). Backed by
//         /api/internal/rfqs/messages-inbox (rfq_messages is service-role only,
//         so the browser can't aggregate it directly).
// RIGHT — the selected conversation's thread via the shared <RfqMessageThread>
//         (rfqId + vendorId), with a composer. Posting works as the first
//         message and notifies that vendor. The GET marks vendor messages
//         read-by-internal on load, so we refetch the list when the selection
//         changes / a message is sent — the unread badge clears.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RfqMessageThread, type RfqTheme } from "../../tanda/rfq/RfqQuotesAndMessages";
import { fmtDateDisplay, navigate } from "../helpers";

// Costing-module palette for the shared RFQ message thread — copy of the
// COSTING_RFQ_THEME defined in RfqEditView (dark slate + blue accent) so the
// inbox matches the rest of the module without coupling the two views.
const COSTING_RFQ_THEME: RfqTheme = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#E2E8F0", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#60A5FA", success: "#10B981", warn: "#F59E0B", danger: "#F87171",
};

interface InboxRow {
  rfq_id: string;
  rfq_title: string | null;
  status: string | null;
  project_name: string | null;
  vendor_id: string;
  vendor_name: string | null;
  total: number;
  unread_internal: number;
  last_message_at: string | null;
  last_preview: string;
}

// One conversation == (rfq, vendor); used as the selection + React key.
const convKey = (r: { rfq_id: string; vendor_id: string }) => `${r.rfq_id}::${r.vendor_id}`;

// Short relative-ish timestamp for the list (full ts lives in the thread).
function shortTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return fmtDateDisplay(iso.slice(0, 10));
}

export default function RfqMessagesInbox() {
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/internal/rfqs/messages-inbox");
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const b = await r.json(); if (b?.error) msg = b.error; } catch { /* noop */ }
        throw new Error(msg);
      }
      const raw = await r.json();
      const data: InboxRow[] = Array.isArray(raw) ? raw : [];
      setRows(data);
      // Keep the current selection if still present; otherwise pick the first
      // conversation so the right pane isn't blank on first open.
      setSelected((prev) => {
        if (prev && data.some((x) => convKey(x) === prev)) return prev;
        return data.length > 0 ? convKey(data[0]) : null;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Opening a thread marks its vendor messages read-by-internal on the server
  // (RfqMessageThread's GET side-effect). Refetch the list a beat later so the
  // unread badge for the now-read thread clears.
  useEffect(() => {
    if (!selected) return;
    const t = window.setTimeout(() => { void load(); }, 600);
    return () => window.clearTimeout(t);
  }, [selected, load]);

  const safeRows: InboxRow[] = Array.isArray(rows) ? rows : [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return safeRows;
    return safeRows.filter((r) =>
      [r.project_name, r.rfq_title, r.vendor_name].some((v) => (v || "").toLowerCase().includes(q))
    );
  }, [safeRows, search]);

  const selectedRow = safeRows.find((x) => convKey(x) === selected) || null;
  const unreadTotal = safeRows.reduce((n, r) => n + (r.unread_internal > 0 ? 1 : 0), 0);

  return (
    <div style={{ display: "flex", height: "100%", background: "#0F172A", color: "#E2E8F0" }}>
      {/* LEFT — conversation list */}
      <div style={{ width: 380, flexShrink: 0, borderRight: "1px solid #334155", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "16px 18px 10px", borderBottom: "1px solid #334155" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Messages</h2>
            <span style={{ color: "#94A3B8", fontSize: 12 }}>
              {safeRows.length} {safeRows.length === 1 ? "conversation" : "conversations"}
              {unreadTotal > 0 && <> · {unreadTotal} unread</>}
            </span>
            <button
              onClick={() => void load()}
              title="Refresh"
              style={{ marginLeft: "auto", background: "transparent", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
            >
              ↻
            </button>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="Search project, RFQ, or vendor…"
            style={{ marginTop: 10, width: "100%", boxSizing: "border-box", padding: "7px 10px", borderRadius: 6, border: "1px solid #334155", background: "#0F172A", color: "#E2E8F0", fontSize: 12, fontFamily: "inherit" }}
          />
        </div>

        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {error && <div style={{ padding: 14, color: "#F87171", fontSize: 13 }}>Error: {error}</div>}
          {loading && safeRows.length === 0 ? (
            <div style={{ padding: 24, color: "#94A3B8", fontSize: 13 }}>Loading…</div>
          ) : safeRows.length === 0 ? (
            <div style={{ padding: "30px 18px", color: "#64748B", fontSize: 13, lineHeight: 1.5 }}>
              No sent RFQs yet. Once you send an RFQ to a vendor, the conversation appears here — select it to message them.
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "30px 18px", color: "#64748B", fontSize: 13 }}>No conversations match "{search}".</div>
          ) : filtered.map((row) => {
            const k = convKey(row);
            const active = k === selected;
            const header = [row.project_name, row.rfq_title].filter(Boolean).join(" · ") || row.rfq_title || "(untitled RFQ)";
            return (
              <button
                key={k}
                onClick={() => setSelected(k)}
                style={{
                  display: "block", width: "100%", textAlign: "left", border: "none",
                  borderBottom: "1px solid #1E293B",
                  borderLeft: `3px solid ${active ? "#60A5FA" : "transparent"}`,
                  background: active ? "#1E293B" : "transparent",
                  color: "#E2E8F0", cursor: "pointer", padding: "12px 16px",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontWeight: row.unread_internal > 0 ? 700 : 600, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {header}
                  </span>
                  {row.unread_internal > 0 && (
                    <span style={{ background: "#60A5FA", color: "#0F172A", fontSize: 11, fontWeight: 700, borderRadius: 10, padding: "1px 7px", flexShrink: 0 }}>
                      {row.unread_internal}
                    </span>
                  )}
                  <span style={{ color: "#64748B", fontSize: 11, flexShrink: 0 }}>{shortTime(row.last_message_at)}</span>
                </div>
                <div style={{ color: "#94A3B8", fontSize: 11, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {row.vendor_name || "(unknown vendor)"}
                </div>
                <div style={{
                  color: row.unread_internal > 0 ? "#CBD5E1" : "#64748B",
                  fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontStyle: row.last_preview ? "normal" : "italic",
                }}>
                  {row.last_preview || "No messages yet — start the conversation"}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* RIGHT — selected conversation thread */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px", minWidth: 0 }}>
        {selectedRow ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{selectedRow.rfq_title || "(untitled RFQ)"}</h2>
              {selectedRow.status && (
                <span style={{ color: "#94A3B8", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>
                  {selectedRow.status}
                </span>
              )}
              <a
                href="#"
                onClick={(e) => { e.preventDefault(); navigate("rfq-edit", selectedRow.rfq_id); }}
                style={{ marginLeft: "auto", color: "#60A5FA", fontSize: 13, textDecoration: "none" }}
                title="Open the full RFQ"
              >
                Open RFQ →
              </a>
            </div>
            <div style={{ color: "#94A3B8", fontSize: 12, marginBottom: 4 }}>
              {selectedRow.project_name ? `${selectedRow.project_name} · ` : ""}
              Conversation with <b style={{ color: "#CBD5E1" }}>{selectedRow.vendor_name || "vendor"}</b>
            </div>
            {/* Shared thread, scoped to THIS (rfq, vendor). Marks vendor
                messages read-by-internal on load, so refetch the list
                afterwards to clear the unread badge. Composer posts the first
                message and notifies this vendor. */}
            <RfqMessageThread
              key={convKey(selectedRow)}
              rfqId={selectedRow.rfq_id}
              vendorId={selectedRow.vendor_id}
              theme={COSTING_RFQ_THEME}
              onPosted={() => void load()}
            />
          </>
        ) : (
          <div style={{ color: "#64748B", fontSize: 14, padding: "60px 0", textAlign: "center" }}>
            {safeRows.length === 0 ? "No sent RFQs yet." : "Select a conversation on the left to read and reply."}
          </div>
        )}
      </div>
    </div>
  );
}
