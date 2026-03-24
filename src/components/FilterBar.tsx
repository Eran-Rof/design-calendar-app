import React from "react";
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

  const Section = ({ title, items, filterSet, setFilter, getKey, getLabel, getColor }) => {
    const isOpen = openSection === title;
    const activeCount = items.filter(i => filterSet.has(getKey(i))).length;
    return (
      <div>
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
  };

  const divider = <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "2px 0" }} />;

  return (
    <div style={{ padding: "10px 22px", borderBottom: "1px solid rgba(255,255,255,0.1)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "#2D3748dd", backdropFilter: "blur(8px)", position: "sticky", top: 64, zIndex: 99 }}>
      {/* Filters button */}
      <div ref={ref} style={{ position: "relative" }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            padding: "5px 12px", borderRadius: 8,
            border: `1px solid ${hasActive ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.15)"}`,
            background: hasActive ? "rgba(255,255,255,0.12)" : "none",
            color: hasActive ? "#fff" : "rgba(255,255,255,0.7)",
            cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 6,
          }}
        >
          🔽 Filters
          {hasActive && (
            <span style={{ background: "#C8210A", color: "#fff", borderRadius: 10, fontSize: 10, padding: "1px 6px", fontWeight: 700 }}>
              {totalActive}
            </span>
          )}
        </button>
        {open && (
          <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, background: "#1A202C", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.45)", minWidth: 200, zIndex: 999, paddingBottom: 8 }}>
            <Section title="Brand" items={brands} filterSet={filterBrand} setFilter={setFilterBrand} getKey={b => b.id} getLabel={b => b.name} getColor={b => b.color} />
            {divider}
            <Section title="Season" items={seasons} filterSet={filterSeason} setFilter={setFilterSeason} getKey={s => s} getLabel={s => s} getColor={null} />
            {divider}
            <Section title="Customer" items={customers.map(c => typeof c === "string" ? c : c.name)} filterSet={filterCustomer} setFilter={setFilterCustomer} getKey={c => c} getLabel={c => c} getColor={null} />
            {divider}
            <Section title="Vendor" items={vendors.map(v => v.name)} filterSet={filterVendor} setFilter={setFilterVendor} getKey={v => v} getLabel={v => v} getColor={null} />
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

      {/* Active filter chips shown to the right */}
      {activeChips.map((chip, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(200,33,10,0.2)", border: "1px solid rgba(200,33,10,0.4)", borderRadius: 20, padding: "3px 8px 3px 10px", fontSize: 11, color: "#fff", fontWeight: 500 }}>
          {chip.label}
          <button onClick={chip.clear} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1, marginLeft: 2 }}>✕</button>
        </div>
      ))}
    </div>
  );
}


export default FilterBar;
