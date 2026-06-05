// Costing Module — RFQ Messages inbox.
//
// A global inbox of every RFQ that has at least one message, so the buyer
// doesn't have to open each RFQ to find out a vendor replied. This is
// ADDITIVE — the per-RFQ thread still lives inside RfqEditView; this just
// surfaces all threads in one place from the main "Messages" menu item.
//
// LEFT  — list of RFQs (title, vendor name(s), last-message preview, unread
//         badge, time), unread-first. Backed by the server inbox endpoint
//         /api/internal/rfqs/messages-inbox (rfq_messages is service-role
//         only, so the browser can't aggregate it directly).
// RIGHT — the selected RFQ's thread via the shared <RfqMessageThread>, which
//         talks to /api/internal/rfqs/:id/messages and marks vendor messages
//         read-by-internal on load (which is why we refetch the list when the
//         selection changes / a reply is sent — the unread badge clears).

import React, { useCallback, useEffect, useState } from "react";
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
  last_message_at: string;
  last_message_preview: string;
  unread_internal: number;
  total: number;
  vendor_names: string[];
}

// Short relative-ish timestamp for the list (full ts lives in the thread).
function shortTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return fmtDateDisplay(iso.slice(0, 10));
}

export default function RfqMessagesInbox() {
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
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
      const data = (await r.json()) as InboxRow[];
      setRows(data);
      // Keep the current selection if it's still present; otherwise pick the
      // first row so the right pane isn't blank on first open.
      setSelected((prev) => {
        if (prev && data.some((x) => x.rfq_id === prev)) return prev;
        return data.length > 0 ? data[0].rfq_id : null;
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
  // unread badge for the now-read thread clears. Skipped on the very first
  // render (no selection yet) and debounced to let the thread's GET land.
  useEffect(() => {
    if (!selected) return;
    const t = window.setTimeout(() => { void load(); }, 600);
    return () => window.clearTimeout(t);
  }, [selected, load]);

  const selectedRow = rows.find((x) => x.rfq_id === selected) || null;

  return (
    <div style={{ display: "flex", height: "100%", background: "#0F172A", color: "#E2E8F0" }}>
      {/* LEFT — RFQ list */}
      <div style={{ width: 360, flexShrink: 0, borderRight: "1px solid #334155", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "16px 18px 10px", borderBottom: "1px solid #334155", display: "flex", alignItems: "baseline", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Messages</h2>
          <span style={{ color: "#94A3B8", fontSize: 12 }}>{rows.length} {rows.length === 1 ? "thread" : "threads"}</span>
          <button
            onClick={() => void load()}
            title="Refresh"
            style={{ marginLeft: "auto", background: "transparent", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
          >
            ↻
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {error && <div style={{ padding: 14, color: "#F87171", fontSize: 13 }}>Error: {error}</div>}
          {loading && rows.length === 0 ? (
            <div style={{ padding: 24, color: "#94A3B8", fontSize: 13 }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: "30px 18px", color: "#64748B", fontSize: 13, lineHeight: 1.5 }}>
              No RFQ messages yet. When a vendor replies on an RFQ, or you message a vendor from an RFQ, the conversation shows up here.
            </div>
          ) : rows.map((row) => {
            const active = row.rfq_id === selected;
            const vendors = row.vendor_names.length ? row.vendor_names.join(", ") : "—";
            return (
              <button
                key={row.rfq_id}
                onClick={() => setSelected(row.rfq_id)}
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
                    {row.rfq_title || "(untitled RFQ)"}
                  </span>
                  {row.unread_internal > 0 && (
                    <span style={{ background: "#60A5FA", color: "#0F172A", fontSize: 11, fontWeight: 700, borderRadius: 10, padding: "1px 7px", flexShrink: 0 }}>
                      {row.unread_internal}
                    </span>
                  )}
                  <span style={{ color: "#64748B", fontSize: 11, flexShrink: 0 }}>{shortTime(row.last_message_at)}</span>
                </div>
                <div style={{ color: "#94A3B8", fontSize: 11, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {vendors}
                </div>
                <div style={{
                  color: row.unread_internal > 0 ? "#CBD5E1" : "#64748B",
                  fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {row.last_message_preview || "—"}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* RIGHT — selected RFQ thread */}
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
              {selectedRow.vendor_names.length ? selectedRow.vendor_names.join(", ") : "No invited vendors"}
            </div>
            {/* Shared thread — marks vendor messages read-by-internal on load,
                so refetch the list afterwards to clear the unread badge. */}
            <RfqMessageThread
              key={selectedRow.rfq_id}
              rfqId={selectedRow.rfq_id}
              theme={COSTING_RFQ_THEME}
              onPosted={() => void load()}
            />
          </>
        ) : (
          <div style={{ color: "#64748B", fontSize: 14, padding: "60px 0", textAlign: "center" }}>
            {rows.length === 0 ? "No messages yet." : "Select a conversation on the left to read and reply."}
          </div>
        )}
      </div>
    </div>
  );
}
