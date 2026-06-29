// src/tanda/InternalEmployees.tsx
//
// Tangerine P2 Chunk 8 - HR/Employee master admin panel.
// CRUD over employees. manager_employee_id picker is a dropdown of other
// active employees. Soft-delete via PATCH is_active=false.
//
// Wave 5 universal-primitive adoption (2026-05-30):
//   - TablePrefs           — per-user column show/hide on the list table.
//   - useRowClickEdit +    — click anywhere on a row (except action buttons)
//     ScrollHighlightRow     to open the edit modal; faded blue trail keeps
//                            track of where the operator last clicked.
//   - DynamicSearchInput   — replaces the old <input> + onChange wiring with
//                            a 200ms-debounced searchbox + clear-X built in.
//   - SearchableSelect     — manager picker in the modal swaps native
//                            <select> for the type-ahead combobox (employee
//                            rosters can easily exceed the ~7-option
//                            threshold this primitive targets).

import { useCallback, useEffect, useMemo, useState } from "react";
import { confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
// Cross-cutter T11-3 — audit-trail drop-in for the employee detail modal.
import RowHistory from "./components/RowHistory";
// Wave 5 universal primitives.
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import DynamicSearchInput from "./components/DynamicSearchInput";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import { NOTIFICATION_CATEGORIES } from "../lib/notificationCategories";
import { SB_URL, SB_HEADERS } from "../utils/supabase";

type Employee = {
  id: string;
  entity_id: string;
  auth_user_id: string | null;
  code: string;
  first_name: string;
  last_name: string;
  display_name: string;
  email: string;
  title: string | null;
  department: string | null;
  // P16 — title / department FK pointers + per-rep commission rates.
  title_id: string | null;
  department_id: string | null;
  commission_wholesale_pct: number | string | null;
  commission_closeout_pct: number | string | null;
  manager_employee_id: string | null;
  hire_date: string | null;
  termination_date: string | null;
  is_active: boolean;
  phone: string | null;
  // Internal notification categories this employee receives email alerts for.
  notification_subscriptions: string[] | null;
  // Internal apps where this employee receives IN-APP notifications.
  // null = all apps (back-compat).
  apps: string[] | null;
  // metadata.plm_user_id links the employee to their PLM login
  // (app_data['users'].id) so in-app notifications actually reach them.
  metadata: { plm_user_id?: string; [k: string]: unknown } | null;
  created_at: string;
  updated_at: string;
};

// Internal apps an employee can receive in-app notifications in. Keys MUST
// match the AppKey values in src/components/notifications/notificationApps.ts
// AND the ALLOWED_APP_KEYS list in the employees API handlers. The external
// vendor / b2b portals are intentionally excluded.
const IN_APP_NOTIFICATION_APPS: { key: string; label: string }[] = [
  { key: "tanda",    label: "PO WIP" },
  { key: "design",   label: "Design Calendar" },
  { key: "ats",      label: "ATS" },
  { key: "techpack", label: "Tech Packs" },
  { key: "gs1",      label: "GTIN Creation" },
  { key: "planning", label: "Inventory Planning" },
  { key: "rof",      label: "Phase Reviews" },
];

// A PLM login (app_data['users'] entry) the employee can be linked to.
type PlmUser = { id: string; username?: string; name?: string };

// P16 — reference-master rows fetched for the title / department pickers.
type EmployeeTitle = { id: string; name: string; is_sales_role: boolean };
type EmployeeDepartment = { id: string; name: string };

// Wave 5 — column visibility registry. Persistence key namespace follows
// the project convention used by InternalStyleMaster ("tangerine:<panel>:columns").
const EMPLOYEES_TABLE_KEY = "tangerine:employees:columns";
const EMPLOYEES_COLUMNS: ColumnDef[] = [
  { key: "code",        label: "Code" },
  { key: "name",        label: "Name" },
  { key: "email",       label: "Email" },
  { key: "title",       label: "Title" },
  { key: "department",  label: "Department" },
  { key: "active",      label: "Active" },
];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  // boxSizing keeps width:100% + padding inside the grid cell; without it
  // the field overflows its column and bleeds into the neighbouring field.
  boxSizing: "border-box",
  // colorScheme makes native pickers (date / time / color) render their
  // popup chrome in dark mode so the calendar widget matches the panel.
  colorScheme: "dark",
};
// Chunk M — greyed, read-only display for server-generated codes (operator item 14).
// Rendered as a real <input readOnly> so its box metrics match the sibling
// inputs exactly (operator: "code overlapped to name and heights don't match").
const readonlyCodeStyle: React.CSSProperties = {
  ...inputStyle,
  color: C.textMuted, border: `1px dashed ${C.cardBdr}`,
  fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600,
  cursor: "default", opacity: 0.85,
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

// Operator request — phone is freeform input but coerced into the US mask
// (XXX) XXX-XXXX as the operator types. Strips non-digits, caps at 10, and
// renders only as many groups as there are digits so partial entry isn't
// jarring. Pasting "5551234567" or "+1 (555) 123-4567" both normalise.
function formatPhone(raw: string): string {
  const d = (raw || "").replace(/\D/g, "").slice(0, 10);
  if (d.length === 0) return "";
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function InternalEmployees() {
  const [rows, setRows] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);

  // P16 — reference masters for the title / department pickers in the modal.
  const [titles, setTitles] = useState<EmployeeTitle[]>([]);
  const [departments, setDepartments] = useState<EmployeeDepartment[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const [tr, dr] = await Promise.all([
          fetch("/api/internal/employee-titles"),
          fetch("/api/internal/employee-departments"),
        ]);
        if (tr.ok) setTitles(await tr.json() as EmployeeTitle[]);
        if (dr.ok) setDepartments(await dr.json() as EmployeeDepartment[]);
      } catch {
        // Non-fatal: pickers fall back to empty lists; the panel still works.
      }
    })();
  }, []);

  // Wave 5 — column visibility (per-user persisted via user_preferences).
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    EMPLOYEES_TABLE_KEY,
    EMPLOYEES_COLUMNS,
  );
  const isVisible = useCallback((k: string) => visibleColumns.has(k), [visibleColumns]);

  // title/department render resolved lookups (titleOf/deptOf), so they stay
  // non-sortable.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:employees:sort",
    accessors: {
      name: (e) => e.display_name,
      active: (e) => e.is_active,
    },
  });

  // P16 — the modal writes the title_id / department_id FK pointers (via the
  // SearchableSelect pickers), but the list reads the legacy title / department
  // *text* columns. Rows edited through the new pickers therefore had blank
  // text columns and showed "—" even though a title/department was set
  // (operator: "title and department not showing for Molly"). Resolve the name
  // from the FK first, falling back to the legacy text column.
  const titleNameById = useMemo(() => new Map(titles.map((t) => [t.id, t.name])), [titles]);
  const deptNameById = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);
  const titleOf = useCallback(
    (e: Employee) => (e.title_id && titleNameById.get(e.title_id)) || e.title || "—",
    [titleNameById],
  );
  const deptOf = useCallback(
    (e: Employee) => (e.department_id && deptNameById.get(e.department_id)) || e.department || "—",
    [deptNameById],
  );

  // Wave 5 — universal row-click + scroll-highlight. Clicking anywhere on a
  // row opens the edit modal; the inline <button>s already short-circuit via
  // the hook's INTERACTIVE_SELECTOR (no extra stopPropagation needed).
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { getRowProps } = useRowClickEdit<Employee>({
    onRowClick: (e) => setEditing(e),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (e) => `Edit employee ${e.code}${e.display_name ? ` ${e.display_name}` : ""}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/employees?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [q, includeInactive]);

  async function deactivate(id: string) {
    if (!(await confirmDialog("Mark this employee inactive? (Soft delete; recoverable via toggle.)"))) return;
    const r = await fetch(`/api/internal/employees/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) {
      setErr((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return;
    }
    void load();
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Employees</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Internal staff, contractors, future hires. auth account binding is optional.
        </span>
        <button style={{ ...btnPrimary, marginLeft: "auto" }} onClick={() => setAddOpen(true)}>+ Add</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
        <DynamicSearchInput
          value={q}
          onChange={setQ}
          placeholder="Search code / name / email"
          ariaLabel="Search employees"
          wrapperStyle={{ maxWidth: 280 }}
        />
        <label style={{ color: C.textSub, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <TablePrefsButton
          tableKey={EMPLOYEES_TABLE_KEY}
          columns={EMPLOYEES_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="employees"
          sheetName="Employees"
          columns={[
            { key: "code",                header: "Code" },
            { key: "display_name",        header: "Name" },
            { key: "first_name",          header: "First Name" },
            { key: "last_name",           header: "Last Name" },
            { key: "email",               header: "Email" },
            { key: "phone",               header: "Phone" },
            { key: "title",               header: "Title" },
            { key: "department",          header: "Department" },
            { key: "manager_employee_id", header: "Manager ID" },
            { key: "hire_date",           header: "Hire Date",        format: "date" },
            { key: "termination_date",    header: "Termination Date", format: "date" },
            { key: "is_active",           header: "Active" },
            { key: "auth_user_id",        header: "Auth User ID" },
            { key: "created_at",          header: "Created", format: "datetime" },
            { key: "updated_at",          header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <SortableTh label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("code")} />
              <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("name")} />
              <SortableTh label="Email" sortKey="email" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("email")} />
              <th style={th} hidden={!isVisible("title")}>Title</th>
              <th style={th} hidden={!isVisible("department")}>Department</th>
              <SortableTh label="Active" sortKey="active" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("active")} />
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={7}>Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={7}>
                <span style={{ color: C.textMuted }}>No employees yet. Click <strong>+ Add</strong> to create one.</span>
              </td></tr>
            )}
            {sorted.map((e) => (
              <ScrollHighlightRow
                key={e.id}
                rowId={e.id}
                highlightedRowId={highlightedId}
                {...getRowProps(e)}
                style={e.is_active ? undefined : { opacity: 0.55 }}
              >
                <td style={{ ...td, fontFamily: "monospace" }} hidden={!isVisible("code")}>{e.code}</td>
                <td style={td} hidden={!isVisible("name")}>{e.display_name}</td>
                <td style={{ ...td, color: C.textSub }} hidden={!isVisible("email")}>{e.email}</td>
                <td style={td} hidden={!isVisible("title")}>{titleOf(e)}</td>
                <td style={td} hidden={!isVisible("department")}>{deptOf(e)}</td>
                <td style={td} hidden={!isVisible("active")}>{e.is_active ? "Active" : "Inactive"}</td>
                <td style={td}>
                  <button style={btnSecondary} onClick={() => setEditing(e)}>Edit</button>
                  &nbsp;
                  {e.is_active && (
                    <button style={btnDanger} onClick={() => void deactivate(e.id)}>Deactivate</button>
                  )}
                </td>
              </ScrollHighlightRow>
            ))}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <EmployeeModal
          mode="add"
          employees={rows}
          titles={titles}
          departments={departments}
          onCancel={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && (
        <EmployeeModal
          mode="edit"
          employee={editing}
          employees={rows}
          titles={titles}
          departments={departments}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function EmployeeModal({ mode, employee, employees, titles, departments, onCancel, onSaved }: {
  mode: "add" | "edit";
  employee?: Employee;
  employees: Employee[];
  titles: EmployeeTitle[];
  departments: EmployeeDepartment[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    code: employee?.code ?? "",
    first_name: employee?.first_name ?? "",
    last_name: employee?.last_name ?? "",
    email: employee?.email ?? "",
    title: employee?.title ?? "",
    department: employee?.department ?? "",
    // P16 — FK pointers + commission rates.
    title_id: employee?.title_id ?? "",
    department_id: employee?.department_id ?? "",
    commission_wholesale_pct: employee?.commission_wholesale_pct != null
      ? String(employee.commission_wholesale_pct) : "0",
    commission_closeout_pct: employee?.commission_closeout_pct != null
      ? String(employee.commission_closeout_pct) : "0",
    manager_employee_id: employee?.manager_employee_id ?? "",
    hire_date: employee?.hire_date ?? "",
    termination_date: employee?.termination_date ?? "",
    phone: formatPhone(employee?.phone ?? ""),
    is_active: employee?.is_active ?? true,
    notification_subscriptions: employee?.notification_subscriptions ?? [],
    // In-app notification apps. Empty array in the form = "all apps" (the
    // server stores it as NULL). We seed from the row's apps (null → []).
    apps: employee?.apps ?? [],
    // PLM-login link (app_data['users'].id) read from metadata.plm_user_id.
    plm_user_id: (employee?.metadata?.plm_user_id as string | undefined) ?? "",
  });

  // Toggle a notification category on/off in the form's subscription list.
  function toggleSubscription(key: string) {
    setForm((f) => ({
      ...f,
      notification_subscriptions: f.notification_subscriptions.includes(key)
        ? f.notification_subscriptions.filter((k) => k !== key)
        : [...f.notification_subscriptions, key],
    }));
  }

  // Toggle an in-app notification app on/off in the form's apps list.
  function toggleApp(key: string) {
    setForm((f) => ({
      ...f,
      apps: f.apps.includes(key) ? f.apps.filter((k) => k !== key) : [...f.apps, key],
    }));
  }

  // Load the PLM logins (app_data['users']) for the link picker, lazily on mount.
  const [plmUsers, setPlmUsers] = useState<PlmUser[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.users&select=value`, { headers: SB_HEADERS });
        if (!res.ok) return;
        const rows = await res.json();
        const raw = Array.isArray(rows) && rows[0]?.value ? rows[0].value : "[]";
        const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as PlmUser[];
        if (!cancelled && Array.isArray(parsed)) setPlmUsers(parsed);
      } catch { /* non-fatal: picker shows empty, link is optional */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof typeof form>(k: K, v: typeof form[K]) {
    setForm({ ...form, [k]: v });
  }

  async function save() {
    setErr(null);
    setSaving(true);
    try {
      // Keep the denormalized title / department *text* columns in sync with
      // the FK pointers the pickers set, so the list + Excel export (which read
      // the text columns) always reflect the chosen title/department.
      const selectedTitleName = titles.find((t) => t.id === form.title_id)?.name ?? null;
      const selectedDeptName = departments.find((d) => d.id === form.department_id)?.name ?? null;
      const payload: Record<string, unknown> = {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: form.email.trim(),
        title: form.title_id ? selectedTitleName : (form.title.trim() || null),
        department: form.department_id ? selectedDeptName : (form.department.trim() || null),
        // P16 — new FK pointers + commission rates. Commission rates are only
        // meaningful for sales-role titles; we still send them (0 default) so a
        // role flip doesn't leave a stale value behind.
        title_id: form.title_id || null,
        department_id: form.department_id || null,
        commission_wholesale_pct: form.commission_wholesale_pct.trim() === ""
          ? 0 : parseFloat(form.commission_wholesale_pct),
        commission_closeout_pct: form.commission_closeout_pct.trim() === ""
          ? 0 : parseFloat(form.commission_closeout_pct),
        manager_employee_id: form.manager_employee_id.trim() || null,
        hire_date: form.hire_date.trim() || null,
        termination_date: form.termination_date.trim() || null,
        phone: form.phone.trim() || null,
        is_active: form.is_active,
        notification_subscriptions: form.notification_subscriptions,
        // In-app notification apps: empty selection = all apps (send null).
        apps: form.apps.length > 0 ? form.apps : null,
        // PLM-login link (app_data['users'].id) — empty clears it server-side.
        plm_user_id: form.plm_user_id.trim() || null,
      };
      // Chunk M — code is server-generated; never sent from the client.
      // auth_user_id is no longer collected in the form (operator request);
      // the server treats it as optional and defaults it to null on create.

      const url = mode === "add"
        ? "/api/internal/employees"
        : `/api/internal/employees/${employee!.id}`;
      const r = await fetch(url, {
        method: mode === "add" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const otherActive = useMemo(
    () => employees.filter((e) => e.id !== employee?.id && e.is_active),
    [employees, employee?.id],
  );

  // Wave 5 — Manager picker swap: native <select> → SearchableSelect.
  // Employee rosters grow past the ~7-option threshold the primitive
  // targets; the haystack includes the employee code so filtering by
  // "EB001" or by display name both work.
  const managerOptions: SearchableSelectOption[] = useMemo(() => {
    return [
      { value: "", label: "(select)" },
      ...otherActive.map((m) => ({
        value: m.id,
        label: `${m.display_name} (${m.code})`,
        searchHaystack: `${m.display_name} ${m.code} ${m.email ?? ""}`,
      })),
    ];
  }, [otherActive]);

  // P16 — title / department pickers + commission-rate reveal.
  const titleOptions: SearchableSelectOption[] = useMemo(() => {
    return [
      { value: "", label: "(select)" },
      ...titles.map((t) => ({
        value: t.id,
        label: t.is_sales_role ? `${t.name} (sales)` : t.name,
        searchHaystack: t.name,
      })),
    ];
  }, [titles]);

  const departmentOptions: SearchableSelectOption[] = useMemo(() => {
    return [
      { value: "", label: "(select)" },
      ...departments.map((d) => ({ value: d.id, label: d.name, searchHaystack: d.name })),
    ];
  }, [departments]);

  // The selected title's is_sales_role flag drives the commission-rate reveal.
  const selectedTitleIsSalesRole = useMemo(
    () => titles.some((t) => t.id === form.title_id && t.is_sales_role),
    [titles, form.title_id],
  );

  // PLM-login picker options (app_data['users']).
  const plmUserOptions: SearchableSelectOption[] = useMemo(() => {
    return [
      { value: "", label: "(not linked)" },
      ...plmUsers.map((u) => {
        const label = u.name ? (u.username ? `${u.name} (${u.username})` : u.name) : (u.username || "—");
        return { value: u.id, label, searchHaystack: `${u.name ?? ""} ${u.username ?? ""} ${u.id}` };
      }),
    ];
  }, [plmUsers]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8,
        padding: 24, width: "min(640px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
      }}>
        <h2 style={{ margin: "0 0 16px 0", fontSize: 18 }}>
          {mode === "add" ? "Add employee" : "Edit employee"}
        </h2>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            {/* Chunk M — codes are server-generated + read-only (operator item 14).
                A real <input readOnly> (vs a <div>) guarantees identical height
                to the sibling fields so the row lines up cleanly. */}
            <input
              readOnly
              tabIndex={-1}
              style={mode === "add"
                ? { ...readonlyCodeStyle, fontStyle: "italic", fontFamily: "inherit" }
                : readonlyCodeStyle}
              value={mode === "add" ? "(auto-generated on save)" : (employee?.code || "—")}
            />
          </Field>
          {/* Operator request — hide the Active toggle on the Add form; new
              employees default to active server-side. Kept on Edit so an
              employee can be (re)activated/deactivated from the modal. */}
          {mode === "edit" && (
            <Field label="Active">
              <label style={{ color: C.textSub, fontSize: 13, display: "flex", alignItems: "center", gap: 6, paddingTop: 6 }}>
                <input type="checkbox" checked={form.is_active} onChange={(e) => set("is_active", e.target.checked)} />
                Is active
              </label>
            </Field>
          )}
          <Field label="First name">
            <input style={inputStyle} value={form.first_name} onChange={(e) => set("first_name", e.target.value)} />
          </Field>
          <Field label="Last name">
            <input style={inputStyle} value={form.last_name} onChange={(e) => set("last_name", e.target.value)} />
          </Field>
          <Field label="Email">
            <input style={inputStyle} value={form.email} onChange={(e) => set("email", e.target.value)} type="email" />
          </Field>
          <Field label="Phone">
            <input
              style={inputStyle}
              value={form.phone}
              onChange={(e) => set("phone", formatPhone(e.target.value))}
              placeholder="(555) 123-4567"
              inputMode="tel"
            />
          </Field>
          <Field label="Title">
            <SearchableSelect
              value={form.title_id || null}
              onChange={(v) => set("title_id", v)}
              options={titleOptions}
              placeholder="(select)"
              emptyText="No matching titles"
            />
          </Field>
          <Field label="Department">
            <SearchableSelect
              value={form.department_id || null}
              onChange={(v) => set("department_id", v)}
              options={departmentOptions}
              placeholder="(select)"
              emptyText="No matching departments"
            />
          </Field>
          {/* P16 — commission rates only shown for sales-role titles. */}
          {selectedTitleIsSalesRole && (
            <>
              <Field label="Wholesale %">
                <input
                  style={inputStyle}
                  type="number"
                  min="0"
                  max="100"
                  step="0.001"
                  value={form.commission_wholesale_pct}
                  onChange={(e) => set("commission_wholesale_pct", e.target.value)}
                  placeholder="0"
                />
              </Field>
              <Field label="Closeouts %">
                <input
                  style={inputStyle}
                  type="number"
                  min="0"
                  max="100"
                  step="0.001"
                  value={form.commission_closeout_pct}
                  onChange={(e) => set("commission_closeout_pct", e.target.value)}
                  placeholder="0"
                />
              </Field>
              <div style={{ gridColumn: "1 / -1", fontSize: 11, color: C.textMuted, marginTop: -4 }}>
                Closeout = any sale with margin ≤ 14%.
              </div>
            </>
          )}
          <Field label="Manager">
            <SearchableSelect
              value={form.manager_employee_id || null}
              onChange={(v) => set("manager_employee_id", v)}
              options={managerOptions}
              placeholder="(select)"
              emptyText="No matching employees"
            />
          </Field>
          <Field label="Hire date">
            <input style={inputStyle} type="date" value={form.hire_date} onChange={(e) => set("hire_date", e.target.value)} />
          </Field>
          <Field label="Termination date">
            <input style={inputStyle} type="date" value={form.termination_date} onChange={(e) => set("termination_date", e.target.value)} />
          </Field>

          {/* Email notification subscriptions — ticking a box routes that
              category's internal alerts to this employee's email (in addition
              to any INTERNAL_*_EMAILS env recipients). */}
          <div style={{ gridColumn: "1 / -1", marginTop: 4 }}>
            <label style={{ display: "block", marginBottom: 6, color: C.textSub, fontSize: 12, fontWeight: 600 }}>
              Email notifications
            </label>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
              This employee receives an email when any checked event happens. Requires a valid email above.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px" }}>
              {NOTIFICATION_CATEGORIES.map((cat) => (
                <label
                  key={cat.key}
                  title={cat.description}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.textSub, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={form.notification_subscriptions.includes(cat.key)}
                    onChange={() => toggleSubscription(cat.key)}
                  />
                  {cat.label}
                </label>
              ))}
            </div>
          </div>

          {/* In-app notification apps — which internal apps this employee sees
              this person's notifications in. Blank = all apps. */}
          <div style={{ gridColumn: "1 / -1", marginTop: 4 }}>
            <label style={{ display: "block", marginBottom: 6, color: C.textSub, fontSize: 12, fontWeight: 600 }}>
              In-app notification apps
            </label>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
              Apps where this employee receives in-app notifications (blank = all). Requires a linked PLM login below.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px" }}>
              {IN_APP_NOTIFICATION_APPS.map((app) => (
                <label
                  key={app.key}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.textSub, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={form.apps.includes(app.key)}
                    onChange={() => toggleApp(app.key)}
                  />
                  {app.label}
                </label>
              ))}
            </div>
          </div>

          {/* PLM login link — without this the in-app bell can't match this
              employee (the internal shell keys on app_data['users'].id). */}
          <div style={{ gridColumn: "1 / -1", marginTop: 4 }}>
            <Field label="Linked PLM login (for in-app delivery)">
              <SearchableSelect
                value={form.plm_user_id || null}
                onChange={(v) => set("plm_user_id", v ?? "")}
                options={plmUserOptions}
                placeholder="(not linked)"
                emptyText="No matching logins"
              />
            </Field>
            {!form.plm_user_id && (
              <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 4 }}>
                Not linked — in-app notifications won't reach this employee (email still works). Pick their PLM login to enable the in-app bell.
              </div>
            )}
          </div>
        </div>

        {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginTop: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btnSecondary} onClick={onCancel} disabled={saving}>Cancel</button>
          <button style={btnPrimary} onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : mode === "add" ? "Create" : "Save"}
          </button>
        </div>

        {/* Cross-cutter T11-3 — audit trail timeline */}
        {mode === "edit" && employee && (
          <RowHistory source_table="employees" source_id={employee.id} />
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", marginBottom: 4, color: C.textSub, fontSize: 12, fontWeight: 600 }}>
        {label}
      </label>
      {children}
    </div>
  );
}
