// Cross-cutter T4-4 — Auto-landing redirect toast.
//
// Tiny bottom-right toast that shows "Welcome back — landing on {label}…"
// when useAutoLanding() decides to redirect. Visible for ~2s before
// fading out via CSS opacity transition. After that the toast unmounts.
//
// Why visible? Operators have asked to know WHY their click on /tanda
// suddenly redirected to /tanda?view=ar_invoices. A 2-second confirmation
// is the lightest-weight way to make the behaviour discoverable without
// blocking the actual landing.
//
// Usage from an app shell:
//
//   const landing = useAutoLanding();
//   return (
//     <>
//       …app chrome…
//       <AutoLandingToast landing={landing} />
//     </>
//   );

import { useEffect, useState } from "react";

import type { UseAutoLandingResult } from "../hooks/useAutoLanding";

export interface AutoLandingToastProps {
  /** Result of useAutoLanding(); the toast only renders when
   *  `landing.redirecting === true`. */
  landing: UseAutoLandingResult;
  /** Override visible duration in ms. Default 2000. Tests pass a smaller
   *  value or use fake timers. */
  durationMs?: number;
}

// Slate palette — matches Tanda chrome + FavoritesDrawer.
const C = {
  bg:     "#1E293B",
  border: "#334155",
  text:   "#F1F5F9",
  accent: "#3B82F6",
};

export default function AutoLandingToast({
  landing,
  durationMs = 2000,
}: AutoLandingToastProps) {
  const [visible, setVisible] = useState(false);
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    if (!landing.redirecting) return;
    setVisible(true);
    setFaded(false);
    // Start fade slightly before the page actually navigates away —
    // ~200ms of fade is enough to feel snappy.
    const fadeAt = Math.max(0, durationMs - 200);
    const fadeId = setTimeout(() => setFaded(true), fadeAt);
    const hideId = setTimeout(() => {
      setVisible(false);
      setFaded(false);
    }, durationMs);
    return () => {
      clearTimeout(fadeId);
      clearTimeout(hideId);
    };
  }, [landing.redirecting, durationMs]);

  if (!visible) return null;
  if (!landing.redirectLabel) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="auto-landing-toast"
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 9999,
        background: C.bg,
        color: C.text,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 13,
        fontWeight: 500,
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
        opacity: faded ? 0 : 1,
        transition: "opacity 200ms ease-out",
        display: "flex",
        alignItems: "center",
        gap: 8,
        maxWidth: 360,
      }}
    >
      <span aria-hidden="true" style={{ color: C.accent, fontSize: 16 }}>↻</span>
      <span>
        Welcome back — landing on <strong>{landing.redirectLabel}</strong>…
      </span>
    </div>
  );
}
