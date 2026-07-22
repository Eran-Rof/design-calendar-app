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
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { useSearchSeed } from "./hooks/useSearchSeed";
import { readDrillParam, consumeDrillParams } from "./scorecardDrill";
import { getCachedAuthUserId, getCachedAuthUserEmail } from "../utils/tangerineAuthUser";
// Universal row-click + scroll-highlight primitive (operator ask #4).
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import { useStyleThumbs, StyleThumb } from "../shared/ui/StyleThumb";
import { ColorSwatch } from "../shared/ui/ColorSwatch";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { MatrixFormModal, type PrepackMatrix } from "./InternalPrepackMatrix";

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
  /** Old style codes captured when the style was renumbered — keep string-grain
   *  lookups (Xoro importer, prepack matrix) resolving the renamed style. */
  aliases: string[] | null;
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
  unit_weight_kg: number | null;
  units_per_carton: number | null;
  carton_cbm_m3: number | null;
  carton_length_in: number | null;
  carton_width_in: number | null;
  carton_height_in: number | null;
  gross_weight_lb: number | null;
  cbm_confidence: string | null;
  cbm_note: string | null;
  cbm_inputs: Record<string, unknown> | null;
  carton_cbm_override: boolean | null;
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

type ColorLite = { id: string; name: string; code?: string | null; hex?: string | null };

// gender_master row (Chunk J item 13) — replaces the hardcoded GENDER_OPTIONS.
type GenderMaster = { id: string; code: string; label: string; sort_order: number };

