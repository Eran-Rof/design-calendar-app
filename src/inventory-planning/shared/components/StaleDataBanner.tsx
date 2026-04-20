// Lightweight banner surfaced at the top of a workbench when one of
// its dependent signals is stale. Severity picks the color; the banner
// stays dismissable in a session (localStorage) so it doesn't bully the
// planner every pageload.

import { useEffect, useMemo, useState } from "react";
import type { IpFreshnessSignal } from "../../admin/types/admin";
import { loadFreshnessSignals, signalFor } from "../../admin/services/dataFreshnessService";
import { PAL } from "../../components/styles";

const SEVERITY_COLOR: Record<string, string> = {
  info:     "#3B82F6",
  warning:  "#F59E0B",
  critical: "#EF4444",
};

export interface StaleDataBannerProps {
  // Which entity_type signals should flip this banner on?
  watch: string[];
  // Optional storage key so dismissals are per-surface.
  dismissKey?: string;
}

export default function StaleDataBanner({ watch, dismissKey }: StaleDataBannerProps) {
  const [signals, setSignals] = useState<IpFreshnessSignal[]>([]);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined" || !dismissKey) return false;
    return window.sessionStorage.getItem(`ip_banner_dismiss_${dismissKey}`) === "1";
  });

  useEffect(() => {
    let cancelled = false;
    loadFreshnessSignals().then((s) => { if (!cancelled) setSignals(s); });
    return () => { cancelled = true; };
  }, []);

  const issues = useMemo(() => {
    return watch
      .map((e) => signalFor(signals, e))
      .filter((s): s is IpFreshnessSignal => !!s && s.severity !== "fresh");
  }, [watch, signals]);

  if (dismissed || issues.length === 0) return null;

  // Highest severity wins for the banner color.
  const order = { info: 0, warning: 1, critical: 2, fresh: -1 } as const;
  const worst = [...issues].sort((a, b) => (order[b.severity as keyof typeof order]) - (order[a.severity as keyof typeof order]))[0];
  const color = SEVERITY_COLOR[worst.severity] ?? PAL.textMuted;

  function dismiss() {
    setDismissed(true);
    if (typeof window !== "undefined" && dismissKey) {
      window.sessionStorage.setItem(`ip_banner_dismiss_${dismissKey}`, "1");
    }
  }

  return (
    <div style={{
      background: color + "15",
      border: `1px solid ${color}`,
      borderRadius: 8,
      padding: "10px 14px",
      color,
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      marginBottom: 12,
      fontSize: 13,
    }}>
      <span style={{ fontSize: 16, lineHeight: 1 }}>{worst.severity === "critical" ? "⚠" : "ⓘ"}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, marginBottom: 2 }}>
          {worst.severity === "critical" ? "Critical: stale data" : "Data may be stale"}
        </div>
        <div style={{ color: PAL.textDim, fontSize: 12 }}>
          {issues.map((s) => (
            <span key={s.entity_type} style={{ marginRight: 12 }}>
              <code>{s.entity_type}</code> · {s.age_hours == null ? "never" : `${s.age_hours}h old`} (threshold {s.threshold_hours}h)
            </span>
          ))}
        </div>
      </div>
      <a href="/planning/admin" style={{ color, textDecoration: "underline", fontSize: 12 }}>Integration health →</a>
      <button onClick={dismiss}
              style={{ background: "transparent", border: `1px solid ${color}44`, color, borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 12 }}>
        Dismiss
      </button>
    </div>
  );
}
