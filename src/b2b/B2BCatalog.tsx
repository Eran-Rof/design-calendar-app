import { useEffect, useMemo, useRef, useState } from "react";
import { B } from "./theme";
import { apiB2B } from "./apiB2B";
import { formatMoney } from "./useCart";
import type { CatalogItem, CartLine } from "./types";
import SearchableSelect from "../tanda/components/SearchableSelect";

// P18-C / M41 — Catalog + per-customer wholesale pricing. Prices are resolved
// server-side for the logged-in buyer; the client never sends a customer_id or
// a price. "Add to cart" is only offered for styles that have a resolved price.
// Brand / gender / text filters hit the server; category + sort refine the
// loaded set on the client so browsing 2,000+ styles stays responsive.
type SortKey = "code" | "name" | "price_asc" | "price_desc";

export default function B2BCatalog({
  onAdd,
}: {
  onAdd: (line: CartLine) => void;
}) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [gender, setGender] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<SortKey>("code");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced fetch on filter/search change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void load(); }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, brand, gender]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (brand) params.set("brand_id", brand);
      if (gender) params.set("gender", gender);
      const qs = params.toString();
      const data = await apiB2B<CatalogItem[]>(`/api/b2b/catalog${qs ? `?${qs}` : ""}`);
      setItems(data || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load catalog");
    } finally {
      setLoading(false);
    }
  }

  // Build brand + gender + category filter options from the loaded set.
  const brandOpts = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (i.brand_id && i.brand_name) m.set(i.brand_id, i.brand_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);
  const genderOpts = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (i.gender_code) m.set(i.gender_code, i.gender_label || i.gender_code);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);
  const categoryOpts = useMemo(() => {
    const s = new Set<string>();
    for (const i of items) if (i.category_name) s.add(i.category_name);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [items]);

  // Category filter + sort, applied client-side over the loaded set.
  const displayed = useMemo(() => {
    const out = category ? items.filter((i) => i.category_name === category) : items.slice();
    const cmp: Record<SortKey, (a: CatalogItem, b: CatalogItem) => number> = {
      code: (a, b) => a.style_code.localeCompare(b.style_code),
      name: (a, b) => (a.style_name || a.style_code).localeCompare(b.style_name || b.style_code),
      price_asc: (a, b) => (a.price_cents ?? Infinity) - (b.price_cents ?? Infinity),
      price_desc: (a, b) => (b.price_cents ?? -Infinity) - (a.price_cents ?? -Infinity),
    };
    out.sort(cmp[sort]);
    return out;
  }, [items, category, sort]);

  return (
    <div>
      <div style={toolbar}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search styles…"
          style={{ ...input, flex: 1, minWidth: 180 }}
        />
        <SearchableSelect
          theme="light"
          value={brand || null}
          onChange={(v) => setBrand(v)}
          options={[
            { value: "", label: "All brands" },
            ...brandOpts.map(([id, name]) => ({ value: id, label: name })),
          ]}
          inputStyle={input}
        />
        <SearchableSelect
          theme="light"
          value={gender || null}
          onChange={(v) => setGender(v)}
          options={[
            { value: "", label: "All genders" },
            ...genderOpts.map(([code, label]) => ({ value: code, label })),
          ]}
          inputStyle={input}
        />
        <SearchableSelect
          theme="light"
          value={category || null}
          onChange={(v) => setCategory(v)}
          options={[
            { value: "", label: "All categories" },
            ...categoryOpts.map((c) => ({ value: c, label: c })),
          ]}
          inputStyle={input}
        />
        <SearchableSelect
          theme="light"
          value={sort}
          onChange={(v) => setSort(v as SortKey)}
          options={[
            { value: "code", label: "Sort: Style code" },
            { value: "name", label: "Sort: Name" },
            { value: "price_asc", label: "Sort: Price ↑" },
            { value: "price_desc", label: "Sort: Price ↓" },
          ]}
          inputStyle={input}
        />
      </div>

      {err && <div style={errBox}>{err}</div>}

      {loading ? (
        <div style={muted}>Loading catalog…</div>
      ) : displayed.length === 0 ? (
        <div style={muted}>No styles match your filters.</div>
      ) : (
        <>
          <div style={countBar}>
            {displayed.length} style{displayed.length === 1 ? "" : "s"}
            {category ? ` in ${category}` : ""}
          </div>
          <div style={grid}>
            {displayed.map((it) => <CatalogCard key={it.style_id} item={it} onAdd={onAdd} />)}
          </div>
        </>
      )}
    </div>
  );
}

