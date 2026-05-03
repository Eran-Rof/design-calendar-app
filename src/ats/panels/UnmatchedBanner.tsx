import React, { useState } from "react";
import type { ATSRow } from "../types";

export interface UnmatchedBannerProps {
  unmatchedRows: ATSRow[];
}

export const UnmatchedBanner: React.FC<UnmatchedBannerProps> = ({ unmatchedRows }) => {
  const [open, setOpen] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedSku, setCopiedSku] = useState<string | null>(null);

  if (unmatchedRows.length === 0) return null;

  const count = unmatchedRows.length;
  const styleWord = count === 1 ? "style" : "styles";

  const onCopyAll = () => {
    const text = unmatchedRows.map(r => r.sku).join("\n");
    navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  };

  const onCopyOne = (sku: string) => {
    navigator.clipboard.writeText(sku);
    setCopiedSku(sku);
    setTimeout(() => setCopiedSku(prev => (prev === sku ? null : prev)), 600);
  };

  return (
    <div style={{ background: "rgba(245,158,11,0.08)", borderBottom: "1px solid rgba(245,158,11,0.3)", padding: "12px 24px" }}>
      <div style={{ maxWidth: 1600, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 16, color: "#F59E0B" }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: "#F1F5F9", fontWeight: 600 }}>
              {count} {styleWord} not in item master — these rows are hidden from the grid
            </div>
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>
              These items can't be matched to ip_item_master. Add them to the planning Item Master Excel and re-upload, or fix the SKU in your inventory file.
            </div>
          </div>
          <button
            onClick={() => setOpen(o => !o)}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(245,158,11,0.12)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            style={{
              padding: "4px 10px",
              border: "1px solid rgba(245,158,11,0.5)",
              color: "#F59E0B",
              background: "transparent",
              fontSize: 11,
              cursor: "pointer",
              borderRadius: 4,
            }}
          >
            {open ? "Hide list ▲" : "View list ▼"}
          </button>
        </div>

        {open && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: "#94A3B8" }}>{count} unmatched SKUs:</span>
              <button
                onClick={onCopyAll}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(245,158,11,0.12)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                style={{
                  padding: "4px 10px",
                  border: "1px solid rgba(245,158,11,0.5)",
                  color: "#F59E0B",
                  background: "transparent",
                  fontSize: 11,
                  cursor: "pointer",
                  borderRadius: 4,
                }}
              >
                {copiedAll ? "✓ Copied" : "Copy all"}
              </button>
            </div>
            <div style={{ maxHeight: 240, overflowY: "auto", background: "#0F172A", borderRadius: 6, padding: "8px 12px", fontSize: 11, fontFamily: "monospace", color: "#E2E8F0" }}>
              {unmatchedRows.map((row, i) => {
                const highlighted = copiedSku === row.sku;
                return (
                  <div
                    key={`${row.sku}-${i}`}
                    onClick={() => onCopyOne(row.sku)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "3px 6px",
                      borderRadius: 4,
                      cursor: "pointer",
                      background: highlighted ? "rgba(16,185,129,0.18)" : "transparent",
                      transition: "background 0.15s",
                    }}
                  >
                    <span>{row.sku}</span>
                    <span style={{ fontSize: 10, color: "#64748B", padding: "1px 6px", border: "1px solid #334155", borderRadius: 3 }}>
                      {row.store ?? "ROF"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
