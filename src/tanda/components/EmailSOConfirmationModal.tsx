// EmailSOConfirmationModal — email a Sales Order confirmation to a customer
// contact (operator item 7). Pick a contact (or type an address), optionally
// attach the order's supporting documents (choose which when there's more than
// one), add an optional note, and send. POSTs the SO's email-confirmation endpoint
// which builds the branded HTML confirmation server-side + attaches the chosen docs.

import { useEffect, useMemo, useState } from "react";
import { notify } from "../../shared/ui/warn";

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const lbl: React.CSSProperties = { fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 };

export interface SOContact { name?: string; email?: string; title?: string }
export interface SODoc { id: string; title?: string; kind?: string; original_filename?: string }

export interface EmailSOConfirmationModalProps {
  soId: string;
  soNumber: string | null;
  customerName: string;
  contacts: SOContact[];
  /** Pre-selected recipient (the buyer on the order). Falls back to the first
   *  contact with an email, then manual entry. */
  defaultEmail?: string;
  onClose: () => void;
  onSent: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function EmailSOConfirmationModal({ soId, soNumber, customerName, contacts, defaultEmail, onClose, onSent }: EmailSOConfirmationModalProps) {
  // Contacts that actually have an email; "" = type one manually.
  const emailContacts = useMemo(() => contacts.filter((c) => c.email && EMAIL_RE.test(c.email)), [contacts]);
  // Default to the order's buyer when it's a known contact; else the first
  // contact; else manual entry.
  const initialPick = (defaultEmail && emailContacts.some((c) => c.email === defaultEmail))
    ? defaultEmail
    : (emailContacts[0]?.email || "__manual__");
  const [pick, setPick] = useState<string>(initialPick);
  const [manualEmail, setManualEmail] = useState(
    initialPick === "__manual__" && defaultEmail && EMAIL_RE.test(defaultEmail) ? defaultEmail : "",
  );
  const toEmail = pick === "__manual__" ? manualEmail.trim() : pick;

  const [message, setMessage] = useState("");
  const [attach, setAttach] = useState(false);
  const [docs, setDocs] = useState<SODoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    fetch(`/api/internal/documents?context_table=sales_orders&context_id=${encodeURIComponent(soId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((arr) => {
        if (cancel) return;
        const list = (Array.isArray(arr) ? arr : []) as SODoc[];
        setDocs(list);
        setSelectedDocs(new Set(list.map((d) => d.id))); // default: all selected
      })
      .catch(() => { if (!cancel) setDocs([]); })
      .finally(() => { if (!cancel) setDocsLoading(false); });
    return () => { cancel = true; };
  }, [soId]);

  function toggleDoc(id: string) {
    setSelectedDocs((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function send() {
    if (!EMAIL_RE.test(toEmail)) { setErr("Enter a valid email address."); return; }
    setSending(true); setErr(null);
    try {
      const document_ids = attach ? docs.filter((d) => selectedDocs.has(d.id)).map((d) => d.id) : [];
      // Item 25 — mirror the order window's "Show images" toggle: when it's on,
      // the emailed confirmation embeds the style images too.
      let with_images = false;
      try { with_images = localStorage.getItem("tangerine:order:showImages") === "1"; } catch { /* ignore */ }
      const r = await fetch(`/api/internal/sales-orders/${soId}/email-confirmation`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_email: toEmail, message: message.trim() || undefined, document_ids, with_images }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(`Confirmation emailed to ${toEmail}${j.attachments ? ` with ${j.attachments} attachment${j.attachments === 1 ? "" : "s"}` : ""}.`, "success");
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }

  const docLabel = (d: SODoc) => d.title || d.original_filename || d.kind || "document";

  return (
    <div onClick={(e) => { e.stopPropagation(); if (!sending) onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(540px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <div style={{ padding: 20, paddingBottom: 12 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Email order confirmation</h3>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 16 }}>
            {soNumber || "(draft)"} · {customerName} — sends a branded confirmation to the chosen contact.
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Send to</div>
            <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={sending} style={{ ...inputStyle, cursor: "pointer" }}>
              {emailContacts.map((c, i) => (
                <option key={i} value={c.email}>{c.name ? `${c.name}${c.title ? ` (${c.title})` : ""} — ${c.email}` : c.email}</option>
              ))}
              <option value="__manual__">Type an email address…</option>
            </select>
            {pick === "__manual__" && (
              <input type="email" value={manualEmail} onChange={(e) => setManualEmail(e.target.value)} disabled={sending} placeholder="name@customer.com" style={{ ...inputStyle, marginTop: 6, borderColor: manualEmail && !EMAIL_RE.test(manualEmail) ? C.danger : C.cardBdr }} />
            )}
            {emailContacts.length === 0 && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>This customer has no contact emails on file — type one above (add contacts in Customer Master).</div>}
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Note (optional)</div>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} disabled={sending} rows={2} placeholder="A short message above the confirmation…" style={{ ...inputStyle, resize: "vertical" }} />
          </div>

          {/* Attach supporting documents — ask, then let the operator choose which. */}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.textSub, marginBottom: docs.length && attach ? 8 : 0 }}>
            <input type="checkbox" checked={attach} disabled={sending || docsLoading} onChange={(e) => setAttach(e.target.checked)} />
            Also attach the order's documents{docsLoading ? " (loading…)" : docs.length ? ` (${docs.length})` : " (none on this order)"}
          </label>
          {attach && docs.length > 0 && (
            <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: "6px 10px", background: "#0b1220" }}>
              {docs.length > 1 && <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4 }}>Select which to attach:</div>}
              {docs.map((d) => (
                <label key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.text, padding: "3px 0" }}>
                  <input type="checkbox" checked={selectedDocs.has(d.id)} disabled={sending} onChange={() => toggleDoc(d.id)} />
                  {docLabel(d)}{d.kind ? <span style={{ color: C.textMuted }}> · {d.kind}</span> : null}
                </label>
              ))}
            </div>
          )}

          {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 13 }}>{err}</div>}
        </div>

        <div style={{ position: "sticky", bottom: 0, background: C.card, borderTop: `1px solid ${C.cardBdr}`, padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={sending} style={btnSecondary}>Cancel</button>
          <button onClick={() => void send()} disabled={sending || !EMAIL_RE.test(toEmail) || (attach && selectedDocs.size === 0)} style={{ ...btnPrimary, opacity: sending || !EMAIL_RE.test(toEmail) ? 0.6 : 1 }}>
            {sending ? "Sending…" : "Send confirmation"}
          </button>
        </div>
      </div>
    </div>
  );
}