// Operator: weight (kg) and carton CBM (m³) show WITHOUT the leading zero
// (e.g. 0.0807 → .0807, 0.36 → .36). Number(".0807") still parses on save.
const noLead = (v: string): string => v.replace(/^(-?)0(?=\.\d)/, "$1");

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
  colorScheme: "dark",
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
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch(useSearchSeed(), 200);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  // "Needs review" filter — shows only styles flagged by an Inventory Planning
  // promotion (attributes.needs_review / source=planning_promoted) so a
  // merchandiser can complete their details. Defaults ON when arrived at via
  // the notification deep-link (?review=1).
  const [reviewOnly, setReviewOnly] = useState<boolean>(() => {
    try { return new URLSearchParams(window.location.search).get("review") === "1"; } catch { return false; }
  });
  // "Missing size scale" drill (Today → master.scales_missing, ?scale=missing):
  // filters the grid to just the styles the v_style_scale_missing view flags
  // (no size_scale_id + a real multi-size run — the 44). The style_codes come
  // from /api/internal/style-master/scale-missing so the count matches the
  // to-do exactly; the grid then shows only those.
  const [scaleMissing, setScaleMissing] = useState<boolean>(() => readDrillParam("scale") === "missing");
  const [missingScaleCodes, setMissingScaleCodes] = useState<Set<string> | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Style | null>(null);
  const [assigningScales, setAssigningScales] = useState(false);
  const [htsBackfill, setHtsBackfill] = useState<{ running: boolean; updated: number; processed: number }>(
    { running: false, updated: 0, processed: 0 },
  );
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
  const [scales, setScales] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const loadScales = useCallback(async () => {
    try {
      const r = await fetch(`/api/internal/size-scales`);
      if (!r.ok) return;
      const d = await r.json();
      const arr = Array.isArray(d) ? d : (Array.isArray(d?.scales) ? d.scales : []);
      setScales(arr.map((s: Record<string, unknown>) => ({ id: s.id as string, code: (s.code as string) || "", name: (s.name as string) || "" })));
    } catch { /* non-fatal */ }
  }, []);
  // List/export show the scale NAME (fall back to code only if a name is missing).
  const scaleNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scales) m.set(s.id, s.name || s.code);
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
  const visibleRows = useMemo(() => {
    let out = reviewOnly ? rows.filter(isNeedsReview) : rows;
    if (scaleMissing && missingScaleCodes) {
      out = out.filter((r) => missingScaleCodes.has(String(r.style_code).toUpperCase()));
    }
    return out;
  }, [rows, reviewOnly, scaleMissing, missingScaleCodes]);

  // Client-side column sort (shared useSort hook). Direct scalar columns resolve
  // by key; the id→label columns (gender / brand / size scale / base fabric)
  // sort by their DISPLAYED text via accessors. Purely additive — order only
  // changes once a header is clicked, and blanks always cluster last.
  const styleSortAccessors = useMemo<Record<string, (r: Style) => unknown>>(() => ({
    gender_code: (r) => genderLabelFor(r.gender_code, genderLabelMap),
    brand_name: (r) => (r.brand_id ? (brandNameById.get(r.brand_id) ?? "") : ""),
    size_scale_code: (r) => (r.size_scale_id ? (scaleNameById.get(r.size_scale_id) ?? "") : ""),
    base_fabric: (r) => r.base_fabric?.code ?? r.base_fabric_legacy ?? "",
  }), [genderLabelMap, brandNameById, scaleNameById]);
  const { sorted: sortedRows, sortKey, sortDir, onHeaderClick } = useSort(visibleRows, {
    persistKey: "tanda.style_master.sort",
    accessors: styleSortAccessors,
  });
  // Fetch the missing-scale style_codes once when the drill is active; consume
  // the one-shot ?scale= param so it doesn't linger on a later visit.
  useEffect(() => {
    if (!scaleMissing) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/internal/style-master/scale-missing");
        if (!r.ok) return;
        const d = await r.json();
        const codes: string[] = Array.isArray(d?.style_codes) ? d.style_codes : [];
        if (alive) setMissingScaleCodes(new Set(codes.map((c) => String(c).toUpperCase())));
      } catch { /* non-fatal — banner still shows, filter just no-ops */ }
    })();
    consumeDrillParams(["scale"]);
    return () => { alive = false; };
  }, [scaleMissing]);
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
  async function autoAssignScales(source: "skus" | "sales" = "skus") {
    const qs = source === "sales" ? "?source=sales" : "";
    const basis = source === "sales" ? "sizes actually sold (orders + invoices)" : "their SKU size variants";
    setAssigningScales(true);
    try {
      const pr = await fetch(`/api/internal/style-master/auto-assign-scales${qs}`);
      const prev = await pr.json();
      if (!pr.ok) throw new Error(prev.error || `HTTP ${pr.status}`);
      if (!prev.matched) { notify(prev.error || "No unscaled styles could be matched to a size scale.", "info"); return; }
      const breakdown = Object.entries(prev.by_scale || {})
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map(([k, v]) => `${k}: ${v}`).join(" · ");
      const ok = await confirmDialog(
        `Assign size scales to ${prev.matched} of ${prev.considered} unscaled styles (best match on ${basis})?\n\n${breakdown}\n\nSkipped ${prev.skipped} (ambiguous or no good match). Only styles without a scale are changed — nothing is overwritten, and you can still fine-tune any style in its edit modal.`,
        { title: source === "sales" ? "Assign size scales from sales" : "Auto-assign size scales", icon: "", confirmText: `Assign ${prev.matched}` },
      );
      if (!ok) return;
      const ar = await fetch(`/api/internal/style-master/auto-assign-scales${qs}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }),
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

  // Bulk AI HTS backfill for Bangladesh / China / Madagascar across every apparel
  // style (operator #4). Loops the keyset-cursor endpoint until done, classifying
  // each style for its OWN gender and stamping the flat +10% additional tariff.
  async function backfillHts() {
    const ok = await confirmDialog(
      "Auto-fill HTS codes for Bangladesh, China & Madagascar on every apparel style?\n\nUses AI (per style, gender-aware) to classify a single HS code and the duty rate for each country, and applies the flat +10% additional tariff. Styles that already have all 3 countries are skipped. This runs in the background and may take a few minutes.",
      { title: "Auto-fill HTS (BD / CN / MG)", icon: "", confirmText: "Start" },
    );
    if (!ok) return;
    setHtsBackfill({ running: true, updated: 0, processed: 0 });
    let after = "";
    let totalUpdated = 0;
    let totalProcessed = 0;
    try {
      for (let guard = 0; guard < 1000; guard++) {
        const r = await fetch("/api/internal/hts/backfill", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ after, limit: 8 }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (j.note) { notify(j.note, "info"); break; }
        totalUpdated += j.updated || 0;
        totalProcessed += j.processed || 0;
        after = j.lastId || after;
        setHtsBackfill({ running: true, updated: totalUpdated, processed: totalProcessed });
        if (j.done) break;
      }
      notify(`HTS backfill complete — classified ${totalUpdated} styles across BD/CN/MG (${totalProcessed} scanned).`, "success");
      await load();
    } catch (e: unknown) {
      notify(`HTS backfill failed: ${e instanceof Error ? e.message : String(e)} (updated ${totalUpdated} so far)`, "error");
    } finally {
      setHtsBackfill({ running: false, updated: totalUpdated, processed: totalProcessed });
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
            {assigningScales ? "Assigning…" : "Auto-assign size scales"}
          </button>
          <button
            onClick={() => void autoAssignScales("sales")}
            style={btnSecondary}
            disabled={assigningScales}
            title="Assign each unscaled style the best-fitting size scale based on the sizes ACTUALLY SOLD (sales orders + invoices), not the full SKU catalog"
          >
            {assigningScales ? "Assigning…" : "From sales history"}
          </button>
          <button
            onClick={() => void downloadSkippedScales()}
            style={btnSecondary}
            disabled={assigningScales}
            title="Download the styles the auto-assign skips (single/pair sizes or no good match), with the reason, to assign a scale by hand"
          >
            Skipped styles
          </button>
          <button
            onClick={() => void backfillHts()}
            style={btnSecondary}
            disabled={htsBackfill.running}
            title="Use AI to fill HTS codes + duty rates for Bangladesh, China & Madagascar on every apparel style (gender-aware), with the flat +10% additional tariff"
          >
            {htsBackfill.running ? `HTS… ${htsBackfill.updated}` : "Auto-fill HTS (BD/CN/MG)"}
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
          Needs review{reviewCount > 0 ? ` (${reviewCount})` : ""}
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
            size_scale_code: r.size_scale_id ? (scaleNameById.get(r.size_scale_id) ?? null) : null,
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

      {scaleMissing && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, marginBottom: 12,
          background: "rgba(59,130,246,0.12)", border: `1px solid ${C.primary}`,
          borderRadius: 8, padding: "8px 12px", fontSize: 13, color: C.text,
        }}>
          <span style={{ fontWeight: 600 }}>
            Showing {missingScaleCodes ? missingScaleCodes.size.toLocaleString() : "…"} style{missingScaleCodes && missingScaleCodes.size === 1 ? "" : "s"} missing a size scale
          </span>
          <span style={{ color: C.textMuted }}>— use Auto-assign size scales above, or pick a scale per style.</span>
          <button
            onClick={() => { setScaleMissing(false); setMissingScaleCodes(null); }}
            style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${C.cardBdr}`, color: C.textSub, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}
          >
            ✕ Clear filter
          </button>
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 220px)", overflowY: "auto", overflowX: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : visibleRows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            {scaleMissing ? "No styles missing a size scale." : reviewOnly ? "No styles awaiting review." : "No styles found."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 52, textAlign: "center" }}>Img</th>
                <SortableTh label="Style Number" sortKey="style_code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("style_code")} />
                <SortableTh label="Style Name" sortKey="style_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("style_name")} />
                <SortableTh label="Description" sortKey="description" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("description")} />
                <SortableTh label="Gender" sortKey="gender_code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("gender_code")} />
                <SortableTh label="Group" sortKey="group_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("group_name")} />
                <SortableTh label="Category" sortKey="category_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("category_name")} />
                <SortableTh label="Sub Category" sortKey="sub_category_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("sub_category_name")} />
                <SortableTh label="Brand" sortKey="brand_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("brand_name")} />
                <SortableTh label="Size Scale" sortKey="size_scale_code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("size_scale_code")} />
                <SortableTh label="Base Fabric" sortKey="base_fabric" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("base_fabric")} />
                <SortableTh label="HTS" sortKey="hts_code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("hts_code")} />
                <SortableTh label="Season" sortKey="season" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("season")} />
                <SortableTh label="Year" sortKey="design_year" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("design_year")} />
                <SortableTh label="Lifecycle" sortKey="lifecycle_status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("lifecycle_status")} />
                <SortableTh label="Apparel" sortKey="is_apparel" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("is_apparel")} />
                <th style={{ ...th, width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => (
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
                  <td style={td} hidden={!isVisible("size_scale_code")}>{r.size_scale_id ? (scaleNameById.get(r.size_scale_id) || "…") : "—"}</td>
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

// Keep only positive integer size→qty entries from one pack column.
function cleanPackCol(col: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (col && typeof col === "object") {
    for (const [k, v] of Object.entries(col as Record<string, unknown>)) {
      const n = Math.floor(Number(v));
      if (k && Number.isFinite(n) && n > 0) out[k] = n;
    }
  }
  return out;
}
// Normalize a stored size_scale_pack into the editor's per-inseam shape
// (Record<inseam, {size:qty}>). The stored value is either flat ({size:qty},
// styles with no inseams) — which lands under the "" key (shared) — or already
// nested per-inseam ({inseam:{size:qty}}).
function normalizeStoredPack(raw: unknown): Record<string, Record<string, number>> {
  if (!raw || typeof raw !== "object") return {};
  const nested = Object.values(raw as Record<string, unknown>).some((v) => v != null && typeof v === "object");
  if (nested) {
    const out: Record<string, Record<string, number>> = {};
    for (const [ins, col] of Object.entries(raw as Record<string, unknown>)) {
      const c = cleanPackCol(col);
      if (Object.keys(c).length) out[String(ins)] = c;
    }
    return out;
  }
  const flat = cleanPackCol(raw);
  return Object.keys(flat).length ? { "": flat } : {};
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
    unit_weight_kg:       style?.unit_weight_kg != null ? noLead(String(style.unit_weight_kg)) : "",
    units_per_carton:     style?.units_per_carton != null ? String(style.units_per_carton) : "",
    carton_cbm_m3:        style?.carton_cbm_m3 != null ? noLead(String(style.carton_cbm_m3)) : "",
    // AI master-carton estimator (CBM). Inputs persist inside cbm_inputs; the
    // unit-weight estimator field is in LB (the rollup column unit_weight_kg
    // stays the source of truth and is kept in sync from it).
    carton_length_in:     style?.carton_length_in != null ? String(style.carton_length_in) : "",
    carton_width_in:      style?.carton_width_in != null ? String(style.carton_width_in) : "",
    carton_height_in:     style?.carton_height_in != null ? String(style.carton_height_in) : "",
    gross_weight_lb:      style?.gross_weight_lb != null ? String(style.gross_weight_lb) : "",
    cbm_confidence:       style?.cbm_confidence ?? "",
    cbm_note:             style?.cbm_note ?? "",
    carton_cbm_override:  style?.carton_cbm_override === true,
    cbm_fold_type:        (style?.cbm_inputs?.fold_type as string) ?? "",
    cbm_product_type:     (style?.cbm_inputs?.product_type as string) ?? style?.category_name ?? "",
    cbm_unit_weight_lb:   (style?.cbm_inputs?.unit_weight_lb != null
                            ? String(style.cbm_inputs.unit_weight_lb)
                            : (style?.unit_weight_kg != null ? (style.unit_weight_kg * 2.20462).toFixed(3) : "")),
    aliases:              style?.aliases ?? [],
  });
  // The style code at modal open — used to detect a renumber so the UI can warn
  // that the old code will be captured as an alias.
  const originalStyleCode = style?.style_code ?? "";
  // The inputs the persisted estimate was generated from (cache key).
  const [cbmInputs, setCbmInputs] = useState<Record<string, unknown> | null>(style?.cbm_inputs ?? null);
  const [cbmLoading, setCbmLoading] = useState(false);

  const cbmKey = () => ({
    product_type: form.cbm_product_type.trim(),
    fold_type: form.cbm_fold_type.trim(),
    pack_qty: form.units_per_carton.trim(),
    unit_weight_lb: form.cbm_unit_weight_lb.trim(),
  });
  // Recompute the canonical carton_cbm_m3 from inch dims (L*W*H / 61023.6).
  const cbmFromInches = (l: string, w: string, h: string): string => {
    const L = Number(l), W = Number(w), H = Number(h);
    if (!Number.isFinite(L) || !Number.isFinite(W) || !Number.isFinite(H) || L <= 0 || W <= 0 || H <= 0) return "";
    return noLead(((L * W * H) / 61023.6).toFixed(4));
  };
  // A hand-edited dimension (or ticking the override box) means a forwarder-
  // measured carton — flag override and recompute the effective CBM from it.
  const setOverrideDim = (key: "carton_length_in" | "carton_width_in" | "carton_height_in", val: string) => {
    setForm((f) => {
      const next = { ...f, [key]: val, carton_cbm_override: true };
      next.carton_cbm_m3 = cbmFromInches(next.carton_length_in, next.carton_width_in, next.carton_height_in);
      return next;
    });
  };

  async function estimateCarton() {
    if (cbmLoading) return;
    if (form.carton_cbm_override) {
      notify("A measured-carton override is set — untick it to re-estimate.", "info");
      return;
    }
    const key = cbmKey();
    if (!key.product_type && !key.fold_type) {
      notify("Pick a product type and fold type first.", "info");
      return;
    }
    // Cache: skip the API call when nothing changed and an estimate exists.
    if (cbmInputs && form.carton_cbm_m3.trim() &&
        JSON.stringify(cbmInputs) === JSON.stringify(key)) {
      notify("Inputs unchanged — using the cached estimate.", "info");
      return;
    }
    setCbmLoading(true);
    try {
      const r = await fetch("/api/internal/style-master/cbm-estimate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_type: key.product_type,
          fold_type: key.fold_type,
          unit_weight_lb: key.unit_weight_lb,
          pack_qty: key.pack_qty,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      // Graceful no-op (e.g. ANTHROPIC_API_KEY not configured) returns ONLY a
      // note with no estimate. A successful estimate also carries `note` (the
      // one-line assumption), so only bail when there are no dims/cbm to apply.
      if (data.note && data.cbm == null && data.carton_length_in == null) { notify(data.note, "info"); return; }
      setForm((f) => ({
        ...f,
        carton_length_in: data.carton_length_in != null ? String(data.carton_length_in) : "",
        carton_width_in:  data.carton_width_in != null ? String(data.carton_width_in) : "",
        carton_height_in: data.carton_height_in != null ? String(data.carton_height_in) : "",
        gross_weight_lb:  data.gross_weight_lb != null ? String(data.gross_weight_lb) : "",
        carton_cbm_m3:    data.cbm != null ? noLead(String(data.cbm)) : f.carton_cbm_m3,
        cbm_confidence:   data.confidence || "",
        cbm_note:         data.note || "",
        carton_cbm_override: false,
      }));
      setCbmInputs(key);
    } catch (e: unknown) {
      notify(`Carton estimate failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setCbmLoading(false);
    }
  }
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
  const [coo, setCoo] = useState<{ country: string; hts_code: string; duty_rate_pct: string; additional_tariff_pct: string }[]>(() => {
    const fromAttr = (style?.attributes as Record<string, unknown> | undefined)?.coo_hts;
    if (Array.isArray(fromAttr) && fromAttr.length > 0) {
      return fromAttr.slice(0, 3).map((c) => {
        const o = (c ?? {}) as Record<string, unknown>;
        return {
          country: o.country != null ? String(o.country) : "",
          hts_code: o.hts_code != null ? String(o.hts_code) : "",
          duty_rate_pct: o.duty_rate_pct != null ? String(o.duty_rate_pct) : "",
          // Trump-administration additional tariff (flat +10%, all countries) —
          // default 10 for legacy rows that predate the field (operator #4).
          additional_tariff_pct: o.additional_tariff_pct != null ? String(o.additional_tariff_pct) : "10",
        };
      });
    }
    // Seed one primary row from the legacy single hts_code / duty_rate.
    return [{ country: "", hts_code: style?.hts_code ?? "", duty_rate_pct: style?.duty_rate_pct != null ? String(style.duty_rate_pct) : "", additional_tariff_pct: "10" }];
  });
  // Per-style size-scale PACK ratio (size → representative qty), e.g. { S:2, M:3,
  // L:3, XL:2 }. Defines how a single total typed into the SO / PO matrix Qty
  // column is split across sizes. Persisted in style attributes.size_scale_pack.
  // Per-inseam pack ratio. Keyed by inseam; the "" key holds the shared/flat pack
  // for styles with no inseams. Serialized back to flat ({size:qty}) when the
  // style has no inseams, or nested ({inseam:{size:qty}}) when it does.
  const [scaleOpen, setScaleOpen] = useState(false);
  const [packByInseam, setPackByInseam] = useState<Record<string, Record<string, number>>>(
    () => normalizeStoredPack((style?.attributes as Record<string, unknown> | undefined)?.size_scale_pack),
  );

  // Prepack-matrix editor (PPK styles only). A prepack style's per-size garment
  // composition lives in prepack_matrices, keyed by the PPK style_code. We reuse
  // the SAME entry window as the Prepack Matrices master (MatrixFormModal) as a
  // popup so the operator can define it inline; saving it closes only the popup
  // and leaves this style form open. The canonical PPK grain gate is style_code
  // containing "PPK" (see project_ppk_grain_rule_CANONICAL).
  const isPpkStyle = /PPK/i.test(form.style_code || "");
  const [ppkMatrixOpen, setPpkMatrixOpen] = useState(false);
  const [ppkMatrix, setPpkMatrix] = useState<PrepackMatrix | null>(null);
  // Add-case prefill (pack token + laid-out sizes) derived from the PPK-needed
  // view, so a brand-new matrix opens with its Pack Token and size columns
  // ready rather than blank. Null when editing an existing matrix or when the
  // style isn't in the needed view (operator types them by hand).
  const [ppkPrefill, setPpkPrefill] = useState<Partial<PrepackMatrix> | null>(null);
  const [ppkMatrixLoading, setPpkMatrixLoading] = useState(false);
  // Look up any existing matrix for the current PPK style_code (exact match) so
  // the button reads Edit vs Add and opening it prefills the existing sizes
  // rather than clobbering them on the POST upsert.
  const loadPpkMatrix = useCallback(async (): Promise<PrepackMatrix | null> => {
    const code = form.style_code.trim();
    if (!code) return null;
    try {
      const r = await fetch(`/api/internal/prepack-matrices?q=${encodeURIComponent(code)}&include_inactive=true`);
      if (!r.ok) return null;
      const list = (await r.json()) as PrepackMatrix[];
      return Array.isArray(list)
        ? (list.find((m) => (m.ppk_style_code || "").toLowerCase() === code.toLowerCase()) ?? null)
        : null;
    } catch { return null; }
  }, [form.style_code]);
  // Derive the add-case prefill from v_prepack_ppk_needed (pack token + master
  // name + the sized-sibling sizes). Prefers the assigned size scale's ordered
  // sizes when present. Returns null if the style isn't listed (e.g. no sized
  // sibling) so the operator just fills the popup by hand.
  const loadPpkPrefill = useCallback(async (): Promise<Partial<PrepackMatrix> | null> => {
    const code = form.style_code.trim();
    if (!code) return null;
    try {
      const r = await fetch("/api/internal/prepack-matrices/needed");
      if (!r.ok) return null;
      const list = (await r.json()) as Array<{
        ppk_style_code: string; style_name?: string; pack_token?: string | null;
        sizes?: string[]; scale_sizes?: string[];
      }>;
      const hit = Array.isArray(list)
        ? list.find((x) => (x.ppk_style_code || "").toLowerCase() === code.toLowerCase())
        : null;
      if (!hit) return null;
      const sizeList = (hit.scale_sizes && hit.scale_sizes.length ? hit.scale_sizes : hit.sizes) || [];
      return {
        ppk_style_code: code,
        name: hit.style_name || "",
        pack_token: hit.pack_token || "",
        sizes: sizeList.map((sz) => ({ size: sz, qty_per_pack: 0, inner_pack_qty: 0 })),
      } as Partial<PrepackMatrix>;
    } catch { return null; }
  }, [form.style_code]);
  // Refresh the existing-matrix status whenever the (PPK) style code changes so
  // the button label is correct before it's ever clicked.
  useEffect(() => {
    if (!isPpkStyle) { setPpkMatrix(null); return; }
    let alive = true;
    void loadPpkMatrix().then((m) => { if (alive) setPpkMatrix(m); });
    return () => { alive = false; };
  }, [isPpkStyle, loadPpkMatrix]);

  async function openPpkMatrix() {
    setPpkMatrixLoading(true);
    const existing = await loadPpkMatrix();
    setPpkMatrix(existing);
    // Only derive a prefill for the ADD case — editing loads the real matrix.
    setPpkPrefill(existing ? null : await loadPpkPrefill());
    setPpkMatrixLoading(false);
    setPpkMatrixOpen(true);
  }

  // Declared COLORS — the colors this style is offered in, stored as an array of
  // color_master ids in attributes.color_ids. These drive the SO/PO size-matrix
  // rows (api/_lib/styleMatrix.js merges them with the SKU-derived colors) so a
  // brand-new style renders its color rows before any SKU exists. The master
  // list (searchable + admin add-new) loads from /api/internal/colors.
  const [colorMaster, setColorMaster] = useState<ColorLite[]>([]);
  const [colorIds, setColorIds] = useState<string[]>(() => {
    const fromAttr = (style?.attributes as Record<string, unknown> | undefined)?.color_ids;
    return Array.isArray(fromAttr) ? fromAttr.filter((x): x is string => typeof x === "string" && !!x) : [];
  });
  // Show/hide toggle for the declared-colors editor (a style can carry many
  // colors — collapsing keeps the modal compact).
  const [colorsShown, setColorsShown] = useState(true);
  // Declared INSEAMS — the inseam lengths this (bottoms) style is offered in,
  // stored as a string array in attributes.inseams. Drive the matrix inseam rows
  // the same way colors do. Optional — only bottoms set these.
  const [inseams, setInseams] = useState<string[]>(() => {
    const fromAttr = (style?.attributes as Record<string, unknown> | undefined)?.inseams;
    return Array.isArray(fromAttr) ? fromAttr.map((x) => String(x).trim()).filter(Boolean) : [];
  });
  const [inseamDraft, setInseamDraft] = useState("");
  const [aliasDraft, setAliasDraft] = useState("");
  const addAlias = (raw: string) => {
    const v = raw.trim().toUpperCase();
    if (!v) return;
    setForm((f) => (f.aliases.includes(v) ? f : { ...f, aliases: [...f.aliases, v] }));
    setAliasDraft("");
  };
  const removeAlias = (v: string) => setForm((f) => ({ ...f, aliases: f.aliases.filter((x) => x !== v) }));

  // Which COO row's AI "Suggest HTS" list is currently open / loading (null = none).
  const [htsRowIdx, setHtsRowIdx] = useState<number | null>(null);
  const setCooField = (idx: number, key: "country" | "hts_code" | "duty_rate_pct" | "additional_tariff_pct", val: string) =>
    setCoo((rows) => rows.map((r, i) => (i === idx ? { ...r, [key]: val } : r)));
  const addCoo = () => setCoo((rows) => (rows.length >= 3 ? rows : [...rows, { country: "", hts_code: "", duty_rate_pct: "", additional_tariff_pct: "10" }]));
  const removeCoo = (idx: number) => setCoo((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== idx)));
  const countryOptions = useMemo(() => countries.map((c) => ({ value: c.name, label: c.name, searchHaystack: `${c.name} ${c.iso2}` })), [countries]);

  // Sizes that the Scale window lets the operator enter a pack qty for — taken
  // (in order) from the style's currently-selected size scale. Empty until a
  // size scale is picked.
  const scaleSizes = useMemo<string[]>(() => {
    const s = sizeScales.find((x) => x.id === form.size_scale_id);
    return Array.isArray(s?.sizes) ? s!.sizes : [];
  }, [sizeScales, form.size_scale_id]);
  // Inseam columns the Scale window offers — the style's declared inseams, or a
  // single shared column ("") when the style has none.
  const scaleInseamKeys = useMemo<string[]>(() => (inseams.length ? inseams : [""]), [inseams]);
  const getScaleQty = (ins: string, sz: string) => packByInseam[ins]?.[sz] || 0;
  const setScaleQty = (ins: string, sz: string, raw: string) =>
    setPackByInseam((p) => {
      const n = Math.floor(Number(raw));
      const col = { ...(p[ins] || {}) };
      if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) delete col[sz];
      else col[sz] = n;
      const next = { ...p };
      if (Object.keys(col).length) next[ins] = col; else delete next[ins];
      return next;
    });
  // Row total (one inseam across all sizes) and column total (one size across all
  // inseams) for the horizontal pack matrix.
  const inseamRowTotal = (ins: string) => scaleSizes.reduce((t, sz) => t + getScaleQty(ins, sz), 0);
  const sizeColTotal = (sz: string) => scaleInseamKeys.reduce((t, ins) => t + getScaleQty(ins, sz), 0);
  const scaleTotal = useMemo(
    () => scaleInseamKeys.reduce((t, ins) => t + scaleSizes.reduce((u, sz) => u + (packByInseam[ins]?.[sz] || 0), 0), 0),
    [scaleInseamKeys, scaleSizes, packByInseam],
  );
  // Serialize the editor state back to the stored shape: flat when no inseams,
  // nested per-inseam otherwise.
  const serializeScalePack = (): Record<string, unknown> => {
    if (inseams.length) {
      const out: Record<string, Record<string, number>> = {};
      for (const ins of inseams) {
        const c = cleanPackCol(packByInseam[ins]);
        if (Object.keys(c).length) out[ins] = c;
      }
      return out;
    }
    return cleanPackCol(packByInseam[""]);
  };

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

  // Surface the inseams this style already sells (derived from its SKUs /
  // inventory, the same set the Inventory Matrix and SO/PO grids show) so an
  // existing bottoms style shows its inseams in Style Master without the operator
  // re-typing them. Merged in declared-first + deduped; persisted on the next
  // Save. Edit mode only — a brand-new style has no SKUs. Non-fatal on error.
  useEffect(() => {
    if (mode !== "edit" || !style?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(style.id)}`);
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        const fromSkus = Array.isArray(j?.inseams) ? (j.inseams as unknown[]).map((x) => String(x).trim()).filter(Boolean) : [];
        if (fromSkus.length) {
          setInseams((prev) => {
            const seen = new Set(prev);
            const add = fromSkus.filter((v) => !seen.has(v));
            return add.length ? [...prev, ...add] : prev;
          });
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [mode, style?.id]);

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

  // Load the color master for the Colors picker. Non-fatal on error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/colors`);
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && Array.isArray(data)) setColorMaster(data as ColorLite[]);
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

  // ── Colors (declared, multi-select) ────────────────────────────────────────
  const colorNameById = useMemo(() => {
    const m = new Map<string, ColorLite>();
    for (const c of colorMaster) m.set(c.id, c);
    return m;
  }, [colorMaster]);
  // The colors NOT already selected, for the "add a color" dropdown.
  const colorPickOptions: SearchableSelectOption[] = useMemo(() => {
    const picked = new Set(colorIds);
    return colorMaster
      .filter((c) => !picked.has(c.id))
      .map((c) => ({ value: c.id, label: c.code ? `${c.name} (${c.code})` : c.name, searchHaystack: `${c.name} ${c.code ?? ""}` }));
  }, [colorMaster, colorIds]);
  const addColorToStyle = useCallback((id: string) => {
    if (!id) return;
    setColorIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  const removeColorFromStyle = useCallback((id: string) => {
    setColorIds((prev) => prev.filter((x) => x !== id));
  }, []);
  // Declared colors sorted alphabetically by name for the columnar display.
  const sortedColorIds = useMemo(() => {
    return [...colorIds].sort((a, b) =>
      (colorNameById.get(a)?.name || a).toLowerCase().localeCompare((colorNameById.get(b)?.name || b).toLowerCase()),
    );
  }, [colorIds, colorNameById]);
  // Admin "+ Add new color" — POST to the color master, then select the new
  // (or pre-existing, case-insensitive) color. The endpoint is idempotent and
  // returns the row's id either way so we can attach it to this style.
  const addNewColor = useCallback((qRaw: string) => {
    const name = qRaw.trim();
    if (!name) return;
    void (async () => {
      try {
        const r = await fetch(`/api/internal/colors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!r.ok) {
          const msg = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
          notify(`Could not add color to master: ${msg}`, "error");
          return;
        }
        const saved = await r.json() as ColorLite;
        setColorMaster((prev) => prev.some((c) => c.id === saved.id) ? prev : [...prev, saved]);
        setColorIds((prev) => prev.includes(saved.id) ? prev : [...prev, saved.id]);
      } catch (e: unknown) {
        notify(`Could not add color to master: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    })();
  }, []);

  // ── Inseams (declared, multi-value free entry) ─────────────────────────────
  const COMMON_INSEAMS = ["28", "29", "30", "31", "32", "34", "36"];
  const addInseam = useCallback((raw: string) => {
    const v = raw.trim();
    if (!v) return;
    setInseams((prev) => prev.includes(v) ? prev : [...prev, v]);
    setInseamDraft("");
  }, []);
  const removeInseam = useCallback((v: string) => {
    setInseams((prev) => prev.filter((x) => x !== v));
  }, []);

  const sizeScaleOptions: SearchableSelectOption[] = useMemo(() => {
    const opts: SearchableSelectOption[] = [
      { value: "", label: "(select)" },
      ...sizeScales.map((s) => ({
        value: s.id,
        label: s.name,                       // name only (operator: hide the code)
        searchHaystack: `${s.code} ${s.name}`, // still searchable by code
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
        label: f.name,                                       // name only (operator: hide the code)
        searchHaystack: `${f.code} ${f.name} ${f.composition_text}`, // still searchable by code
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
        label: style.base_fabric.name,
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
    // No-colour guard (non-blocking). A style saved with no declared colours
    // creates no ip_item_master colour+size variants, so the PO/SO/AR size
    // matrices and the product catalogs can't render it until colours AND SKU
    // variants exist (the colour_ids drive the matrix colour rows before any SKU
    // is created). Warn via the shared app-coloured confirm surface, but allow
    // the save to proceed — operators legitimately stage a style before colours.
    if (colorIds.length === 0) {
      const proceed = await confirmDialog(
        "This style has no colors selected. Purchase order, sales order, and AR size matrices — and product catalogs — won't display this style until you add its colors and SKU variants exist. Save without colors?",
        { confirmText: "Save without colors" },
      );
      if (!proceed) return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      // COO × HTS rows → persisted array (attributes.coo_hts) + the primary (row 0)
      // mirrored onto the legacy hts_code / duty_rate_pct columns. Drop blank rows.
      const cooRows = coo
        .map((r) => ({
          country: r.country.trim(),
          hts_code: r.hts_code.trim(),
          duty_rate_pct: r.duty_rate_pct.trim() === "" ? null : Number(r.duty_rate_pct),
          additional_tariff_pct: r.additional_tariff_pct.trim() === "" ? null : Number(r.additional_tariff_pct),
        }))
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
        additional_tariff_pct: cooRows[0]?.additional_tariff_pct ?? null,
        unit_weight_kg:       form.unit_weight_kg.trim() === "" ? null : Number(form.unit_weight_kg),
        units_per_carton:     form.units_per_carton.trim() === "" ? null : Math.floor(Number(form.units_per_carton)),
        carton_cbm_m3:        form.carton_cbm_m3.trim() === "" ? null : Number(form.carton_cbm_m3),
        // AI master-carton estimate (+ manual override) — operator CBM estimator.
        carton_length_in:     form.carton_length_in.trim() === "" ? null : Number(form.carton_length_in),
        carton_width_in:      form.carton_width_in.trim() === "" ? null : Number(form.carton_width_in),
        carton_height_in:     form.carton_height_in.trim() === "" ? null : Number(form.carton_height_in),
        gross_weight_lb:      form.gross_weight_lb.trim() === "" ? null : Number(form.gross_weight_lb),
        cbm_confidence:       form.cbm_confidence.trim() || null,
        cbm_note:             form.cbm_note.trim() || null,
        cbm_inputs:           cbmInputs,
        carton_cbm_override:  form.carton_cbm_override,
        attributes:           { ...(style?.attributes ?? {}), coo_hts: cooRows, size_scale_pack: serializeScalePack(), color_ids: colorIds, inseams },
        aliases:              (form.aliases || []).map((a) => a.trim().toUpperCase()).filter(Boolean),
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
        // Renumber: send style_code only when it changed. The server captures the
        // old code as an alias and cascades the new code to the catalog.
        if (form.style_code.trim().toUpperCase() !== originalStyleCode.trim().toUpperCase() && form.style_code.trim() !== "") {
          body.style_code = form.style_code.trim().toUpperCase();
        }
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 24, width: "min(92vw, 760px)", maxWidth: "92vw", minWidth: 0, maxHeight: "90vh", overflowY: "auto", overflowX: "hidden", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{title}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, minWidth: 0 }}>
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
              <>
                <input
                  type="text"
                  value={form.style_code}
                  onChange={(e) => setForm({ ...form, style_code: e.target.value })}
                  style={inputStyle}
                  title="Renumber the style. The old code is kept as an alias so history and lookups still resolve it."
                />
                {form.style_code.trim().toUpperCase() !== originalStyleCode.trim().toUpperCase() && form.style_code.trim() !== "" && (
                  <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>
                    Renumbering <b>{originalStyleCode}</b> → <b>{form.style_code.trim().toUpperCase()}</b>. The old code is kept as an alias; the new code cascades to the catalog (SKUs keep their codes, so all history stays linked).
                  </div>
                )}
              </>
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
            <SearchableSelect
              value={form.gender_code || null}
              onChange={(v) => setForm({ ...form, gender_code: v })}
              options={genderSelectOptions.map((g) => ({ value: g.value, label: g.label }))}
              inputStyle={inputStyle as React.CSSProperties}
            />
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
                onClick={() => {
                  // When the style has inseams but the pack was only ever entered
                  // flat (no inseams before), seed each inseam column from that
                  // flat pack so the operator adjusts rather than starts from zero.
                  setPackByInseam((p) => {
                    if (!inseams.length) return p;
                    const flat = p[""];
                    const hasPerInseam = inseams.some((i) => p[i] && Object.keys(p[i]).length);
                    if (flat && Object.keys(flat).length && !hasPerInseam) {
                      const seeded: Record<string, Record<string, number>> = {};
                      for (const i of inseams) seeded[i] = { ...flat };
                      return seeded;
                    }
                    return p;
                  });
                  setScaleOpen(true);
                }}
                disabled={!form.size_scale_id}
                style={{ ...btnSecondary, whiteSpace: "nowrap", flexShrink: 0, opacity: form.size_scale_id ? 1 : 0.5 }}
                title={form.size_scale_id
                  ? "Define a pack ratio per size — typing one total in the SO/PO matrix auto-fills every size from this"
                  : "Pick a size scale first"}
              >
                Scale{scaleTotal > 0 ? ` (${scaleTotal})` : ""}
              </button>
            </div>
          </Field>

          {/* Prepack matrix — PPK styles only. Opens the SAME entry window as the
              Prepack Matrices master (MatrixFormModal) as a popup; on save the
              popup closes and this style form stays open. */}
          {isPpkStyle && (
            <Field label="Prepack matrix">
              <button
                type="button"
                onClick={() => void openPpkMatrix()}
                disabled={ppkMatrixLoading}
                style={{ ...btnSecondary, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: ppkMatrixLoading ? 0.6 : 1 }}
                title="Define this prepack's per-size garment composition (1 pack = the size quantities)"
              >
                {ppkMatrixLoading ? "Loading…" : ppkMatrix ? "Edit prepack matrix" : "+ Add prepack matrix"}
              </button>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                This style is a prepack (PPK){ppkMatrix ? <> — matrix <strong style={{ color: C.textSub }}>{ppkMatrix.code}</strong> is defined.</> : " — define its per-size composition so the Inventory Matrix can explode packs into sized eaches."}
              </div>
            </Field>
          )}

          {/* Rise (style_master.rise) — denim HIGH/MID/LOW; blank = n/a. */}
          <Field label="Rise">
            <SearchableSelect
              value={form.rise || null}
              onChange={(v) => setForm({ ...form, rise: v })}
              options={RISE_OPTIONS.map((r) => ({ value: r, label: r || "(select)" }))}
              inputStyle={inputStyle as React.CSSProperties}
            />
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
            <SearchableSelect
              value={form.lifecycle_status || null}
              onChange={(v) => setForm({ ...form, lifecycle_status: v })}
              options={LIFECYCLE_OPTIONS.map((g) => ({ value: g, label: g }))}
              inputStyle={inputStyle as React.CSSProperties}
            />
          </Field>
          <Field label="Planning class">
            <SearchableSelect
              value={form.planning_class || null}
              onChange={(v) => setForm({ ...form, planning_class: v })}
              options={PLANNING_OPTIONS.map((g) => ({ value: g, label: g || "(select)" }))}
              inputStyle={inputStyle as React.CSSProperties}
            />
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
          <Field label="HTS code · Duty % · +Tariff % · COO" span>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {coo.map((row, idx) => (
                <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
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
                      style={{ ...inputStyle, flex: "0 0 9ch", minWidth: 0 }}
                      placeholder="Duty %"
                      title="HTS duty rate % for this country of origin"
                    />
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={row.additional_tariff_pct}
                      onChange={(e) => setCooField(idx, "additional_tariff_pct", e.target.value)}
                      style={{ ...inputStyle, flex: "0 0 9ch", minWidth: 0, color: C.warn }}
                      placeholder="+Tariff %"
                      title="Additional tariff % (Trump-administration flat +10%, all countries) — on top of the duty rate"
                    />
                    <div style={{ flex: "0 0 22ch", minWidth: 0 }}>
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
                      {htsLoading && htsRowIdx === idx ? "…" : "Suggest HTS"}
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
              AI uses Group (top/bottom/accessory) + Gender + the base fabric's composition; the COO drives the country-specific duty rate (AGOA / USMCA / GSP, etc.). The <span style={{ color: C.warn }}>+Tariff %</span> is the Trump-administration additional tariff (flat +10%, all countries) charged on top of the duty rate. Row 1 is the primary HTS used across costing &amp; customs.
            </div>
          </Field>
          <Field label="Apparel?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_apparel} onChange={(e) => setForm({ ...form, is_apparel: e.target.checked })} />
              Yes (enforce 5-dim matrix on linked items)
            </label>
          </Field>

          {/* Colors — the colors this style is offered in. Drive the SO/PO size
              matrix rows. Searchable picker over the color master; admins can
              add a brand-new color inline (everyone can pick existing ones). */}
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Colors">
              {/* Show/hide toggle — colors can be numerous; collapse to keep the modal compact. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: C.textMuted }}>
                  {colorIds.length} color{colorIds.length === 1 ? "" : "s"}
                </span>
                {colorIds.length > 0 && (
                  <button type="button" onClick={() => setColorsShown((s) => !s)}
                    style={{ ...btnSecondary, padding: "2px 10px", fontSize: 12 }}>
                    {colorsShown ? "Hide" : "Show"}
                  </button>
                )}
              </div>
              {colorsShown && (
                <>
                  {colorIds.length === 0 && (
                    <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>No colors yet — add the colors this style comes in.</div>
                  )}
                  {/* Alphabetical, flowed top-to-bottom into auto-fit columns. */}
                  {colorIds.length > 0 && (
                    <div style={{ columnWidth: 180, columnGap: 16, marginBottom: 8 }}>
                      {sortedColorIds.map((id) => {
                        const c = colorNameById.get(id);
                        return (
                          <div key={id} style={{ breakInside: "avoid", display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, padding: "2px 0" }}>
                            {c && <ColorSwatch name={c.name} hex={c.hex} size={13} />}
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {c ? (c.code ? `${c.name} (${c.code})` : c.name) : <em style={{ color: C.textMuted }}>color {id.slice(0, 8)}…</em>}
                            </span>
                            <button type="button" onClick={() => removeColorFromStyle(id)} title="Remove color" style={{ background: "none", border: 0, color: "#F87171", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ maxWidth: 360 }}>
                    <SearchableSelect
                      value={null}
                      onChange={(v) => { if (v) addColorToStyle(v); }}
                      options={colorPickOptions}
                      placeholder="Search colors to add…"
                      onAddNew={isAdmin ? addNewColor : undefined}
                      addNewLabel={isAdmin ? (q) => `+ Add new color “${q.trim()}” to master` : undefined}
                    />
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                    These become the color rows in the Sales Order / Purchase Order size matrix.
                    {isAdmin ? " You can add a new color to the master." : " Only admins can add a brand-new color to the master."}
                  </div>
                </>
              )}
            </Field>
          </div>

          {/* Inseams — optional, bottoms only. Each declared inseam becomes a
              matrix row (color × inseam × size) on SO / PO entry. */}
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Inseams (optional — bottoms)">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {inseams.length === 0 && (
                  <span style={{ fontSize: 12, color: C.textMuted }}>No inseams — leave empty for tops / non-bottoms.</span>
                )}
                {inseams.map((v) => (
                  <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 14, padding: "3px 8px" }}>
                    {v}
                    <button type="button" onClick={() => removeInseam(v)} title="Remove inseam" style={{ background: "none", border: 0, color: "#F87171", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <input
                  type="text"
                  value={inseamDraft}
                  onChange={(e) => setInseamDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addInseam(inseamDraft); } }}
                  placeholder="e.g. 32"
                  style={{ ...inputStyle, width: "10ch" }}
                />
                <button type="button" onClick={() => addInseam(inseamDraft)} style={btnSecondary} disabled={!inseamDraft.trim()}>+ Add inseam</button>
                <span style={{ fontSize: 11, color: C.textMuted }}>quick add:</span>
                {COMMON_INSEAMS.filter((v) => !inseams.includes(v)).map((v) => (
                  <button key={v} type="button" onClick={() => addInseam(v)} style={{ ...btnSecondary, padding: "4px 8px", fontSize: 12 }}>{v}</button>
                ))}
              </div>
            </Field>
          </div>

          {/* Aliases — old style codes (auto-captured on renumber; also editable).
              Keep string-grain lookups (Xoro importer, prepack matrix) resolving a
              renamed style. */}
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Aliases (old style codes)">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {form.aliases.length === 0 && (
                  <span style={{ fontSize: 12, color: C.textMuted }}>No aliases. Renumbering this style auto-captures its old code here.</span>
                )}
                {form.aliases.map((v) => (
                  <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 14, padding: "3px 8px", fontFamily: "monospace" }}>
                    {v}
                    <button type="button" onClick={() => removeAlias(v)} title="Remove alias" style={{ background: "none", border: 0, color: "#F87171", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <input
                  type="text"
                  value={aliasDraft}
                  onChange={(e) => setAliasDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAlias(aliasDraft); } }}
                  placeholder="e.g. RYB147730"
                  style={{ ...inputStyle, width: "16ch" }}
                />
                <button type="button" onClick={() => addAlias(aliasDraft)} style={btnSecondary} disabled={!aliasDraft.trim()}>+ Add alias</button>
                <span style={{ fontSize: 11, color: C.textMuted }}>old Xoro/legacy codes resolve to this style on import &amp; lookup.</span>
              </div>
            </Field>
          </div>

          {/* Pack / logistics — roll up to PO total weight / cartons / CBM. */}
          <Field label="Pack / logistics">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div>
                <input type="text" inputMode="decimal" value={form.unit_weight_kg}
                  onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setForm({ ...form, unit_weight_kg: noLead(e.target.value) }); }}
                  style={inputStyle} placeholder="0.00" />
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Unit weight (kg)</div>
              </div>
              <div>
                <input type="text" inputMode="numeric" value={form.units_per_carton}
                  onChange={(e) => { if (/^\d*$/.test(e.target.value)) setForm({ ...form, units_per_carton: e.target.value }); }}
                  style={inputStyle} placeholder="0" />
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Units / carton</div>
              </div>
              <div>
                <input type="text" inputMode="decimal" value={form.carton_cbm_m3}
                  onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setForm({ ...form, carton_cbm_m3: noLead(e.target.value) }); }}
                  style={inputStyle} placeholder="0.000" />
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Carton CBM (m³)</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Used on Purchase Orders to roll up total weight, cartons, and CBM.</div>
          </Field>

          {/* AI master-carton estimator. Estimates carton dims + CBM + gross
              weight from product type / fold / unit weight / pack qty. A
              hand-entered (forwarder-measured) carton overrides the estimate. */}
          <Field label="Master carton — AI estimate">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <SearchableSelect
                  value={form.cbm_product_type || null}
                  onChange={(v) => setForm({ ...form, cbm_product_type: v || "" })}
                  options={[{ value: "", label: "(select)" }, ...dimValues.categories.map((c) => ({ value: c, label: c }))]}
                  placeholder="Product type…"
                />
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Product type (category)</div>
              </div>
              <div>
                <SearchableSelect
                  value={form.cbm_fold_type || null}
                  onChange={(v) => setForm({ ...form, cbm_fold_type: v })}
                  options={[
                    { value: "", label: "Fold type…" },
                    ...[
                      "Flat / Boxed — folded flat in layers",
                      "Half-fold — folded once, stacked",
                      "Rolled — knits, loungewear",
                      "Hanging / GOH — on hangers, garment-on-hanger carton",
                      "Bulk / Loose — poly-bagged, loose-packed",
                    ].map((f) => ({ value: f, label: f })),
                  ]}
                  inputStyle={inputStyle as React.CSSProperties}
                />
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Fold type</div>
              </div>
              <div>
                <input type="text" inputMode="decimal" value={form.cbm_unit_weight_lb}
                  onChange={(e) => {
                    if (!/^\d*\.?\d*$/.test(e.target.value)) return;
                    const lb = e.target.value;
                    const kg = lb.trim() === "" ? "" : noLead((Number(lb) / 2.20462).toFixed(4));
                    setForm({ ...form, cbm_unit_weight_lb: lb, unit_weight_kg: kg });
                  }}
                  style={inputStyle} placeholder="0.00" />
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Unit weight (lb) — syncs kg above</div>
              </div>
              <div style={{ display: "flex", alignItems: "flex-start" }}>
                <button type="button" onClick={() => void estimateCarton()} disabled={cbmLoading}
                  style={{ ...btnSecondary, width: "100%" }}
                  title="Estimate the master carton dimensions, CBM and gross weight with AI (Claude). Uses units/carton from the Pack/logistics row above.">
                  {cbmLoading ? "Estimating…" : "Estimate carton"}
                </button>
              </div>
            </div>

            {/* Carton dimensions — editable; editing flags a measured override. */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
              {([
                ["carton_length_in", "L (in)"],
                ["carton_width_in", "W (in)"],
                ["carton_height_in", "H (in)"],
              ] as const).map(([key, label]) => (
                <div key={key}>
                  <input type="text" inputMode="decimal" value={form[key]}
                    onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setOverrideDim(key, e.target.value); }}
                    style={inputStyle} placeholder="0.0" />
                  <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{label}</div>
                </div>
              ))}
              <div>
                <input type="text" inputMode="decimal" value={form.gross_weight_lb}
                  onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setForm({ ...form, gross_weight_lb: e.target.value }); }}
                  style={inputStyle} placeholder="0.0" />
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Gross wt (lb)</div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 12 }}>
                <input type="checkbox" checked={form.carton_cbm_override}
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    carton_cbm_override: e.target.checked,
                    carton_cbm_m3: e.target.checked
                      ? (cbmFromInches(f.carton_length_in, f.carton_width_in, f.carton_height_in) || f.carton_cbm_m3)
                      : f.carton_cbm_m3,
                  }))} />
                Measured carton (overrides AI estimate)
              </label>
              {form.cbm_confidence && (
                <span style={{ fontSize: 11, fontWeight: 600,
                  color: form.cbm_confidence === "high" ? C.success : form.cbm_confidence === "medium" ? C.warn : C.danger }}>
                  Confidence: {form.cbm_confidence}{form.cbm_confidence !== "high" ? " — verify by hand" : ""}
                </span>
              )}
            </div>
            {form.cbm_note && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontStyle: "italic" }}>{form.cbm_note}</div>}
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Estimate only — for freight planning. The carton CBM (m³) above is what Purchase Orders roll up; a measured carton overrides it everywhere.</div>
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

          {/* GS1 → EDI reference. The barcodes minted for this style are what every
              downstream EDI document references; this collapsible note explains the
              standard supplier ⇄ retailer flow so the codes stay consistent. */}
          <div style={{ gridColumn: "1 / -1" }}>
            <details style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 12px" }}>
              <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600, color: C.textSub, listStyle: "revert" }}>
                GS1 → EDI: the standard workflow
              </summary>
              <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.55, marginTop: 8 }}>
                The UPC / GTIN barcodes for this style flow through the retail integration
                in this order. Keep the codes consistent end to end — the retailer can only
                order what was published in the catalog.
                <ol style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  <li><strong style={{ color: C.textSub }}>Catalog</strong> — supplier publishes the style catalog via GDSN or a retail portal.</li>
                  <li><strong style={{ color: C.textSub }}>Download</strong> — retailer imports the catalog to update their system with the correct barcodes (UPC / EAN / GTIN).</li>
                  <li><strong style={{ color: C.textSub }}>EDI 850</strong> — retailer sends a Purchase Order using the exact downloaded barcodes.</li>
                  <li><strong style={{ color: C.textSub }}>EDI 856</strong> — supplier ships and sends an Advance Shipping Notice (ASN) matching those codes.</li>
                  <li><strong style={{ color: C.textSub }}>EDI 810</strong> — supplier sends the Invoice for final payment.</li>
                </ol>
                <div style={{ marginTop: 8 }}>
                  Generate and manage these codes in the <strong style={{ color: C.textSub }}>GS1 app</strong> →
                  UPC Master, Pack GTINs, and the Workflow Guide.
                </div>
              </div>
            </details>
          </div>
        </div>

        {mode === "edit" && style && (
          <StyleFabricsSection styleId={style.id} />
        )}

        {/* Customer style numbers — one base style ⇄ each customer's own number,
            so customer-customized variants don't fork new style rows. */}
        {mode === "edit" && style && (
          <StyleCustomerNumbersSection styleId={style.id} />
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
            style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(880px, 95vw)", maxHeight: "90vh", overflow: "auto" }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 4 }}>Size Scale — pack ratio</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
              Enter a representative quantity per size (the ratio is what matters)
              {inseams.length > 0 ? <> — one <strong>row per inseam</strong>, so each inseam can have its own size curve</> : null}.
              In an SO or PO size matrix, typing one total in the <strong>Qty</strong> column splits it
              across sizes in that row{inseams.length > 0 ? "’s inseam" : ""} proportion, then rounds each
              size up to a full carton of {24}.
            </div>
            {/* Horizontal pack matrix — sizes run across as columns (like the SO/PO
                size matrix); one row per inseam, or a single "Pack qty" row when the
                style has no inseams. A Total column closes each row; a column-totals
                footer appears once there's more than one row. */}
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, position: "static", textAlign: "left" }}>{inseams.length > 0 ? "Inseam" : ""}</th>
                    {scaleSizes.map((sz) => (
                      <th key={sz} style={{ ...th, position: "static", textAlign: "right", whiteSpace: "nowrap" }}>{sz}</th>
                    ))}
                    <th style={{ ...th, position: "static", textAlign: "right" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {scaleInseamKeys.map((ins) => (
                    <tr key={ins || "_"} style={{ borderBottom: `1px solid ${C.cardBdr}` }}>
                      <td style={{ padding: "6px 10px", color: C.textSub, whiteSpace: "nowrap", fontWeight: 600 }}>
                        {ins ? `${ins}″` : "Pack qty"}
                      </td>
                      {scaleSizes.map((sz) => {
                        const q = getScaleQty(ins, sz);
                        return (
                          <td key={sz} style={{ padding: "4px 6px", textAlign: "right" }}>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={q ? String(q) : ""}
                              onChange={(e) => { if (/^\d*$/.test(e.target.value)) setScaleQty(ins, sz, e.target.value); }}
                              placeholder="0"
                              style={{ ...inputStyle, width: "6ch", textAlign: "right", fontFamily: "SFMono-Regular, Menlo, monospace" }}
                            />
                          </td>
                        );
                      })}
                      <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 800, color: C.primary, fontFamily: "monospace" }}>
                        {inseamRowTotal(ins) || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {scaleInseamKeys.length > 1 && (
                  <tfoot>
                    <tr style={{ borderTop: `2px solid ${C.cardBdr}` }}>
                      <td style={{ padding: "8px 10px", fontWeight: 700, color: C.textSub }}>Total</td>
                      {scaleSizes.map((sz) => (
                        <td key={sz} style={{ padding: "8px 6px", textAlign: "right", color: C.textMuted, fontFamily: "monospace" }}>
                          {sizeColTotal(sz) || "—"}
                        </td>
                      ))}
                      <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 800, color: C.primary, fontFamily: "monospace" }}>
                        {scaleTotal || "—"}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setPackByInseam({})} style={btnSecondary} disabled={scaleTotal === 0}>Clear all</button>
              <button type="button" onClick={() => setScaleOpen(false)} style={btnPrimary}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Prepack-matrix popup — the IDENTICAL entry window used by the Prepack
          Matrices master. Prefilled with this style's PPK code (and the existing
          matrix when one exists). Saving closes only this popup; the style form
          stays open so the operator keeps working. */}
      {ppkMatrixOpen && (
        <MatrixFormModal
          mode={ppkMatrix ? "edit" : "add"}
          matrix={(ppkMatrix ?? ppkPrefill ?? undefined) as PrepackMatrix | undefined}
          initialPpk={form.style_code}
          initialPackToken={(ppkMatrix?.pack_token ?? ppkPrefill?.pack_token) ?? undefined}
          onClose={() => setPpkMatrixOpen(false)}
          onSaved={() => {
            setPpkMatrixOpen(false);
            notify("Prepack matrix saved.", "success");
            void loadPpkMatrix().then(setPpkMatrix);
          }}
        />
      )}
    </div>
  );
}

