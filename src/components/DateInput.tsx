import React, { useRef, useState, useEffect } from "react";
import { TH } from "../utils/theme";

// ─── DATE INPUT (click anywhere opens picker) ────────────────────────────────
export function DateInput({ value, onChange, onBlur, style, disabled, min }: {
  value?: string;
  onChange?: (v: string) => void;
  onBlur?: (v: string) => void;
  style?: React.CSSProperties;
  disabled?: boolean;
  min?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={ref}
      type="date"
      value={value || ""}
      min={min}
      onChange={(e) => onChange && onChange(e.target.value)}
      onBlur={(e) => onBlur && onBlur(e.target.value)}
      disabled={disabled}
      onClick={() => {
        if (disabled || !ref.current) return;
        try {
          (ref.current as any).showPicker();
        } catch (e) {}
      }}
      style={{ ...style, cursor: disabled ? "default" : "pointer" }}
    />
  );
}

// ─── LEAD TIME CELL ──────────────────────────────────────────────────────────
export function LeadTimeCell({ value, onCommit }: {
  value: number;
  onCommit: (n: number) => void;
}) {
  const [local, setLocal] = useState(String(value ?? ""));
  useEffect(() => { setLocal(String(value ?? "")); }, [value]);
  return (
    <input
      type="number"
      min="0"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={() => {
        const n = parseInt(local);
        if (!isNaN(n) && n >= 0) onCommit(n);
        else setLocal(String(value ?? ""));
      }}
      style={{ width: 75, padding: "5px 8px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "#fff", color: TH.text, fontFamily: "inherit", fontSize: 13, textAlign: "center", outline: "none" }}
    />
  );
}

export default DateInput;
