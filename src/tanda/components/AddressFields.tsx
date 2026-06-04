// src/tanda/components/AddressFields.tsx
//
// Structured address editor backing a jsonb column (vendors.address,
// customers.billing_address / shipping_address). Far friendlier than a raw-JSON
// textarea. The value is a plain object { line1, line2, city, state,
// postal_code, country }; unknown keys on the incoming value are preserved.

export type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  [k: string]: unknown;
};

const C = { cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8" };
const input: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box",
};

export default function AddressFields({
  label, value, onChange,
}: {
  label: string;
  value: Address;
  onChange: (next: Address) => void;
}) {
  const v = value || {};
  const set = (k: string, val: string) => onChange({ ...v, [k]: val });
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input style={{ ...input, gridColumn: "1 / -1" }} placeholder="Street address" value={String(v.line1 ?? "")} onChange={(e) => set("line1", e.target.value)} />
        <input style={{ ...input, gridColumn: "1 / -1" }} placeholder="Suite / unit (optional)" value={String(v.line2 ?? "")} onChange={(e) => set("line2", e.target.value)} />
        <input style={input} placeholder="City" value={String(v.city ?? "")} onChange={(e) => set("city", e.target.value)} />
        <input style={input} placeholder="State / province" value={String(v.state ?? "")} onChange={(e) => set("state", e.target.value)} />
        <input style={input} placeholder="Postal code" value={String(v.postal_code ?? "")} onChange={(e) => set("postal_code", e.target.value)} />
        <input style={input} placeholder="Country" value={String(v.country ?? "")} onChange={(e) => set("country", e.target.value)} />
      </div>
    </div>
  );
}