function Field({ label, children, span }: { label: string; children: React.ReactNode; span?: boolean }) {
  // minWidth:0 lets this grid item shrink below its content's intrinsic width
  // (grid items default to min-width:auto), so wide inner content truncates
  // instead of forcing the whole two-column grid — and the modal — off-screen.
  // `span` makes an inherently-wide field (e.g. the HTS/COO row) take the full
  // grid width instead of squeezing into one column.
  return (
    <div style={{ minWidth: 0, gridColumn: span ? "1 / -1" : undefined }}>
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
              <SearchableSelect
                value={draft.role || null}
                onChange={(v) => setDraft({ ...draft, role: v })}
                options={FABRIC_ROLES.map((r) => ({ value: r, label: r }))}
                inputStyle={{ ...(inputStyle as React.CSSProperties), minWidth: 0 }}
              />
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
              <SearchableSelect
                value={draft.fabric_code_id || null}
                onChange={(v) => setDraft({ ...draft, fabric_code_id: v })}
                options={[
                  { value: "", label: "— select —" },
                  ...fabrics.map((f) => ({ value: f.id, label: `${f.code} — ${f.name}` })),
                ]}
                inputStyle={{ ...(inputStyle as React.CSSProperties), minWidth: 0 }}
              />
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
// Customer style numbers — one base style ⇄ each customer's own style number.
// Self-managing: reads/writes /api/internal/style-customer-numbers directly.
// Lets one base style serve many customers without forking a style row each.
// ─────────────────────────────────────────────────────────────────────────────
type CustomerLite = { id: string; name: string; code?: string | null };
type StyleCustomerLink = {
  id: string;
  customer_id: string;
  customer_style_number: string;
  notes: string | null;
  customer?: CustomerLite | null;
};

function StyleCustomerNumbersSection({ styleId }: { styleId: string }) {
  const [links, setLinks] = useState<StyleCustomerLink[]>([]);
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({ customer_id: "", customer_style_number: "", notes: "" });

  async function loadLinks() {
    try {
      const r = await fetch(`/api/internal/style-customer-numbers?style_id=${styleId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setLinks(await r.json() as StyleCustomerLink[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  async function loadCustomers() {
    try {
      const r = await fetch(`/api/internal/customer-master?limit=5000`);
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data)) setCustomers(data as CustomerLite[]);
    } catch { /* non-fatal */ }
  }
  useEffect(() => { void loadLinks(); void loadCustomers(); }, [styleId]);

  const customerOptions: SearchableSelectOption[] = useMemo(() => [
    { value: "", label: "(select customer)" },
    ...customers.map((c) => ({ value: c.id, label: c.code ? `${c.name} (${c.code})` : c.name, searchHaystack: `${c.name} ${c.code ?? ""}` })),
  ], [customers]);

  async function addLink() {
    setErr(null);
    try {
      if (!draft.customer_id) throw new Error("Select a customer");
      if (!draft.customer_style_number.trim()) throw new Error("Enter the customer's style number");
      const r = await fetch(`/api/internal/style-customer-numbers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style_id: styleId, customer_id: draft.customer_id, customer_style_number: draft.customer_style_number.trim(), notes: draft.notes || null }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setAddOpen(false);
      setDraft({ customer_id: "", customer_style_number: "", notes: "" });
      await loadLinks();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  async function removeLink(id: string) {
    if (!(await confirmDialog("Remove this customer style-number mapping?"))) return;
    try {
      const r = await fetch(`/api/internal/style-customer-numbers/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await loadLinks();
    } catch (e: unknown) {
      notify(`Remove failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Customer style numbers</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>One base style, many customers — record each customer&apos;s own number so a customer PO resolves to this style.</div>
        </div>
        {!addOpen && <button onClick={() => setAddOpen(true)} style={btnSecondary}>+ Add customer #</button>}
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "6px 10px", borderRadius: 4, marginBottom: 8, fontSize: 12 }}>{err}</div>
      )}

      {loading ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>Loading…</div>
      ) : links.length === 0 ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>No customer style numbers mapped.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={th}>Customer</th>
              <th style={th}>Their style #</th>
              <th style={th}>Notes</th>
              <th style={{ ...th, width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <td style={td}>{l.customer ? (l.customer.code ? `${l.customer.name} (${l.customer.code})` : l.customer.name) : <span style={{ color: C.textMuted }}>(unknown)</span>}</td>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{l.customer_style_number}</td>
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
          <div style={{ minWidth: 0 }}>
            <Field label="Customer">
              <SearchableSelect
                value={draft.customer_id || null}
                onChange={(v) => setDraft({ ...draft, customer_id: v })}
                options={customerOptions}
                placeholder="Search customer…"
              />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8, minWidth: 0 }}>
            <Field label="Customer's style #">
              <input type="text" value={draft.customer_style_number}
                onChange={(e) => setDraft({ ...draft, customer_style_number: e.target.value })}
                style={{ ...inputStyle, minWidth: 0 }} placeholder="e.g. ABC-123" />
            </Field>
            <Field label="Notes">
              <input type="text" value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                style={{ ...inputStyle, minWidth: 0 }} placeholder="optional" />
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
