// CRUD panel for future buyer/planner demand requests. The compute layer
// reads rows from here through the repo at forecast-run time.
//
// Lives inside the workbench page — the caller passes master lists so we
// don't re-query.

import { Fragment, useEffect, useMemo, useState } from "react";
import type { IpCategory, IpCustomer, IpItem, IpSalesWholesaleRow } from "../types/entities";
import type {
  IpConfidenceLevel,
  IpFutureDemandRequest,
  IpRequestStatus,
  IpRequestType,
} from "../types/wholesale";
import { wholesaleRepo } from "../services/wholesalePlanningRepository";
import { monthOf } from "../compute/periods";
import { S, PAL, formatQty, formatPeriodCode } from "../components/styles";
import ConfirmModal from "../components/ConfirmModal";
import { MultiSelectDropdown } from "../components/MultiSelectDropdown";
import type { ToastMessage } from "../components/Toast";

const REQUEST_TYPES: IpRequestType[] = [
  "buyer_request", "expected_reorder", "program_fill_in",
  "seasonal_estimate", "planner_estimate", "customer_expansion",
];
const CONFIDENCE_LEVELS: IpConfidenceLevel[] = ["committed", "probable", "possible", "estimate"];
const STATUSES: IpRequestStatus[] = ["open", "applied", "archived"];

