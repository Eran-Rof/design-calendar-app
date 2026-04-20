import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface Preferences {
  preferred_currency: string;
  preferred_payment_method: "ach" | "wire" | "virtual_card" | "check" | "paypal" | "wise";
  fx_handling: "pay_in_vendor_currency" | "pay_in_usd_vendor_absorbs" | "pay_in_usd_we_absorb";
  updated_at?: string;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const METHODS: { value: Preferences["preferred_payment_method"]; label: string }[] = [
  { value: "ach",          label: "ACH (US bank transfer)" },
  { value: "wire",         label: "Wire transfer" },
  { value: "virtual_card", label: "Virtual card" },
  { value: "check",        label: "Check / cheque" },
  { value: "paypal",       label: "PayPal" },
  { value: "wise",         label: "Wise" },
];
const FX_HANDLING: { value: Preferences["fx_handling"]; label: string; description: string }[] = [
  { value: "pay_in_vendor_currency",    label: "Pay me in my local currency", description: "The buyer converts USD to my currency and covers the FX fee." },
  { value: "pay_in_usd_vendor_absorbs", label: "Pay in USD — I absorb FX",    description: "I receive USD and handle the conversion on my end." },
  { value: "pay_in_usd_we_absorb",      label: "Pay in USD — buyer absorbs FX", description: "Buyer pays in USD; any bank-side FX fee is deducted from my payout." },
];

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}
async function api(path: string, init: RequestInit = {}) {
  const t = await token();
  return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
}

export default function VendorPaymentPreferences() {
  const [prefs, setPrefs] = useState<Preferences>({
    preferred_currency: "USD",
    preferred_payment_method: "ach",
    fx_handling: "pay_in_usd_vendor_absorbs",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await api("/api/vendor/payment-preferences");
        if (!r.ok) throw new Error(await r.text());
        const d = await r.json() as Preferences | null;
        if (d) { setPrefs({ preferred_currency: d.preferred_currency, preferred_payment_method: d.preferred_payment_method, fx_handling: d.fx_handling }); setLastSaved(d.updated_at || null); }
      } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  async function save() {
    setSaving(true); setMsg(null); setErr(null);
    try {
      const r = await api("/api/vendor/payment-preferences", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      if (!r.ok) throw new Error(await r.text());
      setMsg("Preferences saved.");
      setLastSaved(new Date().toISOString());
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  if (loading) return <div style={{ color: C.textMuted, padding: 20 }}>Loading…</div>;

  return (
    <div style={{ color: C.text, padding: 20, maxWidth: 720 }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>Payment preferences</h2>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, marginBottom: 16 }}>
        How your buyer should send you money. Applied to all future payments; existing in-flight payments aren't affected.
      </div>

      {err && <div style={{ color: C.danger, marginBottom: 10 }}>{err}</div>}
      {msg && <div style={{ color: C.success, marginBottom: 10 }}>{msg}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 16 }}>
        <Row label="Preferred currency (ISO 4217)">
          <input value={prefs.preferred_currency} onChange={(e) => setPrefs({ ...prefs, preferred_currency: e.target.value.toUpperCase().slice(0, 3) })} maxLength={3} style={{ ...inp, maxWidth: 100 }} />
        </Row>

        <Row label="Preferred payment method">
          <select value={prefs.preferred_payment_method} onChange={(e) => setPrefs({ ...prefs, preferred_payment_method: e.target.value as Preferences["preferred_payment_method"] })} style={inp}>
            {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Row>

        <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 6, marginTop: 10 }}>FX handling</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {FX_HANDLING.map((m) => (
            <label key={m.value} style={{ padding: 10, background: C.bg, border: `1px solid ${prefs.fx_handling === m.value ? C.primary : C.cardBdr}`, borderRadius: 6, cursor: "pointer" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <input type="radio" checked={prefs.fx_handling === m.value} onChange={() => setPrefs({ ...prefs, fx_handling: m.value })} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{m.description}</div>
                </div>
              </div>
            </label>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 14 }}>
          <div style={{ fontSize: 11, color: C.textMuted }}>{lastSaved ? `Last saved ${new Date(lastSaved).toLocaleString()}` : "Not saved yet."}</div>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save preferences"}</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
