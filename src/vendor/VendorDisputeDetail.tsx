import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import StatusBadge, { disputeTone } from "./StatusBadge";
import { fmtDate } from "./utils";
import { showAlert } from "./ui/AppDialog";
import AttachmentsManager from "./ui/AttachmentsManager";

interface Dispute {
  id: string;
  subject: string;
  type: string;
  status: string;
  priority: string;
  created_at: string;
  resolution: string | null;
  resolved_at: string | null;
  po_id: string | null;
  invoice_id: string | null;
}

interface Message {
  id: string;
  dispute_id: string;
  sender_type: "vendor" | "internal";
  sender_name: string;
  body: string;
  created_at: string;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
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

export default function VendorDisputeDetail() {
  const { id } = useParams<{ id: string }>();
  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/disputes/${id}`, { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setDispute(data.dispute);
      setMessages(data.messages || []);
      // Resolve caller's vendor_id for the attachments storage folder.
      // RLS guarantees the dispute belongs to this vendor.
      if (!vendorId) {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (uid) {
          const { data: vu } = await supabaseVendor.from("vendor_users")
            .select("vendor_id").eq("auth_id", uid).maybeSingle();
          setVendorId((vu as { vendor_id: string } | null)?.vendor_id || null);
        }
      }
      window.setTimeout(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      }, 0);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [id]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/disputes/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) throw new Error(await r.text());
      setDraft("");
      await load();
    } catch (e: unknown) {
      await showAlert({ title: "Send failed", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally {
      setSending(false);
    }
  }

  if (loading) return <div style={{ color: TH.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!dispute) return null;

  return (
    <div>
      <Link to="/vendor/disputes" style={{ color: "rgba(255,255,255,0.8)", fontSize: 13, textDecoration: "none" }}>← Disputes</Link>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "18px 22px", marginTop: 12, boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 700 }}>{dispute.type.replace(/_/g, " ")} · priority {dispute.priority}</div>
            <h2 style={{ margin: "4px 0 10px", color: TH.text, fontSize: 20 }}>{dispute.subject}</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <StatusBadge label={dispute.status === "under_review" ? "Under review" : dispute.status[0].toUpperCase() + dispute.status.slice(1)} tone={disputeTone(dispute.status)} />
              <span style={{ fontSize: 12, color: TH.textMuted }}>Opened {fmtDate(dispute.created_at)}</span>
            </div>
          </div>
          <div style={{ fontSize: 12, color: TH.textMuted, textAlign: "right" }}>
            {dispute.po_id && <div>PO: {dispute.po_id.slice(0, 8)}…</div>}
            {dispute.invoice_id && <div>Invoice: {dispute.invoice_id.slice(0, 8)}…</div>}
          </div>
        </div>
        {dispute.resolution && (
          <div style={{ marginTop: 12, padding: "10px 12px", background: "#F0FFF4", border: "1px solid #C6F6D5", borderRadius: 6, fontSize: 13, color: "#276749" }}>
            <b>Resolution:</b> {dispute.resolution}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", height: 520, marginTop: 16, border: `1px solid ${TH.border}`, borderRadius: 8, background: TH.surface, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 13, fontWeight: 700, color: TH.text }}>Messages</div>
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", background: TH.surfaceHi }}>
          {messages.length === 0 ? (
            <div style={{ color: TH.textMuted, fontSize: 13, textAlign: "center", padding: "40px 0" }}>No messages yet.</div>
          ) : messages.map((m) => {
            const mine = m.sender_type === "vendor";
            return (
              <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
                <div style={{ maxWidth: "78%", background: mine ? TH.primary : "#FFFFFF", color: mine ? "#FFFFFF" : TH.text, border: `1px solid ${mine ? TH.primary : TH.border}`, borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, opacity: 0.85, color: mine ? "rgba(255,255,255,0.9)" : TH.textMuted }}>
                    {m.sender_name} · {mine ? "You" : "Ring of Fire"}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{m.body}</div>
                  <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>{timeAgo(m.created_at)}</div>
                </div>
              </div>
            );
          })}
        </div>
        {dispute.status !== "closed" && dispute.status !== "resolved" && (
          <div style={{ padding: "10px 14px", borderTop: `1px solid ${TH.border}`, background: TH.surface, display: "flex", gap: 8 }}>
            <textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
              placeholder="Type a message… (⌘+Enter to send)"
              style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
            />
            <button onClick={() => void send()} disabled={sending || !draft.trim()} style={{ padding: "0 18px", borderRadius: 6, border: "none", background: sending || !draft.trim() ? TH.textMuted : TH.primary, color: "#FFFFFF", cursor: sending ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        )}
      </div>

      {vendorId && (
        <div style={{ marginTop: 14 }}>
          <AttachmentsManager
            entityType="dispute"
            entityId={dispute.id}
            storageFolder={`${vendorId}/disputes`}
            readOnly={dispute.status === "closed" || dispute.status === "resolved"}
            label="Evidence / supporting documents"
          />
        </div>
      )}
    </div>
  );
}
