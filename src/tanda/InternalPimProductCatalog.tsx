// src/tanda/InternalPimProductCatalog.tsx
//
// Tangerine P8-8 — PIM Product Catalog (M42 PIM UI).
//
// Landing/list panel for the PIM admin UI. Filters: category dropdown
// (tree-aware: Parent > Child > Grandchild rendered as flat options),
// publish_status (draft / published / mixed / unset), search-by-style.
//
// Columns: style_code, style_name (from style_master), category, primary
// image thumb (90px square), description publish status, last_updated.
//
// Click a row → opens the per-style detail editor (InternalPimStyleDetail)
// as a sub-route INSIDE this panel (state-driven; no separate nav entry —
// per spec the detail editor doesn't get its own ModuleKey).
//
// Spec: docs/tangerine/P8-data-crm-architecture.md §5 + §6.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import InternalPimStyleDetail from "./InternalPimStyleDetail";
import SearchableSelect from "./components/SearchableSelect";

type Category = {
  id: string;
  parent_category_id: string | null;
  code: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  depth: number;
};

type Style = {
  id: string;
  style_code: string;
  style_name: string | null;
  description: string;
  category_id: string | null;
  gender_code: string | null;
  season: string | null;
  design_year: number | null;
  is_apparel: boolean;
  launch_date: string | null;
  lifecycle_status: string;
  planning_class: string | null;
  base_fabric: string | null;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

// Composite shape returned by GET /api/internal/pim/styles/:style_id.
// We hit it lazily per-row to pull the primary thumb + publish status — but
// the list view doesn't have a "list all styles + PIM merged" endpoint, so
// we fetch styles via the existing /api/internal/style-master listing and
// enrich a small page-sized window with the composite data.
type ImageRow = {
  id: string;
  storage_path: string;
  storage_path_thumb: string | null;
  storage_path_web: string | null;
  is_primary: boolean;
  sort_order: number;
};
type DescriptionRow = {
  id: string;
  locale: string;
  publish_status: "draft" | "published";
  published_at: string | null;
  updated_at: string;
};
type PimComposite = {
  style: Style;
  images: ImageRow[];
  descriptions: DescriptionRow[];
};

type RowVM = Style & {
  category_label: string;
  primary_thumb: string | null;
  publish_label: "draft" | "published" | "mixed" | "—";
  pim_updated: string | null;
  loaded: boolean;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13, verticalAlign: "middle",
};

const PUBLISH_FILTER_OPTIONS = [
  { value: "",          label: "All publish states" },
  { value: "draft",     label: "Draft only" },
  { value: "published", label: "Published only" },
  { value: "mixed",     label: "Mixed (some locales draft, some published)" },
  { value: "unset",     label: "No description yet" },
];

// Build "Parent > Child > Grandchild" labels from the flat category list with
// depth + parent_category_id. The categories endpoint already orders by depth
// + sort + name, so we just need a JS-side ancestry walk to assemble the path.
function buildCategoryPathMap(cats: Category[]): Map<string, string> {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const memo = new Map<string, string>();
  function pathOf(id: string): string {
    if (memo.has(id)) return memo.get(id)!;
    const c = byId.get(id);
    if (!c) return "(unknown)";
    if (!c.parent_category_id) {
      memo.set(id, c.name);
      return c.name;
    }
    const parent = pathOf(c.parent_category_id);
    const full = `${parent} > ${c.name}`;
    memo.set(id, full);
    return full;
  }
  for (const c of cats) pathOf(c.id);
  return memo;
}

// Derive overall publish label from a style's description rows. Only en-US
// for now, but the math handles future locales transparently.
function derivePublishLabel(descs: DescriptionRow[]): RowVM["publish_label"] {
  if (!descs || descs.length === 0) return "—";
  const statuses = new Set(descs.map((d) => d.publish_status));
  if (statuses.size === 1) {
    return statuses.has("published") ? "published" : "draft";
  }
  return "mixed";
}

function pickPrimaryThumb(images: ImageRow[]): string | null {
  if (!images || images.length === 0) return null;
  // Prefer is_primary=true, fall back to first by sort_order.
  const sorted = [...images].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return a.sort_order - b.sort_order;
  });
  const top = sorted[0];
  return top.storage_path_thumb || top.storage_path_web || top.storage_path || null;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
  } catch { return iso; }
}

