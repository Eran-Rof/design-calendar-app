import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Custom popover calendar — no native <input type="date">, so no
 * browser-picker quirks. Click the field to open; click a day to commit;
 * use the arrow buttons to navigate months freely without committing.
 * Click outside to close without committing.
 */
export function MilestoneDateInput({ value, onCommit, style }: { value: string; onCommit: (v: string) => void; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [popPos, setPopPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const parsed = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T00:00:00") : null;
  const initialMonth = parsed ?? new Date();
  const [view, setView] = useState<{ y: number; m: number }>({ y: initialMonth.getFullYear(), m: initialMonth.getMonth() });

  useEffect(() => {
    if (open) {
      const base = parsed ?? new Date();
      setView({ y: base.getFullYear(), m: base.getMonth() });
      const rect = wrapRef.current?.getBoundingClientRect();
      if (rect) {
        const popWidth = 240;
        const popHeight = 260;
        let left = rect.left;
        let top = rect.bottom + 4;
        if (top + popHeight > window.innerHeight) top = Math.max(8, rect.top - popHeight - 4);
        if (left + popWidth > window.innerWidth) left = Math.max(8, window.innerWidth - popWidth - 8);
        setPopPos({ top, left });
      }
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (wrapRef.current && wrapRef.current.contains(t)) return;
      if (popRef.current && popRef.current.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const display = parsed
    ? `${String(parsed.getMonth() + 1).padStart(2, "0")}/${String(parsed.getDate()).padStart(2, "0")}/${parsed.getFullYear()}`
    : "—";

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const firstDay = new Date(view.y, view.m, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);

  const navMonth = (delta: number) => {
    let y = view.y, m = view.m + delta;
    while (m < 0) { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    y = Math.max(2020, Math.min(2035, y));
    setView({ y, m });
  };

  const cells: Array<{ d: number | null; iso: string | null }> = [];
  for (let i = 0; i < startWeekday; i++) cells.push({ d: null, iso: null });
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(view.y, view.m, d);
    cells.push({ d, iso: fmt(dt) });
  }
  while (cells.length % 7 !== 0) cells.push({ d: null, iso: null });

  const popStyle: React.CSSProperties = {
    position: "fixed",
    top: popPos.top,
    left: popPos.left,
    zIndex: 9999,
    background: "#0F172A",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: 8,
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    width: 240,
  };
  const headerBtn: React.CSSProperties = { background: "#1E293B", border: "1px solid #334155", color: "#9CA3AF", borderRadius: 4, width: 24, height: 24, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 };
  const dayCell = (selected: boolean, isToday: boolean): React.CSSProperties => ({
    width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", borderRadius: 4, fontSize: 11,
    background: selected ? "#3B82F6" : isToday ? "#1E293B" : "transparent",
    color: selected ? "#fff" : isToday ? "#60A5FA" : "#D1D5DB",
    border: isToday && !selected ? "1px solid #334155" : "1px solid transparent",
  });

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{ ...style, textAlign: "left", cursor: "pointer" } as React.CSSProperties}
      >
        {display}
      </button>
      {open && createPortal(
        <div ref={popRef} style={popStyle}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <button type="button" onClick={() => navMonth(-1)} style={headerBtn}>‹</button>
            <div style={{ color: "#D1D5DB", fontSize: 12, fontWeight: 600 }}>{monthNames[view.m]} {view.y}</div>
            <button type="button" onClick={() => navMonth(1)} style={headerBtn}>›</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
            {["S","M","T","W","T","F","S"].map((d, i) => (
              <div key={i} style={{ fontSize: 9, color: "#6B7280", textAlign: "center" }}>{d}</div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
            {cells.map((c, i) => {
              if (c.d === null) return <div key={i} />;
              const isSelected = c.iso === value;
              const dt = new Date(view.y, view.m, c.d!); dt.setHours(0,0,0,0);
              const isToday = dt.getTime() === today.getTime();
              return (
                <div
                  key={i}
                  style={dayCell(isSelected, isToday)}
                  onClick={() => {
                    setOpen(false);
                    if (c.iso && c.iso !== value) onCommit(c.iso);
                  }}
                >
                  {c.d}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, paddingTop: 6, borderTop: "1px solid #1E293B" }}>
            <button
              type="button"
              onClick={() => {
                const t = new Date();
                const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
                setOpen(false);
                if (iso !== value) onCommit(iso);
              }}
              style={{ background: "none", border: "1px solid #334155", color: "#60A5FA", fontSize: 10, cursor: "pointer", borderRadius: 4, padding: "3px 8px" }}
            >
              Today
            </button>
            {value && (
              <button
                type="button"
                onClick={() => { setOpen(false); onCommit(""); }}
                style={{ background: "none", border: "none", color: "#6B7280", fontSize: 10, cursor: "pointer" }}
              >
                Clear
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
