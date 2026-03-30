import React from "react";
import S from "./styles";

export function StatCard({ icon, label, value, color, sortKey, activeSort, onSort, fmt, marginPct }: {
  icon: string; label: string; value: number; color: string;
  sortKey?: string; activeSort?: string | null; onSort?: (k: string | null) => void;
  fmt?: "dollar" | "margin"; marginPct?: number;
}) {
  const isActive = !!(sortKey && activeSort === sortKey);
  let display: string;
  if (fmt === "dollar") {
    display = value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value.toFixed(0)}`;
    if (value >= 1000000) display = `$${(value / 1000000).toFixed(2)}M`;
  } else if (fmt === "margin") {
    display = value >= 1000000 ? `$${(value / 1000000).toFixed(2)}M` : value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value.toFixed(0)}`;
  } else {
    display = value.toLocaleString();
  }
  return (
    <div
      style={{ ...S.statCard, borderTop: `2px solid ${color}`, cursor: sortKey ? "pointer" : "default",
        outline: isActive ? `2px solid ${color}` : "none", outlineOffset: -2,
        background: isActive ? `${color}18` : "#1E293B" }}
      onClick={() => sortKey && onSort && onSort(isActive ? null : sortKey)}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontSize: 11, color: "#9CA3AF", lineHeight: 1.3 }}>{label}</span>
        <span style={{ fontSize: 14, color, opacity: 0.7 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "monospace", marginTop: 4, lineHeight: 1.2 }}>
        {display}
      </div>
      {fmt === "margin" && marginPct != null && (
        <div style={{ fontSize: 11, color, opacity: 0.75, fontFamily: "monospace" }}>
          {(marginPct * 100).toFixed(1)}%
        </div>
      )}
    </div>
  );
}
