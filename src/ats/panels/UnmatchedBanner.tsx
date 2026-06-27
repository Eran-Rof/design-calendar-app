import React, { useEffect, useState } from "react";
import type { ATSRow } from "../types";

export interface UnmatchedBannerProps {
  unmatchedRows: ATSRow[];
  // True once the ATS load pipeline has settled — Excel data fetched,
  // master cache loaded, rows enriched. The banner uses this to defer
  // rendering until 200ms AFTER the signal flips true so the count
  // shown reflects the post-master-load state, not the transient
  // pre-load state where every row reads as unmatched.
  ready?: boolean;
}

export const UnmatchedBanner: React.FC<UnmatchedBannerProps> = ({ unmatchedRows, ready = true }) => {
  const [open, setOpen] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedSku, setCopiedSku] = useState<string | null>(null);
  // Local dismiss flag — banner stays gone for the rest of the session
  // but reappears on the next ATS load (= next upload, refresh, etc.).
  // Persisting the dismissal would risk hiding new unmatched SKUs that
  // appear on later uploads.
  const [dismissed, setDismissed] = useState(false);
  // Show only after a 200ms grace period beyond `ready=true`. If ready
  // flips back to false (e.g. a new upload kicks off a reload) we
  // immediately hide and re-arm the timer.
  const [postReady, setPostReady] = useState(false);
  useEffect(() => {
    if (!ready) { setPostReady(false); return; }
    const t = setTimeout(() => setPostReady(true), 200);
    return () => clearTimeout(t);
  }, [ready]);

  if (!postReady || unmatchedRows.length === 0 || dismissed) return null;

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
          <button
            onClick={() => setDismissed(true)}
            title="Dismiss this warning (will reappear on next upload)"
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(245,158,11,0.12)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            style={{
              width: 26,
              height: 26,
              border: "1px solid rgba(245,158,11,0.5)",
              color: "#F59E0B",
              background: "transparent",
              fontSize: 14,
              lineHeight: 1,
              cursor: "pointer",
              borderRadius: 4,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
            }}
          >
            ✕
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
