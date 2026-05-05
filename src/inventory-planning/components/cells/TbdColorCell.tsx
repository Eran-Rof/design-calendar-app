// Editable color cell on TBD rows. Click → popover with searchable
// list of every color used by any style in the same category, plus a
// free-text input for brand-new colors.
//
// "isNew" semantics: a typed color is flagged NEW only when it's not
// in `allKnownColorsLower` (every color seen anywhere in the current
// run). Picking a sibling-style color in the same category clears
// the flag immediately. Picking a string nothing else uses sets the
// flag, surfaces an orange "NEW" badge, and stays until the master
// catches up.

import { useEffect, useMemo, useRef, useState } from "react";
import { S, PAL } from "../styles";

export function TbdColorCell({
  value, isNewColor, isNewForStyle, knownColors, allKnownColorsLower, masterColorsLower, onSave,
  blocked, onBlocked,
}: {
  value: string;
  // Truly new — color isn't in the item master at all. Orange badge.
  isNewColor: boolean;
  // New for THIS style — color exists in the master for some other
  // style but not for this row's style. Green badge. Mutually
  // exclusive with isNewColor (the call site only sets one).
  isNewForStyle: boolean;
  knownColors: string[];
  allKnownColorsLower: Set<string>;
  // Master-known colors (lowercased). Used to flag dropdown options
  // with the orange NEW badge when they're not in the master —
  // lets the planner reuse a color they typed earlier on a
  // different row without re-typing it as new.
  masterColorsLower?: Set<string>;
  onSave: (color: string, isNew: boolean) => Promise<void>;
  // When true, clicking the trigger fires onBlocked instead of
  // opening the picker. Used to lock color edits to the first row
  // of a NEW style — see WholesalePlanningGrid's render call site.
  blocked?: boolean;
  onBlocked?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  // Always offer TBD as the first option so the planner can revert
  // to the catch-all stock-buy slot after picking a real color. We
  // de-dupe in case knownColors happens to contain "TBD" already.
  const optionList = useMemo(() => {
    const out: string[] = ["TBD"];
    for (const c of knownColors) {
      if (c.toLowerCase() !== "tbd") out.push(c);
    }
    return out;
  }, [knownColors]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return optionList;
    // Search-on-type: include any option whose name contains the
    // query (case-insensitive). The picker scope is already the
    // category + TBD, so the planner sees every relevant option
    // after a few keystrokes.
    return optionList.filter((c) => c.toLowerCase().includes(q));
  }, [query, optionList]);
  const queryTrim = query.trim();
  // The query is "new" when no master color anywhere matches it.
  // Picking a category sibling's color (already in allKnownColorsLower)
  // is NOT new even if it isn't on the current style yet. The literal
  // "TBD" is the canonical placeholder — never flagged as new.
  const queryIsNew = queryTrim.length > 0
    && queryTrim.toLowerCase() !== "tbd"
    && !allKnownColorsLower.has(queryTrim.toLowerCase());

  async function commit(color: string, isNew: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(color, isNew);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  // Trigger: shows current color + (NEW) badge or (TBD) hint.
  const isPlaceholder = value === "TBD";
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        onClick={() => {
          if (blocked) { onBlocked?.(); return; }
          setOpen((v) => !v);
        }}
        style={{
          background: isPlaceholder
            ? `${PAL.textMuted}22`
            : (isNewColor ? `${PAL.yellow}22` : (isNewForStyle ? `${PAL.green}22` : "transparent")),
          border: `1px solid ${isNewColor ? PAL.yellow : (isNewForStyle ? PAL.green : (isPlaceholder ? PAL.textMuted : PAL.border))}`,
          color: isNewColor ? PAL.yellow : (isNewForStyle ? PAL.green : (isPlaceholder ? PAL.textMuted : PAL.text)),
          borderRadius: 6,
          padding: "3px 8px",
          fontSize: 12,
          cursor: blocked ? "not-allowed" : "pointer",
          fontFamily: "inherit",
          textAlign: "left" as const,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
        title={isNewColor
          ? "New color — not in the item master at all. Will auto-clear when the master gains this color."
          : (isNewForStyle
            ? "New for this style — color exists in the master for other styles, but not yet for this one."
            : (isPlaceholder ? "Click to assign a color" : "Click to change color"))}
      >
        <span>{value}</span>
        {isNewColor && (
          <span style={{ background: PAL.yellow, color: "#000", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700 }}>NEW</span>
        )}
        {!isNewColor && isNewForStyle && (
          <span style={{ background: PAL.green, color: "#000", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700 }}>NEW</span>
        )}
        <span style={{ color: PAL.textMuted, fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 60,
            background: PAL.panel,
            border: `1px solid ${PAL.border}`,
            borderRadius: 8,
            minWidth: 240,
            maxHeight: 320,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ padding: 8, borderBottom: `1px solid ${PAL.borderFaint}`, position: "sticky", top: 0, background: PAL.panel }}>
            <input
              autoFocus
              type="text"
              placeholder="Type to search or add new color…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && queryIsNew) { e.preventDefault(); void commit(queryTrim, true); }
              }}
              style={{ ...S.input, width: "100%" }}
            />
            <div style={{ marginTop: 4, fontSize: 10, color: PAL.textMuted, lineHeight: 1.4 }}>
              {knownColors.length === 0
                ? "No known colors in this category yet — type one to add a NEW color."
                : "Pick any color used in this category, or type a new one (flagged NEW until the master catches up)."}
            </div>
          </div>
          {filtered.length === 0 && !queryIsNew && (
            <div style={{ padding: 12, color: PAL.textMuted, fontSize: 12 }}>No matches</div>
          )}
          {filtered.map((c) => {
            const cLower = c.toLowerCase();
            const optionIsNew = c !== "TBD"
              && cLower !== "tbd"
              && !!masterColorsLower
              && !masterColorsLower.has(cLower);
            // Picking an existing planner-typed color should keep
            // the NEW flag set (so the row's badge stays accurate
            // until the master picks up the color).
            const commitIsNew = optionIsNew;
            return (
              <div
                key={c}
                role="option"
                tabIndex={0}
                onClick={() => commit(c, commitIsNew)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(c, commitIsNew); } }}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                  color: c === value ? PAL.accent : (optionIsNew ? PAL.yellow : PAL.text),
                  background: c === value ? `${PAL.accent}11` : (optionIsNew ? `${PAL.yellow}11` : undefined),
                  fontWeight: c === value ? 600 : undefined,
                  borderBottom: `1px solid ${PAL.borderFaint}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ flex: 1 }}>{c}</span>
                {optionIsNew && (
                  <span style={{ background: PAL.yellow, color: "#000", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700 }}>NEW</span>
                )}
              </div>
            );
          })}
          {queryIsNew && (
            <div
              role="option"
              tabIndex={0}
              onClick={() => commit(queryTrim, true)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(queryTrim, true); } }}
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
              }}
              title="This color isn't in the item master yet — it'll be flagged NEW until a future build sees it."
            >
              <span>Add as NEW color:</span>
              <strong>{queryTrim}</strong>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
