import React, { useEffect } from "react";
import { TH } from "../utils/theme";

function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: any[];
  onClose: () => void;
}) {
  useEffect(() => {
    const h = () => onClose();
    window.addEventListener("click", h);
    window.addEventListener("scroll", h, true);
    return () => {
      window.removeEventListener("click", h);
      window.removeEventListener("scroll", h, true);
    };
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed",
        left: x,
        top: y,
        background: TH.surface,
        border: `1px solid ${TH.border}`,
        borderRadius: 10,
        padding: "6px 0",
        zIndex: 3000,
        minWidth: 180,
        boxShadow: `0 16px 40px ${TH.shadowMd}`,
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={onClose}
    >
      {items.map((item, i) =>
        item === "---" ? (
          <div
            key={i}
            style={{ height: 1, background: TH.border, margin: "4px 0" }}
          />
        ) : (
          <button
            key={i}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "9px 16px",
              background: "none",
              border: "none",
              color: item.danger ? "#B91C1C" : TH.text,
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "inherit",
              textAlign: "left",
            }}
            onMouseEnter={(e) => ((e.target as HTMLElement).style.background = TH.surfaceHi)}
            onMouseLeave={(e) => ((e.target as HTMLElement).style.background = "none")}
          >
            {item.icon} {item.label}
          </button>
        )
      )}
    </div>
  );
}

export default ContextMenu;
