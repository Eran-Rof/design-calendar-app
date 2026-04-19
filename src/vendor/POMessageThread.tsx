import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TH } from "../utils/theme";

// Reusable message thread component. Works with either the vendor's
// authenticated Supabase client or the internal anon client — pass the
// right one plus the sender info.

export interface Sender {
  type: "vendor" | "internal";
  name: string;
  auth_id?: string;    // vendor sender
  internal_id?: string;  // internal sender
}

interface Message {
  id: string;
  po_id: string;
  sender_type: string;
  sender_name: string;
  body: string;
  read_by_vendor: boolean;
  read_by_internal: boolean;
  created_at: string;
}

interface Attachment {
  id: string;
  message_id: string;
  file_url: string;
  file_name: string;
  file_size_bytes: number | null;
}

interface Props {
  poId: string;
  poNumber?: string;
  sender: Sender;
  client: SupabaseClient;
  /** Height in px; defaults to 500. */
  height?: number;
  /** Auto-mark incoming as read when viewed (based on sender side). */
  autoMarkRead?: boolean;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function POMessageThread({ poId, poNumber, sender, client, height = 500, autoMarkRead = true }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const { data: msgs, error: mErr } = await client
        .from("po_messages")
        .select("id, po_id, sender_type, sender_name, body, read_by_vendor, read_by_internal, created_at")
        .eq("po_id", poId)
        .order("created_at", { ascending: true });
      if (mErr) throw mErr;
      const m = (msgs ?? []) as Message[];
      setMessages(m);

      if (m.length > 0) {
        const { data: atts } = await client
          .from("po_message_attachments")
          .select("id, message_id, file_url, file_name, file_size_bytes")
          .in("message_id", m.map((x) => x.id));
        const grouped: Record<string, Attachment[]> = {};
        for (const a of (atts ?? []) as Attachment[]) {
          grouped[a.message_id] = grouped[a.message_id] ?? [];
          grouped[a.message_id].push(a);
        }
        setAttachments(grouped);

        if (autoMarkRead) {
          const toMark = m.filter((x) => x.sender_type !== sender.type
            && !(sender.type === "vendor" ? x.read_by_vendor : x.read_by_internal)).map((x) => x.id);
          if (toMark.length > 0) {
            const patch = sender.type === "vendor" ? { read_by_vendor: true } : { read_by_internal: true };
            await client.from("po_messages").update(patch).in("id", toMark);
          }
        }
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      // scroll to bottom after paint
      window.setTimeout(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      }, 0);
    }
  }

  useEffect(() => { void load(); }, [poId]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setErr(null);
    try {
      const row: Record<string, unknown> = {
        po_id: poId,
        sender_type: sender.type,
        sender_name: sender.name,
        body,
        read_by_vendor: sender.type === "vendor",
        read_by_internal: sender.type === "internal",
      };
      if (sender.type === "vendor") row.sender_auth_id = sender.auth_id;
      else row.sender_internal_id = sender.internal_id;

      const { error } = await client.from("po_messages").insert(row);
      if (error) throw error;
      setDraft("");
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height, border: `1px solid ${TH.border}`, borderRadius: 8, background: TH.surface, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 13, fontWeight: 700, color: TH.text }}>
        PO messages{poNumber ? ` — ${poNumber}` : ""}
      </div>

      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", background: TH.surfaceHi }}>
        {loading ? (
          <div style={{ color: TH.textMuted, fontSize: 13 }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: TH.textMuted, fontSize: 13, textAlign: "center", padding: "40px 0" }}>No messages yet. Start the conversation below.</div>
        ) : (
          messages.map((m) => {
            const mine = m.sender_type === sender.type;
            const atts = attachments[m.id] ?? [];
            return (
              <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
                <div style={{ maxWidth: "78%", background: mine ? TH.primary : "#FFFFFF", color: mine ? "#FFFFFF" : TH.text, border: `1px solid ${mine ? TH.primary : TH.border}`, borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, opacity: 0.85, color: mine ? "rgba(255,255,255,0.9)" : TH.textMuted }}>
                    {m.sender_name} · {m.sender_type === "vendor" ? "Vendor" : "Ring of Fire"}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{m.body}</div>
                  {atts.length > 0 && (
                    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                      {atts.map((a) => (
                        <div key={a.id} style={{ fontSize: 11, opacity: 0.9 }}>📎 {a.file_name}</div>
                      ))}
                    </div>
                  )}
                  <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>{timeAgo(m.created_at)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {err && (
        <div style={{ padding: "6px 12px", background: TH.accent, color: TH.primary, fontSize: 12, borderTop: `1px solid ${TH.accentBdr}` }}>{err}</div>
      )}

      <div style={{ padding: "10px 14px", borderTop: `1px solid ${TH.border}`, background: TH.surface, display: "flex", gap: 8 }}>
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          placeholder="Type a message… (⌘+Enter to send)"
          style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
        />
        <button
          onClick={() => void send()}
          disabled={sending || !draft.trim()}
          style={{ padding: "0 18px", borderRadius: 6, border: "none", background: sending || !draft.trim() ? TH.textMuted : TH.primary, color: "#FFFFFF", cursor: sending ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
