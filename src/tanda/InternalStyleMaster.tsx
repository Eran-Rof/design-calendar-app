// src/tanda/InternalStyleMaster.tsx
//
// Tangerine P1 Chunk 7 — internal admin panel for style_master CRUD.
// List + search + create + edit + soft-delete (and a toggle to view deleted).
// Wraps /api/internal/style-master and /api/internal/style-master/:id.
//
// P3 Chunk 11 (2026-05-27): adds a "Fabrics" subsection in the edit modal that
// reads/writes the style_fabric_codes junction. The subsection manages its own
// state and calls /api/internal/style-fabric-codes directly — the style_master
// save flow is unchanged.
//
// Style Master Sweep (2026-05-30) — operator asks #5/#6/#7/#12:
//   • #5  Adds group_name / category_name / sub_category_name columns to the
//         list view and edit modal (SearchableSelect inputs since these have
//         a small but growing set of values across the catalog).
//   • #6  Replaces the modal title with "Style: <code> <name>" (edit) or
//         "Add Style" (add). Adds a notes-log section showing timestamp +
//         author email + note text, with an inline "Add note" composer.
//   • #7  style_name is now backfilled by the migration, so the list cell
//         renders the populated value (still falls back to "—" defensively).
//   • #12 Gender dropdown is the canonical six-letter set
//         { M, B, C, G, W, U } with descriptive labels.
//
// Fabric FK (2026-05-30, operator ask #13):
//   • The free-form `base_fabric` text input is replaced by a SearchableSelect
//     populated from /api/internal/fabric-codes (the existing fabric master).
//     The DB column is now `base_fabric_code_id` (FK to fabric_codes.id) and
//     the API embeds the joined `base_fabric: { id, code, name }` object.
//     The legacy text column `base_fabric_legacy` is read-only here, surfaced
//     as a muted help line beside the picker if the FK is unset and a legacy
//     value exists, so operators can see what to re-pick.
//
// Style Master Polish (2026-05-30) — operator asks A/B/C:
//   • A   Search is now dynamic via <DynamicSearchInput> + useDebouncedSearch
//         (200 ms cadence, matching CustomerMaster + COA). The previous
//         Enter-or-click-Search workflow had become the operator's primary
//         complaint after PR #595 (TablePrefs) shipped; the input was wired
//         but the load() callback only refetched on explicit submit.
//   • B   The three classifier dropdowns (Group / Category / Sub Category)
//         pull their option set from /api/internal/style-master/dim-values
//         (distinct values across the whole table, not just the page that
//         happens to be loaded). When the signed-in operator is an admin
//         (cached MS auth user uuid present) an "+ Add new…" row is
//         surfaced; non-admins can still pick existing values but cannot
//         introduce new ones from the modal.
//   • C   Gender dropdown labels now show just the descriptive name
//         ("Mens", "Boys", "Child", "Girls", "Womens", "Unisex"). The
//         stored value remains the single-letter code (M/B/C/G/W/U).
//
// Chunk J — Style Master + Catalog + Fabric (2026-06-01):
//   • Item 4   Brand picker (SearchableSelect from /api/internal/brands) bound
//              to style_master.brand_id; new Brand list column + export field.
//   • Items 10/11  The Group / Category / Sub-category dropdowns now read the
//              style_classifications master (/api/internal/style-classifications
//              ?kind=…) instead of the old dim-values endpoint. Admin "+ Add
//              new…" POSTs a new style_classifications row so the master grows.
//   • Item 13  Gender options come from gender_master (/api/internal/genders),
//              which carries Toddler ("T"); saved gender_code pre-selects.

