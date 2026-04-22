import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface Card {
  id: string;
  card_number_last4: string;
  expiry_month: number;
  expiry_year: number;
  credit_limit: number;
  amount_spent: number;
  status: "active" | "spent" | "cancelled" | "expired";
  provider: string;
  issued_at: string;
  expires_at: string;
  invoice?: { id: string; invoice_number: string; total: number } | null;
}
interface Reveal {
  card_number: string;
  cvv: string;
  card_number_last4: string;
  expiry_month: number;
  expiry_year: number;
  credit_limit: number;
  warning: string;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

async function token() { const { data: { session } } = await supabaseVendor.auth.getSession(); return session?.access_token || ""; }
async function api(path: string, init: RequestInit = {}) { const t = await token(); return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } }); }

export default function VendorVirtualCards() {
  const [rows, setRows] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [revealErr, setRevealErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api("/api/vendor/virtual-cards");
      if (!r.ok) throw new Error(await r.text());
      setRows(((await r.json()) as { rows: Card[] }).rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function doReveal(cardId: string) {
    setRevealingId(cardId); setReveal(null); setRevealErr(null);
    const r = await api(`/api/vendor/virtual-cards/${cardId}/reveal`);
    if (!r.ok) { setRevealErr(await r.text()); return; }
    setReveal(await r.json() as Reveal);
  }

  async function confirmSpent(cardId: string) {
    if (!confirm("Mark this card as fully spent? Use this when you've charged the card for the full amount.")) return;
    const r = await api(`/api/vendor/virtual-cards/${cardId}/confirm-spent`, { method: "POST" });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  return (
    <div style={{ color: C.text, padding: 20 }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>Virtual cards</h2>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, marginBottom: 16 }}>
        Use a virtual card to be paid immediately on an approved invoice. Full card details are available for 24 hours after issuance.
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No virtual cards yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {rows.map((cd) => {
            const revealWindowOpen = Date.now() - new Date(cd.issued_at).getTime() <= 24 * 60 * 60 * 1000 && cd.status === "active";
            const remaining = Number(cd.credit_limit) - Number(cd.amount_spent);
            return (
              <div key={cd.id} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderLeft: `4px solid ${cd.status === "active" ? C.success : cd.status === "cancelled" ? C.danger : C.textMuted}`, borderRadius: 8, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>•••• •••• •••• {cd.card_number_last4}</div>
                  <StatusChip status={cd.status} />
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                  Exp {String(cd.expiry_month).padStart(2, "0")}/{cd.expiry_year} · {cd.provider} · issued {new Date(cd.issued_at).toLocaleDateString()}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 10 }}>
                  <Mini label="Limit" value={`$${Number(cd.credit_limit).toLocaleString()}`} />
                  <Mini label="Spent" value={`$${Number(cd.amount_spent).toLocaleString()}`} color={C.warn} />
                  <Mini label="Remaining" value={`$${remaining.toLocaleString()}`} color={C.success} />
                </div>
                {cd.invoice && <div style={{ fontSize: 11, color: C.textSub, marginTop: 8 }}>Invoice: {cd.invoice.invoice_number}</div>}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
                  {revealWindowOpen && <button onClick={() => void doReveal(cd.id)} style={btnSecondary}>Reveal details</button>}
                  {cd.status === "active" && <button onClick={() => void confirmSpent(cd.id)} style={btnPrimary}>Mark spent</button>}
                </div>
                {revealingId === cd.id && (reveal || revealErr) && (
                  <div style={{ marginTop: 10, padding: 10, background: C.bg, border: `1px solid ${reveal ? C.success : C.danger}`, borderRadius: 6, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                    {revealErr ? <span style={{ color: C.danger }}>{revealErr}</span> : reveal && (
                      <>
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.warn, textTransform: "uppercase", marginBottom: 6 }}>⚠ {reveal.warning}</div>
                        <div>Number: <strong>{reveal.card_number}</strong></div>
                        <div>CVV: <strong>{reveal.cvv}</strong></div>
                        <div>Exp: {String(reveal.expiry_month).padStart(2, "0")}/{reveal.expiry_year}</div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = status === "active" ? C.success : status === "spent" ? C.primary : status === "cancelled" || status === "expired" ? C.danger : C.textSub;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status}</span>;
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: 8, background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2, color: color || C.text }}>{value}</div>
    </div>
  );
}

const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
