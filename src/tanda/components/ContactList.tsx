// src/tanda/components/ContactList.tsx
//
// Repeatable multi-contact editor backing a jsonb `contacts` array column
// (customers.contacts — up to 12; factor_master.contacts — up to 3). Each
// contact is a plain object; the visible fields are configurable per caller
// (customers carry a Department, factors do not). Nothing is shown until the
// caller seeds a row or the user clicks "+ Add contact", so a record with no
// extra contacts stays compact.
//
// Email fields render with a mailto affordance (operator ask — click to send
// an email) that activates as soon as the address looks valid.

import React from "react";
import { formatUsPhone } from "../../shared/phone";

export type Contact = {
  id?: string;          // stable per-contact key (for customer_contact_notes)
  name?: string;
  email?: string;
  phone?: string;
  title?: string;
  department?: string;
  [k: string]: unknown;
};

export type ContactField = "name" | "email" | "phone" | "title" | "department";

const C = { cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8", primary: "#3B82F6", danger: "#EF4444" };
const input: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box",
};
const FIELD_META: Record<ContactField, { placeholder: string; type: string }> = {
  name:       { placeholder: "Name",       type: "text" },
  email:      { placeholder: "Email",      type: "email" },
  phone:      { placeholder: "Phone",      type: "text" },
  title:      { placeholder: "Title",      type: "text" },
  department: { placeholder: "Department", type: "text" },
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function ContactList({
  label, value, onChange, max, fields,
}: {
  label: string;
  value: Contact[];
  onChange: (next: Contact[]) => void;
  /** Hard cap on the number of contacts. */
  max: number;
  /** Which fields each contact row shows, in order. */
  fields: ContactField[];
}) {
  const list = Array.isArray(value) ? value : [];

  const setField = (i: number, k: ContactField, val: string) => {
    const clean = k === "phone" ? formatUsPhone(val) : val;
    const next = list.map((c, idx) => (idx === i ? { ...c, [k]: clean } : c));
    onChange(next);
  };
  const addContact = () => { if (list.length < max) onChange([...list, {}]); };
  const removeContact = (i: number) => onChange(list.filter((_, idx) => idx !== i));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {label}{list.length > 0 ? ` (${list.length}/${max})` : ""}
        </div>
        {list.length < max && (
          <button type="button" onClick={addContact}
            style={{ background: "transparent", border: `1px solid ${C.cardBdr}`, color: C.primary, borderRadius: 4, padding: "3px 10px", fontSize: 12, cursor: "pointer" }}>
            + Add contact
          </button>
        )}
      </div>
      {list.length === 0 && (
        <div style={{ fontSize: 12, color: C.textMuted, fontStyle: "italic" }}>No additional contacts. Click “+ Add contact”.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.map((c, i) => (
          <div key={i} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 8, position: "relative" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: C.textMuted }}>Contact {i + 1}</span>
              <button type="button" onClick={() => removeContact(i)} title="Remove contact"
                style={{ background: "transparent", border: 0, color: C.danger, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 4px" }}>×</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {fields.map((f) => {
                const val = String(c[f] ?? "");
                const isEmail = f === "email";
                const mailOk = isEmail && EMAIL_RE.test(val.trim());
                return (
                  <div key={f} style={{ position: "relative", display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type={FIELD_META[f].type}
                      value={val}
                      placeholder={FIELD_META[f].placeholder}
                      onChange={(e) => setField(i, f, e.target.value)}
                      style={{ ...input, ...(isEmail ? { paddingRight: 30 } : {}) }}
                    />
                    {isEmail && (
                      <a
                        href={mailOk ? `mailto:${val.trim()}` : undefined}
                        title={mailOk ? `Email ${val.trim()}` : "Enter a valid email to enable"}
                        onClick={(e) => { if (!mailOk) e.preventDefault(); }}
                        style={{
                          position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                          textDecoration: "none", fontSize: 14, lineHeight: 1,
                          color: mailOk ? C.primary : C.textMuted, cursor: mailOk ? "pointer" : "default",
                        }}
                      >Email</a>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
