// SalesRepPickerCell — autocomplete cell for picking the costing project's
// sales rep. Hits /api/internal/costing/search/sales-reps (ILIKE on
// display_name + email).
//
// The previous freeform text input was rejected by the API because
// sales_rep_id expects a sales_reps.id UUID — typing anything else (alpha
// or numeric) failed autosave with "invalid input syntax for uuid".

import React, { useEffect, useRef, useState } from "react";
import { searchSalesReps, type SalesRepHit } from "../services/costingApi";

interface Props {
  /** Display label for the currently-selected rep (display_name), or null. */
  value: string | null;
  /** Called when the operator picks a rep from the dropdown. */
  onPick: (rep: SalesRepHit) => void;
  /** Called when the operator clears the field (delete to empty). */
  onClear?: () => void;
  placeholder?: string;
  inputStyle?: React.CSSProperties;
}

export default function SalesRepPickerCell({ value, onPick, onClear, placeholder, inputStyle }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value || "");
  const [rows, setRows] = useState<SalesRepHit[]>([]);
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
        const out = await searchSalesReps(text, controller.signal);
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
        placeholder={placeholder || "Type rep name or email…"}
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
          minWidth: 280, maxHeight: 260, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          marginTop: 2,
        }}>
          {loading && <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>Searching…</div>}
          {!loading && rows.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>
              {text ? `No reps match "${text}".` : "Type to search reps…"}
            </div>
          )}
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setText(r.display_name || r.email || "");
                setOpen(false);
                onPick(r);
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
              <div style={{ fontWeight: 600 }}>{r.display_name || "(no name)"}</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>
                {r.email || ""}
                {typeof r.default_commission_pct === "number" ? ` · ${r.default_commission_pct}%` : ""}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
