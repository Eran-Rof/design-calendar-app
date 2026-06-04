import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";

interface QuoteLine {
  id: string;
  rfq_line_item_id: string | null;
  unit_price: number | null;
  quantity: number | null;
  notes: string | null;
}

interface Quote {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  status: string;
  total_price: number | null;
  lead_time_days: number | null;
  valid_until: string | null;
  notes: string | null;
  submitted_at: string | null;
  health_score: number;
  lines: QuoteLine[];
}

interface RfqDetail {
  rfq: { id: string; title: string; description: string | null; category: string | null; status: string; submission_deadline: string | null; awarded_to_vendor_id: string | null };
  line_items: { id: string; line_index: number; description: string; quantity: number; unit_of_measure: string | null }[];
  invitations: { id: string; vendor_id: string; status: string; vendor: { name: string } }[];
  quotes: { id: string; status: string }[];
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

type SortKey = "price" | "lead_time" | "health";

export default function InternalRfqDetail({ rfqId, onClose, onChanged }: { rfqId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<RfqDetail | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("price");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [dRes, qRes] = await Promise.all([
        fetch(`/api/internal/rfqs/${rfqId}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText))),
        fetch(`/api/internal/rfqs/${rfqId}/quotes?sort=${sort}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText))),
      ]);
      setDetail(dRes as RfqDetail);
      setQuotes(qRes as Quote[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [rfqId, sort]);

  async function publish() {
    const r = await fetch(`/api/internal/rfqs/${rfqId}/publish`, { method: "POST" });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load(); onChanged();
  }
  async function closeRfq() {
    if (!(await confirmDialog("Close this RFQ? No more quotes can be submitted."))) return;
    const r = await fetch(`/api/internal/rfqs/${rfqId}/close`, { method: "POST" });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load(); onChanged();
  }
  async function award(vendorId: string, vendorName: string) {
    if (!(await confirmDialog(`Award this RFQ to ${vendorName}? All other quotes will be rejected.`))) return;
    const r = await fetch(`/api/internal/rfqs/${rfqId}/award/${vendorId}`, { method: "POST" });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load(); onChanged();
  }

  function downloadCsv() {
    const headers = ["Vendor", "Status", "Total price", "Lead time (days)", "Valid until", "Health score", "Submitted at"];
    const rows = quotes.map((q) => [
      q.vendor_name || "",
      q.status,
      q.total_price != null ? String(q.total_price) : "",
      q.lead_time_days != null ? String(q.lead_time_days) : "",
      q.valid_until || "",
      String(q.health_score),
      q.submitted_at || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `rfq-${rfqId}-quotes.csv`; a.click(); URL.revokeObjectURL(url);
  }

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;
  if (!detail) return null;

  const { rfq } = detail;
  const isAwarded = rfq.status === "awarded";

  return (
    <div style={{ color: C.text }}>
      <div onClick={onClose} style={{ color: C.textMuted, fontSize: 13, cursor: "pointer", marginBottom: 10 }}>← All RFQs</div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "18px 22px", marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700 }}>{rfq.category || "RFQ"}</div>
            <h2 style={{ margin: "4px 0 8px", fontSize: 22 }}>{rfq.title}</h2>
            <div style={{ color: C.textSub, fontSize: 13 }}>{rfq.description}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>
              Status: <b style={{ textTransform: "capitalize" }}>{rfq.status}</b>
              {rfq.submission_deadline && <> · Deadline: {rfq.submission_deadline.slice(0, 10)}</>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {rfq.status === "draft" && <button onClick={() => void publish()} style={btnPrimary}>Publish</button>}
            {rfq.status === "published" && <button onClick={() => void closeRfq()} style={btnSecondary}>Close</button>}
            <button onClick={downloadCsv} style={btnSecondary}>⬇ CSV</button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Quote comparison ({quotes.length})</h3>
        <div style={{ color: C.textMuted, fontSize: 12, marginLeft: "auto" }}>Sort:</div>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={selectSt}>
          <option value="price">Lowest price</option>
          <option value="lead_time">Fastest lead time</option>
          <option value="health">Highest health</option>
        </select>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 130px 120px 110px 100px 140px 160px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Vendor</div>
          <div style={{ textAlign: "right" }}>Total</div>
          <div style={{ textAlign: "right" }}>Lead time</div>
          <div style={{ textAlign: "right" }}>Health</div>
          <div>Status</div>
          <div>Submitted</div>
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {quotes.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No quotes yet.</div>
        ) : quotes.map((q) => {
          const lineNotes = (q.lines || []).filter((l) => l.notes && l.notes.trim());
          const hasNotes = !!(q.notes && q.notes.trim()) || lineNotes.length > 0;
          const isOpen = !!expanded[q.id];
          return (
          <div key={q.id}>
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 130px 120px 110px 100px 140px 160px", padding: "10px 14px", borderBottom: isOpen ? "none" : `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                {hasNotes && (
                  <span
                    onClick={() => setExpanded((p) => ({ ...p, [q.id]: !p[q.id] }))}
                    title={isOpen ? "Hide vendor notes" : "Show vendor notes"}
                    style={{ cursor: "pointer", color: C.primary, fontSize: 11, userSelect: "none" }}
                  >
                    {isOpen ? "▾" : "▸"} 📝
                  </span>
                )}
                {q.vendor_name || "—"}
              </div>
              <div style={{ textAlign: "right" }}>{q.total_price != null ? `$${Number(q.total_price).toLocaleString()}` : "—"}</div>
              <div style={{ textAlign: "right", color: C.textSub }}>{q.lead_time_days != null ? `${q.lead_time_days}d` : "—"}</div>
              <div style={{ textAlign: "right", color: q.health_score >= 80 ? C.success : q.health_score >= 60 ? C.warn : C.danger, fontWeight: 700 }}>{q.health_score}</div>
              <div style={{ color: statusColor(q.status), fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>{q.status}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{q.submitted_at ? q.submitted_at.slice(0, 10) : "—"}</div>
              <div style={{ textAlign: "right" }}>
                {!isAwarded && q.status === "submitted" && (
                  <button onClick={() => void award(q.vendor_id, q.vendor_name || q.vendor_id)} style={{ ...btnPrimary, background: C.success }}>Award</button>
                )}
                {isAwarded && q.status === "awarded" && <span style={{ color: C.success, fontSize: 12, fontWeight: 700 }}>✓ Awarded</span>}
              </div>
            </div>
            {isOpen && hasNotes && (
              <div style={{ padding: "10px 16px 14px", borderBottom: `1px solid ${C.cardBdr}`, background: C.bg }}>
                {q.notes && q.notes.trim() && (
                  <div style={{ marginBottom: lineNotes.length ? 10 : 0 }}>
                    <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 3 }}>Quote note</div>
                    <div style={{ fontSize: 12, color: C.textSub, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{q.notes}</div>
                  </div>
                )}
                {lineNotes.length > 0 && (
                  <div>
                    <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Line notes</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {lineNotes.map((l) => {
                        const li = detail.line_items.find((x) => x.id === l.rfq_line_item_id);
                        const label = li ? `#${li.line_index} ${li.description}` : "Line";
                        return (
                          <div key={l.id} style={{ fontSize: 12, color: C.textSub, lineHeight: 1.4 }}>
                            <span style={{ color: C.textMuted }}>{label}:</span> {l.notes}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          );
        })}
      </div>

      <RfqMessageThread rfqId={rfqId} />
    </div>
  );
}

interface RfqMessage {
  id: string;
  sender_type: string;
  sender_name: string;
  body: string;
  created_at: string;
}

// Internal-side RFQ message thread. Lets the buyer reviewing this RFQ read
// vendor messages and reply. Talks to /api/internal/rfqs/:id/messages (the
// rfq_messages table is service-role only). Internal replies right-aligned,
// vendor messages left-aligned.
function RfqMessageThread({ rfqId }: { rfqId: string }) {
  const [messages, setMessages] = useState<RfqMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/rfqs/${rfqId}/messages`);
      if (!r.ok) throw new Error(await r.text());
      setMessages((await r.json()) as RfqMessage[]);
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
      const r = await fetch(`/api/internal/rfqs/${rfqId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, sender_name: "Ring of Fire" }),
      });
      if (!r.ok) throw new Error(await r.text());
      setDraft("");
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); }
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, marginTop: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 14, fontWeight: 700 }}>Messages</div>
      <div style={{ maxHeight: 320, overflowY: "auto", padding: "12px 16px" }}>
        {loading ? (
          <div style={{ color: C.textMuted, fontSize: 13 }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: C.textMuted, fontSize: 13, textAlign: "center", padding: "30px 0" }}>No messages yet. Reply to a vendor or start the conversation below.</div>
        ) : messages.map((m) => {
          const mine = m.sender_type === "internal";
          return (
            <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
              <div style={{ maxWidth: "78%", background: mine ? C.primary : C.bg, color: C.text, border: `1px solid ${mine ? C.primary : C.cardBdr}`, borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>
                <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, opacity: 0.85, color: mine ? "rgba(255,255,255,0.9)" : C.textMuted }}>
                  {m.sender_name} · {m.sender_type === "vendor" ? "Vendor" : "Ring of Fire"}
                </div>
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{m.body}</div>
                <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>{new Date(m.created_at).toLocaleString()}</div>
              </div>
            </div>
          );
        })}
      </div>
      {err && <div style={{ padding: "6px 16px", color: C.danger, fontSize: 12 }}>{err}</div>}
      <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.cardBdr}`, display: "flex", gap: 8 }}>
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          placeholder="Reply to the vendor… (⌘/Ctrl+Enter to send)"
          style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
        />
        <button onClick={() => void send()} disabled={sending || !draft.trim()} style={{ ...btnPrimary, opacity: sending || !draft.trim() ? 0.5 : 1, cursor: sending || !draft.trim() ? "not-allowed" : "pointer" }}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function statusColor(s: string) {
  if (s === "awarded") return C.success;
  if (s === "submitted" || s === "under_review") return C.primary;
  if (s === "rejected") return C.danger;
  return C.textSub;
}

const btnPrimary = { padding: "6px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const selectSt = { padding: "5px 8px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 12 } as const;
