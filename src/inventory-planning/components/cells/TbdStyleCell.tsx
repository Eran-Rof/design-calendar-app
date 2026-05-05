// Editable style cell on TBD rows. Click → popover listing every
// style in the same item-master category plus a literal "TBD"
// option at the top so the planner can revert to the catch-all
// stock-buy slot. Picking a real style turns the row into that
// style's TBD line; picking "TBD" sends the qty to the catch-all
// (style=TBD, color=TBD) line for the period.
//
// Popover renders via React Portal anchored to the trigger via
// getBoundingClientRect — keeps it from being clipped by the grid's
// tableWrap (overflow:auto) ancestor.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { S, PAL } from "../styles";

export function TbdStyleCell({
  value, isNewStyle, categoryStyles, allKnownStylesLower, masterStylesLower, onSave,
}: {
  value: string;
  // Orange "NEW" badge when the row's style isn't in the item
  // master at all (matches the same-named flag on TbdColorCell).
  isNewStyle: boolean;
  categoryStyles: string[];
  // Master-wide style set (lowercased) used to decide whether a
  // typed query is brand-new vs already in another category.
  allKnownStylesLower: Set<string>;
  // Master-only style set (lowercased). Drives the per-option NEW
  // badge in the dropdown — a planner-added style still in
  // categoryStyles shows orange so the planner sees it can be
  // reused but is awaiting master sync.
  masterStylesLower?: Set<string>;
  onSave: (styleCode: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Anchor the popover to the trigger button using a portal so the
  // grid's tableWrap (overflow:auto) can't clip or out-stack it.
  const [anchor, setAnchor] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  useEffect(() => {
    if (!open) { setAnchor(null); return; }
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setAnchor({ top: r.bottom + 4, left: r.left, minWidth: Math.max(r.width, 240) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const optionList = useMemo(() => {
    const out: string[] = ["TBD"];
    for (const s of categoryStyles) {
      if (s.toLowerCase() !== "tbd") out.push(s);
    }
    return out;
  }, [categoryStyles]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return optionList;
    return optionList.filter((s) => s.toLowerCase().includes(q));
  }, [query, optionList]);
  const queryTrim = query.trim();
  // The query is "new" when no master style anywhere matches it
  // (case-insensitive). Picking a category sibling style from the
  // dropdown is NOT new even if it isn't on this row's category
  // yet. The literal "TBD" placeholder is never new.
  const queryIsNew = queryTrim.length > 0
    && queryTrim.toLowerCase() !== "tbd"
    && !allKnownStylesLower.has(queryTrim.toLowerCase());
  // Style-code sanitizer for the "Add as NEW" path: uppercase
  // alphanumeric only. Style codes are SKU prefixes (e.g.
  // "RYO0659") — symbols and lowercase letters break downstream
  // joins (item master, label batches, ATS lookups). Strip on
  // commit, not on input, so the planner can paste freely.
  const sanitizeStyleCode = (s: string): string =>
    s.toUpperCase().replace(/[^A-Z0-9]/g, "");

  async function commit(styleCode: string) {
    if (busy || styleCode === value) { setOpen(false); return; }
    setBusy(true);
    try {
      await onSave(styleCode);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const isPlaceholder = value === "TBD";
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: -9 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: isPlaceholder
            ? `${PAL.textMuted}22`
            : (isNewStyle ? `${PAL.yellow}22` : "transparent"),
          border: `1px solid ${isNewStyle ? PAL.yellow : (isPlaceholder ? PAL.textMuted : PAL.border)}`,
          color: isNewStyle ? PAL.yellow : (isPlaceholder ? PAL.textMuted : PAL.accent),
          borderRadius: 6,
          padding: "3px 8px",
          fontSize: 12,
          cursor: "pointer",
          fontFamily: "monospace",
          textAlign: "left" as const,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
        title={isNewStyle
          ? "New style — not yet in the item master. Will auto-clear when the master gains this style."
          : (isPlaceholder ? "Catch-all stock-buy slot — click to assign a style" : "Click to change style or revert to TBD")}
      >
        <span>{value}</span>
        {isNewStyle && (
          <span style={{ background: PAL.yellow, color: "#000", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700 }}>NEW</span>
        )}
        <span style={{ color: PAL.textMuted, fontSize: 9 }}>▾</span>
      </button>
      {open && anchor && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: "fixed",
            top: anchor.top,
            left: anchor.left,
            zIndex: 1000,
            background: PAL.panel,
            border: `1px solid ${PAL.border}`,
            borderRadius: 8,
            minWidth: anchor.minWidth,
            maxHeight: 360,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ padding: 8, borderBottom: `1px solid ${PAL.borderFaint}`, position: "sticky", top: 0, background: PAL.panel }}>
            <input
              autoFocus
              type="text"
              placeholder="Type to search or add new style…"
              value={query}
              onChange={(e) => setQuery(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && queryIsNew) { e.preventDefault(); void commit(sanitizeStyleCode(queryTrim)); }
              }}
              style={{ ...S.input, width: "100%", fontFamily: "monospace" }}
            />
            <div style={{ marginTop: 4, fontSize: 10, color: PAL.textMuted, lineHeight: 1.4 }}>
              {categoryStyles.length === 0
                ? "No styles in this category yet — type one to add a NEW style, or pick TBD to keep as a catch-all."
                : "Pick any style in this category, type a new one (flagged NEW until the master catches up), or TBD to revert."}
            </div>
          </div>
          {filtered.length === 0 && !queryIsNew && (
            <div style={{ padding: 12, color: PAL.textMuted, fontSize: 12 }}>No matches</div>
          )}
          {filtered.map((s) => {
            const sLower = s.toLowerCase();
            const optionIsNew = s !== "TBD"
              && sLower !== "tbd"
              && !!masterStylesLower
              && !masterStylesLower.has(sLower);
            return (
              <div
                key={s}
                role="option"
                tabIndex={0}
                onMouseDown={(e) => { e.preventDefault(); void commit(s); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(s); } }}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontFamily: "monospace",
                  fontSize: 13,
                  color: s === value ? PAL.accent : (s === "TBD" ? PAL.textMuted : (optionIsNew ? PAL.yellow : PAL.text)),
                  background: s === value ? `${PAL.accent}11` : (s === "TBD" ? `${PAL.textMuted}10` : (optionIsNew ? `${PAL.yellow}11` : undefined)),
                  fontWeight: s === value ? 600 : undefined,
                  borderBottom: `1px solid ${PAL.borderFaint}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ flex: 1 }}>{s}</span>
                {optionIsNew && (
                  <span style={{ background: PAL.yellow, color: "#000", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700, fontFamily: "inherit" }}>NEW</span>
                )}
              </div>
            );
          })}
          {queryIsNew && (
            <div
              role="option"
              tabIndex={0}
              onMouseDown={(e) => { e.preventDefault(); void commit(sanitizeStyleCode(queryTrim)); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(sanitizeStyleCode(queryTrim)); } }}
              style={{
                padding: "10px 12px",
                cursor: "pointer",
                fontSize: 13,
                color: PAL.yellow,
                background: `${PAL.yellow}11`,
                borderTop: filtered.length > 0 ? `1px solid ${PAL.borderFaint}` : undefined,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: "monospace",
              }}
              title="This style isn't in the item master yet — it'll be flagged NEW until a future build sees it."
            >
              <span style={{ fontFamily: "inherit" }}>Add as NEW style:</span>
              <strong>{queryTrim}</strong>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
