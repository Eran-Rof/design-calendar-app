// Shared browser-tab title hook for the PLM sub-apps.
//
// Every internal app (ATS, PO WIP, Tech Packs, Design Calendar, Costing,
// GS1, Planning) boots standalone via path-based routing in main.tsx, so the
// browser tab inherits the static <title>Design Calendar</title> from
// index.html and never changes as the user moves between views. This hook lets
// each app reflect its current page/view in the tab — mirroring the behavior
// Tangerine.tsx already has ("<module> · Tangerine") — so a wall of open tabs
// is identifiable at a glance.
//
// Callers compose the full string (e.g. `${label} · PO WIP`); the convention
// across the suite is "<current view> · <app name>".

import { useEffect } from "react";

/**
 * Title-case a snake_case / kebab-case view key as a fallback tab label,
 * e.g. "health_scores" -> "Health Scores". Callers override the handful of
 * keys this gets wrong (acronyms like RFQs / FX / ESG).
 */
export function humanizeView(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Sets document.title to the supplied string whenever it changes. Empty /
 * falsy values are ignored so a brief render gap can't blank the tab.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}
