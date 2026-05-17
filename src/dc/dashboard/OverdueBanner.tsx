// Red warning strip shown above the stat cards when there are overdue
// tasks AND no stat filter is currently active. Self-contained:
// receives the overdue task list + a brand-resolver callback.

import { TH } from "../styles";
import type { Task, Brand } from "../../store/types";

export interface OverdueBannerProps {
  overdue: Task[];
  getBrand: (id: string) => Brand;
}

export function OverdueBanner({ overdue, getBrand }: OverdueBannerProps) {
  if (overdue.length === 0) return null;
  return (
    <div
      style={{
        background: "#FFF5F5",
        border: "1px solid #FEB2B2",
        borderLeft: `4px solid ${TH.primary}`,
        borderRadius: 10,
        padding: "12px 20px",
        marginBottom: 22,
        display: "flex",
        gap: 12,
        alignItems: "center",
      }}
    >
      <span>⚠️</span>
      <span style={{ color: "#B91C1C", fontSize: 13 }}>
        <strong>{overdue.length} overdue</strong> —{" "}
        {overdue
          .map((t) => `${(getBrand(t.brand) || {}).short || t.brand} ${t.phase}`)
          .join(", ")}
      </span>
    </div>
  );
}
