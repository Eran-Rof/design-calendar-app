// Assumption CRUD for the selected scenario.

import { useState } from "react";
import type {
  IpAssumptionType,
  IpAssumptionUnit,
  IpScenario,
  IpScenarioAssumption,
} from "../types/scenarios";
import type { IpCategory, IpCustomer, IpChannel, IpItem } from "../../types/entities";
import { scenarioRepo } from "../services/scenarioRepo";
import { logChange } from "../services/auditLogService";
import { S, PAL } from "../../components/styles";
import { confirmDialog } from "../../../shared/ui/warn";
import type { ToastMessage } from "../../components/Toast";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import SearchableSelect from "../../../tanda/components/SearchableSelect";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";

const TABLE_KEY = "ip.scenario_assumptions";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "type", label: "Type" },
  { key: "value", label: "Value" },
  { key: "unit", label: "Unit" },
  { key: "scope", label: "Scope" },
  { key: "note", label: "Note" },
];

const TYPES: Array<{ key: IpAssumptionType; unit: IpAssumptionUnit; hint: string }> = [
  { key: "demand_uplift_percent",   unit: "percent", hint: "+ lifts demand by %, − reduces it" },
  { key: "override_qty",            unit: "qty",     hint: "replace override qty directly" },
  { key: "protection_percent",      unit: "percent", hint: "ecom: protected = final × %" },
  { key: "reserve_qty_override",    unit: "qty",     hint: "force this reserve qty for matching rows" },
  { key: "receipt_delay_days",      unit: "days",    hint: "shift open-PO expected_date by N days" },
  { key: "lead_time_days_override", unit: "days",    hint: "(Phase 5+: not yet consumed by supply pass)" },
  { key: "promo_flag",              unit: "flag",    hint: "1 = on, 0 = off (ecom)" },
  { key: "markdown_flag",           unit: "flag",    hint: "1 = on, 0 = off (ecom)" },
];

export interface ScenarioAssumptionsPanelProps {
  scenario: IpScenario;
  assumptions: IpScenarioAssumption[];
  items: IpItem[];
  categories: IpCategory[];
  customers: IpCustomer[];
  channels: IpChannel[];
  readOnly?: boolean;
  onChange: () => Promise<void> | void;
  onToast: (t: ToastMessage) => void;
}

