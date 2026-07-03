// Cross-cutter T4-3 — "Set as my landing page" button.
//
// Small (~h-7) button that takes a menu_key and persists it as the
// operator's home_route preference. The actual auto-landing redirect
// lives in T4-4; this chunk only writes the preference.
//
// States:
//   • disabled "✓ Your landing page" — when current home_route matches
//   • "🏠 Set as landing page" — clickable, untouched
//   • brief "Saved ✓" toast for 1.6s after a successful PUT

import { useState } from "react";
import { usePersonalization } from "../hooks/usePersonalization";

interface SetAsHomeButtonProps {
  menuKey: string;
  /** Optional className override (default: small pill). */
  className?: string;
}

export default function SetAsHomeButton({ menuKey, className }: SetAsHomeButtonProps) {
  const { homeRoute, setHomeRoute } = usePersonalization();
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const isCurrent = homeRoute === menuKey;
  const showSaved = savedAt !== null && Date.now() - savedAt < 1600;

  async function onClick() {
    if (isCurrent || busy) return;
    setBusy(true);
    try {
      await setHomeRoute(menuKey);
      setSavedAt(Date.now());
      // Clear the savedAt flag so the label flips back to the
      // "✓ Your landing page" disabled state after the toast window.
      setTimeout(() => setSavedAt(null), 1700);
    } catch {
      // Hook already rolled back; stay quiet for now.
    } finally {
      setBusy(false);
    }
  }

  const label = isCurrent
    ? "✓ Your landing page"
    : showSaved
      ? "Saved ✓"
      : "Set as landing page";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isCurrent || busy}
      aria-label={isCurrent ? "Current landing page" : "Set as landing page"}
      title={isCurrent ? "This is your current landing page" : "Make this view open by default"}
      className={className}
      style={{
        height: 28,
        padding: "0 10px",
        fontSize: 12,
        fontWeight: 500,
        borderRadius: 6,
        border: "1px solid #334155",
        background: isCurrent ? "#1E293B" : "#0F172A",
        color: isCurrent ? "#94A3B8" : "#CBD5E1",
        cursor: isCurrent || busy ? "default" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        opacity: busy ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}
