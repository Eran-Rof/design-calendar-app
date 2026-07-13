// src/tanda/exports/IncomeStatementExportButton.tsx
//
// Export dropdown for the Income Statement panel. Mirrors the shared
// <ExportButton> look (dark menu, Excel / PDF) but emits the NetSuite-style
// STATEMENT (see incomeStatementExport.ts) instead of a flat grid dump.

import { useEffect, useRef, useState } from "react";
import {
  downloadIncomeStatementXlsx, printIncomeStatementPdf, type StatementModel,
} from "./incomeStatementExport";

const defaultBtn: React.CSSProperties = {
  background: "transparent", color: "#CBD5E1", border: "1px solid #334155",
  padding: "6px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12,
};
const menuStyle: React.CSSProperties = {
  position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 1000, minWidth: 168,
  background: "#1E293B", border: "1px solid #334155", borderRadius: 6,
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: 4, display: "flex", flexDirection: "column", gap: 2,
};
const menuItemStyle: React.CSSProperties = {
  background: "transparent", color: "#F1F5F9", border: "none", borderRadius: 4,
  padding: "7px 10px", fontSize: 12, textAlign: "left", cursor: "pointer", whiteSpace: "nowrap",
};

export default function IncomeStatementExportButton({
  model, filename, disabled,
}: {
  model: () => StatementModel;
  filename: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = async (fmt: "xlsx" | "pdf") => {
    setOpen(false);
    if (disabled) return;
    const m = model();
    if (fmt === "pdf") printIncomeStatementPdf(m);
    else await downloadIncomeStatementXlsx(m, filename);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ ...defaultBtn, opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
        title={disabled ? "No activity to export" : "Export the statement (Excel or PDF)"}
      >
        Export statement
        <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && !disabled && (
        <div role="menu" style={menuStyle}>
          <button type="button" role="menuitem" style={menuItemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#334155")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            onClick={() => void pick("xlsx")}>Excel (.xlsx)</button>
          <button type="button" role="menuitem" style={menuItemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#334155")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            onClick={() => void pick("pdf")}>PDF</button>
        </div>
      )}
    </div>
  );
}
