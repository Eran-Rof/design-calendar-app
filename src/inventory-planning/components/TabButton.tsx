// Tab-style toggle button used by every planning workbench's
// header strip. Was duplicated byte-for-byte across the wholesale,
// ecom, accuracy, and supply-reconciliation workbenches.

import type { ReactNode } from "react";
import { PAL } from "./styles";

export function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick}
            style={{
              background: active ? PAL.panel : "transparent",
              border: `1px solid ${active ? PAL.accent : PAL.border}`,
              color: active ? PAL.text : PAL.textDim,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}>
      {children}
    </button>
  );
}
