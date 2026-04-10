import React, { useState, useRef, useEffect } from "react";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";

// ─── FILTER BAR ─────────────────────────────────────────────────────────────
function FilterBar({
  brands, seasons, customers, vendors,
  filterBrand, setFilterBrand,
  filterSeason, setFilterSeason,
  filterCustomer, setFilterCustomer,
  filterVendor, setFilterVendor,
}) {
  const [open, setOpen] = useState(false);
  const [openSection, setOpenSection] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function toggle(set, val) {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val); else next.add(val);
      return next;
    });
  }

  const totalActive = filterBrand.size + filterSeason.size + filterCustomer.size + filterVendor.size;
  const hasActive = totalActive > 0;

  // Build active filter chips for display
  const activeChips = [
    ...[...filterBrand].map(id => ({ label: brands.find(b => b.id === id)?.name || id, clear: () => toggle(setFilterBrand, id) })),
    ...[...filterSeason].map(s => ({ label: s, clear: () => toggle(setFilterSeason, s) })),
    ...[...filterCustomer].map(c => ({ label: c, clear: () => toggle(setFilterCustomer, c) })),
    ...[...filterVendor].map(v => ({ label: v, clear: () => toggle(setFilterVendor, v) })),
  ];

  function renderSection(title, items, filterSet, setFilter, getKey, getLabel, getColor) {
    const isOpen = openSection === title;
    const activeCount = items.filter(i => filterSet.has(getKey(i))).length;
    return (
      <div key={title}>
        <button
          onClick={() => setOpenSection(isOpen ? null : title)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            width: "100%", padding: "9px 14px", border: "none",
            background: "none", color: activeCount > 0 ? "#fff" : "rgba(255,255,255,0.7)",
            cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: activeCount > 0 ? 700 : 500,
          }}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
          onMouseLeave={e => e.currentTarget.style.background = "none"}
        >
          <span>{title}{activeCount > 0 ? ` (${activeCount})` : ""}</span>
          <span style={{ opacity: 0.5, fontSize: 9 }}>{isOpen ? "▲" : "▼"}</span>
        </button>
        {isOpen && (
          <div style={{ paddingBottom: 4 }}>
            {items.map(i => {
              const key = getKey(i);
              const checked = filterSet.has(key);
              const color = getColor ? getColor(i) : null;
              return (
                <button
                  key={key}
                  onClick={() => toggle(setFilter, key)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%",
                    padding: "6px 14px 6px 28px", border: "none",
                    background: checked ? "rgba(200,33,10,0.12)" : "none",
                    color: checked ? "#fff" : "rgba(255,255,255,0.65)",
                    cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                    fontWeight: checked ? 600 : 400, textAlign: "left",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = checked ? "rgba(200,33,10,0.15)" : "rgba(255,255,255,0.06)"}
                  onMouseLeave={e => e.currentTarget.style.background = checked ? "rgba(200,33,10,0.12)" : "none"}
                >
                  {color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />}
                  {getLabel(i)}
                  {checked && <span style={{ marginLeft: "auto", color: "#C8210A", fontSize: 13 }}>✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const divider = <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "2px 0" }} />;

  return (
    <div style={{ padding: "3px 22px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", background: "rgba(15,23,42,0.85)", backdropFilter: "blur(8px)", position: "sticky", top: 64, zIndex: 99, minHeight: 32 }}>
      {/* Filters button */}
      <div ref={ref} style={{ position: "relative" }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            padding: "3px 10px", borderRadius: 6,
            border: `1px solid ${hasActive ? "rgba(200,33,10,0.6)" : "rgba(255,255,255,0.12)"}`,
            background: hasActive ? "rgba(200,33,10,0.15)" : "rgba(255,255,255,0.05)",
            color: hasActive ? "#fff" : "rgba(255,255,255,0.55)",
            cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 5,
          }}
        >
          ⚙ Filters
          {hasActive && (
            <span style={{ background: "#C8210A", color: "#fff", borderRadius: 10, fontSize: 9, padding: "1px 5px", fontWeight: 700 }}>
              {totalActive}
            </span>
          )}
        </button>
        {open && (
          <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, background: "#1A202C", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.45)", minWidth: 200, zIndex: 999, paddingBottom: 8 }}>
            {renderSection("Brand", brands, filterBrand, setFilterBrand, b => b.id, b => b.name, b => b.color)}
            {divider}
            {renderSection("Season", seasons, filterSeason, setFilterSeason, s => s, s => s, null)}
            {divider}
            {renderSection("Customer", customers.map(c => typeof c === "string" ? c : c.name), filterCustomer, setFilterCustomer, c => c, c => c, null)}
            {divider}
            {renderSection("Vendor", vendors.map(v => v.name), filterVendor, setFilterVendor, v => v, v => v, null)}
            {hasActive && (
              <div style={{ padding: "8px 14px 0", borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: 4 }}>
                <button
                  onClick={() => { setFilterBrand(new Set()); setFilterSeason(new Set()); setFilterCustomer(new Set()); setFilterVendor(new Set()); setOpen(false); }}
                  style={{ width: "100%", padding: "7px", borderRadius: 7, border: "1px solid rgba(255,255,255,0.15)", background: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}
                >
                  ✕ Clear All Filters
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Active filter chips */}
      {activeChips.map((chip, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 3, background: "rgba(200,33,10,0.18)", border: "1px solid rgba(200,33,10,0.35)", borderRadius: 20, padding: "2px 6px 2px 8px", fontSize: 10, color: "rgba(255,255,255,0.85)", fontWeight: 500 }}>
          {chip.label}
          <button onClick={chip.clear} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", padding: 0, fontSize: 11, lineHeight: 1, marginLeft: 1 }}>✕</button>
        </div>
      ))}
    </div>
  );
}


export default FilterBar;
