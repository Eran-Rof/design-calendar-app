import React, { useEffect, useMemo, useState } from "react";
import { TH } from "../../utils/theme";
import { loadCompanySettings } from "../services/supabaseGs1";
import {
  loadCatalog,
  loadPriceLists,
  loadCatalogSource,
  importSelectedStyleColors,
  updateCatalogItem,
  deleteCatalogItem,
  buildGdsnXml,
  buildRetailCsv,
  downloadTextFile,
  markPublished,
} from "../services/catalogService";
import type {
  CatalogItem, CatalogSourceRow, PriceListOption, CompanySettings, CatalogStatus,
} from "../types";
import SearchableSelect from "../../tanda/components/SearchableSelect";

const FIELD_LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase", letterSpacing: "0.04em",
};
const INPUT: React.CSSProperties = {
  padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13,
  color: TH.text, background: "#fff", outline: "none", boxSizing: "border-box",
};
const TH_STYLE: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontSize: 11, fontWeight: 600, color: TH.textSub2,
  background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`,
  textTransform: "uppercase", letterSpacing: "0.04em", position: "sticky", top: 0,
};
const TD_STYLE: React.CSSProperties = {
  padding: "6px 10px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}`, whiteSpace: "nowrap",
};
const BTN: React.CSSProperties = {
  padding: "7px 13px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer",
  border: `1px solid ${TH.border}`, background: "#fff", color: TH.textSub,
};
const BTN_PRIMARY: React.CSSProperties = {
  ...BTN, background: TH.primary, color: "#fff", border: `1px solid ${TH.primary}`,
};

const STATUS_STYLE: Record<CatalogStatus, React.CSSProperties> = {
  draft:     { background: "#F1F5F9", color: "#475569", border: "1px solid #CBD5E0" },
  ready:     { background: "#FFFBEB", color: "#92400E", border: "1px solid #FDE68A" },
  published: { background: "#F0FFF4", color: "#276749", border: "1px solid #C6F6D5" },
};

const skKey = (s: string, c: string) => `${s.trim().toUpperCase()}|${c.trim().toUpperCase()}`;