export default function InternalPimProductCatalog() {
  const [styles, setStyles] = useState<Style[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [composites, setComposites] = useState<Map<string, PimComposite>>(new Map());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>(""); // category id; expands children
  const [publishFilter, setPublishFilter] = useState<string>("");

  const [openStyleId, setOpenStyleId] = useState<string | null>(null);

  async function loadCategories() {
    try {
      const r = await fetch(`/api/internal/pim/categories?is_active=true`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setCategories(await r.json() as Category[]);
    } catch (e: unknown) {
      // Non-fatal: catalog still renders without the filter.
      console.warn("[PIM] categories load failed:", e);
    }
  }

  async function loadStyles() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      params.set("limit", "500");
      const r = await fetch(`/api/internal/style-master?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json() as Style[];
      // Soft-deleted styles aren't relevant to PIM — the existing /style-master
      // GET already excludes them by default, so this is belt-and-suspenders.
      setStyles(data.filter((s) => !s.deleted_at));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // After styles arrive, lazy-load the PIM composite (images + descriptions)
  // for the first N rows. Doing N parallel fetches against /styles/:id keeps
  // latency manageable even on 500-style entities; the UI shows a skeleton
  // for rows that haven't completed yet.
  useEffect(() => {
    if (styles.length === 0) {
      setComposites(new Map());
      return;
    }
    let cancelled = false;
    const ids = styles.map((s) => s.id);
    (async () => {
      // Concurrency-cap at 6 so a 500-style entity doesn't open 500 sockets.
      const next = new Map<string, PimComposite>();
      const queue = [...ids];
      const workers: Promise<void>[] = [];
      const CONCURRENCY = 6;
      async function worker() {
        while (queue.length > 0 && !cancelled) {
          const id = queue.shift()!;
          try {
            const r = await fetch(`/api/internal/pim/styles/${id}`);
            if (r.ok) {
              const j = await r.json() as PimComposite;
              if (!cancelled) {
                next.set(id, j);
                // Push partial progress every ~10 rows so the UI feels live.
                if (next.size % 10 === 0) setComposites(new Map(next));
              }
            }
          } catch { /* swallow per-row errors */ }
        }
      }
      for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
      await Promise.all(workers);
      if (!cancelled) setComposites(new Map(next));
    })();
    return () => { cancelled = true; };
  }, [styles]);

  useEffect(() => {
    void loadCategories();
    void loadStyles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const catPaths = useMemo(() => buildCategoryPathMap(categories), [categories]);

  // Tree-aware filter: if the user picks "Womens", we include all styles
  // whose category is "Womens" OR any descendant. We compute the descendant
  // set once per filter change.
  const descendantOf = useMemo(() => {
    if (!categoryFilter) return null;
    const childrenByParent = new Map<string, string[]>();
    for (const c of categories) {
      if (!c.parent_category_id) continue;
      const list = childrenByParent.get(c.parent_category_id) || [];
      list.push(c.id);
      childrenByParent.set(c.parent_category_id, list);
    }
    const out = new Set<string>([categoryFilter]);
    const queue = [categoryFilter];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const kids = childrenByParent.get(cur) || [];
      for (const k of kids) {
        if (!out.has(k)) {
          out.add(k);
          queue.push(k);
        }
      }
    }
    return out;
  }, [categoryFilter, categories]);

  // Build the row view-model: join styles with composite + category labels.
  const rows: RowVM[] = useMemo(() => {
    return styles.map((s) => {
      const comp = composites.get(s.id);
      const loaded = comp != null;
      const publish_label = loaded ? derivePublishLabel(comp!.descriptions) : "—";
      const primary_thumb = loaded ? pickPrimaryThumb(comp!.images) : null;
      const pim_updated = loaded
        ? comp!.descriptions.reduce<string | null>((max, d) => {
            if (!max) return d.updated_at;
            return d.updated_at > max ? d.updated_at : max;
          }, null)
        : null;
      return {
        ...s,
        category_label: s.category_id ? (catPaths.get(s.category_id) || "(unmapped)") : "(unmapped)",
        primary_thumb,
        publish_label,
        pim_updated,
        loaded,
      };
    });
  }, [styles, composites, catPaths]);

  // Apply client-side filters (category tree + publish state).
  const filteredRows: RowVM[] = useMemo(() => {
    return rows.filter((r) => {
      if (descendantOf && (!r.category_id || !descendantOf.has(r.category_id))) {
        return false;
      }
      if (publishFilter) {
        if (publishFilter === "unset" && r.publish_label !== "—") return false;
        if (publishFilter !== "unset" && r.publish_label !== publishFilter) return false;
      }
      return true;
    });
  }, [rows, descendantOf, publishFilter]);

  // If a row is opened, render the detail editor full-pane instead of the list.
  if (openStyleId) {
    return (
      <InternalPimStyleDetail
        styleId={openStyleId}
        onBack={() => {
          setOpenStyleId(null);
          // Re-fetch the composite for the row we just edited so the list
          // reflects new images / publish status without a full reload.
          void (async () => {
            try {
              const r = await fetch(`/api/internal/pim/styles/${openStyleId}`);
              if (r.ok) {
                const j = await r.json() as PimComposite;
                setComposites((prev) => {
                  const n = new Map(prev);
                  n.set(openStyleId, j);
                  return n;
                });
              }
            } catch { /* non-fatal */ }
          })();
        }}
      />
    );
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Product Catalog</h2>
        <div style={{ fontSize: 12, color: C.textMuted }}>
          Styles are created via <strong>Style Master</strong>. This panel manages PIM metadata on top of them.
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search style code or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void loadStyles()}
          style={{ ...inputStyle, maxWidth: 280 }}
        />
        <button onClick={() => void loadStyles()} style={btnSecondary}>Search</button>

        <div style={{ width: 280 }}>
          <SearchableSelect
            value={categoryFilter || null}
            onChange={(v) => setCategoryFilter(v)}
            options={[
              { value: "", label: "All categories" },
              ...categories.map((c) => ({ value: c.id, label: catPaths.get(c.id) || c.name })),
            ]}
            placeholder="All categories"
          />
        </div>

        <select
          value={publishFilter}
          onChange={(e) => setPublishFilter(e.target.value)}
          style={{ ...inputStyle, maxWidth: 280 } as React.CSSProperties}
        >
          {PUBLISH_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <ExportButton
          rows={filteredRows as unknown as Array<Record<string, unknown>>}
          filename="pim-product-catalog"
          sheetName="Product Catalog"
          columns={[
            { key: "style_code",     header: "Style Number" },
            { key: "style_name",     header: "Style Name" },
            { key: "category_label", header: "Category" },
            { key: "publish_label",  header: "Publish Status" },
            { key: "pim_updated",    header: "Last Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
          maxHeight: "calc(100vh - 240px)", overflowY: "auto", overflowX: "auto",
        }}
      >
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading styles…</div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            {styles.length === 0 ? "No styles found." : "No styles match the current filters."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 110 }}>Image</th>
                <th style={th}>Style Number</th>
                <th style={th}>Style Name</th>
                <th style={th}>Category</th>
                <th style={th}>Publish Status</th>
                <th style={th}>Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setOpenStyleId(r.id)}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#0b1220")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  <td style={{ ...td, width: 110 }}>
                    {r.primary_thumb ? (
                      <img
                        src={r.primary_thumb}
                        alt={r.style_code}
                        style={{
                          width: 90, height: 90, objectFit: "cover",
                          borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: "#0b1220",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 90, height: 90, borderRadius: 6,
                          border: `1px dashed ${C.cardBdr}`, background: "#0b1220",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 22, color: C.textMuted,
                        }}
                        title={r.loaded ? "No primary image" : "Loading…"}
                      >
                        {r.loaded ? "🖼️" : "…"}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>
                    {r.style_code}
                  </td>
                  <td style={td}>{r.style_name || r.description || "—"}</td>
                  <td style={td}>{r.category_label}</td>
                  <td style={td}>
                    <PublishPill label={r.publish_label} loaded={r.loaded} />
                  </td>
                  <td style={td}>{fmtDate(r.pim_updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PublishPill({ label, loaded }: { label: RowVM["publish_label"]; loaded: boolean }) {
  if (!loaded) {
    return <span style={{ color: C.textMuted, fontSize: 12 }}>Loading…</span>;
  }
  const palette: Record<RowVM["publish_label"], { bg: string; color: string; text: string }> = {
    published: { bg: "#064e3b", color: "#6ee7b7", text: "Published" },
    draft:     { bg: "#78350f", color: "#fcd34d", text: "Draft" },
    mixed:     { bg: "#1e3a8a", color: "#93c5fd", text: "Mixed" },
    "—":        { bg: "#374151", color: "#d1d5db", text: "No description" },
  };
  const p = palette[label];
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 10,
      background: p.bg, color: p.color, fontSize: 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {p.text}
    </span>
  );
}