export default function ScenarioAssumptionsPanel({
  scenario, assumptions, items, categories, customers, channels,
  readOnly, onChange, onToast,
}: ScenarioAssumptionsPanelProps) {
  const [type, setType] = useState<IpAssumptionType>("demand_uplift_percent");
  const [value, setValue] = useState("");
  const [scopeSku, setScopeSku] = useState("");
  const [scopeCategory, setScopeCategory] = useState("");
  const [scopeCustomer, setScopeCustomer] = useState("");
  const [scopeChannel, setScopeChannel] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  const customerById = new Map(customers.map((c) => [c.id, c.name]));
  const channelById = new Map(channels.map((c) => [c.id, c.name]));
  const categoryById = new Map(categories.map((c) => [c.id, c.name]));
  const itemById = new Map(items.map((i) => [i.id, i.sku_code]));

  const selectedUnit = TYPES.find((t) => t.key === type)?.unit ?? "qty";
  const selectedHint = TYPES.find((t) => t.key === type)?.hint ?? "";

  // Additive per-column sort over the assumption rows. Type/scope cells render
  // derived/looked-up values, so supply matching accessors.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(assumptions, {
    persistKey: "ip:scenario_assumptions:sort",
    accessors: {
      type: (a) => a.assumption_type.replace(/_/g, " "),
      value: (a) => a.assumption_value ?? null,
      unit: (a) => a.assumption_unit ?? "",
      scope: (a) => scopeLabel(a, itemById, categoryById, customerById, channelById),
      note: (a) => a.note ?? "",
    },
  });

  async function addAssumption() {
    const v = Number(value);
    if (!Number.isFinite(v)) { onToast({ text: "Value must be a number", kind: "error" }); return; }
    setSaving(true);
    try {
      const row = await scenarioRepo.createAssumption({
        scenario_id: scenario.id,
        assumption_type: type,
        assumption_value: v,
        assumption_unit: selectedUnit,
        applies_to_sku_id: scopeSku || null,
        applies_to_category_id: scopeCategory || null,
        applies_to_customer_id: scopeCustomer || null,
        applies_to_channel_id: scopeChannel || null,
        period_start: null,
        note: note.trim() || null,
        created_by: null,
      });
      await logChange({
        entity_type: "assumption",
        entity_id: row.id,
        changed_field: type,
        new_value: `${v} ${selectedUnit}`,
        planning_run_id: scenario.planning_run_id,
        scenario_id: scenario.id,
      });
      setValue(""); setNote("");
      setScopeSku(""); setScopeCategory(""); setScopeCustomer(""); setScopeChannel("");
      await onChange();
      onToast({ text: "Assumption added", kind: "success" });
    } catch (e) {
      onToast({ text: "Couldn't add — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function removeAssumption(id: string) {
    if (!(await confirmDialog("Remove this assumption?"))) return;
    try {
      await scenarioRepo.deleteAssumption(id);
      await logChange({
        entity_type: "assumption",
        entity_id: id,
        changed_field: "deleted",
        scenario_id: scenario.id,
        planning_run_id: scenario.planning_run_id,
      });
      await onChange();
      onToast({ text: "Assumption removed", kind: "success" });
    } catch (e) {
      onToast({ text: "Couldn't remove — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    }
  }

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={S.cardTitle}>Scenario assumptions</h3>
        <TablePrefsButton
          tableKey={TABLE_KEY}
          columns={ALL_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
        />
      </div>
      {!readOnly && (
        <div style={{ ...S.infoCell, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: PAL.textDim, marginBottom: 8 }}>
            Add assumption · {selectedHint}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            <div>
              <label style={S.label}>Type</label>
              <SearchableSelect value={type} onChange={(v) => setType(v as IpAssumptionType)} inputStyle={{ ...S.select, width: "100%" }}
                options={TYPES.map((t) => ({ value: t.key, label: t.key.replace(/_/g, " ") }))} />
            </div>
            <div>
              <label style={S.label}>Value ({selectedUnit})</label>
              <input style={{ ...S.input, width: "100%" }} value={value}
                     inputMode="numeric"
                     placeholder={selectedUnit === "flag" ? "0 or 1" : ""}
                     onChange={(e) => setValue(e.target.value)} />
            </div>
            <div>
              <label style={S.label}>SKU scope (optional)</label>
              <SearchableSelect value={scopeSku || null} onChange={(v) => setScopeSku(v)} inputStyle={{ ...S.select, width: "100%" }}
                options={[{ value: "", label: "— all —" }, ...items.slice(0, 500).map((i) => ({ value: i.id, label: i.sku_code }))]} />
            </div>
            <div>
              <label style={S.label}>Category scope (optional)</label>
              <SearchableSelect value={scopeCategory || null} onChange={(v) => setScopeCategory(v)} inputStyle={{ ...S.select, width: "100%" }}
                options={[{ value: "", label: "— all —" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
            </div>
            <div>
              <label style={S.label}>Customer (wholesale)</label>
              <SearchableSelect value={scopeCustomer || null} onChange={(v) => setScopeCustomer(v)} inputStyle={{ ...S.select, width: "100%" }}
                options={[{ value: "", label: "— all —" }, ...customers.map((c) => ({ value: c.id, label: c.name }))]} />
            </div>
            <div>
              <label style={S.label}>Channel (ecom)</label>
              <SearchableSelect value={scopeChannel || null} onChange={(v) => setScopeChannel(v)} inputStyle={{ ...S.select, width: "100%" }}
                options={[{ value: "", label: "— all —" }, ...channels.map((c) => ({ value: c.id, label: c.name }))]} />
            </div>
            <div style={{ gridColumn: "1 / 3" }}>
              <label style={S.label}>Note</label>
              <input style={{ ...S.input, width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div style={{ alignSelf: "end" }}>
              <button style={S.btnPrimary} onClick={addAssumption} disabled={saving}>
                {saving ? "Saving…" : "+ Add assumption"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("type")} />
              <SortableTh label="Value" sortKey="value" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("value")} />
              <SortableTh label="Unit" sortKey="unit" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("unit")} />
              <SortableTh label="Scope" sortKey="scope" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("scope")} />
              <SortableTh label="Note" sortKey="note" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("note")} />
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.id}>
                <td style={S.td} hidden={!visibleColumns.has("type")}>{a.assumption_type.replace(/_/g, " ")}</td>
                <td style={{ ...S.tdNum, fontFamily: "monospace" }} hidden={!visibleColumns.has("value")}>{a.assumption_value ?? "–"}</td>
                <td style={{ ...S.td, color: PAL.textDim }} hidden={!visibleColumns.has("unit")}>{a.assumption_unit ?? "–"}</td>
                <td style={{ ...S.td, color: PAL.textDim, fontSize: 11 }} hidden={!visibleColumns.has("scope")}>
                  {scopeLabel(a, itemById, categoryById, customerById, channelById)}
                </td>
                <td style={{ ...S.td, color: PAL.textMuted }} hidden={!visibleColumns.has("note")}>{a.note ?? ""}</td>
                <td style={S.td}>
                  {!readOnly && (
                    <button style={{ ...S.btnGhost, color: PAL.red }} onClick={() => removeAssumption(a.id)}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
            {assumptions.length === 0 && (
              <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 32 }}>
                No assumptions yet. {readOnly ? "Scenario is read-only." : "Add one above and click \"Apply + Recompute\"."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function scopeLabel(
  a: IpScenarioAssumption,
  itemById: Map<string, string>,
  categoryById: Map<string, string>,
  customerById: Map<string, string>,
  channelById: Map<string, string>,
): string {
  const parts: string[] = [];
  if (a.applies_to_sku_id) parts.push(`SKU ${itemById.get(a.applies_to_sku_id) ?? "—"}`);
  if (a.applies_to_category_id) parts.push(`cat ${categoryById.get(a.applies_to_category_id) ?? "—"}`);
  if (a.applies_to_customer_id) parts.push(`cust ${customerById.get(a.applies_to_customer_id) ?? "—"}`);
  if (a.applies_to_channel_id) parts.push(`chan ${channelById.get(a.applies_to_channel_id) ?? "—"}`);
  if (a.period_start) parts.push(`period ${a.period_start}`);
  return parts.length ? parts.join(" · ") : "(all)";
}
