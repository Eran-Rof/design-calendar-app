import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface Fx {
  from_currency: string; to_currency: string;
  from_amount: number; to_amount: number;
  fx_rate: number; fx_fee_amount: number;
  fx_provider: string | null; status: string;
}
interface Payment {
  id: string;
  amount: number; currency: string; method: string; status: string;
  reference: string | null;
  initiated_at: string; completed_at: string | null;
  metadata: Record<string, unknown> | null;
  invoice?: { id: string; invoice_number: string; total: number } | null;
  fx: Fx | null;
}
interface Card {
  id: string; card_number_last4: string; expiry_month: number; expiry_year: number;
  credit_limit: number; amount_spent: number; status: string;
  issued_at: string;
  invoice?: { id: string; invoice_number: string; total: number } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

async function token() { const { data: { session } } = await supabaseVendor.auth.getSession(); return session?.access_token || ""; }

export default function VendorPayments() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true); setErr(null);
      try {
        const t = await token();
        const r = await fetch("/api/vendor/payments", { headers: { Authorization: `Bearer ${t}` } });
        if (!r.ok) throw new Error(await r.text());
        const d = await r.json() as { payments: Payment[]; virtual_cards: Card[] };
        setPayments(d.payments || []); setCards(d.virtual_cards || []);
      } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  return (
    <div style={{ color: C.text, padding: 20 }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>Payments</h2>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, marginBottom: 16 }}>Your recent payments, FX conversions, and virtual cards.</div>

      {err && <div style={{ color: C.danger, marginBottom: 10 }}>{err}</div>}
      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
        <>
          <h3 style={{ fontSize: 15, margin: "0 0 8px", color: C.textSub }}>Recent payments ({payments.length})</h3>
          {payments.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, marginBottom: 18 }}>No payments yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
              {payments.map((p) => (
                <div key={p.id} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{p.currency} {Number(p.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>
                        {p.invoice ? `Invoice ${p.invoice.invoice_number} · ` : ""}
                        {p.method.toUpperCase()} · {new Date(p.initiated_at).toLocaleDateString()}
                        {p.reference ? ` · ${p.reference}` : ""}
                      </div>
                    </div>
                    <StatusChip status={p.status} />
                  </div>

                  {p.fx && (
                    <div style={{ marginTop: 8, padding: 8, background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6, fontSize: 11 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>FX conversion</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                        <FxMini label="From" value={`${p.fx.from_currency} ${Number(p.fx.from_amount).toLocaleString()}`} />
                        <FxMini label="To"   value={`${p.fx.to_currency} ${Number(p.fx.to_amount).toLocaleString()}`} />
                        <FxMini label="Rate" value={Number(p.fx.fx_rate).toFixed(6)} />
                        <FxMini label="FX fee" value={`${p.fx.to_currency} ${Number(p.fx.fx_fee_amount).toFixed(2)}`} color={C.warn} />
                      </div>
                      <div style={{ color: C.textMuted, fontSize: 10, marginTop: 4 }}>Provider: {p.fx.fx_provider || "—"} · status {p.fx.status}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <h3 style={{ fontSize: 15, margin: "0 0 8px", color: C.textSub }}>Virtual cards ({cards.length})</h3>
          {cards.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No virtual cards issued to you.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
              {cards.map((cd) => (
                <div key={cd.id} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <div style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>•••• {cd.card_number_last4}</div>
                    <StatusChip status={cd.status} />
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Exp {String(cd.expiry_month).padStart(2, "0")}/{cd.expiry_year}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
                    <FxMini label="Limit" value={`$${Number(cd.credit_limit).toLocaleString()}`} />
                    <FxMini label="Remaining" value={`$${(Number(cd.credit_limit) - Number(cd.amount_spent)).toLocaleString()}`} color={C.success} />
                  </div>
                  {cd.invoice && <div style={{ fontSize: 10, color: C.textSub, marginTop: 6 }}>Invoice {cd.invoice.invoice_number}</div>}
                </div>
              ))}
            </div>
          )}
          {cards.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 11, color: C.textMuted, textAlign: "right" }}>
              <a href="/vendor/virtual-cards" style={{ color: C.primary, textDecoration: "none" }}>Manage all virtual cards →</a>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = ["completed", "active", "paid"].includes(status) ? C.success
    : ["failed", "cancelled", "expired", "rejected"].includes(status) ? C.danger
    : status === "processing" ? C.warn : C.primary;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status}</span>;
}

function FxMini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2, color: color || C.text }}>{value}</div>
    </div>
  );
}
