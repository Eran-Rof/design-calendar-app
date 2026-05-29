// Cross-cutter T4-3 — Star/unstar a menu item.
//
// Small icon button that toggles `menuKey` in the operator's favorites
// via the shared usePersonalization hook. Used inside each app's nav
// (next to the active view label) and inside settings list rows.
//
// The button is intentionally unstyled-looking — it inherits the parent
// container's color and only swaps the glyph (★ vs ☆). It's deliberately
// not a full-fat button with chrome because every nav row is dense and
// the star should disappear into the layout.

import { useState } from "react";
import { usePersonalization } from "../hooks/usePersonalization";

interface FavoriteStarProps {
  menuKey: string;
  /** Render size in px. Default 14. */
  size?: number;
  /** Optional className for extra spacing/positioning. */
  className?: string;
}

export default function FavoriteStar({ menuKey, size = 14, className }: FavoriteStarProps) {
  const { favorites, toggleFavorite } = usePersonalization();
  const [busy, setBusy] = useState(false);
  const isFav = favorites.includes(menuKey);

  async function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await toggleFavorite(menuKey);
    } catch {
      // Hook already rolled back. We could surface a toast here once
      // an app-wide toast bus is wired (T4-4); for now stay silent.
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={isFav}
      title={isFav ? "Remove from favorites" : "Add to favorites"}
      className={className}
      style={{
        background: "transparent",
        border: "none",
        padding: 2,
        cursor: busy ? "wait" : "pointer",
        color: isFav ? "#F59E0B" : "#94A3B8",
        fontSize: size,
        lineHeight: 1,
        opacity: busy ? 0.6 : 1,
      }}
    >
      {isFav ? "★" : "☆"}
    </button>
  );
}
