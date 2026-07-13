// Editable customer cell on TBD rows. Click → searchable customer
// list (the same list used by the toolbar's customer filter). Picking
// a real customer reassigns the TBD row to them; the row stays an
// is_tbd line until a future planning build absorbs it as a normal
// forecast row. The (Supply Only) placeholder stays as the default
// trigger style; reassigned rows show the customer name as-is.
//
// Typing a name not in the existing list surfaces an orange
// "Add as NEW customer:" footer — onAddNew handles the master
// insert + row reassignment. Falls through silently when no
// onAddNew is wired (the cell stays read-only-with-search).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { S, PAL } from "../styles";

export function TbdCustomerCell({
  value, isSupplyOnly, isNewCustomer, customers, newCustomerIds, onSave, onAddNew,
}: {
  value: string;
  isSupplyOnly: boolean;
  // Orange NEW badge when this customer was created via the
  // planning-app "Add as NEW customer" flow (persists in DB via
  // external_refs.planning_added until something else populates
  // upstream identifiers).
  isNewCustomer: boolean;
  customers: Array<{ id: string; name: string }>;
  // Set of customer IDs that should show a NEW badge in the
  // dropdown list — same flag as isNewCustomer but applied to
  // every option, not just the chosen one.
  newCustomerIds?: Set<string>;
  onSave: (customerId: string, customerName: string) => Promise<void>;
  onAddNew?: (customerName: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu renders in a portal on document.body with FIXED positioning so
  // the grid's horizontal-scroll overflow can't clip it (it was rendering
  // behind later rows). Position is anchored to the trigger's rect and
  // recomputed on scroll/resize; it flips above the cell when there's more
  // room up top (rows near the viewport bottom).
  const [menuPos, setMenuPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  useEffect(() => {
    if (!open) { setMenuPos(null); return; }
    function reposition() {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(160, Math.min(360, (openUp ? spaceAbove : spaceBelow) - 12));
      setMenuPos(openUp
        ? { left: r.left, bottom: window.innerHeight - r.top + 4, maxHeight }
        : { left: r.left, top: r.bottom + 4, maxHeight });
    }
    reposition();
    // Capture-phase scroll catches scrolling of the inner grid container too
    // (scroll events don't bubble), so the menu tracks the cell.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(q));
  }, [query, customers]);
  const queryTrim = query.trim();
  const queryIsNew = !!onAddNew
    && queryTrim.length > 0
    && !customers.some((c) => c.name.toLowerCase() === queryTrim.toLowerCase());

  async function commit(id: string, name: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(id, name);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }
  async function commitNew() {
    if (busy || !onAddNew || !queryIsNew) return;
    setBusy(true);
    try {
      await onAddNew(queryTrim);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: isSupplyOnly
            ? `${PAL.textMuted}22`
            : (isNewCustomer ? `${PAL.yellow}22` : "transparent"),
          border: `1px solid ${isNewCustomer ? PAL.yellow : (isSupplyOnly ? PAL.textMuted : PAL.border)}`,
          color: isNewCustomer ? PAL.yellow : (isSupplyOnly ? PAL.textMuted : PAL.text),
          borderRadius: 6,
          padding: "3px 8px",
          fontSize: 12,
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left" as const,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
        title={isNewCustomer
          ? "Customer added during this session — orange tag clears on page refresh."
          : (isSupplyOnly ? "Click to reassign this stock buy to a real customer" : "Click to change customer")}
      >
        <span>{value}</span>
        {isNewCustomer && (
          <span style={{ background: PAL.yellow, color: "#000", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700 }}>NEW</span>
        )}
        <span style={{ color: PAL.textMuted, fontSize: 9 }}>▾</span>
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: menuPos.top,
            bottom: menuPos.bottom,
            left: menuPos.left,
            zIndex: 4000,
            background: PAL.panel,
            border: `1px solid ${PAL.border}`,
            borderRadius: 8,
            minWidth: 260,
            maxHeight: menuPos.maxHeight,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ padding: 8, borderBottom: `1px solid ${PAL.borderFaint}`, position: "sticky", top: 0, background: PAL.panel }}>
            <input
              autoFocus
              type="text"
              placeholder={onAddNew ? "Search or add a new customer…" : "Search customers…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && queryIsNew) { e.preventDefault(); void commitNew(); }
              }}
              style={{ ...S.input, width: "100%" }}
            />
          </div>
          {filtered.length === 0 && !queryIsNew && (
            <div style={{ padding: 12, color: PAL.textMuted, fontSize: 12 }}>No matches</div>
          )}
          {filtered.map((c) => {
            const optionIsNew = !!newCustomerIds?.has(c.id);
            return (
              <div
                key={c.id}
                role="option"
                tabIndex={0}
                onClick={() => commit(c.id, c.name)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(c.id, c.name); } }}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                  color: c.name === value ? PAL.accent : (optionIsNew ? PAL.yellow : PAL.text),
                  background: c.name === value ? `${PAL.accent}11` : (optionIsNew ? `${PAL.yellow}11` : undefined),
                  fontWeight: c.name === value ? 600 : undefined,
                  borderBottom: `1px solid ${PAL.borderFaint}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ flex: 1 }}>{c.name}</span>
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
              onMouseDown={(e) => { e.preventDefault(); void commitNew(); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitNew(); } }}
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
              title="This customer isn't in the master yet — clicking will insert them and assign this row."
            >
              <span>Add as NEW customer:</span>
              <strong>{queryTrim}</strong>
              <span style={{ background: PAL.yellow, color: "#000", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700 }}>NEW</span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
