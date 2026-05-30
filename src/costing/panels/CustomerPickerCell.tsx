// CustomerPickerCell — autocomplete cell for picking a costing project's
// customer. Hits /api/internal/costing/search/customers (ILIKE on code +
// billing_address->>name/company so operators can type either the code or
// part of the display name).
//
// Used in ProjectEditView's header form. Stores the customer's UUID on the
// project's customer_id field; the visible label is derived from
// billing_address.name → billing_address.company → code.

import React, { useEffect, useRef, useState } from "react";
import { searchCustomers, customerDisplayName, type CustomerHit } from "../services/costingApi";

interface Props {
  /** Display label for the currently-selected customer (name + code), or null. */
  value: string | null;
  /** Called when the operator picks a customer from the dropdown. */
  onPick: (customer: CustomerHit) => void;
  /** Called when the operator clears the field (delete key on empty input). */
  onClear?: () => void;
  placeholder?: string;
  inputStyle?: React.CSSProperties;
}

export default function CustomerPickerCell({ value, onPick, onClear, placeholder, inputStyle }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value || "");
  const [rows, setRows] = useState<CustomerHit[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setText(value || ""); }, [value]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const out = await searchCustomers(text, controller.signal);
        setRows(out);
      } catch { /* silent */ }
      finally { setLoading(false); }
    }, 200);
    return () => { window.clearTimeout(t); controller.abort(); };
  }, [text, open]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={text}
        placeholder={placeholder || "Type customer code or name…"}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          setOpen(true);
          if (v === "" && onClear) onClear();
        }}
        onFocus={() => setOpen(true)}
        style={{
          width: "100%", padding: "5px 8px", fontSize: 12,
          background: "#0F172A", color: "#E2E8F0",
          border: "1px solid #334155", borderRadius: 4, outline: "none",
          ...inputStyle,
        }}
      />
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 50,
          minWidth: 320, maxHeight: 280, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          marginTop: 2,
        }}>
          {loading && <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>Searching…</div>}
          {!loading && rows.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>
              {text ? `No customers match "${text}".` : "Type to search customers…"}
            </div>
          )}
          {rows.map((c) => {
            const display = customerDisplayName(c);
            return (
              <button
                key={c.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(display);
                  setOpen(false);
                  onPick(c);
                }}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "6px 10px", background: "transparent",
                  border: "none", borderBottom: "1px solid #334155",
                  color: "#E2E8F0", cursor: "pointer", fontSize: 12,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <div style={{ fontWeight: 600 }}>{display}</div>
                <div style={{ fontSize: 11, color: "#94A3B8" }}>
                  {c.code ? c.code : ""}
                  {c.customer_type ? ` · ${c.customer_type}` : ""}
                  {c.default_currency ? ` · ${c.default_currency}` : ""}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
