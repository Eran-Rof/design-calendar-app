// Editable description cell on TBD rows. Inline text input; commits
// on blur or Enter. Empty string clears the override (falls back to
// master description). Same hover affordances as the other Tbd cells.

import { useEffect, useMemo, useRef, useState } from "react";
import { S, PAL } from "../styles";

export function TbdDescriptionCell({
  value, isNew, knownDescriptions, masterDescriptionsLower, onSave,
}: {
  value: string;
  // Orange NEW badge when the description is a planner override
  // (the row's `notes` column is non-empty AND differs from master)
  // — same affordance pattern as the color / style cells.
  isNew: boolean;
  // Distinct descriptions used elsewhere in the run (master + TBD
  // overrides). Drives the dropdown list so the planner can reuse
  // a description they've typed before instead of retyping it.
  knownDescriptions: string[];
  // Master-known descriptions (lowercased). Used to flag dropdown
  // options with the orange NEW badge when they aren't in any
  // master row — same logic as the color/style cells.
  masterDescriptionsLower?: Set<string>;
  onSave: (description: string) => Promise<void>;
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
  // Prefill the search box with the current value when opening so
  // re-editing an existing description works inline. A blank prefill
  // looked like the description had vanished as soon as the picker
  // opened — the planner had to retype the whole string.
  useEffect(() => { if (open) setQuery(value); else setQuery(""); }, [open, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return knownDescriptions;
    return knownDescriptions.filter((d) => d.toLowerCase().includes(q));
  }, [query, knownDescriptions]);
  const queryTrim = query.trim();
  const queryMatchesValue = queryTrim.toLowerCase() === value.trim().toLowerCase();
  const queryIsNew = queryTrim.length > 0
    && !queryMatchesValue
    && !knownDescriptions.some((d) => d.toLowerCase() === queryTrim.toLowerCase());

  async function commit(description: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(description);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center", maxWidth: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={isNew
          ? "Planner-typed description (not in master). Click to edit."
          : (value ? "Click to change description" : "Click to add a description")}
        style={{
          background: isNew ? `${PAL.yellow}22` : "transparent",
          border: `1px solid ${isNew ? PAL.yellow : PAL.border}`,
          color: isNew ? PAL.yellow : (value ? PAL.textDim : PAL.textMuted),
          borderRadius: 6,
          padding: "3px 8px",
          fontSize: 12,
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left" as const,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          maxWidth: "100%",
          overflow: "hidden",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontStyle: value ? "normal" : "italic" }}>
          {value || "Click to add…"}
        </span>
        {isNew && (
          <span style={{ background: PAL.yellow, color: "#000", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700, flexShrink: 0 }}>NEW</span>
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
            minWidth: 280,
            maxHeight: 360,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ padding: 8, borderBottom: `1px solid ${PAL.borderFaint}`, position: "sticky", top: 0, background: PAL.panel }}>
            <input
              autoFocus
              type="text"
              placeholder="Type to search or add new description…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // Enter commits: the typed-but-known existing
                  // description, the typed new description, or
                  // — when the input is unchanged — close cleanly.
                  e.preventDefault();
                  if (queryIsNew) { void commit(queryTrim); return; }
                  const hit = knownDescriptions.find((d) => d.toLowerCase() === queryTrim.toLowerCase());
                  if (hit) { void commit(hit); return; }
                  setOpen(false);
                } else if (e.key === "Tab") {
                  // Tab cancels without committing. Without this the
                  // input loses focus, the picker stays open, and a
                  // subsequent stray Enter on a focused option div
                  // commits the empty Clear-description option —
                  // which then triggers the "change all 9 periods?"
                  // confirm modal even though the planner only meant
                  // to step out of the cell.
                  e.preventDefault();
                  setOpen(false);
                }
              }}
              onBlur={() => {
                // Defer the close so onMouseDown handlers on options
                // get a chance to fire first. If focus left because
                // the user clicked an option, the option's commit
                // already fired and setOpen(false) is a no-op.
                setTimeout(() => setOpen(false), 100);
              }}
              style={{ ...S.input, width: "100%" }}
            />
            <div style={{ marginTop: 4, fontSize: 10, color: PAL.textMuted, lineHeight: 1.4 }}>
              {knownDescriptions.length === 0
                ? "No descriptions yet — type one to add a NEW description."
                : "Pick any description used elsewhere, or type a new one (flagged NEW until the master catches up)."}
            </div>
          </div>
          {value && (
            <div
              role="option"
              tabIndex={0}
              onMouseDown={(e) => { e.preventDefault(); void commit(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(""); } }}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: 12,
                color: PAL.textMuted,
                fontStyle: "italic",
                borderBottom: `1px solid ${PAL.borderFaint}`,
              }}
              title="Clear the override and revert to the master style description (if any)."
            >
              Clear description
            </div>
          )}
          {filtered.length === 0 && !queryIsNew && (
            <div style={{ padding: 12, color: PAL.textMuted, fontSize: 12 }}>No matches</div>
          )}
          {filtered.map((d) => {
            const optionIsNew = !!masterDescriptionsLower && !masterDescriptionsLower.has(d.toLowerCase());
            return (
              <div
                key={d}
                role="option"
                tabIndex={0}
                onMouseDown={(e) => { e.preventDefault(); void commit(d); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(d); } }}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                  color: d === value ? PAL.accent : (optionIsNew ? PAL.yellow : PAL.text),
                  background: d === value ? `${PAL.accent}11` : (optionIsNew ? `${PAL.yellow}11` : undefined),
                  fontWeight: d === value ? 600 : undefined,
                  borderBottom: `1px solid ${PAL.borderFaint}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d}</span>
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
              onMouseDown={(e) => { e.preventDefault(); void commit(queryTrim); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(queryTrim); } }}
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
              title="This description isn't in any master row — flagged NEW until the master catches up."
            >
              <span>Add as NEW description:</span>
              <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{queryTrim}</strong>
              <span style={{ background: PAL.yellow, color: "#000", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700, flexShrink: 0 }}>NEW</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
