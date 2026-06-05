// useEmployeeOptions — shared employee lookup for owner/assignee pickers.
//
// Loads the (small) active employee list once from /api/internal/employees and
// exposes it as SearchableSelect options: label = "Code — First Last", value =
// employee id, with email folded into the search haystack. Used by the CRM /
// Cases owner & assignee pickers so the operator never types a raw user UUID —
// they pick a name; the stored value is still the id (no-UUID standard).

import { useEffect, useMemo, useState } from "react";

export type EmployeeRow = {
  id: string;
  code?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
};

export type EmployeeOption = {
  value: string;
  label: string;
  searchHaystack: string;
};

export function employeeLabel(e: EmployeeRow): string {
  const name = [e.first_name, e.last_name].filter(Boolean).join(" ").trim();
  if (e.code && name) return `${e.code} — ${name}`;
  return name || e.code || e.email || "—";
}

export function useEmployeeOptions(): {
  employees: EmployeeRow[];
  options: EmployeeOption[];
} {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/internal/employees`);
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && Array.isArray(data)) setEmployees(data as EmployeeRow[]);
      } catch { /* non-fatal — picker just stays empty */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const options = useMemo<EmployeeOption[]>(
    () => employees.map((e) => ({
      value: e.id,
      label: employeeLabel(e),
      searchHaystack: [e.code, e.first_name, e.last_name, e.email].filter(Boolean).join(" "),
    })),
    [employees],
  );

  return { employees, options };
}
