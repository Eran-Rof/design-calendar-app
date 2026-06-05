import { useEffect, useState } from "react";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";

// Vendor-side RFQ message thread. Lets the vendor message Ring of Fire about an
// RFQ before any PO exists. Talks to /api/vendor/rfqs/:id/messages (the
// rfq_messages table is service-role only, scoped to the vendor's invitation).
// Vendor messages right-aligned; Ring of Fire left. Shared by the RFQ detail
// page and the Messages → RFQs tab.

interface RfqMessage {
  id: string;
  sender_type: string;
  sender_name: string;
  body: string;
  created_at: string;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;

export default function VendorRfqMessageThread({ rfqId, height = 320, onChanged }: { rfqId: string; height?: number; onChanged?: () => void }) {
  const [messages, setMessages] = useState<RfqMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/rfqs/${rfqId}/messages`, { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      setMessages((await r.json()) as RfqMessage[]);
      // The GET marks incoming messages read — let the parent refresh unread.
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [rfqId]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setErr(null);
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/rfqs/${rfqId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) throw new Error(await r.text());
      setDraft("");
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); }
  }

  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "12px 18px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 14, fontWeight: 700, color: TH.text }}>Messages</div>
      <div style={{ maxHeight: height, overflowY: "auto", padding: "12px 16px", background: TH.surfaceHi }}>
        {loading ? (
          <div style={{ color: TH.textMuted, fontSize: 13 }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: TH.textMuted, fontSize: 13, textAlign: "center", padding: "30px 0" }}>No messages yet. Ask Ring of Fire a question about this RFQ below.</div>
        ) : messages.map((m) => {
          const mine = m.sender_type === "vendor";
          return (
            <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
              <div style={{ maxWidth: "78%", background: mine ? TH.primary : TH.bg, color: TH.text, border: `1px solid ${mine ? TH.primary : TH.border}`, borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>
                <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, opacity: 0.85, color: mine ? "rgba(255,255,255,0.9)" : TH.textMuted }}>
                  {m.sender_name} · {m.sender_type === "vendor" ? "You" : "Ring of Fire"}
                </div>
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{m.body}</div>
                <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>{new Date(m.created_at).toLocaleString()}</div>
              </div>
            </div>
          );
        })}
      </div>
      {err && <div style={{ padding: "6px 16px", color: TH.primary, fontSize: 12 }}>{err}</div>}
      <div style={{ padding: "10px 16px", borderTop: `1px solid ${TH.border}`, background: TH.surface, display: "flex", gap: 8 }}>
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          placeholder="Message Ring of Fire about this RFQ… (⌘/Ctrl+Enter to send)"
          style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.bg, color: TH.text, fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
        />
        <button onClick={() => void send()} disabled={sending || !draft.trim()} style={{ ...btnPrimary, opacity: sending || !draft.trim() ? 0.5 : 1, cursor: sending || !draft.trim() ? "not-allowed" : "pointer" }}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
