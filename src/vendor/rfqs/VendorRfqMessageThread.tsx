import { useEffect, useRef, useState } from "react";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";

// Vendor-side RFQ message thread. Lets the vendor message Ring of Fire about an
// RFQ before any PO exists. Talks to /api/vendor/rfqs/:id/messages (the
// rfq_messages table is service-role only, scoped to the vendor's invitation).
// Vendor messages right-aligned; Ring of Fire left. Shared by the RFQ detail
// page and the Messages → RFQs tab.

interface Attachment {
  name: string;
  type: string;
  size: number;
  url: string;
}
interface RfqMessage {
  id: string;
  sender_type: string;
  sender_name: string;
  body: string;
  created_at: string;
  attachments?: Attachment[];
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

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

  function pickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files || []);
    const tooBig = picked.filter(f => f.size > 15_728_640);
    const valid = picked.filter(f => f.size <= 15_728_640);
    if (tooBig.length > 0) setErr(`${tooBig.map(f => f.name).join(", ")} exceed${tooBig.length === 1 ? "s" : ""} the 15 MB limit and ${tooBig.length === 1 ? "was" : "were"} not attached.`);
    setPendingFiles(p => [...p, ...valid].slice(0, 5));
    e.target.value = "";
  }

  async function send() {
    const body = draft.trim();
    if (!body && pendingFiles.length === 0) return;
    setSending(true);
    setUploading(pendingFiles.length > 0);
    setErr(null);
    try {
      let attachments: { name: string; type: string; size: number; data: string }[] = [];
      if (pendingFiles.length > 0) {
        attachments = await Promise.all(pendingFiles.map(f => new Promise<{ name: string; type: string; size: number; data: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: f.name, type: f.type, size: f.size, data: reader.result as string });
          reader.onerror = reject;
          reader.readAsDataURL(f);
        })));
      }
      const t = await token();
      const r = await fetch(`/api/vendor/rfqs/${rfqId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ body, attachments }),
      });
      if (!r.ok) throw new Error(await r.text());
      setDraft("");
      setPendingFiles([]);
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); setUploading(false); }
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
                  {m.sender_name}
                </div>
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{m.body}</div>
                {(m.attachments || []).length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                    {(m.attachments || []).map((a, i) => (
                      a.type.startsWith("image/") ? (
                        <a key={i} href={a.url} target="_blank" rel="noopener noreferrer">
                          <img src={a.url} alt={a.name} style={{ maxWidth: 200, maxHeight: 200, borderRadius: 6, display: "block" }} />
                        </a>
                      ) : (
                        <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" style={{ color: mine ? "rgba(255,255,255,0.9)" : TH.primary, fontSize: 12, display: "flex", alignItems: "center", gap: 4, textDecoration: "none" }}>
                          {a.name}
                        </a>
                      )
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>{new Date(m.created_at).toLocaleString()}</div>
              </div>
            </div>
          );
        })}
      </div>
      {err && <div style={{ padding: "6px 16px", color: TH.primary, fontSize: 12 }}>{err}</div>}
      <div style={{ borderTop: `1px solid ${TH.border}`, background: TH.surface }}>
        <div style={{ padding: "10px 16px 0", display: "flex", gap: 8 }}>
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
            placeholder="Message Ring of Fire about this RFQ…"
            style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.bg, color: TH.text, fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
          />
        </div>
        {pendingFiles.length > 0 && (
          <div style={{ padding: "4px 16px", display: "flex", flexWrap: "wrap", gap: 6 }}>
            {pendingFiles.map((f, i) => (
              <span key={i} style={{ background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 14, padding: "3px 10px", fontSize: 11, color: TH.text, display: "flex", alignItems: "center", gap: 6 }}>
                {f.name}
                <span onClick={() => setPendingFiles(p => p.filter((_, j) => j !== i))} style={{ cursor: "pointer", color: TH.textMuted, fontWeight: 700 }}>×</span>
              </span>
            ))}
          </div>
        )}
        <div style={{ padding: "6px 16px 10px", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt" style={{ display: "none" }} onChange={pickFiles} />
          <button onClick={() => fileInputRef.current?.click()} title="Attach file" style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "transparent", color: TH.textMuted, cursor: "pointer", fontSize: 13, lineHeight: 1 }}>
            Attach
          </button>
          <button onClick={() => void send()} disabled={sending || (!draft.trim() && pendingFiles.length === 0)} style={{ ...btnPrimary, opacity: sending || (!draft.trim() && pendingFiles.length === 0) ? 0.5 : 1, cursor: sending || (!draft.trim() && pendingFiles.length === 0) ? "not-allowed" : "pointer" }}>
            {uploading ? "Uploading…" : sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
