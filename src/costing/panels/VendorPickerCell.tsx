// VendorPickerCell — autocomplete for vendors (used in VendorQuotePanel).
//
// Same shape as StylePickerCell but hits /api/internal/costing/search/vendors.

import React, { useEffect, useRef, useState } from "react";
import { useVendorSearch } from "../hooks/useStyleSearch";
import { addVendor } from "../services/costingApi";
import { useCostingStore } from "../store/costingStore";
import type { VendorHit } from "../services/costingApi";

interface Props {
  value: string | null;
  onPick: (vendor: VendorHit) => void;
  placeholder?: string;
  inputStyle?: React.CSSProperties;
}

export default function VendorPickerCell({ value, onPick, placeholder, inputStyle }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value || "");
  const [adding, setAdding] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { rows, loading, search } = useVendorSearch();
  const setNotice = useCostingStore((s) => s.setNotice);

  const canAdd = text.trim().length > 0 && !loading && !rows.some((r) => (r.legal_name || r.code || "").toLowerCase() === text.trim().toLowerCase());

  const onInlineAdd = async () => {
    const name = text.trim();
    if (!name) return;
    setAdding(true);
    try {
      const created = await addVendor(name);
      setText(created.legal_name || created.code || "");
      setOpen(false);
      onPick(created);
      setNotice(`Added new vendor "${name}"`, "info");
    } catch (e) {
      setNotice(`Could not add vendor: ${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  useEffect(() => { setText(value || ""); }, [value]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={text}
        placeholder={placeholder || "Type vendor name…"}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          search(v);
          setOpen(true);
        }}
        onFocus={() => { if (text) { search(text); setOpen(true); } }}
        style={{
          width: "100%", padding: "5px 8px", fontSize: 12,
          background: "#0F172A", color: "#E2E8F0",
          border: "1px solid #334155", borderRadius: 4, outline: "none",
          ...inputStyle,
        }}
      />
      {open && (rows.length > 0 || loading) && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 50,
          minWidth: 280, maxHeight: 280, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          marginTop: 2,
        }}>
          {loading && <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>Searching…</div>}
          {rows.map((v) => (
            <button
              key={v.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setText(v.legal_name || v.code || "");
                setOpen(false);
                onPick(v);
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
              <div style={{ fontWeight: 600 }}>{v.legal_name || v.code || v.id}</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>
                {v.code ? `${v.code}` : ""}
                {v.country ? ` · ${v.country}` : ""}
                {v.default_currency ? ` · ${v.default_currency}` : ""}
              </div>
            </button>
          ))}
          {!loading && rows.length === 0 && text && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>No matches.</div>
          )}
          {canAdd && (
            <button
              type="button"
              disabled={adding}
              onMouseDown={(e) => { e.preventDefault(); onInlineAdd(); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 10px", background: "#0F172A",
                border: "none", color: "#10B981", cursor: adding ? "wait" : "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >{adding ? "Adding…" : `+ Add new vendor "${text.trim()}"`}</button>
          )}
        </div>
      )}
    </div>
  );
}
