// QuickAddPartyModal — on-the-fly "+ New customer / + New vendor" popup used from
// the Sales Order, Purchase Order and AR Invoice entry windows (operator item 1).
// Opens over the current entry window; on Save it creates the master record and
// hands the new row back via onCreated() so the caller can select it inline and
// keep working — no navigating away to the master screen.
//
// Only Name is required (codes are server-generated). The handful of optional
// fields cover the common "I need to capture them now" case; full master details
// can be filled later on the Customer/Vendor Master screen.

import { useRef, useState } from "react";

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", danger: "#EF4444",
};
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };

/** Minimal shape the callers need back: id + display name + code. The endpoints
 *  return the full master row, so callers can cast to their own type. */
export interface QuickAddedParty {
  id: string;
  name: string;
  customer_code?: string;
  code?: string;
  [k: string]: unknown;
}

export interface QuickAddPartyModalProps {
  kind: "customer" | "vendor";
  initialName?: string;
  onClose: () => void;
  onCreated: (row: QuickAddedParty) => void;
}

export default function QuickAddPartyModal({ kind, initialName = "", onClose, onCreated }: QuickAddPartyModalProps) {
  const isCustomer = kind === "customer";
  const endpoint = isCustomer ? "/api/internal/customer-master" : "/api/internal/vendor-master";
  const title = isCustomer ? "Add customer" : "Add vendor";

  const [name, setName] = useState(initialName);
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [website, setWebsite] = useState("");
  // Item 21 — a customer added on the fly must capture a ship-to address, because
  // a Sales Order can't proceed without one. Required for customers only.
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postal, setPostal] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // If the customer was created but the ship-to POST failed, we keep the created
  // row here so a retry only re-sends the location (never a duplicate customer).
  const createdRef = useRef<QuickAddedParty | null>(null);

  async function save() {
    if (!name.trim()) { setErr("Name is required."); return; }
    if (isCustomer && (!line1.trim() || !city.trim())) {
      setErr("Ship-to address (street + city) is required to use this customer on a sales order.");
      return;
    }
    setSaving(true); setErr(null);
    try {
      // Both master endpoints accept name (required) + email/phone/country/website.
      // The contact-name column differs: customers use `contact_name`, vendors use
      // `contact`. Skip re-creating the party if a prior attempt already did.
      let party = createdRef.current;
      if (!party) {
        const body: Record<string, unknown> = {
          name: name.trim(),
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          country: country.trim() || undefined,
          website: website.trim() || undefined,
        };
        if (contactName.trim()) body[isCustomer ? "contact_name" : "contact"] = contactName.trim();
        const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        party = j as QuickAddedParty;
        createdRef.current = party;
      }
      // Create the customer's default ship-to location so the SO can select it.
      if (isCustomer) {
        const loc = await fetch("/api/internal/customer-locations", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customer_id: party.id,
            name: "Ship-to",
            location_type: "store",
            is_default: true,
            address: {
              line1: line1.trim(),
              line2: line2.trim() || undefined,
              city: city.trim(),
              state: state.trim() || undefined,
              postal: postal.trim() || undefined,
              country: country.trim() || undefined,
            },
          }),
        });
        if (!loc.ok) throw new Error((await loc.json().catch(() => ({}))).error || `Ship-to address failed (HTTP ${loc.status})`);
      }
      onCreated(party);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div
      onClick={(e) => { e.stopPropagation(); if (!saving) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <div style={{ padding: 20, paddingBottom: 12 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{title}</h3>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 16 }}>
            {isCustomer ? "The customer code" : "The vendor code"} is assigned automatically. Add more details later on the master screen.
          </div>

          <label style={{ display: "block", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Name *</div>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={saving}
              style={{ ...inputStyle, borderColor: !name.trim() ? C.danger : C.cardBdr }}
              placeholder={isCustomer ? "customer / company name" : "vendor / supplier name"}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <label>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Contact name</div>
              <input value={contactName} onChange={(e) => setContactName(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
            </label>
            <label>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Email</div>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={saving} style={inputStyle} placeholder="name@company.com" />
            </label>
            <label>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Phone</div>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
            </label>
            <label>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Country</div>
              <input value={country} onChange={(e) => setCountry(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
            </label>
          </div>

          <label style={{ display: "block" }}>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Website</div>
            <input value={website} onChange={(e) => setWebsite(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
          </label>

          {/* Item 21 — ship-to address (customers only; required — a sales order
              can't proceed without one). Saved as the customer's default location. */}
          {isCustomer && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${C.cardBdr}` }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Ship-to address *</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>
                Required — a sales order needs a ship-to. Saved as this customer's default location; refine it later on the Customer Master.
              </div>
              <label style={{ display: "block", marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Street address *</div>
                <input value={line1} onChange={(e) => setLine1(e.target.value)} disabled={saving}
                  style={{ ...inputStyle, borderColor: !line1.trim() ? C.danger : C.cardBdr }} placeholder="street, building" />
              </label>
              <label style={{ display: "block", marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Address line 2</div>
                <input value={line2} onChange={(e) => setLine2(e.target.value)} disabled={saving} style={inputStyle} placeholder="suite, floor (optional)" />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
                <label>
                  <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>City *</div>
                  <input value={city} onChange={(e) => setCity(e.target.value)} disabled={saving}
                    style={{ ...inputStyle, borderColor: !city.trim() ? C.danger : C.cardBdr }} placeholder="city" />
                </label>
                <label>
                  <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>State / region</div>
                  <input value={state} onChange={(e) => setState(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
                </label>
                <label>
                  <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Postal</div>
                  <input value={postal} onChange={(e) => setPostal(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
                </label>
              </div>
            </div>
          )}

          {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 13 }}>{err}</div>}
        </div>

        {/* Frozen Save/Cancel footer. */}
        <div style={{ position: "sticky", bottom: 0, background: C.card, borderTop: `1px solid ${C.cardBdr}`, padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={btnSecondary}>Cancel</button>
          {(() => {
            const incomplete = !name.trim() || (isCustomer && (!line1.trim() || !city.trim()));
            return (
              <button onClick={() => void save()} disabled={saving || incomplete} style={{ ...btnPrimary, opacity: saving || incomplete ? 0.6 : 1 }}>
                {saving ? "Saving…" : title}
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