export default function CatalogPanel() {
  const [rows, setRows] = useState<CatalogItem[]>([]);
  const [lists, setLists] = useState<PriceListOption[]>([]);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [selectedListId, setSelectedListId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | CatalogStatus>("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});

  // Picker state (select styles & colors BEFORE import).
  const [pickerOpen, setPickerOpen] = useState(false);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const [cat, pls, co] = await Promise.all([loadCatalog(), loadPriceLists(), loadCompanySettings()]);
      setRows(cat);
      setLists(pls);
      setCompany(co);
      if (!selectedListId && pls.length) {
        setSelectedListId(pls.find((l) => l.is_default)?.id ?? pls[0].id);
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Called by the picker when the operator confirms a selection.
  async function importSelections(selections: Array<{ style_no: string; color: string }>) {
    if (!selectedListId) { setErr("Pick a price list first."); return; }
    setImporting(true);
    setErr(null);
    setInfo(null);
    try {
      const r = await importSelectedStyleColors(selectedListId, selections);
      setInfo(`Added ${r.imported} style/color row(s) — ${r.priced} priced from the list, ${r.unpriced} with no list price, ${r.with_gtin} already have a pack GTIN.`);
      setPickerOpen(false);
      await refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setImporting(false);
    }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        r.style_no.toLowerCase().includes(needle) ||
        (r.style_name || "").toLowerCase().includes(needle) ||
        r.color.toLowerCase().includes(needle) ||
        (r.brand || "").toLowerCase().includes(needle) ||
        (r.pack_gtin || "").toLowerCase().includes(needle)
      );
    });
  }, [rows, q, statusFilter]);

  const allChecked = filtered.length > 0 && filtered.every((r) => checked.has(r.id));
  function toggleAll() {
    setChecked((prev) => {
      if (allChecked) { const n = new Set(prev); filtered.forEach((r) => n.delete(r.id)); return n; }
      const n = new Set(prev); filtered.forEach((r) => n.add(r.id)); return n;
    });
  }
  function toggleOne(id: string) {
    setChecked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function savePrice(row: CatalogItem) {
    const draft = priceDraft[row.id];
    if (draft === undefined) return;
    const dollars = Number(draft);
    const cents = draft.trim() === "" ? null : (Number.isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 100) : NaN);
    if (Number.isNaN(cents)) { setErr(`Invalid price "${draft}" for ${row.style_no} ${row.color}`); return; }
    if (cents === row.price_cents) { setPriceDraft((p) => { const n = { ...p }; delete n[row.id]; return n; }); return; }
    try {
      const updated = await updateCatalogItem(row.id, { price_cents: cents });
      if (updated) setRows((rs) => rs.map((r) => (r.id === row.id ? updated : r)));
      setPriceDraft((p) => { const n = { ...p }; delete n[row.id]; return n; });
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  }

  async function setStatus(row: CatalogItem, status: CatalogStatus) {
    try {
      const updated = await updateCatalogItem(row.id, { status });
      if (updated) setRows((rs) => rs.map((r) => (r.id === row.id ? updated : r)));
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  }

  async function removeRow(row: CatalogItem) {
    if (!window.confirm(`Remove ${row.style_no} ${row.color} from the catalog?`)) return;
    try {
      await deleteCatalogItem(row.id);
      setRows((rs) => rs.filter((r) => r.id !== row.id));
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  }

  // Rows targeted by export/publish: checked, else all filtered.
  function targetRows(): CatalogItem[] {
    const sel = filtered.filter((r) => checked.has(r.id));
    return sel.length ? sel : filtered;
  }

  function exportGdsn() {
    const items = targetRows();
    if (!items.length) { setErr("No rows to export."); return; }
    const missingGtin = items.filter((r) => !r.pack_gtin).length;
    downloadTextFile("gs1-catalog-cin.xml", buildGdsnXml(items, company), "application/xml");
    setInfo(`GDSN CIN payload generated for ${items.length} item(s)${missingGtin ? ` — ${missingGtin} have no pack GTIN yet (mint them in Pack GTINs)` : ""}. Submit this to your data pool / portal.`);
  }
  function exportCsv() {
    const items = targetRows();
    if (!items.length) { setErr("No rows to export."); return; }
    downloadTextFile("gs1-catalog.csv", buildRetailCsv(items), "text/csv");
  }
  async function publish() {
    const items = targetRows().filter((r) => r.status !== "published");
    if (!items.length) { setErr("Nothing to publish (rows already published, or none selected)."); return; }
    const target = company?.company_name ? `${company.company_name} — GDSN` : "GDSN";
    try {
      await markPublished(items.map((r) => r.id), target);
      setInfo(`Marked ${items.length} item(s) published.`);
      await refresh();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  }

  const priced = rows.filter((r) => r.price_cents != null).length;
  const published = rows.filter((r) => r.status === "published").length;
  const chosenList = lists.find((l) => l.id === selectedListId);

  return (
    <div style={{ padding: "24px 24px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Styles Catalog</h2>
      <p style={{ margin: "0 0 18px", color: TH.textMuted, fontSize: 13, lineHeight: 1.5, maxWidth: 780 }}>
        The publishable supplier catalog (workflow step 1). First <strong>select the styles &amp; colors</strong> you want
        in the catalog, then <strong>import</strong> to pull each style's sales price from a Tangerine price list. Adjust
        prices, then publish as a GDSN / retail-portal feed. The pack GTIN on each row is what the EDI 850/856/810 reference.
      </p>

      {/* Step bar: pick price list + add styles */}
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "16px 18px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 320 }}>
            <label style={FIELD_LABEL}>Price list (sales price source for import)</label>
            <SearchableSelect
              theme="light"
              value={selectedListId || null}
              onChange={(v) => setSelectedListId(v)}
              inputStyle={{ ...INPUT, minWidth: 320 }}
              options={[
                ...(lists.length === 0 ? [{ value: "", label: "No price lists found" }] : []),
                ...lists.map((l) => ({
                  value: l.id,
                  label: `${l.code} — ${l.name}${l.is_default ? " (default)" : ""} · ${l.item_count} styles · ${l.currency}`,
                })),
              ]}
            />
          </div>
          <button onClick={() => { setErr(null); setPickerOpen(true); }} disabled={!selectedListId} style={BTN_PRIMARY}>
            ＋ Add styles &amp; colors
          </button>
          <button onClick={() => void refresh()} disabled={loading} style={BTN}>↻ Refresh</button>
          <div style={{ marginLeft: "auto", fontSize: 12, color: TH.textMuted, alignSelf: "center" }}>
            {rows.length} rows · {priced} priced · {published} published
          </div>
        </div>
        <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 8 }}>
          Pick the price list first, then <strong>Add styles &amp; colors</strong> to choose which to bring in — import pulls
          the price for the selected rows only. Re-adding the same style+color refreshes its price (keyed on style + color; never duplicates).
        </div>
      </div>

      {err && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.border}`, borderRadius: 8, padding: "10px 14px", marginBottom: 12, color: TH.primary, fontSize: 13 }}>{err}</div>
      )}
      {info && (
        <div style={{ background: "#F0FFF4", border: "1px solid #C6F6D5", borderRadius: 8, padding: "10px 14px", marginBottom: 12, color: "#276749", fontSize: 13 }}>{info}</div>
      )}

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search style, color, brand, GTIN…"
          style={{ ...INPUT, width: 280 }}
        />
        <SearchableSelect
          theme="light"
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as "" | CatalogStatus)}
          inputStyle={{ ...INPUT, width: 150 }}
          options={[
            { value: "", label: "All statuses" },
            { value: "draft", label: "Draft" },
            { value: "ready", label: "Ready" },
            { value: "published", label: "Published" },
          ]}
        />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={exportCsv} style={BTN}>Export CSV</button>
          <button onClick={exportGdsn} style={BTN}>Export GDSN (XML)</button>
          <button onClick={() => void publish()} style={BTN_PRIMARY}>Publish{checked.size ? ` (${checked.size})` : " all shown"}</button>
        </div>
      </div>

      {/* Catalog table */}
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, overflow: "auto", maxHeight: "62vh" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...TH_STYLE, width: 32 }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} />
              </th>
              <th style={TH_STYLE}>Style No</th>
              <th style={TH_STYLE}>Style Name</th>
              <th style={TH_STYLE}>Color</th>
              <th style={TH_STYLE}>Brand</th>
              <th style={TH_STYLE}>Pack GTIN</th>
              <th style={{ ...TH_STYLE, textAlign: "right" }}>Price</th>
              <th style={TH_STYLE}>Status</th>
              <th style={TH_STYLE}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={9} style={{ ...TD_STYLE, color: TH.textMuted, textAlign: "center", padding: 24 }}>
                {loading ? "Loading…" : "No catalog rows yet — pick a price list and click “＋ Add styles & colors”."}
              </td></tr>
            )}
            {filtered.map((r) => {
              const draft = priceDraft[r.id];
              const shown = draft !== undefined ? draft : (r.price_cents != null ? (r.price_cents / 100).toFixed(2) : "");
              return (
                <tr key={r.id}>
                  <td style={TD_STYLE}><input type="checkbox" checked={checked.has(r.id)} onChange={() => toggleOne(r.id)} /></td>
                  <td style={TD_STYLE}>{r.style_no}</td>
                  <td style={{ ...TD_STYLE, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{r.style_name || ""}</td>
                  <td style={TD_STYLE}>{r.color}</td>
                  <td style={TD_STYLE}>{r.brand || ""}</td>
                  <td style={{ ...TD_STYLE, fontFamily: "ui-monospace, monospace", color: r.pack_gtin ? TH.text : TH.textMuted }}>
                    {r.pack_gtin || "—"}
                  </td>
                  <td style={{ ...TD_STYLE, textAlign: "right" }}>
                    <input
                      value={shown}
                      onChange={(e) => setPriceDraft((p) => ({ ...p, [r.id]: e.target.value }))}
                      onBlur={() => void savePrice(r)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      inputMode="decimal"
                      placeholder="—"
                      style={{ ...INPUT, width: 84, textAlign: "right", padding: "4px 7px" }}
                    />
                  </td>
                  <td style={TD_STYLE}>
                    <SearchableSelect
                      theme="light"
                      value={r.status}
                      onChange={(v) => void setStatus(r, v as CatalogStatus)}
                      inputStyle={{ ...INPUT, padding: "3px 6px", fontSize: 11, fontWeight: 600, ...STATUS_STYLE[r.status] }}
                      options={[
                        { value: "draft", label: "Draft" },
                        { value: "ready", label: "Ready" },
                        { value: "published", label: "Published" },
                      ]}
                    />
                  </td>
                  <td style={TD_STYLE}>
                    <button onClick={() => void removeRow(r)} title="Remove" style={{ ...BTN, padding: "3px 8px", color: "#B91C1C" }}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: TH.textMuted, marginTop: 10, maxWidth: 780, lineHeight: 1.5 }}>
        Export GDSN (XML) produces a GS1 CIN trade-item payload (one item per pack GTIN) ready to submit to your
        data pool (e.g. 1WorldSync / GS1 Canada). Connecting to a live data pool needs that partner's account, GLN,
        and transport credentials — those aren't configured here.
      </p>

      {pickerOpen && (
        <StyleColorPicker
          priceListLabel={chosenList ? `${chosenList.code} — ${chosenList.name}` : ""}
          importing={importing}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(sel) => void importSelections(sel)}
        />
      )}
    </div>
  );
}

// ── Style & color picker (select first, then import) ──────────────────────────

function StyleColorPicker({
  priceListLabel, importing, onCancel, onConfirm,
}: {
  priceListLabel: string;
  importing: boolean;
  onCancel: () => void;
  onConfirm: (selections: Array<{ style_no: string; color: string }>) => void;
}) {
  const [source, setSource] = useState<CatalogSourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pq, setPq] = useState("");
  const [hideInCatalog, setHideInCatalog] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // skKey
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // style_no

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const src = await loadCatalogSource();
        if (alive) setSource(src);
      } catch (e) {
        if (alive) setLoadErr(String(e instanceof Error ? e.message : e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Group source rows by style.
  const groups = useMemo(() => {
    const needle = pq.trim().toLowerCase();
    const byStyle = new Map<string, { style_no: string; style_name: string | null; brand: string | null; colors: CatalogSourceRow[] }>();
    for (const r of source) {
      if (hideInCatalog && r.in_catalog) continue;
      if (needle) {
        const hay = `${r.style_no} ${r.style_name || ""} ${r.brand || ""} ${r.color}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      let g = byStyle.get(r.style_no);
      if (!g) { g = { style_no: r.style_no, style_name: r.style_name, brand: r.brand, colors: [] }; byStyle.set(r.style_no, g); }
      g.colors.push(r);
    }
    return Array.from(byStyle.values()).sort((a, b) => a.style_no.localeCompare(b.style_no));
  }, [source, pq, hideInCatalog]);

  const MAX_STYLES = 250;
  const shownGroups = groups.slice(0, MAX_STYLES);
  const overflow = groups.length - shownGroups.length;

  function toggleColor(r: CatalogSourceRow) {
    const k = skKey(r.style_no, r.color);
    setSelected((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }
  function styleState(g: { colors: CatalogSourceRow[] }): "all" | "some" | "none" {
    let on = 0;
    for (const c of g.colors) if (selected.has(skKey(c.style_no, c.color))) on++;
    return on === 0 ? "none" : on === g.colors.length ? "all" : "some";
  }
  function toggleStyle(g: { colors: CatalogSourceRow[] }) {
    const st = styleState(g);
    setSelected((prev) => {
      const n = new Set(prev);
      for (const c of g.colors) {
        const k = skKey(c.style_no, c.color);
        if (st === "all") n.delete(k); else n.add(k);
      }
      return n;
    });
  }
  function toggleExpand(styleNo: string) {
    setExpanded((prev) => { const n = new Set(prev); n.has(styleNo) ? n.delete(styleNo) : n.add(styleNo); return n; });
  }
  function selectAllShown() {
    setSelected((prev) => {
      const n = new Set(prev);
      for (const g of shownGroups) for (const c of g.colors) n.add(skKey(c.style_no, c.color));
      return n;
    });
  }

  const confirmList = useMemo(() => {
    const out: Array<{ style_no: string; color: string }> = [];
    for (const r of source) if (selected.has(skKey(r.style_no, r.color))) out.push({ style_no: r.style_no, color: r.color });
    return out;
  }, [source, selected]);

  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: TH.surface, borderRadius: 12, width: "min(820px, 95vw)", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 12px 40px rgba(0,0,0,0.3)" }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${TH.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: TH.text }}>Select styles &amp; colors</div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 2 }}>
            Choose what to add to the catalog. Prices will be pulled from <strong>{priceListLabel || "the selected price list"}</strong> on import.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <input autoFocus value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search style, name, brand, color…" style={{ ...INPUT, flex: 1, minWidth: 220 }} />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: TH.textSub, whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={hideInCatalog} onChange={(e) => setHideInCatalog(e.target.checked)} />
              Hide already in catalog
            </label>
            <button onClick={selectAllShown} style={{ ...BTN, padding: "5px 10px" }}>Select all shown</button>
            <button onClick={() => setSelected(new Set())} style={{ ...BTN, padding: "5px 10px" }}>Clear</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ overflow: "auto", padding: "8px 12px", flex: 1 }}>
          {loading && <div style={{ padding: 24, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>Loading styles &amp; colors…</div>}
          {loadErr && <div style={{ padding: 14, color: TH.primary, fontSize: 13 }}>{loadErr}</div>}
          {!loading && !loadErr && shownGroups.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No styles match.</div>
          )}
          {shownGroups.map((g) => {
            const st = styleState(g);
            const isOpen = expanded.has(g.style_no);
            return (
              <div key={g.style_no} style={{ borderBottom: `1px solid ${TH.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 6px" }}>
                  <input
                    type="checkbox"
                    checked={st === "all"}
                    ref={(el) => { if (el) el.indeterminate = st === "some"; }}
                    onChange={() => toggleStyle(g)}
                  />
                  <button onClick={() => toggleExpand(g.style_no)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 13, color: TH.text, display: "flex", alignItems: "center", gap: 6, flex: 1, textAlign: "left" }}>
                    <span style={{ width: 12, color: TH.textMuted }}>{isOpen ? "▾" : "▸"}</span>
                    <strong>{g.style_no}</strong>
                    <span style={{ color: TH.textSub2 }}>{g.style_name || ""}</span>
                    {g.brand && <span style={{ fontSize: 11, color: TH.textMuted }}>· {g.brand}</span>}
                    <span style={{ marginLeft: "auto", fontSize: 11, color: TH.textMuted }}>{g.colors.length} color{g.colors.length === 1 ? "" : "s"}</span>
                  </button>
                </div>
                {isOpen && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 6px 10px 30px" }}>
                    {g.colors.map((c) => {
                      const k = skKey(c.style_no, c.color);
                      const on = selected.has(k);
                      return (
                        <label key={k} title={c.in_catalog ? "Already in catalog — re-adding refreshes its price" : ""}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 9px", borderRadius: 14, cursor: "pointer",
                            background: on ? "#EBF8FF" : "#fff", color: c.in_catalog ? TH.textMuted : TH.textSub,
                            border: `1px solid ${on ? "#90CDF4" : TH.border}` }}>
                          <input type="checkbox" checked={on} onChange={() => toggleColor(c)} />
                          {c.color}
                          {c.pack_gtin && <span title="Has a pack GTIN" style={{ fontSize: 10, color: "#276749" }}>●</span>}
                          {c.in_catalog && <span style={{ fontSize: 10 }}>✓</span>}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {overflow > 0 && (
            <div style={{ padding: 12, textAlign: "center", color: TH.textMuted, fontSize: 12 }}>
              + {overflow} more styles — refine your search to narrow the list (selections you've already made are kept).
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${TH.border}`, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 13, color: TH.textSub2 }}>{confirmList.length} style/color selected</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={onCancel} style={BTN} disabled={importing}>Cancel</button>
            <button onClick={() => onConfirm(confirmList)} style={BTN_PRIMARY} disabled={importing || confirmList.length === 0}>
              {importing ? "Importing…" : `Import ${confirmList.length} → pull prices`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