function CatalogCard({ item, onAdd }: { item: CatalogItem; onAdd: (l: CartLine) => void }) {
  const minQty = item.min_qty && item.min_qty > 0 ? item.min_qty : 1;
  const [qty, setQty] = useState(minQty);
  const hasPrice = item.price_cents != null;

  return (
    <div style={card}>
      {/* Image slot — renders the product image when present, else a branded
          placeholder so every card keeps the same storefront layout. */}
      <div style={imageWrap}>
        {item.image_url
          ? <img src={item.image_url} alt={item.style_name || item.style_code} style={imageEl} loading="lazy" />
          : <span style={{ color: B.textMuted, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>{(item.style_code || "?").slice(0, 6)}</span>}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, color: B.text, fontSize: 14 }}>{item.style_code}</div>
        {item.style_name && <div style={{ color: B.textSub, fontSize: 13, marginTop: 2 }}>{item.style_name}</div>}
        <div style={{ color: B.textMuted, fontSize: 12, marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {item.brand_name && <span>{item.brand_name}</span>}
          {item.gender_label && <span>· {item.gender_label}</span>}
          {item.category_name && <span>· {item.category_name}</span>}
        </div>
      </div>
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div>
          <span style={{ fontWeight: 700, color: hasPrice ? B.text : B.textMuted, fontSize: 15 }}>
            {formatMoney(item.price_cents, item.currency || "USD")}
          </span>
          {hasPrice && item.min_qty && item.min_qty > 1 && (
            <div style={{ color: B.textMuted, fontSize: 11, marginTop: 2 }}>min {item.min_qty}</div>
          )}
        </div>
        {hasPrice && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="number"
              min={minQty}
              value={qty}
              onChange={(e) => setQty(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              style={{ ...input, width: 64, padding: "6px 8px" }}
            />
            <button
              type="button"
              disabled={qty <= 0}
              onClick={() =>
                onAdd({
                  style_id: item.style_id,
                  style_code: item.style_code,
                  style_name: item.style_name,
                  qty,
                  price_cents: item.price_cents as number,
                  currency: item.currency || "USD",
                })
              }
              style={addBtn(qty <= 0)}
            >
              Add
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const toolbar: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 };
const countBar: React.CSSProperties = { color: B.textMuted, fontSize: 13, marginBottom: 12 };
const grid: React.CSSProperties = {
  display: "grid", gap: 14,
  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
};
const card: React.CSSProperties = {
  background: B.surface, border: `1px solid ${B.border}`, borderRadius: 12,
  padding: 16, boxShadow: `0 1px 3px ${B.shadow}`, display: "flex", flexDirection: "column",
};
const imageWrap: React.CSSProperties = {
  height: 120, marginBottom: 12, borderRadius: 8, background: B.bg,
  border: `1px solid ${B.border}`, display: "flex", alignItems: "center",
  justifyContent: "center", overflow: "hidden",
};
const imageEl: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
const input: React.CSSProperties = {
  padding: "9px 11px", borderRadius: 8, border: `1px solid ${B.border}`,
  fontSize: 14, fontFamily: "inherit", background: B.surface, color: B.text, boxSizing: "border-box",
};
const addBtn = (disabled: boolean): React.CSSProperties => ({
  padding: "7px 14px", borderRadius: 8, border: "none",
  background: disabled ? B.textMuted : B.primary, color: "#fff",
  fontWeight: 600, fontSize: 13, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
});
const muted: React.CSSProperties = { color: B.textMuted, fontSize: 14, padding: "24px 0" };
const errBox: React.CSSProperties = {
  color: B.danger, fontSize: 13, marginBottom: 14, padding: "10px 12px",
  background: B.dangerBg, border: `1px solid ${B.dangerBdr}`, borderRadius: 8,
};
