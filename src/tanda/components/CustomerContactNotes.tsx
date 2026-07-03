// CustomerContactNotes — timestamped notes (+ optional reminder) on one
// customer AP/Trans/CB contact (operator #12). Self-contained: loads its own
// notes for (customerId, contactId), lets the user add a note with an optional
// reminder. When the reminder is due, the contact-reminders cron notifies the
// author (the user who set it); the bell click deep-links back here.
import { useCallback, useEffect, useState } from "react";
import { getCachedAuthUserId, getCachedAuthUserName } from "../../utils/tangerineAuthUser";

type Note = {
  id: string;
  customer_id: string;
  contact_id: string;
  body: string;
  created_by_name: string | null;
  created_at: string;
  remind_at: string | null;
  reminder_sent: boolean;
};

const C = {
  card: "#0b1220", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8",
  textSub: "#CBD5E1", primary: "#3B82F6", warn: "#F59E0B", danger: "#EF4444",
};
const input: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark",
};
const btn: React.CSSProperties = {
  background: "#1E293B", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
function fmt(ts: string): string {
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch { return ts; }
}

export default function CustomerContactNotes({ customerId, contactId, highlightNoteId }: {
  customerId: string; contactId: string; highlightNoteId?: string | null;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/internal/customer-contact-notes?customer_id=${encodeURIComponent(customerId)}&contact_id=${encodeURIComponent(contactId)}`);
      const j = await r.json();
      if (r.ok) setNotes(Array.isArray(j) ? j : []);
    } catch { /* ignore */ }
  }, [customerId, contactId]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/internal/customer-contact-notes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id: customerId, contact_id: contactId, body: text,
          created_by_user_id: getCachedAuthUserId() || undefined,
          created_by_name: getCachedAuthUserName() || undefined,
          // datetime-local → ISO (local time interpreted by the browser).
          remind_at: remindAt ? new Date(remindAt).toISOString() : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setBody(""); setRemindAt("");
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function del(id: string) {
    try {
      await fetch(`/api/internal/customer-contact-notes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch { /* ignore */ }
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, marginTop: 6 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: notes.length ? 10 : 0 }}>
        {notes.map((n) => (
          <div key={n.id} style={{ display: "flex", gap: 8, alignItems: "flex-start",
            borderLeft: `2px solid ${n.id === highlightNoteId ? C.primary : C.cardBdr}`, paddingLeft: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: C.text, whiteSpace: "pre-wrap" }}>{n.body}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                {n.created_by_name || "—"} · {fmt(n.created_at)}
                {n.remind_at && (
                  <span style={{ color: n.reminder_sent ? C.textMuted : C.warn, marginLeft: 8 }}>
                    {fmt(n.remind_at)}{n.reminder_sent ? " (sent)" : ""}
                  </span>
                )}
              </div>
            </div>
            <button type="button" title="Delete note" onClick={() => void del(n.id)}
              style={{ ...btn, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" }}>✕</button>
          </div>
        ))}
      </div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Add a note…"
        style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
        <label style={{ fontSize: 11, color: C.textMuted }}>Remind me</label>
        <input type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} style={{ ...input, width: 200 }} />
        <button type="button" onClick={() => void add()} disabled={busy || !body.trim()}
          style={{ ...btn, color: C.primary, borderColor: C.primary, marginLeft: "auto" }}>
          {busy ? "…" : remindAt ? "Add note + reminder" : "Add note"}
        </button>
      </div>
      {err && <div style={{ color: C.danger, fontSize: 11, marginTop: 4 }}>{err}</div>}
    </div>
  );
}
