// LineStatusCell — per-line status pill + menu for the costing grid.
//
// Status is a STORED lifecycle (draft|sent|quoted|awarded|lost|revised|closed).
// The event-driven states (Sent, Quoted, Awarded, Lost, Revised) are read-only —
// the RFQ publish/submit/award handlers set them. The operator can only pick the
// manual states: Draft / Closed. Picking Closed is a deliberate terminal close;
// picking Draft resets the line to its starting state.

import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { usePopoverAnchor } from "../hooks/usePopoverAnchor";
import { effectiveLineStatus, stageLabel, stageIcon, stageColor } from "../hooks/usePlanFlow";
import type { CostingLine, CostingLineStatus } from "../types";

const MANUAL_OPTIONS: { value: CostingLineStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "closed", label: "Closed" },
];

interface Props {
  line: CostingLine;
  onChange: (next: CostingLineStatus) => void;
}

export default function LineStatusCell({ line, onChange }: Props) {
  const eff = effectiveLineStatus(line);
  const sc = stageColor(eff);
  // Event-driven (read-only) states: everything except the two manual ones.
  const isAuto = eff !== "draft" && eff !== "closed";

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const { anchorRef, pos } = usePopoverAnchor<HTMLButtonElement>({ open, minWidth: 180 });

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (v: CostingLineStatus) => { onChange(v); setOpen(false); };

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <button
        type="button"
        ref={anchorRef}
        onClick={() => setOpen((o) => !o)}
        title={isAuto ? `${stageLabel(eff)} (set automatically)` : "Click to set Draft / Closed"}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 4, cursor: "pointer",
          background: sc.bg, color: sc.fg, border: `1px solid ${sc.bar}`,
          borderRadius: 4, padding: "3px 8px", fontSize: 11, fontWeight: 700,
        }}
      >
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {stageIcon(eff)} {stageLabel(eff)}
        </span>
        <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
      </button>
      {open && pos && ReactDOM.createPortal(
        <div
          ref={popRef}
          style={{
            position: "fixed", left: pos.left, top: pos.top, width: pos.width,
            zIndex: 9999, background: "#1E293B", border: "1px solid #475569",
            borderRadius: 8, boxShadow: "0 8px 20px rgba(0,0,0,0.5)", padding: 4,
          }}
        >
          <div style={{ fontSize: 9, color: "#94A3B8", padding: "4px 8px", letterSpacing: ".06em", textTransform: "uppercase" }}>Set status</div>
          {MANUAL_OPTIONS.map((o) => {
            const osc = stageColor(o.value);
            const isCurrentManual = (line.status || "draft") === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => pick(o.value)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  background: isCurrentManual ? "#33415555" : "transparent", border: "none",
                  color: "#E2E8F0", padding: "6px 8px", fontSize: 12, cursor: "pointer", borderRadius: 4,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = isCurrentManual ? "#33415555" : "transparent"; }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 2, background: osc.bar }} />
                {stageIcon(o.value)} {o.label}
                {isCurrentManual && <span style={{ marginLeft: "auto", color: "#64748B", fontSize: 10 }}>✓</span>}
              </button>
            );
          })}
          {isAuto && (
            <div style={{ fontSize: 10, color: "#94A3B8", padding: "6px 8px", borderTop: "1px solid #334155", lineHeight: 1.4 }}>
              Currently <strong style={{ color: sc.fg }}>{stageLabel(eff)}</strong> — set automatically
              {eff === "awarded" ? " (vendor formally awarded via RFQ)."
                : eff === "lost" ? " (another vendor won this style)."
                : eff === "quoted" ? " (vendor submitted a quote)."
                : eff === "revised" ? " (revision sent to vendor)."
                : " (line is on an active RFQ)."}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