// Pulls the same item-master attribute fields the wholesale grid uses
// (group_name = Category, category_name = Sub Cat, gender). Both panels
// agree on naming so a planner who scopes by Category here sees the
// same buckets they see in the planning grid.
function readGroupName(item: IpItem | undefined | null): string | null {
  const v = item?.attributes && (item.attributes as Record<string, unknown>).group_name;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function readSubCategoryName(item: IpItem | undefined | null): string | null {
  const v = item?.attributes && (item.attributes as Record<string, unknown>).category_name;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export interface FutureDemandRequestsPanelProps {
  customers: IpCustomer[];
  categories: IpCategory[];
  items: IpItem[];
  requests: IpFutureDemandRequest[];
  onChange: () => Promise<void> | void;
  onToast: (t: ToastMessage) => void;
  currentUser?: string | null;
}

export default function FutureDemandRequestsPanel({
  customers, categories, items, requests, onChange, onToast, currentUser,
}: FutureDemandRequestsPanelProps) {
  const [filterStatus, setFilterStatus] = useState<IpRequestStatus | "all">("open");
  const [filterCustomer, setFilterCustomer] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterSubCat, setFilterSubCat] = useState<string>("all");
  const [filterStyle, setFilterStyle] = useState<string>("all");
  const [filterColor, setFilterColor] = useState<string>("all");
  const [filterDescription, setFilterDescription] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IpFutureDemandRequest | null>(null);

  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // ── Master-derived option pools ────────────────────────────────────
  // Categories / sub-cats / styles / colors / descriptions extracted
  // from the item master once. These power both the filter row above
  // the table AND the new-request form's pickers.
  const groupNames = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) { const g = readGroupName(i); if (g) set.add(g); }
    return Array.from(set).sort();
  }, [items]);
  const subCatNames = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      const sc = readSubCategoryName(i);
      if (!sc) continue;
      // Scope sub-cat list to the active category filter so the planner
      // sees only relevant options.
      if (filterCategory !== "all" && readGroupName(i) !== filterCategory) continue;
      set.add(sc);
    }
    return Array.from(set).sort();
  }, [items, filterCategory]);
  // TBD always rides at the top of style / color / description option
  // lists — same convention the wholesale grid's pickers use for the
  // catch-all stock-buy slot. Lets the planner record a request even
  // when the variant hasn't been added to the master yet.
  const styleNames = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      if (filterCategory !== "all" && readGroupName(i) !== filterCategory) continue;
      if (filterSubCat !== "all" && readSubCategoryName(i) !== filterSubCat) continue;
      const v = i.style_code ?? i.sku_code;
      if (v && v.toUpperCase() !== "TBD") set.add(v);
    }
    return ["TBD", ...Array.from(set).sort()];
  }, [items, filterCategory, filterSubCat]);
  const colorNames = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      if (filterStyle !== "all" && filterStyle !== "TBD" && (i.style_code ?? i.sku_code) !== filterStyle) continue;
      if (i.color && i.color.toUpperCase() !== "TBD") set.add(i.color);
    }
    return ["TBD", ...Array.from(set).sort()];
  }, [items, filterStyle]);
  const descriptionNames = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      if (filterStyle !== "all" && filterStyle !== "TBD" && (i.style_code ?? i.sku_code) !== filterStyle) continue;
      if (i.description && i.description.toUpperCase() !== "TBD") set.add(i.description);
    }
    return ["TBD", ...Array.from(set).sort()];
  }, [items, filterStyle]);

  // ── Filter pass ────────────────────────────────────────────────────
  const visible = useMemo(() => {
    return requests.filter((r) => {
      if (filterStatus !== "all" && r.request_status !== filterStatus) return false;
      if (filterCustomer !== "all" && r.customer_id !== filterCustomer) return false;
      const item = itemById.get(r.sku_id);
      if (filterCategory !== "all" && readGroupName(item) !== filterCategory) return false;
      if (filterSubCat !== "all" && readSubCategoryName(item) !== filterSubCat) return false;
      const style = item?.style_code ?? item?.sku_code ?? "";
      if (filterStyle !== "all" && style !== filterStyle) return false;
      if (filterColor !== "all" && (item?.color ?? "") !== filterColor) return false;
      if (filterDescription !== "all" && (item?.description ?? "") !== filterDescription) return false;
      return true;
    });
  }, [requests, filterStatus, filterCustomer, filterCategory, filterSubCat, filterStyle, filterColor, filterDescription, itemById]);

  async function archive(id: string) {
    setBusyId(id);
    try {
      await wholesaleRepo.updateRequest(id, { request_status: "archived" });
      await onChange();
      onToast({ text: "Request archived", kind: "success" });
    } catch (e) {
      onToast({ text: "Archive failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusyId(target.id);
    try {
      await wholesaleRepo.deleteRequest(target.id);
      await onChange();
      onToast({ text: "Request deleted", kind: "success" });
    } catch (e) {
      onToast({ text: "Delete failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={S.cardTitle}>Future demand requests</h3>
        <button style={S.btnPrimary} onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ New request"}
        </button>
      </div>

      {showForm && (
        <RequestForm
          customers={customers}
          items={items}
          categories={categories}
          currentUser={currentUser}
          onCancel={() => setShowForm(false)}
          onToast={onToast}
          onSaved={async (count) => {
            await onChange();
            setShowForm(false);
            onToast({
              text: count === 1 ? "Request created" : `${count} requests created`,
              kind: "success",
            });
          }}
        />
      )}

      {/* Hide the filter / search row while the new-request form is
          open — the filter dropdowns visually compete with the form's
          own pickers (same component, same layout) and the planner
          can't tell them apart at a glance. The row reappears as soon
          as the form is closed (Save success or Cancel). */}
      {!showForm && (
      <div style={{ ...S.toolbar, flexWrap: "wrap" }}>
        <MultiSelectDropdown
          compact
          singleSelect
          selected={filterStatus === "all" ? [] : [filterStatus]}
          onChange={(next) => setFilterStatus(((next[0] as IpRequestStatus) ?? "all") as IpRequestStatus | "all")}
          allLabel="All statuses"
          placeholder="Search statuses…"
          options={STATUSES.map((s) => ({ value: s, label: s }))}
        />
        <MultiSelectDropdown
          compact
          singleSelect
          selected={filterCustomer === "all" ? [] : [filterCustomer]}
          onChange={(next) => setFilterCustomer(next[0] ?? "all")}
          allLabel="All customers"
          placeholder="Search customers…"
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
        <MultiSelectDropdown
          compact
          singleSelect
          selected={filterCategory === "all" ? [] : [filterCategory]}
          onChange={(next) => { setFilterCategory(next[0] ?? "all"); setFilterSubCat("all"); setFilterStyle("all"); }}
          allLabel="All categories"
          placeholder="Search categories…"
          options={groupNames.map((g) => ({ value: g, label: g }))}
        />
        <MultiSelectDropdown
          compact
          singleSelect
          selected={filterSubCat === "all" ? [] : [filterSubCat]}
          onChange={(next) => { setFilterSubCat(next[0] ?? "all"); setFilterStyle("all"); }}
          allLabel="All sub cats"
          placeholder="Search sub cats…"
          options={subCatNames.map((s) => ({ value: s, label: s }))}
        />
        <MultiSelectDropdown
          compact
          singleSelect
          selected={filterStyle === "all" ? [] : [filterStyle]}
          onChange={(next) => { setFilterStyle(next[0] ?? "all"); setFilterColor("all"); setFilterDescription("all"); }}
          allLabel="All styles"
          placeholder="Search styles…"
          options={styleNames.map((s) => ({ value: s, label: s }))}
        />
        <MultiSelectDropdown
          compact
          singleSelect
          selected={filterColor === "all" ? [] : [filterColor]}
          onChange={(next) => setFilterColor(next[0] ?? "all")}
          allLabel="All colors"
          placeholder="Search colors…"
          options={colorNames.map((c) => ({ value: c, label: c }))}
        />
        <MultiSelectDropdown
          compact
          singleSelect
          selected={filterDescription === "all" ? [] : [filterDescription]}
          onChange={(next) => setFilterDescription(next[0] ?? "all")}
          allLabel="All descriptions"
          placeholder="Search descriptions…"
          options={descriptionNames.map((d) => ({ value: d, label: d }))}
        />
        <button
          style={{ ...S.btnSecondary, padding: "5px 10px", fontSize: 12 }}
          onClick={() => {
            setFilterStatus("open"); setFilterCustomer("all");
            setFilterCategory("all"); setFilterSubCat("all"); setFilterStyle("all");
            setFilterColor("all"); setFilterDescription("all");
          }}
        >Clear</button>
        <span style={{ color: PAL.textMuted, fontSize: 12 }}>
          {visible.length} of {requests.length}
        </span>
      </div>
      )}

      {!showForm && (
        <SalesHistorySummary
          items={items}
          filterCategory={filterCategory}
          filterSubCat={filterSubCat}
          filterStyle={filterStyle}
        />
      )}

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Period</th>
              <th style={S.th}>Customer</th>
              <th style={S.th}>Category</th>
              <th style={S.th}>Sub Cat</th>
              <th style={S.th}>Style</th>
              <th style={S.th}>Color</th>
              <th style={S.th}>Description</th>
              <th style={{ ...S.th, textAlign: "right" }}>Qty</th>
              <th style={S.th}>Type</th>
              <th style={S.th}>Confidence</th>
              <th style={S.th}>Status</th>
              <th style={S.th}>Note</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const customer = customerById.get(r.customer_id);
              const item = itemById.get(r.sku_id);
              // Parse the structured note marker the form writes on
              // save. Format: [REQ key1=val1|key2=val2|…] user note
              // (TBD prefix is the same shape with a different tag).
              // When present, prefer the planner's picks over what the
              // resolved sku_id's item row carries — works for both
              // TBD requests (where sku_id is a fallback) AND non-TBD
              // requests (where the item often lacks group_name /
              // category_name).
              const meta: Record<string, string> = {};
              let isTbd = false;
              let cleanNote = r.note ?? "";
              const m = cleanNote.match(/^\[(TBD|REQ)\s+([^\]]+)\]\s*(.*)$/);
              if (m) {
                isTbd = m[1] === "TBD";
                for (const pair of m[2].split("|")) {
                  const eq = pair.indexOf("=");
                  if (eq < 0) continue;
                  meta[pair.slice(0, eq)] = pair.slice(eq + 1);
                }
                cleanNote = m[3] ?? "";
              } else {
                // Legacy support — pre-marker TBD format from earlier
                // commits used "TBD <style>/<color>" plain text.
                const old = cleanNote.match(/^\[TBD style=([^ ]+) color=([^ ]+) desc=([^\]]+)\]\s*(.*)$/);
                if (old) {
                  isTbd = true;
                  meta.style = old[1]; meta.color = old[2]; meta.desc = old[3];
                  cleanNote = old[4] ?? "";
                }
              }
              const styleDisp = meta.style ?? item?.style_code ?? item?.sku_code ?? r.sku_id.slice(0, 8);
              const colorDisp = meta.color ?? item?.color ?? "–";
              const descDisp  = meta.desc  ?? item?.description ?? "–";
              const catDisp   = meta.cat   ?? readGroupName(item) ?? "–";
              const subCatDisp = meta.subcat ?? readSubCategoryName(item) ?? "–";
              const noteDisp  = cleanNote;
              return (
                <tr key={r.id}>
                  <td style={S.td}>{formatPeriodCode(monthOf(r.target_period_start).period_code)}</td>
                  <td style={S.td}>{customer?.name ?? r.customer_id.slice(0, 8)}</td>
                  <td style={{ ...S.td, color: PAL.textDim }}>{catDisp}</td>
                  <td style={{ ...S.td, color: PAL.textDim }}>{subCatDisp}</td>
                  <td style={{ ...S.td, fontFamily: "monospace", color: isTbd ? PAL.yellow : PAL.accent }}>{styleDisp}</td>
                  <td style={{ ...S.td, color: PAL.textDim }}>{colorDisp}</td>
                  <td style={{ ...S.td, color: PAL.textDim, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={descDisp}>
                    {descDisp}
                  </td>
                  <td style={S.tdNum}>{formatQty(r.requested_qty)}</td>
                  <td style={S.td}>{r.request_type}</td>
                  <td style={S.td}>{r.confidence_level}</td>
                  <td style={S.td}>{r.request_status}</td>
                  <td style={{ ...S.td, color: PAL.textMuted }}>{noteDisp}</td>
                  <td style={S.td}>
                    {r.request_status !== "archived" && (
                      <button style={S.btnGhost} onClick={() => archive(r.id)} disabled={busyId === r.id}>
                        Archive
                      </button>
                    )}
                    <button style={{ ...S.btnGhost, color: PAL.red }} onClick={() => setDeleteTarget(r)} disabled={busyId === r.id}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={13} style={{ ...S.td, color: PAL.textMuted, textAlign: "center", padding: 32 }}>
                {requests.length === 0
                  ? "No future demand requests yet. Click \"New request\" to add the first one."
                  : "No requests match your filters."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {deleteTarget && (
        <ConfirmModal
          icon="🗑"
          title="Delete request?"
          message="This removes the request entirely. Archive it instead if you want to keep the record."
          confirmText="Delete"
          confirmColor={PAL.red}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

function RequestForm({
  customers, items, currentUser, onCancel, onSaved, onToast,
}: {
  customers: IpCustomer[];
  categories: IpCategory[];
  items: IpItem[];
  currentUser?: string | null;
  onCancel: () => void;
  onSaved: (count: number) => Promise<void>;
  onToast: (t: ToastMessage) => void;
}) {
  const [customerId, setCustomerId] = useState<string>(customers[0]?.id ?? "");
  const [groupName, setGroupName] = useState<string>("");
  const [subCatName, setSubCatName] = useState<string>("");
  const [styleCode, setStyleCode] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [colorCodes, setColorCodes] = useState<string[]>([]);
  // Multi-select periods. Empty = single fallback (the current month).
  // Each picked YYYY-MM creates one request row.
  const [periodCodes, setPeriodCodes] = useState<string[]>([]);
  const [qty, setQty] = useState("");
  const [confidence, setConfidence] = useState<IpConfidenceLevel>("possible");
  const [type, setType] = useState<IpRequestType>("buyer_request");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // Cascading option pools — each picker scopes the next.
  const groupOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) { const g = readGroupName(i); if (g) set.add(g); }
    return Array.from(set).sort().map((g) => ({ value: g, label: g }));
  }, [items]);
  const subCatOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      if (groupName && readGroupName(i) !== groupName) continue;
      const sc = readSubCategoryName(i);
      if (sc) set.add(sc);
    }
    return Array.from(set).sort().map((s) => ({ value: s, label: s }));
  }, [items, groupName]);
  // TBD pinned to the top of every variant-level picker so the planner
  // can place a request even before the master has the SKU. Picking
  // TBD on Style auto-fills Color + Description to TBD too (handled in
  // the picker's onChange below) since TBD style implies an unknown
  // variant.
  const styleOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      if (groupName && readGroupName(i) !== groupName) continue;
      if (subCatName && readSubCategoryName(i) !== subCatName) continue;
      const v = i.style_code ?? i.sku_code;
      if (v && v.toUpperCase() !== "TBD") set.add(v);
    }
    return [{ value: "TBD", label: "TBD" }, ...Array.from(set).sort().map((s) => ({ value: s, label: s }))];
  }, [items, groupName, subCatName]);
  const colorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      if (styleCode && styleCode !== "TBD" && (i.style_code ?? i.sku_code) !== styleCode) continue;
      if (i.color && i.color.toUpperCase() !== "TBD") set.add(i.color);
    }
    return [{ value: "TBD", label: "TBD" }, ...Array.from(set).sort().map((c) => ({ value: c, label: c }))];
  }, [items, styleCode]);
  const descriptionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      if (styleCode && styleCode !== "TBD" && (i.style_code ?? i.sku_code) !== styleCode) continue;
      if (i.description && i.description.toUpperCase() !== "TBD") set.add(i.description);
    }
    return [{ value: "TBD", label: "TBD" }, ...Array.from(set).sort().map((d) => ({ value: d, label: d }))];
  }, [items, styleCode]);
  // Period options — next 12 months from today. The planner picks one
  // or more YYYY-MM codes; each creates a separate request row.
  const periodOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const code = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      out.push({ value: code, label: formatPeriodCode(code) });
    }
    return out;
  }, []);

  // Resolve a (style, color) pair to the FIRST matching sku_id from
  // the master. Same convention the wholesale grid uses to map a NEW
  // style → variant id when persisting TBD rows.
  // When style or color is TBD, fall back to the first item in the
  // master (any sku_id satisfies the FK) and prepend a TBD marker to
  // the note so the request is still persistable while clearly tagged
  // as awaiting a real variant.
  function resolveSkuId(style: string, color: string): string | null {
    if (style.toUpperCase() === "TBD" || color.toUpperCase() === "TBD") {
      return items[0]?.id ?? null;
    }
    for (const i of items) {
      if ((i.style_code ?? i.sku_code) !== style) continue;
      if (i.color === color) return i.id;
    }
    return null;
  }

  async function save() {
    const qn = Number(qty);
    if (!customerId)                                    { onToast({ text: "Pick a customer", kind: "error" }); return; }
    if (!styleCode)                                     { onToast({ text: "Pick a style", kind: "error" }); return; }
    if (colorCodes.length === 0)                        { onToast({ text: "Pick at least one color", kind: "error" }); return; }
    if (periodCodes.length === 0)                       { onToast({ text: "Pick at least one period", kind: "error" }); return; }
    if (!Number.isFinite(qn) || qn <= 0)                { onToast({ text: "Qty must be a positive number", kind: "error" }); return; }

    // Pre-resolve every (color × period) combination's sku_id so we
    // fail fast if the master is missing any of them.
    const combos: Array<{ skuId: string; color: string; period: string }> = [];
    const missing: string[] = [];
    for (const color of colorCodes) {
      const skuId = resolveSkuId(styleCode, color);
      if (!skuId) { missing.push(`${styleCode}-${color}`); continue; }
      for (const periodCode of periodCodes) combos.push({ skuId, color, period: periodCode });
    }
    if (missing.length > 0) {
      onToast({ text: `No items found for: ${missing.join(", ")}. Check the item master.`, kind: "error" });
      return;
    }

    setSaving(true);
    let written = 0;
    try {
      for (const c of combos) {
        const period = monthOf(`${c.period}-01`);
        const item = items.find((i) => i.id === c.skuId);
        // Encode every planner-picked dimension into a structured note
        // marker so the table can render the planner's actual choices,
        // not whatever the resolved sku_id's master row happens to
        // carry. Non-TBD requests need this for Cat / Sub Cat (the
        // master item often lacks group_name / category_name in
        // attributes) AND TBD requests need it because the sku_id
        // points to an arbitrary fallback row. Fields with no value
        // are omitted; the renderer falls back to the item lookup
        // for missing fields.
        const meta: string[] = [];
        if (groupName) meta.push(`cat=${groupName}`);
        if (subCatName) meta.push(`subcat=${subCatName}`);
        meta.push(`style=${styleCode}`);
        meta.push(`color=${c.color}`);
        if (description) meta.push(`desc=${description}`);
        const isTbd = styleCode.toUpperCase() === "TBD" || c.color.toUpperCase() === "TBD";
        const tag = isTbd ? "TBD" : "REQ";
        const noteParts: string[] = [`[${tag} ${meta.join("|")}]`];
        if (note.trim()) noteParts.push(note.trim());
        const noteOut = noteParts.join(" ");
        await wholesaleRepo.createRequest({
          customer_id: customerId,
          category_id: item?.category_id ?? null,
          sku_id: c.skuId,
          target_period_start: period.period_start,
          target_period_end: period.period_end,
          requested_qty: Math.round(qn),
          confidence_level: confidence,
          request_type: type,
          request_status: "open",
          note: noteOut,
          created_by: currentUser ?? null,
        });
        written++;
      }
      await onSaved(written);
    } catch (e) {
      onToast({
        text: `Saved ${written} of ${combos.length} — ${e instanceof Error ? e.message : String(e)}`,
        kind: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  const totalRows = colorCodes.length * periodCodes.length;

  return (
    <div style={{
      background: PAL.panel,
      border: `1px solid ${PAL.accent}`,
      borderRadius: 10,
      padding: "12px 14px",
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap" as const,
      fontSize: 12,
      marginBottom: 12,
    }}>
      <span style={{ fontWeight: 600, color: PAL.accent }}>+ New request</span>
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Customer:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={customerId ? [customerId] : []}
        onChange={(next) => setCustomerId(next[0] ?? "")}
        allLabel="— pick —"
        placeholder="Search customers…"
        options={customers.map((c) => ({ value: c.id, label: c.name }))}
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Cat:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={groupName ? [groupName] : []}
        onChange={(next) => { setGroupName(next[0] ?? ""); setSubCatName(""); setStyleCode(""); setColorCodes([]); setDescription(""); }}
        allLabel="All cats"
        placeholder="Search categories…"
        options={groupOptions}
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Sub Cat:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={subCatName ? [subCatName] : []}
        onChange={(next) => { setSubCatName(next[0] ?? ""); setStyleCode(""); setColorCodes([]); setDescription(""); }}
        allLabel="All sub cats"
        placeholder="Search sub cats…"
        options={subCatOptions}
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Style:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={styleCode ? [styleCode] : []}
        onChange={(next) => {
          const picked = next[0] ?? "";
          setStyleCode(picked);
          if (picked === "TBD") {
            // TBD style → auto-fill variant pickers to TBD too. The
            // planner can't drill into a variant of an unknown style.
            setColorCodes(["TBD"]);
            setDescription("TBD");
          } else if (picked) {
            // Existing style → auto-fill Description from the master's
            // first row that carries this style. Saves the planner the
            // redundant click for the common case where description
            // matches the style's master description verbatim.
            const masterDesc = items.find((i) => (i.style_code ?? i.sku_code) === picked && i.description)?.description ?? "";
            setColorCodes([]);
            setDescription(masterDesc);
          } else {
            setColorCodes([]);
            setDescription("");
          }
        }}
        allLabel="— pick —"
        placeholder="Search styles…"
        options={styleOptions}
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Description:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={description ? [description] : []}
        onChange={(next) => setDescription(next[0] ?? "")}
        allLabel="(optional)"
        placeholder="Search descriptions…"
        options={descriptionOptions}
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Colors:</span>
      <MultiSelectDropdown
        compact
        selected={colorCodes}
        onChange={setColorCodes}
        allLabel="Colors"
        placeholder="Search colors…"
        options={colorOptions}
        title="Pick one or more colors. Each color × period combo creates a row."
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Periods:</span>
      <MultiSelectDropdown
        compact
        selected={periodCodes}
        onChange={setPeriodCodes}
        allLabel="Periods"
        placeholder="Search periods…"
        options={periodOptions}
        title="Pick one or more months. Each color × period combo creates a row."
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Type:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={[type]}
        onChange={(next) => setType((next[0] as IpRequestType) ?? "buyer_request")}
        allLabel="Type"
        placeholder="Search types…"
        options={REQUEST_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))}
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Confidence:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={[confidence]}
        onChange={(next) => setConfidence((next[0] as IpConfidenceLevel) ?? "possible")}
        allLabel="Confidence"
        placeholder="Search confidence…"
        options={CONFIDENCE_LEVELS.map((c) => ({ value: c, label: c }))}
      />
      <input
        style={{ ...S.input, width: 90, fontSize: 12, padding: "4px 8px", textAlign: "right", fontFamily: "monospace" }}
        value={qty}
        inputMode="numeric"
        placeholder="Qty"
        onChange={(e) => setQty(e.target.value)}
      />
      <input
        style={{ ...S.input, minWidth: 180, fontSize: 12, padding: "4px 8px" }}
        value={note}
        placeholder="Note (optional)"
        onChange={(e) => setNote(e.target.value)}
      />
      {totalRows > 1 && (
        <span style={{ color: PAL.yellow, fontSize: 11, fontWeight: 600 }}>
          → will create {totalRows} rows
        </span>
      )}
      <button
        type="button"
        disabled={saving || !customerId || !styleCode || colorCodes.length === 0 || periodCodes.length === 0}
        onClick={save}
        style={{
          ...S.btnPrimary,
          padding: "5px 14px",
          fontSize: 12,
          opacity: saving || !customerId || !styleCode || colorCodes.length === 0 || periodCodes.length === 0 ? 0.5 : 1,
          cursor: saving || !customerId || !styleCode || colorCodes.length === 0 || periodCodes.length === 0 ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "Saving…" : totalRows > 1 ? `Create ${totalRows} requests` : "Create request"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        style={{ ...S.btnSecondary, padding: "5px 12px", fontSize: 12 }}
      >
        Cancel
      </button>
    </div>
  );
}

// Re-exported so other panels can reuse the constants without duplicating them.
export const ALL_REQUEST_TYPES = REQUEST_TYPES;
export const ALL_CONFIDENCE_LEVELS = CONFIDENCE_LEVELS;

// ── Sales history summary ──────────────────────────────────────────────────
// Per-month rollup of actual wholesale sales for the selected (Cat,
// Sub Cat, Style) scope, AGGREGATED ACROSS COLORS so the planner sees
// the style's full demand profile when sizing a new request. Margin
// uses the item-master unit_cost as the cost basis (best available
// proxy without joining receipts cost).
function SalesHistorySummary({ items, filterCategory, filterSubCat, filterStyle }: {
  items: IpItem[];
  filterCategory: string;
  filterSubCat: string;
  filterStyle: string;
}) {
  const [sales, setSales] = useState<IpSalesWholesaleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 12-month lookback. Refetch on mount only — items list is static
  // across this panel's lifetime, and re-fetching on every filter
  // change would burn IO for what's essentially a client-side reslice.
  useEffect(() => {
    setLoading(true); setErr(null);
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - 12);
    const sinceIso = since.toISOString().slice(0, 10);
    wholesaleRepo.listWholesaleSales(sinceIso)
      .then((rows) => setSales(rows))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const summary = useMemo(() => {
    type Bucket = { qty: number; sales: number; cost: number };
    const buckets = new Map<string, Bucket>();
    for (const s of sales) {
      const item = itemById.get(s.sku_id);
      if (!item) continue;
      if (filterCategory !== "all" && readGroupName(item) !== filterCategory) continue;
      if (filterSubCat !== "all" && readSubCategoryName(item) !== filterSubCat) continue;
      const style = item.style_code ?? item.sku_code;
      if (filterStyle !== "all" && style !== filterStyle) continue;

      const month = (s.txn_date ?? "").slice(0, 7);
      if (!month) continue;
      let b = buckets.get(month);
      if (!b) { b = { qty: 0, sales: 0, cost: 0 }; buckets.set(month, b); }
      const qty = s.qty ?? 0;
      const sales$ = s.net_amount ?? 0;
      const unitCost = item.unit_cost ?? 0;
      b.qty += qty;
      b.sales += sales$;
      b.cost += qty * unitCost;
    }
    const rows = Array.from(buckets.entries())
      .map(([month, b]) => {
        const avgPrice = b.qty > 0 ? b.sales / b.qty : 0;
        const margin = b.sales > 0 ? (b.sales - b.cost) / b.sales : 0;
        return { month, qty: b.qty, avgPrice, totalSales: b.sales, margin };
      })
      .sort((a, b) => a.month.localeCompare(b.month));
    const totals = rows.reduce(
      (acc, r) => {
        acc.qty += r.qty;
        acc.totalSales += r.totalSales;
        return acc;
      },
      { qty: 0, totalSales: 0 },
    );
    // Total avg price = weighted by qty.
    const totalCost = rows.reduce((c, r) => c + (r.totalSales > 0 && r.margin < 1 ? r.totalSales * (1 - r.margin) : 0), 0);
    const totalAvgPrice = totals.qty > 0 ? totals.totalSales / totals.qty : 0;
    const totalMargin = totals.totalSales > 0 ? (totals.totalSales - totalCost) / totals.totalSales : 0;
    return { rows, totalQty: totals.qty, totalAvgPrice, totalSales: totals.totalSales, totalMargin };
  }, [sales, itemById, filterCategory, filterSubCat, filterStyle]);

  const fmtUsd = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` :
    n >= 10_000   ? `$${(n / 1000).toFixed(1)}k` :
                    `$${Math.round(n).toLocaleString()}`;
  const fmtPrice = (n: number) =>
    n > 0 ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "–";
  const fmtPct = (n: number) =>
    Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "–";

  const scopeLabel = (() => {
    const parts: string[] = [];
    if (filterCategory !== "all") parts.push(filterCategory);
    if (filterSubCat !== "all") parts.push(filterSubCat);
    if (filterStyle !== "all") parts.push(filterStyle);
    return parts.length > 0 ? parts.join(" / ") : "All sales";
  })();

  return (
    <div style={{
      ...S.card,
      marginBottom: 12,
      padding: "12px 14px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: PAL.textMuted, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" }}>
          Sales history (trailing 12 mo) · {scopeLabel}
          {filterStyle !== "all" && <span style={{ color: PAL.textMuted, fontWeight: 400, marginLeft: 6 }}>· all colors aggregated</span>}
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
          <Stat label="Qty" value={formatQty(summary.totalQty)} accent={PAL.accent} />
          <Stat label="Avg price" value={fmtPrice(summary.totalAvgPrice)} accent={PAL.text} />
          <Stat label="Total sales" value={fmtUsd(summary.totalSales)} accent={PAL.green} />
          <Stat label="Margin" value={fmtPct(summary.totalMargin)} accent={summary.totalMargin >= 0.4 ? PAL.green : summary.totalMargin >= 0.25 ? PAL.yellow : PAL.red} />
        </div>
      </div>
      {loading ? (
        <div style={{ color: PAL.textMuted, fontSize: 12, padding: 8 }}>Loading sales…</div>
      ) : err ? (
        <div style={{ color: PAL.red, fontSize: 12, padding: 8 }}>Sales load failed — {err}</div>
      ) : summary.rows.length === 0 ? (
        <div style={{ color: PAL.textMuted, fontSize: 12, padding: 8 }}>
          No sales in the last 12 months for {scopeLabel}.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr repeat(4, 1fr)", gap: 4, fontSize: 12 }}>
          <div style={{ color: PAL.textMuted, fontWeight: 600 }}>Month</div>
          <div style={{ color: PAL.textMuted, fontWeight: 600, textAlign: "right" }}>Qty</div>
          <div style={{ color: PAL.textMuted, fontWeight: 600, textAlign: "right" }}>Avg price</div>
          <div style={{ color: PAL.textMuted, fontWeight: 600, textAlign: "right" }}>Total sales</div>
          <div style={{ color: PAL.textMuted, fontWeight: 600, textAlign: "right" }}>Margin</div>
          {summary.rows.map((r) => (
            <Fragment key={r.month}>
              <div style={{ color: PAL.textDim }}>{formatPeriodCode(r.month)}</div>
              <div style={{ textAlign: "right", fontFamily: "monospace", color: PAL.text }}>{formatQty(r.qty)}</div>
              <div style={{ textAlign: "right", fontFamily: "monospace", color: r.avgPrice > 0 ? PAL.text : PAL.textMuted }}>{fmtPrice(r.avgPrice)}</div>
              <div style={{ textAlign: "right", fontFamily: "monospace", color: r.totalSales > 0 ? PAL.green : PAL.textMuted }}>{fmtUsd(r.totalSales)}</div>
              <div style={{
                textAlign: "right",
                fontFamily: "monospace",
                color: r.margin >= 0.4 ? PAL.green : r.margin >= 0.25 ? PAL.yellow : PAL.red,
              }}>{fmtPct(r.margin)}</div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 9, color: PAL.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: accent, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}