import { useCallback, useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import { exportXlsx } from "./exports/useTableExport";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { getCachedAuthUserId, getCachedAuthUserEmail } from "../utils/tangerineAuthUser";
// Universal row-click + scroll-highlight primitive (operator ask #4).
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import { useStyleThumbs, StyleThumb } from "../shared/ui/StyleThumb";
import ScrollHighlightRow from "./components/ScrollHighlightRow";

// Universal Column Visibility primitive (Operator ask #1, 2026-05-30).
// Style Master is the demo panel; the other Tangerine panels are swept in
// a follow-up chunk.
const STYLE_MASTER_TABLE_KEY = "tanda.style_master";
const STYLE_MASTER_COLUMNS: ColumnDef[] = [
  { key: "style_code",        label: "Style Number" },
  { key: "style_name",        label: "Style Name" },
  { key: "description",       label: "Description" },
  { key: "gender_code",       label: "Gender" },
  { key: "group_name",        label: "Group" },
  { key: "category_name",     label: "Category" },
  { key: "sub_category_name", label: "Sub Category" },
  { key: "brand_name",        label: "Brand" },
  { key: "size_scale_code",   label: "Size Scale" },
  { key: "base_fabric",       label: "Base Fabric" },
  { key: "hts_code",          label: "HTS" },
  { key: "season",            label: "Season" },
  { key: "design_year",       label: "Year" },
  { key: "lifecycle_status",  label: "Lifecycle" },
  { key: "is_apparel",        label: "Apparel" },
];

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
  base_fabric_code_id: string | null;
  base_fabric_legacy: string | null;
  /** Embedded join from fabric_codes via base_fabric_code_id FK. */
  base_fabric: { id: string; code: string; name: string } | null;
  group_name: string | null;
  category_name: string | null;
  sub_category_name: string | null;
  brand_id: string | null;
  size_scale_id: string | null;
  rise: string | null;
  hts_code: string | null;
  duty_rate_pct: number | null;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type StyleNote = {
  id: string;
  style_id: string;
  note_text: string;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
};

type DimValues = {
  groups: string[];
  categories: string[];
  sub_categories: string[];
};

type Brand = { id: string; code: string; name: string; is_default?: boolean };

type SizeScaleLite = { id: string; code: string; name: string; sizes?: string[] };

type SeasonLite = { id: string; code: string; name: string };

// gender_master row (Chunk J item 13) — replaces the hardcoded GENDER_OPTIONS.
type GenderMaster = { id: string; code: string; label: string; sort_order: number };

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

// Fallback gender set used only for list-cell labels before the gender_master
// fetch resolves (Chunk J item 13 moves the canonical list to
// /api/internal/genders, which also carries Toddler "T"). The STORED value is
// the single-letter code; the display LABEL is the descriptive name.
const GENDER_FALLBACK: { value: string; label: string }[] = [
  { value: "",  label: "(select)" },
  { value: "M", label: "Mens"   },
  { value: "B", label: "Boys"   },
  { value: "C", label: "Child"  },
  { value: "G", label: "Girls"  },
  { value: "W", label: "Womens" },
  { value: "U", label: "Unisex" },
  { value: "T", label: "Toddler" },
];

const LIFECYCLE_OPTIONS = ["active", "phased_out", "discontinued", "core"];
const PLANNING_OPTIONS  = ["", "core", "seasonal", "fashion"];
// Denim rise classification (style_master.rise). Blank = not applicable.
const RISE_OPTIONS      = ["", "HIGH", "MID", "LOW"];

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = {
  ...btnSecondary, color: C.danger, borderColor: "#7f1d1d",
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  // Freeze the header row when the list scrolls (the table is wrapped in a
  // scrolling container below; sticky positions relative to that ancestor).
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

function genderLabelFor(code: string | null, labelMap?: Map<string, string>): string {
  if (!code) return "—";
  if (labelMap && labelMap.has(code)) return labelMap.get(code)!;
  const hit = GENDER_FALLBACK.find((o) => o.value === code);
  return hit ? hit.label : code;
}

export default function InternalStyleMaster() {
  const [rows, setRows] = useState<Style[]>([]);
  const smThumbs = useStyleThumbs(rows.map((r) => r.id));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Polish ask A — search-as-you-type. `q` binds to the input (synchronous);
  // `qDebounced` is what drives the fetch effect. 200 ms matches the cadence
  // used by Customer Master, COA, and the T6 GlobalSearchPalette.
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  // "Needs review" filter — shows only styles flagged by an Inventory Planning
  // promotion (attributes.needs_review / source=planning_promoted) so a
  // merchandiser can complete their details. Defaults ON when arrived at via
  // the notification deep-link (?review=1).
  const [reviewOnly, setReviewOnly] = useState<boolean>(() => {
    try { return new URLSearchParams(window.location.search).get("review") === "1"; } catch { return false; }
  });
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Style | null>(null);
  const [assigningScales, setAssigningScales] = useState(false);
  // Universal row-click primitive (operator ask #4) — click anywhere on a
  // row (except Edit/Delete buttons) to open the edit modal. Soft-deleted
  // rows are non-interactive.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { getRowProps } = useRowClickEdit<Style>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit style ${r.style_code}${r.style_name ? ` ${r.style_name}` : ""}`,
    disabled: (r) => !!r.deleted_at,
  });

  // Universal column visibility — gear-icon next to search; choices persist
  // per-user via user_preferences (key='table_visibility').
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    STYLE_MASTER_TABLE_KEY,
    STYLE_MASTER_COLUMNS,
  );
  const isVisible = useCallback((k: string) => visibleColumns.has(k), [visibleColumns]);

  // Polish ask B — admin gate for the "+ Add new…" classifier path. Same
  // signal the mirror-status panel uses: a non-empty cached MS auth user
  // uuid is what the operator gets only after completing MS sign-in.
  const authUserId = getCachedAuthUserId();
  const isAdmin = !!authUserId;

  // Chunk J items 10/11 — classifier option lists now come from the
  // style_classifications master (/api/internal/style-classifications?kind=…),
  // not the old dim-values endpoint. Fetched once on mount, refreshed after a
  // save (so a newly-added classification becomes visible without a reload).
  const [dimValues, setDimValues] = useState<DimValues>({
    groups: [],
    categories: [],
    sub_categories: [],
  });

  const loadDimValues = useCallback(async () => {
    try {
      const [gr, cr, sr] = await Promise.all([
        fetch(`/api/internal/style-classifications?kind=group`),
        fetch(`/api/internal/style-classifications?kind=category`),
        fetch(`/api/internal/style-classifications?kind=sub_category`),
      ]);
      const names = async (r: Response): Promise<string[]> => {
        if (!r.ok) return [];
        const d = await r.json();
        return Array.isArray(d)
          ? d.map((x: { name?: string }) => x?.name).filter((n): n is string => typeof n === "string")
          : [];
      };
      const [groups, categories, sub_categories] = await Promise.all([
        names(gr),
        names(cr),
        names(sr),
      ]);
      setDimValues({ groups, categories, sub_categories });
    } catch {
      /* non-fatal — modal will show whatever values resolved */
    }
  }, []);

  // Chunk J item 4 — brand list for the create/edit picker + list column.
  const [brands, setBrands] = useState<Brand[]>([]);
  const loadBrands = useCallback(async () => {
    try {
      const r = await fetch(`/api/internal/brands`);
      if (!r.ok) return;
      const d = await r.json();
      if (d && Array.isArray(d.brands)) setBrands(d.brands as Brand[]);
    } catch { /* non-fatal */ }
  }, []);
  const brandNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of brands) m.set(b.id, b.name);
    return m;
  }, [brands]);

  // Size scales — id → code, so the list can show each style's assigned scale
  // (the auto-assign / per-style picker writes style_master.size_scale_id).
  const [scales, setScales] = useState<Array<{ id: string; code: string }>>([]);
  const loadScales = useCallback(async () => {
    try {
      const r = await fetch(`/api/internal/size-scales`);
      if (!r.ok) return;
      const d = await r.json();
      const arr = Array.isArray(d) ? d : (Array.isArray(d?.scales) ? d.scales : []);
      setScales(arr.map((s: Record<string, unknown>) => ({ id: s.id as string, code: (s.code as string) || "" })));
    } catch { /* non-fatal */ }
  }, []);
  const scaleCodeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scales) m.set(s.id, s.code);
    return m;
  }, [scales]);

  // Chunk J item 13 — gender list from gender_master (carries Toddler "T").
  const [genders, setGenders] = useState<GenderMaster[]>([]);
  const loadGenders = useCallback(async () => {
    try {
      const r = await fetch(`/api/internal/genders`);
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d)) setGenders(d as GenderMaster[]);
    } catch { /* non-fatal */ }
  }, []);
  const genderLabelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of genders) m.set(g.code, g.label);
    return m;
  }, [genders]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeDeleted) params.set("include_deleted", "true");
      const r = await fetch(`/api/internal/style-master?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Style[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [qDebounced, includeDeleted]);

  useEffect(() => { void load(); }, [load]);

  // Styles awaiting review = flagged by a planning promotion. Filtered
  // client-side from the loaded set (the subset is small + recent).
  const isNeedsReview = (s: Style): boolean => {
    const a = s.attributes as { needs_review?: unknown; source?: unknown } | null | undefined;
    return !!a && (a.needs_review === true || a.source === "planning_promoted");
  };
  const reviewCount = useMemo(() => rows.filter(isNeedsReview).length, [rows]);
  const visibleRows = useMemo(() => (reviewOnly ? rows.filter(isNeedsReview) : rows), [rows, reviewOnly]);
  useEffect(() => { void loadDimValues(); }, [loadDimValues]);
  useEffect(() => { void loadBrands(); }, [loadBrands]);
  useEffect(() => { void loadGenders(); }, [loadGenders]);
  useEffect(() => { void loadScales(); }, [loadScales]);

  async function softDelete(id: string) {
    if (!(await confirmDialog("Soft-delete this style? Can be restored by an admin SQL update."))) return;
    try {
      const r = await fetch(`/api/internal/style-master/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  // Bulk best-match size-scale assignment. Previews first (no write), shows the
  // per-scale breakdown, then applies on confirm. Only styles WITHOUT a scale
  // are touched (nothing is overwritten). Per-style manual override stays in the
  // edit modal's "Size Scale" field.
  async function autoAssignScales() {
    setAssigningScales(true);
    try {
      const pr = await fetch("/api/internal/style-master/auto-assign-scales");
      const prev = await pr.json();
      if (!pr.ok) throw new Error(prev.error || `HTTP ${pr.status}`);
      if (!prev.matched) { notify(prev.error || "No unscaled styles could be matched to a size scale.", "info"); return; }
      const breakdown = Object.entries(prev.by_scale || {})
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map(([k, v]) => `${k}: ${v}`).join(" · ");
      const ok = await confirmDialog(
        `Assign size scales to ${prev.matched} of ${prev.considered} unscaled styles (best match on their size variants)?\n\n${breakdown}\n\nSkipped ${prev.skipped} (ambiguous or no good match). Only styles without a scale are changed — nothing is overwritten, and you can still fine-tune any style in its edit modal.`,
        { title: "Auto-assign size scales", icon: "🎯", confirmText: `Assign ${prev.matched}` },
      );
      if (!ok) return;
      const ar = await fetch("/api/internal/style-master/auto-assign-scales", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const applied = await ar.json();
      if (!ar.ok) throw new Error(applied.error || `HTTP ${ar.status}`);
      notify(`Assigned size scales to ${applied.updated ?? prev.matched} styles.`, "success");
      await load();
    } catch (e: unknown) {
      notify(`Auto-assign failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setAssigningScales(false);
    }
  }

  // Download the styles the auto-assign SKIPS (single/pair sizes, no good match)
  // so they can be hand-assigned a scale. xlsx with the reason per style.
  async function downloadSkippedScales() {
    const REASON_LABEL: Record<string, string> = {
      too_few_sizes: "Fewer than 3 sizes (single / pair)",
      no_overlap: "No matching scale",
      low_coverage: "Weak match (<60% of sizes covered)",
      no_variants: "No sizes on record",
    };
    setAssigningScales(true);
    try {
      const r = await fetch("/api/internal/style-master/auto-assign-scales?skipped=1");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const list = (j.skipped_styles || []) as Array<{ style_code: string; sizes: string; gender: string; reason: string }>;
      if (!list.length) { notify("No skipped styles — every unscaled style matched a scale.", "info"); return; }
      exportXlsx({
        rows: list.map((s) => ({
          style_code: s.style_code,
          sizes: s.sizes,
          gender: s.gender,
          reason: REASON_LABEL[s.reason] || s.reason,
        })),
        columns: [
          { key: "style_code", header: "Style Code" },
          { key: "sizes", header: "Size Variants" },
          { key: "gender", header: "Gender" },
          { key: "reason", header: "Why skipped" },
        ],
        filename: "size-scale-skipped",
        sheetName: "Skipped styles",
      });
      notify(`Downloaded ${list.length} skipped styles to assign by hand.`, "success");
    } catch (e: unknown) {
      notify(`Download failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setAssigningScales(false);
    }
  }

  // Refresh hook handed to the modal so a successful save can repaint both
  // the row list AND the dim-value cache (in case a brand-new classifier
  // was added).
  const afterModalSave = useCallback(() => {
    void load();
    void loadDimValues();
  }, [load, loadDimValues]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Style Master</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => void autoAssignScales()}
            style={btnSecondary}
            disabled={assigningScales}
            title="Match each unscaled style to the best-fitting size scale by its size variants (preview before applying)"
          >
            {assigningScales ? "Assigning…" : "🎯 Auto-assign size scales"}
          </button>
          <button
            onClick={() => void downloadSkippedScales()}
            style={btnSecondary}
            disabled={assigningScales}
            title="Download the styles the auto-assign skips (single/pair sizes or no good match), with the reason, to assign a scale by hand"
          >
            ⬇ Skipped styles
          </button>
          <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add style</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <DynamicSearchInput
          value={q}
          onChange={setQ}
          placeholder="Search style number, name or description…"
          ariaLabel="Search styles"
          wrapperStyle={{ maxWidth: 360 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          Show deleted
        </label>
        <label
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: reviewCount > 0 ? "#D97706" : C.textSub, fontWeight: reviewCount > 0 ? 700 : 400 }}
          title="Show only styles promoted from Inventory Planning that still need their master details completed"
        >
          <input
            type="checkbox"
            checked={reviewOnly}
            onChange={(e) => setReviewOnly(e.target.checked)}
          />
          ⚠ Needs review{reviewCount > 0 ? ` (${reviewCount})` : ""}
        </label>
        <TablePrefsButton
          tableKey={STYLE_MASTER_TABLE_KEY}
          columns={STYLE_MASTER_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={visibleRows.map((r) => ({
            ...r,
            base_fabric_code: r.base_fabric?.code ?? null,
            base_fabric_name: r.base_fabric?.name ?? null,
            brand_name: r.brand_id ? (brandNameById.get(r.brand_id) ?? null) : null,
            size_scale_code: r.size_scale_id ? (scaleCodeById.get(r.size_scale_id) ?? null) : null,
          })) as unknown as Array<Record<string, unknown>>}
          filename="style-master"
          sheetName="Style Master"
          columns={[
            { key: "style_code",        header: "Style Number" },
            { key: "style_name",        header: "Style Name" },
            { key: "description",       header: "Description" },
            { key: "gender_code",       header: "Gender" },
            { key: "group_name",        header: "Group" },
            { key: "category_name",     header: "Category" },
            { key: "sub_category_name", header: "Sub Category" },
            { key: "brand_name",        header: "Brand" },
            { key: "size_scale_code",   header: "Size Scale" },
            { key: "season",            header: "Season" },
            { key: "design_year",       header: "Year", format: "number" },
            { key: "lifecycle_status",  header: "Lifecycle" },
            { key: "is_apparel",        header: "Apparel" },
            { key: "planning_class",    header: "Planning Class" },
            { key: "base_fabric_code",  header: "Base Fabric Code" },
            { key: "base_fabric_name",  header: "Base Fabric Name" },
            { key: "base_fabric_legacy", header: "Base Fabric (legacy text)" },
            { key: "hts_code",          header: "HTS Code" },
            { key: "launch_date",       header: "Launch Date", format: "date" },
            { key: "created_at",        header: "Created", format: "datetime" },
            { key: "updated_at",        header: "Updated", format: "datetime" },
            { key: "deleted_at",        header: "Deleted", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 220px)", overflowY: "auto", overflowX: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : visibleRows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            {reviewOnly ? "No styles awaiting review." : "No styles found."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 52, textAlign: "center" }}>Img</th>
                <th style={th} hidden={!isVisible("style_code")}>Style Number</th>
                <th style={th} hidden={!isVisible("style_name")}>Style Name</th>
                <th style={th} hidden={!isVisible("description")}>Description</th>
                <th style={th} hidden={!isVisible("gender_code")}>Gender</th>
                <th style={th} hidden={!isVisible("group_name")}>Group</th>
                <th style={th} hidden={!isVisible("category_name")}>Category</th>
                <th style={th} hidden={!isVisible("sub_category_name")}>Sub Category</th>
                <th style={th} hidden={!isVisible("brand_name")}>Brand</th>
                <th style={th} hidden={!isVisible("size_scale_code")}>Size Scale</th>
                <th style={th} hidden={!isVisible("base_fabric")}>Base Fabric</th>
                <th style={th} hidden={!isVisible("hts_code")}>HTS</th>
                <th style={th} hidden={!isVisible("season")}>Season</th>
                <th style={th} hidden={!isVisible("design_year")}>Year</th>
                <th style={th} hidden={!isVisible("lifecycle_status")}>Lifecycle</th>
                <th style={th} hidden={!isVisible("is_apparel")}>Apparel</th>
                <th style={{ ...th, width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <ScrollHighlightRow
                  key={r.id}
                  rowId={r.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(r)}
                  style={r.deleted_at ? { opacity: 0.4 } : undefined}
                >
                  <td style={{ ...td, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <StyleThumb styleId={r.id} label={r.style_code} url={smThumbs.get(r.id)?.default ?? null} />
                  </td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("style_code")}>
                    {r.style_code}
                  </td>
                  <td style={td} hidden={!isVisible("style_name")}>{r.style_name || "—"}</td>
                  <td style={td} hidden={!isVisible("description")}>{r.description}</td>
                  <td style={td} hidden={!isVisible("gender_code")}>{genderLabelFor(r.gender_code, genderLabelMap)}</td>
                  <td style={td} hidden={!isVisible("group_name")}>{r.group_name || "—"}</td>
                  <td style={td} hidden={!isVisible("category_name")}>{r.category_name || "—"}</td>
                  <td style={td} hidden={!isVisible("sub_category_name")}>{r.sub_category_name || "—"}</td>
                  <td style={td} hidden={!isVisible("brand_name")}>{r.brand_id ? (brandNameById.get(r.brand_id) || "—") : "—"}</td>
                  <td style={td} hidden={!isVisible("size_scale_code")}>{r.size_scale_id ? (scaleCodeById.get(r.size_scale_id) || "…") : "—"}</td>
                  <td style={td} hidden={!isVisible("base_fabric")}>
                    {r.base_fabric
                      ? <span><strong>{r.base_fabric.code}</strong> — {r.base_fabric.name}</span>
                      : r.base_fabric_legacy
                        ? <span style={{ color: C.warn }} title="Legacy free-text — re-pick in edit modal">{r.base_fabric_legacy}</span>
                        : "—"}
                  </td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!isVisible("hts_code")}>{r.hts_code || "—"}</td>
                  <td style={td} hidden={!isVisible("season")}>{r.season || "—"}</td>
                  <td style={td} hidden={!isVisible("design_year")}>{r.design_year ?? "—"}</td>
                  <td style={td} hidden={!isVisible("lifecycle_status")}>{r.lifecycle_status}</td>
                  <td style={td} hidden={!isVisible("is_apparel")}>{r.is_apparel ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {!r.deleted_at && (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); setEditing(r); }} style={btnSecondary}>Edit</button>
                        <button onClick={(e) => { e.stopPropagation(); void softDelete(r.id); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                      </>
                    )}
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && (
        <StyleFormModal
          mode="add"
          dimValues={dimValues}
          brands={brands}
          genders={genders}
          isAdmin={isAdmin}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); afterModalSave(); }}
        />
      )}
      {editing && (
        <StyleFormModal
          mode="edit"
          style={editing}
          dimValues={dimValues}
          brands={brands}
          genders={genders}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); afterModalSave(); }}
        />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  style?: Style;
  dimValues: DimValues;
  brands: Brand[];
  genders: GenderMaster[];
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function StyleFormModal({ mode, style, dimValues, brands, genders, isAdmin, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    style_code:           style?.style_code            ?? "",
    style_name:           style?.style_name            ?? "",
    description:          style?.description           ?? "",
    gender_code:          style?.gender_code           ?? "",
    season:               style?.season                ?? "",
    design_year:          style?.design_year           != null ? String(style.design_year) : "",
    lifecycle_status:     style?.lifecycle_status      ?? "active",
    planning_class:       style?.planning_class        ?? "",
    is_apparel:           style?.is_apparel            ?? true,
    base_fabric_code_id:  style?.base_fabric_code_id   ?? "",
    group_name:           style?.group_name            ?? "",
    category_name:        style?.category_name         ?? "",
    sub_category_name:    style?.sub_category_name     ?? "",
    brand_id:             style?.brand_id              ?? "",
    size_scale_id:        style?.size_scale_id         ?? "",
    rise:                 style?.rise                  ?? "",
    hts_code:             style?.hts_code              ?? "",
    duty_rate_pct:        style?.duty_rate_pct != null ? String(style.duty_rate_pct) : "",
  });
  // AI HTS classification state (Claude Haiku via /api/internal/hts/suggest).
  type HtsSuggestion = { code: string; description: string; duty_rate_pct?: number; confidence: string; reasoning: string };
  const [htsSuggestions, setHtsSuggestions] = useState<HtsSuggestion[]>([]);
  const [htsLoading, setHtsLoading] = useState(false);
  const [htsErr, setHtsErr] = useState<string | null>(null);
  const [fabrics, setFabrics] = useState<FabricCodeLite[]>([]);
  const [sizeScales, setSizeScales] = useState<SizeScaleLite[]>([]);
  const [seasons, setSeasons] = useState<SeasonLite[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Opt-in GS1 UPC minting (add mode only). Disabled until we confirm a GS1
  // company prefix is configured — minting without one would produce invalid
  // barcodes, so we gate the checkbox instead.
  const [generateUpcs, setGenerateUpcs] = useState(false);
  const [gs1HasPrefix, setGs1HasPrefix] = useState<boolean | null>(null);

  // COO × HTS — up to 3 country-of-origin rows, each with its own HTS code +
  // duty rate. Persisted in style attributes.coo_hts; row 0 stays synced to the
  // legacy hts_code / duty_rate_pct columns (which costing / customs / PO read).
  const [countries, setCountries] = useState<{ iso2: string; name: string }[]>([]);
  const [coo, setCoo] = useState<{ country: string; hts_code: string; duty_rate_pct: string }[]>(() => {
    const fromAttr = (style?.attributes as Record<string, unknown> | undefined)?.coo_hts;
    if (Array.isArray(fromAttr) && fromAttr.length > 0) {
      return fromAttr.slice(0, 3).map((c) => {
        const o = (c ?? {}) as Record<string, unknown>;
        return {
          country: o.country != null ? String(o.country) : "",
          hts_code: o.hts_code != null ? String(o.hts_code) : "",
          duty_rate_pct: o.duty_rate_pct != null ? String(o.duty_rate_pct) : "",
        };
      });
    }
    // Seed one primary row from the legacy single hts_code / duty_rate.
    return [{ country: "", hts_code: style?.hts_code ?? "", duty_rate_pct: style?.duty_rate_pct != null ? String(style.duty_rate_pct) : "" }];
  });
  // Per-style size-scale PACK ratio (size → representative qty), e.g. { S:2, M:3,
  // L:3, XL:2 }. Defines how a single total typed into the SO / PO matrix Qty
  // column is split across sizes. Persisted in style attributes.size_scale_pack.
  const [scaleOpen, setScaleOpen] = useState(false);
  const [scalePack, setScalePack] = useState<Record<string, number>>(() => {
    const fromAttr = (style?.attributes as Record<string, unknown> | undefined)?.size_scale_pack;
    const out: Record<string, number> = {};
    if (fromAttr && typeof fromAttr === "object") {
      for (const [k, v] of Object.entries(fromAttr as Record<string, unknown>)) {
        const n = Math.floor(Number(v));
        if (k && Number.isFinite(n) && n > 0) out[k] = n;
      }
    }
    return out;
  });

  // Which COO row's AI "Suggest HTS" list is currently open / loading (null = none).
  const [htsRowIdx, setHtsRowIdx] = useState<number | null>(null);
  const setCooField = (idx: number, key: "country" | "hts_code" | "duty_rate_pct", val: string) =>
    setCoo((rows) => rows.map((r, i) => (i === idx ? { ...r, [key]: val } : r)));
  const addCoo = () => setCoo((rows) => (rows.length >= 3 ? rows : [...rows, { country: "", hts_code: "", duty_rate_pct: "" }]));
  const removeCoo = (idx: number) => setCoo((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== idx)));
  const countryOptions = useMemo(() => countries.map((c) => ({ value: c.name, label: c.name, searchHaystack: `${c.name} ${c.iso2}` })), [countries]);

  // Sizes that the Scale window lets the operator enter a pack qty for — taken
  // (in order) from the style's currently-selected size scale. Empty until a
  // size scale is picked.
  const scaleSizes = useMemo<string[]>(() => {
    const s = sizeScales.find((x) => x.id === form.size_scale_id);
    return Array.isArray(s?.sizes) ? s!.sizes : [];
  }, [sizeScales, form.size_scale_id]);
  const scaleTotal = useMemo(() => scaleSizes.reduce((t, sz) => t + (scalePack[sz] || 0), 0), [scaleSizes, scalePack]);
  const setScaleQty = (sz: string, raw: string) =>
    setScalePack((p) => {
      const n = Math.floor(Number(raw));
      const next = { ...p };
      if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) delete next[sz];
      else next[sz] = n;
      return next;
    });

  // Country list (country_master) for the COO pickers — ISO-2 + name.
  useEffect(() => {
    fetch("/api/internal/countries")
      .then((r) => (r.ok ? r.json() : []))
      .then((arr) => setCountries(Array.isArray(arr) ? (arr as { iso2: string; name: string }[]) : []))
      .catch(() => {/* non-fatal */});
  }, []);

  // Load active fabric_codes for the SearchableSelect picker. Errors are
  // non-fatal — the operator can still save without a fabric.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/fabric-codes?limit=5000`);
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && Array.isArray(data)) setFabrics(data as FabricCodeLite[]);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load active size_scales for the SearchableSelect picker. Non-fatal on error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/size-scales`);
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && Array.isArray(data)) setSizeScales(data as SizeScaleLite[]);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load active seasons for the SearchableSelect picker. Non-fatal on error.
  // style_master.season stays free TEXT storing the chosen season NAME — this
  // picklist is purely additive (no FK).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/seasons`);
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && Array.isArray(data)) setSeasons(data as SeasonLite[]);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Probe whether a GS1 company prefix is configured so we can enable/disable
  // the "Generate UPCs" checkbox. Add mode only — existing styles keep their
  // Xoro/Excel UPCs untouched. Non-fatal on error (checkbox stays disabled).
  useEffect(() => {
    if (mode !== "add") return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/upc-items?check_prefix=1`);
        if (!r.ok) { if (!cancelled) setGs1HasPrefix(false); return; }
        const data = await r.json();
        if (!cancelled) setGs1HasPrefix(!!data?.has_prefix);
      } catch { if (!cancelled) setGs1HasPrefix(false); }
    })();
    return () => { cancelled = true; };
  }, [mode]);

  // Season picker options — value === label === the season NAME (free text).
  // The style's existing season is surfaced even if it isn't in the master list.
  const seasonOptions: SearchableSelectOption[] = useMemo(() => {
    const opts: SearchableSelectOption[] = [
      { value: "", label: "(select)" },
      ...seasons.map((s) => ({
        value: s.name,
        label: s.name,
        searchHaystack: `${s.code} ${s.name}`,
      })),
    ];
    if (form.season && !seasons.some((s) => s.name === form.season)) {
      opts.push({ value: form.season, label: form.season });
    }
    return opts;
  }, [seasons, form.season]);

  // Admin "+ Add new…" grows the season_master (POST). Set the value immediately
  // for snappy UX; a 409 (already exists) is treated as success since the name
  // is what we wanted on the row anyway.
  const addSeason = useCallback((qRaw: string) => {
    const name = qRaw.trim();
    if (!name) return;
    setForm((f) => ({ ...f, season: name }));
    setSeasons((prev) => prev.some((s) => s.name === name) ? prev : [...prev, { id: name, code: "", name }]);
    void (async () => {
      try {
        const r = await fetch(`/api/internal/seasons`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!r.ok && r.status !== 409) {
          const msg = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
          notify(`Could not save new season to master: ${msg}`, "error");
        }
      } catch (e: unknown) {
        notify(`Could not save new season to master: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    })();
  }, []);

  const sizeScaleOptions: SearchableSelectOption[] = useMemo(() => {
    const opts: SearchableSelectOption[] = [
      { value: "", label: "(select)" },
      ...sizeScales.map((s) => ({
        value: s.id,
        label: `${s.code} — ${s.name}`,
        searchHaystack: `${s.code} ${s.name}`,
      })),
    ];
    // Defensive: surface the style's current scale if it didn't come back
    // from the active-only fetch (e.g. it was later deactivated).
    if (form.size_scale_id && !sizeScales.some((s) => s.id === form.size_scale_id)) {
      opts.push({ value: form.size_scale_id, label: form.size_scale_id });
    }
    return opts;
  }, [sizeScales, form.size_scale_id]);

  const fabricOptions: SearchableSelectOption[] = useMemo(() => {
    const opts: SearchableSelectOption[] = [
      { value: "", label: "(select)" },
      ...fabrics.map((f) => ({
        value: f.id,
        label: `${f.code} — ${f.name}`,
        searchHaystack: `${f.code} ${f.name} ${f.composition_text}`,
      })),
    ];
    // Defensive: if the style's current FK points at a fabric that didn't
    // come back from the limited fetch (rare — only if >500 active fabrics
    // exist), surface it via the embedded join so the picker can render it.
    if (
      style?.base_fabric_code_id &&
      style.base_fabric &&
      !fabrics.some((f) => f.id === style.base_fabric_code_id)
    ) {
      opts.push({
        value: style.base_fabric_code_id,
        label: `${style.base_fabric.code} — ${style.base_fabric.name}`,
      });
    }
    return opts;
  }, [fabrics, style?.base_fabric_code_id, style?.base_fabric]);

  // Chunk J item 13 — gender options from gender_master (falls back to the
  // hardcoded set only if the fetch hasn't resolved). A "(none)" row leads.
  const genderSelectOptions = useMemo(() => {
    const base = genders.length > 0
      ? genders.map((g) => ({ value: g.code, label: g.label }))
      : GENDER_FALLBACK.filter((o) => o.value !== "");
    const opts = [{ value: "", label: "(select)" }, ...base];
    // Defensive: surface the current saved code if the master doesn't list it.
    if (form.gender_code && !opts.some((o) => o.value === form.gender_code)) {
      opts.push({ value: form.gender_code, label: form.gender_code });
    }
    return opts;
  }, [genders, form.gender_code]);

  // Chunk J item 4 — brand picker options.
  const brandOptions: SearchableSelectOption[] = useMemo(() => {
    const opts: SearchableSelectOption[] = [
      { value: "", label: "(select)" },
      ...brands.map((b) => ({ value: b.id, label: b.name, searchHaystack: `${b.code} ${b.name}` })),
    ];
    if (form.brand_id && !brands.some((b) => b.id === form.brand_id)) {
      opts.push({ value: form.brand_id, label: form.brand_id });
    }
    return opts;
  }, [brands, form.brand_id]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      // COO × HTS rows → persisted array (attributes.coo_hts) + the primary (row 0)
      // mirrored onto the legacy hts_code / duty_rate_pct columns. Drop blank rows.
      const cooRows = coo
        .map((r) => ({ country: r.country.trim(), hts_code: r.hts_code.trim(), duty_rate_pct: r.duty_rate_pct.trim() === "" ? null : Number(r.duty_rate_pct) }))
        .filter((r) => r.country || r.hts_code || r.duty_rate_pct != null);
      const body: Record<string, unknown> = {
        style_name:           form.style_name.trim() || null,
        description:          form.description.trim(),
        gender_code:          form.gender_code || null,
        season:               form.season || null,
        design_year:          form.design_year ? parseInt(form.design_year, 10) : null,
        lifecycle_status:     form.lifecycle_status,
        planning_class:       form.planning_class || null,
        is_apparel:           form.is_apparel,
        base_fabric_code_id:  form.base_fabric_code_id || null,
        group_name:           form.group_name.trim() || null,
        category_name:        form.category_name.trim() || null,
        sub_category_name:    form.sub_category_name.trim() || null,
        brand_id:             form.brand_id || null,
        size_scale_id:        form.size_scale_id || null,
        rise:                 form.rise.trim() || null,
        hts_code:             cooRows[0]?.hts_code || null,
        duty_rate_pct:        cooRows[0]?.duty_rate_pct ?? null,
        attributes:           { ...(style?.attributes ?? {}), coo_hts: cooRows, size_scale_pack: scalePack },
      };
      let url: string;
      let method: string;
      if (mode === "add") {
        body.style_code = form.style_code.trim().toUpperCase();
        // Opt-in GS1 UPC minting — only sent when the prefix is configured and
        // the operator ticked the box.
        if (generateUpcs && gs1HasPrefix) body.generate_upcs = true;
        url = "/api/internal/style-master";
        method = "POST";
      } else {
        url = `/api/internal/style-master/${style!.id}`;
        method = "PATCH";
      }
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      // Surface the UPC minting outcome (add mode + opt-in). The style is saved
      // regardless; minting runs server-side after insert.
      if (mode === "add" && body.generate_upcs) {
        const saved = await r.json().catch(() => ({}));
        const m = saved?.upc_minting;
        if (m) {
          if (m.minted > 0) notify(`Minted ${m.minted} GS1 UPC${m.minted === 1 ? "" : "s"} for this style.`, "success");
          else if (m.skipped) notify(`No UPCs minted: ${m.reason || "nothing to mint"}`, "info");
        }
      }
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // AI HTS suggestion — HTS is STYLE-specific (same fabric → different code for
  // a pant vs a jacket), so we classify from the style's Group (top/bottom/
  // accessory) + the linked base fabric's composition.
  async function fetchHtsSuggestions(idx: number) {
    setHtsRowIdx(idx);
    const fabric = fabrics.find((f) => f.id === form.base_fabric_code_id);
    const fabricContent = (fabric?.composition_text || "").trim();
    if (!form.group_name.trim() && !fabricContent) {
      setHtsErr("Pick a Group and a Base fabric (with composition) first.");
      return;
    }
    // Gender is decisive for apparel HTS (men's/boys' vs women's/girls' classify
    // differently) — resolve the code to its descriptive label for the prompt.
    const genderLabel = form.gender_code
      ? (genders.find((g) => g.code === form.gender_code)?.label
         || GENDER_FALLBACK.find((o) => o.value === form.gender_code)?.label
         || form.gender_code)
      : "";
    setHtsLoading(true);
    setHtsErr(null);
    setHtsSuggestions([]);
    try {
      const r = await fetch("/api/internal/hts/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fabric_content: fabricContent,
          category: form.group_name.trim(),       // top / bottom / accessory
          gender: genderLabel,                     // Mens / Womens / Boys / Girls / …
          country_of_origin: coo[idx]?.country || "",  // drives the country-specific duty rate
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setHtsSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      if (data.note) setHtsErr(data.note);
    } catch (e: unknown) {
      setHtsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setHtsLoading(false);
    }
  }

  // Pick a suggestion → set the style's hts_code AND auto-fill the HTS Master
  // reference table (best-effort; a 409/dup or error never blocks).
  async function pickHtsSuggestion(s: HtsSuggestion) {
    const idx = htsRowIdx ?? 0;
    setCoo((rows) => rows.map((r, i) => (i === idx
      ? { ...r, hts_code: s.code, duty_rate_pct: s.duty_rate_pct != null ? String(s.duty_rate_pct) : r.duty_rate_pct }
      : r)));
    setHtsSuggestions([]);
    setHtsRowIdx(null);
    const digits = String(s.code).replace(/\D/g, "");
    try {
      await fetch("/api/internal/hts-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: s.code,
          description: s.description || s.code,
          chapter: digits.slice(0, 2) || null,
          heading: digits.slice(0, 4) || null,
          duty_rate_pct: s.duty_rate_pct ?? null,
          notes: "Auto-added from AI HTS classification (Style Master)",
        }),
      });
    } catch { /* non-fatal */ }
  }

  const title =
    mode === "add"
      ? "Add Style"
      : `Style: ${style?.style_code ?? ""}${style?.style_name ? ` ${style.style_name}` : ""}`;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 24, width: "min(92vw, 760px)", maxHeight: "90vh", overflowY: "auto", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{title}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Style Number">
            {mode === "add" ? (
              <input
                type="text"
                value={form.style_code}
                onChange={(e) => setForm({ ...form, style_code: e.target.value })}
                style={inputStyle}
                placeholder="e.g. RY1234"
                autoFocus
              />
            ) : (
              <input type="text" value={form.style_code} disabled style={{ ...inputStyle, opacity: 0.6 }} />
            )}
          </Field>
          <Field label="Style Name">
            <input
              type="text"
              value={form.style_name}
              onChange={(e) => setForm({ ...form, style_name: e.target.value })}
              style={inputStyle}
              placeholder="Short marketing/internal name"
            />
          </Field>
          <Field label="Description">
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              style={inputStyle}
              placeholder="Free-text description"
            />
          </Field>
          <Field label="Gender">
            <select
              value={form.gender_code}
              onChange={(e) => setForm({ ...form, gender_code: e.target.value })}
              style={inputStyle as React.CSSProperties}
            >
              {genderSelectOptions.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </Field>

          {/* Polish ask B — classifier dropdowns. Options sourced from the
              dim-values endpoint (distinct values across the whole catalog).
              When isAdmin, the SearchableSelect surfaces an "+ Add new…" row
              that commits whatever the operator typed; non-admins see the
              existing values only. */}
          <Field label="Group">
            <DimValuePicker
              value={form.group_name}
              onChange={(v) => setForm({ ...form, group_name: v })}
              choices={dimValues.groups}
              isAdmin={isAdmin}
              placeholder="Pick a group…"
              addNewTitle="group"
              kind="group"
            />
          </Field>
          <Field label="Category">
            <DimValuePicker
              value={form.category_name}
              onChange={(v) => setForm({ ...form, category_name: v })}
              choices={dimValues.categories}
              isAdmin={isAdmin}
              placeholder="Pick a category…"
              addNewTitle="category"
              kind="category"
            />
          </Field>
          <Field label="Sub Category">
            <DimValuePicker
              value={form.sub_category_name}
              onChange={(v) => setForm({ ...form, sub_category_name: v })}
              choices={dimValues.sub_categories}
              isAdmin={isAdmin}
              placeholder="Pick a sub-category…"
              addNewTitle="sub-category"
              kind="sub_category"
            />
          </Field>

          {/* Chunk J item 4 — brand picker (style_master.brand_id). */}
          <Field label="Brand">
            <SearchableSelect
              value={form.brand_id || null}
              onChange={(v) => setForm({ ...form, brand_id: v })}
              options={brandOptions}
              placeholder="Pick a brand…"
            />
          </Field>

          {/* Size Scale picker (style_master.size_scale_id) + the per-style Scale
              (pack ratio) editor used to auto-fill the SO / PO matrices. */}
          <Field label="Size Scale">
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <SearchableSelect
                  value={form.size_scale_id || null}
                  onChange={(v) => setForm({ ...form, size_scale_id: v })}
                  options={sizeScaleOptions}
                  placeholder="Pick a size scale…"
                />
              </div>
              <button
                type="button"
                onClick={() => setScaleOpen(true)}
                disabled={!form.size_scale_id}
                style={{ ...btnSecondary, whiteSpace: "nowrap", flexShrink: 0, opacity: form.size_scale_id ? 1 : 0.5 }}
                title={form.size_scale_id
                  ? "Define a pack ratio per size — typing one total in the SO/PO matrix auto-fills every size from this"
                  : "Pick a size scale first"}
              >
                📐 Scale{scaleTotal > 0 ? ` (${scaleTotal})` : ""}
              </button>
            </div>
          </Field>

          {/* Rise (style_master.rise) — denim HIGH/MID/LOW; blank = n/a. */}
          <Field label="Rise">
            <select
              value={form.rise}
              onChange={(e) => setForm({ ...form, rise: e.target.value })}
              style={inputStyle as React.CSSProperties}
            >
              {RISE_OPTIONS.map((r) => <option key={r} value={r}>{r || "(select)"}</option>)}
            </select>
          </Field>

          <Field label="Season">
            <SearchableSelect
              value={form.season || null}
              onChange={(v) => setForm({ ...form, season: v })}
              options={seasonOptions}
              placeholder="e.g. FW26"
              onAddNew={isAdmin ? addSeason : undefined}
              addNewLabel={(q) => {
                const trimmed = q.trim();
                return trimmed ? `+ Add new season "${trimmed}"` : "+ Add new season…";
              }}
            />
          </Field>
          <Field label="Design year">
            <input type="number" value={form.design_year} onChange={(e) => setForm({ ...form, design_year: e.target.value })} style={inputStyle} placeholder="2026" />
          </Field>
          <Field label="Lifecycle">
            <select value={form.lifecycle_status} onChange={(e) => setForm({ ...form, lifecycle_status: e.target.value })} style={inputStyle as React.CSSProperties}>
              {LIFECYCLE_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </Field>
          <Field label="Planning class">
            <select value={form.planning_class} onChange={(e) => setForm({ ...form, planning_class: e.target.value })} style={inputStyle as React.CSSProperties}>
              {PLANNING_OPTIONS.map((g) => <option key={g} value={g}>{g || "(select)"}</option>)}
            </select>
          </Field>
          <Field label="Base fabric">
            <SearchableSelect
              value={form.base_fabric_code_id || null}
              onChange={(v) => setForm({ ...form, base_fabric_code_id: v })}
              options={fabricOptions}
              placeholder="Pick a fabric (search code / name / composition)"
            />
            {!form.base_fabric_code_id && style?.base_fabric_legacy && (
              <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>
                Legacy text: <em>{style.base_fabric_legacy}</em> — pick a fabric above to replace it.
              </div>
            )}
          </Field>
          <Field label="HTS code · Duty rate · COO">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {coo.map((row, idx) => (
                <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="text"
                      value={row.hts_code}
                      onChange={(e) => { setCooField(idx, "hts_code", e.target.value); if (htsRowIdx === idx) setHtsSuggestions([]); }}
                      style={{ ...inputStyle, flex: "1 1 auto", minWidth: 120 }}
                      placeholder="e.g. 6203.42.4011"
                    />
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={row.duty_rate_pct}
                      onChange={(e) => setCooField(idx, "duty_rate_pct", e.target.value)}
                      style={{ ...inputStyle, flex: "0 0 11ch", minWidth: 0 }}
                      placeholder="Duty %"
                      title="HTS duty rate % for this country of origin"
                    />
                    <div style={{ flex: "0 0 24ch", minWidth: 0 }}>
                      <SearchableSelect
                        value={row.country || null}
                        onChange={(v) => setCooField(idx, "country", v || "")}
                        options={countryOptions}
                        placeholder="Country of origin…"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void fetchHtsSuggestions(idx)}
                      disabled={htsLoading && htsRowIdx === idx}
                      style={{ ...btnSecondary, whiteSpace: "nowrap", flex: "0 1 auto", minWidth: 0, padding: "6px 10px", overflow: "hidden", textOverflow: "ellipsis" }}
                      title="Use Claude AI to suggest an HTS code + this country's duty rate from the style's Group + base fabric composition"
                    >
                      {htsLoading && htsRowIdx === idx ? "…" : "🤖 Suggest HTS"}
                    </button>
                    {coo.length > 1 && (
                      <button type="button" onClick={() => removeCoo(idx)} style={{ ...btnSecondary, flexShrink: 0, color: "#F87171", borderColor: "#7f1d1d" }} title="Remove this country of origin">✕</button>
                    )}
                  </div>
                  {htsRowIdx === idx && htsErr && <div style={{ fontSize: 11, color: C.warn }}>{htsErr}</div>}
                  {htsRowIdx === idx && htsSuggestions.length > 0 && (
                    <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 4, overflow: "hidden" }}>
                      {htsSuggestions.map((s, i) => (
                        <div
                          key={i}
                          onClick={() => void pickHtsSuggestion(s)}
                          style={{ padding: "7px 10px", cursor: "pointer", borderBottom: i < htsSuggestions.length - 1 ? `1px solid ${C.cardBdr}` : undefined }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = C.card; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, color: C.primary, fontSize: 13 }}>{s.code}</span>
                            <span style={{ fontSize: 11, color: s.confidence === "high" ? C.success : s.confidence === "medium" ? C.warn : C.textMuted }}>{s.confidence}</span>
                          </div>
                          <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{s.description}</div>
                          {s.duty_rate_pct != null && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>Duty: {s.duty_rate_pct}%</div>}
                          {s.reasoning && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, fontStyle: "italic" }}>{s.reasoning}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {coo.length < 3 && (
                <button type="button" onClick={addCoo} style={{ ...btnSecondary, alignSelf: "flex-start" }}>+ Add COO (up to 3)</button>
              )}
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
              AI uses Group (top/bottom/accessory) + Gender + the base fabric's composition; the COO drives the country-specific duty rate (AGOA / USMCA / GSP, etc.). Row 1 is the primary HTS used across costing &amp; customs.
            </div>
          </Field>
          <Field label="Apparel?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_apparel} onChange={(e) => setForm({ ...form, is_apparel: e.target.checked })} />
              Yes (enforce 5-dim matrix on linked items)
            </label>
          </Field>

          {/* Opt-in GS1 UPC minting — add mode only. Disabled (with tooltip)
              until a GS1 company prefix is configured so we never mint invalid
              barcodes. Existing styles keep their Xoro/Excel UPCs untouched. */}
          {mode === "add" && (
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
                UPC Barcodes
              </div>
              <label
                title={
                  gs1HasPrefix === false
                    ? "No GS1 company prefix is configured — set one in Company Settings to enable UPC minting."
                    : "Mint one unique GS1 UPC per color/size for this style in the background on save."
                }
                style={{
                  display: "flex", alignItems: "center", gap: 6, fontSize: 13,
                  color: gs1HasPrefix === false ? C.textMuted : C.textSub,
                  opacity: gs1HasPrefix === false ? 0.55 : 1,
                  cursor: gs1HasPrefix === false ? "not-allowed" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={generateUpcs && gs1HasPrefix !== false}
                  disabled={gs1HasPrefix === false}
                  onChange={(e) => setGenerateUpcs(e.target.checked)}
                />
                Generate UPCs (GS1) — one unique UPC per color/size
              </label>
              {gs1HasPrefix === false && (
                <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>
                  No GS1 company prefix configured — minting is unavailable.
                </div>
              )}
            </div>
          )}
        </div>

        {mode === "edit" && style && (
          <StyleFabricsSection styleId={style.id} />
        )}

        {/* Operator ask #6 — notes log section. Only meaningful on existing
            rows, so we render it for edit mode only. */}
        {mode === "edit" && style && (
          <StyleNotesSection styleId={style.id} />
        )}

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}
          </button>
        </div>
      </div>

      {/* Per-style Scale (pack ratio) editor. Nested over the style form; edits
          local state only — the style's main Save persists it into
          attributes.size_scale_pack. */}
      {scaleOpen && (
        <div
          onClick={() => setScaleOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflow: "auto" }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 4 }}>📐 Size Scale — pack ratio</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
              Enter a representative quantity per size (the ratio is what matters). In an SO or
              PO size matrix, typing one total in the <strong>Qty</strong> column splits it across
              sizes in this proportion, then rounds each size up to a full carton of {24}.
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, position: "static" }}>Size</th>
                  <th style={{ ...th, position: "static", textAlign: "right" }}>Pack qty</th>
                  <th style={{ ...th, position: "static", textAlign: "right" }}>% of pack</th>
                </tr>
              </thead>
              <tbody>
                {scaleSizes.map((sz) => {
                  const q = scalePack[sz] || 0;
                  const pct = scaleTotal > 0 ? (q / scaleTotal) * 100 : 0;
                  return (
                    <tr key={sz} style={{ borderBottom: `1px solid ${C.cardBdr}` }}>
                      <td style={{ padding: "6px 10px", color: C.textSub }}>{sz}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={q ? String(q) : ""}
                          onChange={(e) => { if (/^\d*$/.test(e.target.value)) setScaleQty(sz, e.target.value); }}
                          placeholder="0"
                          style={{ ...inputStyle, width: "8ch", textAlign: "right", fontFamily: "SFMono-Regular, Menlo, monospace" }}
                        />
                      </td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: C.textMuted, fontFamily: "monospace" }}>
                        {q ? `${pct.toFixed(0)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${C.cardBdr}` }}>
                  <td style={{ padding: "8px 10px", fontWeight: 700, color: C.textSub }}>Total</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 800, color: C.primary, fontFamily: "monospace" }}>{scaleTotal || "—"}</td>
                  <td style={{ padding: "8px 10px" }} />
                </tr>
              </tfoot>
            </table>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setScalePack({})} style={btnSecondary} disabled={scaleTotal === 0}>Clear all</button>
              <button type="button" onClick={() => setScaleOpen(false)} style={btnPrimary}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DimValuePicker — Polish ask B.
//
// Wraps <SearchableSelect> with the existing-value list for one classifier
// column (group_name / category_name / sub_category_name). The dropdown is
// pre-populated with the distinct values currently in style_master and
// supports type-as-you-go filtering.
//
// Admin behaviour: when `isAdmin` is true, the popover surfaces an
// "+ Add new <title>…" row. Picking it commits whatever the operator
// typed; the new value will land on the row when the modal saves and
// will appear in subsequent dim-value loads automatically.
//
// Non-admin behaviour: the add-new row is hidden. The picker still lets
// the operator change the value to anything already in the dim list,
// just not add a brand new one. (If the operator is editing a row whose
// classifier is already a free-text value not in the dim list, the
// current value is surfaced as a one-shot option so the picker shows
// it correctly.)
// ─────────────────────────────────────────────────────────────────────────────
function DimValuePicker({
  value,
  onChange,
  choices,
  isAdmin,
  placeholder,
  addNewTitle,
  kind,
}: {
  value: string;
  onChange: (v: string) => void;
  choices: string[];
  isAdmin: boolean;
  placeholder?: string;
  addNewTitle: string;
  /** style_classifications kind this picker manages. */
  kind: "group" | "category" | "sub_category";
}) {
  const options: SearchableSelectOption[] = useMemo(() => {
    const base: SearchableSelectOption[] = [
      { value: "", label: "(select)" },
      ...choices.map((c) => ({ value: c, label: c })),
    ];
    // If the row's current value isn't one of the known choices, surface it
    // as a one-off option so the picker can render the current selection.
    if (value && !choices.includes(value)) {
      base.push({ value, label: value });
    }
    return base;
  }, [choices, value]);

  // Chunk J items 10/11 — admin "+ Add new…" now grows the style_classifications
  // master (POST), not just the local form value. We set the value immediately
  // for snappy UX; the POST runs in the background and a 409 (already exists) is
  // treated as success since the name is what we wanted on the row anyway.
  const addNew = useCallback((qRaw: string) => {
    const name = qRaw.trim();
    if (!name) return;
    onChange(name);
    void (async () => {
      try {
        const r = await fetch(`/api/internal/style-classifications`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, name }),
        });
        if (!r.ok && r.status !== 409) {
          const msg = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
          notify(`Could not save new ${addNewTitle} to master: ${msg}`, "error");
        }
      } catch (e: unknown) {
        notify(`Could not save new ${addNewTitle} to master: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    })();
  }, [kind, onChange, addNewTitle]);

  return (
    <SearchableSelect
      value={value || null}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      onAddNew={isAdmin ? addNew : undefined}
      addNewLabel={(q) => {
        const trimmed = q.trim();
        return trimmed
          ? `+ Add new ${addNewTitle} "${trimmed}"`
          : `+ Add new ${addNewTitle}…`;
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P3 Chunk 11 — Fabrics subsection embedded in the style edit modal.
// Self-managing: reads/writes /api/internal/style-fabric-codes directly.
// Style master save is independent of this section's lifecycle.
// ─────────────────────────────────────────────────────────────────────────────
const FABRIC_ROLES = ["primary", "lining", "trim", "interlining", "accent", "other"] as const;

type FabricCodeLite = {
  id: string;
  code: string;
  name: string;
  composition_text: string;
  fabric_weight_gsm: number | null;
};

type StyleFabricLink = {
  id: string;
  style_id: string;
  fabric_code_id: string;
  role: string;
  yardage_per_unit: number | null;
  notes: string | null;
  fabric?: FabricCodeLite | null;
};

function StyleFabricsSection({ styleId }: { styleId: string }) {
  const [links, setLinks] = useState<StyleFabricLink[]>([]);
  const [fabrics, setFabrics] = useState<FabricCodeLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({
    role: "primary",
    fabric_code_id: "",
    yardage_per_unit: "",
    notes: "",
  });

  async function loadLinks() {
    try {
      const r = await fetch(`/api/internal/style-fabric-codes?style_id=${styleId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setLinks(await r.json() as StyleFabricLink[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadFabrics() {
    try {
      const r = await fetch(`/api/internal/fabric-codes?limit=5000`);
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data)) setFabrics(data as FabricCodeLite[]);
    } catch { /* non-fatal */ }
  }

  useEffect(() => { void loadLinks(); void loadFabrics(); }, [styleId]);

  async function addLink() {
    setErr(null);
    try {
      if (!draft.fabric_code_id) throw new Error("Select a fabric");
      const body: Record<string, unknown> = {
        style_id: styleId,
        fabric_code_id: draft.fabric_code_id,
        role: draft.role,
        yardage_per_unit: draft.yardage_per_unit ? Number(draft.yardage_per_unit) : null,
        notes: draft.notes || null,
      };
      const r = await fetch(`/api/internal/style-fabric-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setAddOpen(false);
      setDraft({ role: "primary", fabric_code_id: "", yardage_per_unit: "", notes: "" });
      await loadLinks();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeLink(id: string) {
    if (!(await confirmDialog("Remove this fabric from the style?"))) return;
    try {
      const r = await fetch(`/api/internal/style-fabric-codes/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await loadLinks();
    } catch (e: unknown) {
      notify(`Remove failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Fabrics</div>
        {!addOpen && (
          <button onClick={() => setAddOpen(true)} style={btnSecondary}>+ Add fabric</button>
        )}
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "6px 10px", borderRadius: 4, marginBottom: 8, fontSize: 12 }}>
          {err}
        </div>
      )}

      {loading ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>Loading…</div>
      ) : links.length === 0 ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>No fabrics attached.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={th}>Role</th>
              <th style={th}>Fabric</th>
              <th style={th}>Yards/unit</th>
              <th style={th}>Notes</th>
              <th style={{ ...th, width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <td style={td}>{l.role}</td>
                <td style={td}>
                  {l.fabric
                    ? <span><strong>{l.fabric.code}</strong> — {l.fabric.name}</span>
                    : <span style={{ color: C.textMuted }}>(unknown)</span>}
                </td>
                <td style={td}>{l.yardage_per_unit ?? "—"}</td>
                <td style={td}>{l.notes ?? "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <button onClick={() => void removeLink(l.id)} style={btnDanger}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {addOpen && (
        <div style={{ marginTop: 10, padding: 10, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6, minWidth: 0 }}>
          {/* Stacked layout — selects + inputs need ~150px minimum to render readably
              and a 3-column grid overflows the parent edit modal. Two rows × two cols
              keeps everything inside the modal width. */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "end", minWidth: 0 }}>
            <Field label="Role">
              <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} style={{ ...(inputStyle as React.CSSProperties), minWidth: 0 }}>
                {FABRIC_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label="Yards/unit">
              <input
                type="number"
                step="0.0001"
                value={draft.yardage_per_unit}
                onChange={(e) => setDraft({ ...draft, yardage_per_unit: e.target.value })}
                style={{ ...inputStyle, minWidth: 0 }}
              />
            </Field>
          </div>
          <div style={{ marginTop: 8, minWidth: 0 }}>
            <Field label="Fabric">
              <select
                value={draft.fabric_code_id}
                onChange={(e) => setDraft({ ...draft, fabric_code_id: e.target.value })}
                style={{ ...(inputStyle as React.CSSProperties), minWidth: 0 }}
              >
                <option value="">— select —</option>
                {fabrics.map((f) => (
                  <option key={f.id} value={f.id}>{f.code} — {f.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ marginTop: 8, minWidth: 0 }}>
            <Field label="Notes">
              <input
                type="text"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                style={{ ...inputStyle, minWidth: 0 }}
                placeholder="optional"
              />
            </Field>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
            <button onClick={() => setAddOpen(false)} style={btnSecondary}>Cancel</button>
            <button onClick={() => void addLink()} style={btnPrimary}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Style Master Sweep (#6) — Notes log embedded in the style edit modal.
// Reads/writes /api/internal/style-master/notes directly.
// ─────────────────────────────────────────────────────────────────────────────
function StyleNotesSection({ styleId }: { styleId: string }) {
  const [notes, setNotes] = useState<StyleNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const cachedUserId = getCachedAuthUserId();
  const cachedUserEmail = getCachedAuthUserEmail();

  async function loadNotes() {
    setErr(null);
    try {
      const r = await fetch(`/api/internal/style-master/notes?style_id=${styleId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setNotes(await r.json() as StyleNote[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadNotes(); }, [styleId]);

  async function addNote() {
    const text = draft.trim();
    if (!text) return;
    setPosting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        style_id: styleId,
        note_text: text,
      };
      if (cachedUserId) body.created_by = cachedUserId;
      if (cachedUserEmail) body.created_by_email = cachedUserEmail;
      const r = await fetch(`/api/internal/style-master/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setDraft("");
      await loadNotes();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Notes</div>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {cachedUserEmail ? `Signed in as ${cachedUserEmail}` : "Signed-in email not detected — notes will tag (unknown)"}
        </div>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "6px 10px", borderRadius: 4, marginBottom: 8, fontSize: 12 }}>
          {err}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !posting && draft.trim()) void addNote(); }}
          style={{ ...inputStyle, flex: 1 }}
          placeholder="Add a note…"
          disabled={posting}
        />
        <button
          onClick={() => void addNote()}
          style={{ ...btnPrimary, opacity: posting || !draft.trim() ? 0.6 : 1 }}
          disabled={posting || !draft.trim()}
        >
          {posting ? "Adding…" : "Add note"}
        </button>
      </div>

      {loading ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>Loading…</div>
      ) : notes.length === 0 ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>No notes yet.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {notes.map((n) => (
            <li
              key={n.id}
              style={{
                background: C.card,
                border: `1px solid ${C.cardBdr}`,
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: C.textMuted, marginBottom: 2 }}>
                <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>
                  {formatNoteTimestamp(n.created_at)}
                </span>
                <span>{n.created_by_email || "(unknown)"}</span>
              </div>
              <div style={{ color: C.text, whiteSpace: "pre-wrap" }}>{n.note_text}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatNoteTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}
