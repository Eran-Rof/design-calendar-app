// Thin adapter around MultiSelectDropdown for the planner's
// single-select-with-sentinel pattern. The dropdown wants
// `selected: string[]` + `onChange(next: string[])`, but every
// caller using it for a single-pick filter ends up doing the same
// boilerplate at the call site:
//
//   selected={value === "all" ? [] : [value]}
//   onChange={(next) => set(next[0] ?? "all")}
//
// 13 copies of this shape across the request panel was enough.
// `emptyValue` lets callers stay on whatever sentinel they already
// use ("all" for filter strips, "" for form pickers).

import { MultiSelectDropdown } from "./MultiSelectDropdown";

export interface SinglePickFilterProps {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  allLabel?: string;
  placeholder?: string;
  /** Sentinel value meaning "no selection". Defaults to "". */
  emptyValue?: string;
  compact?: boolean;
  title?: string;
  minWidth?: number;
  closeOnMouseLeave?: boolean;
}

export function SinglePickFilter({
  value, onChange, options, allLabel, placeholder, emptyValue = "",
  compact, title, minWidth, closeOnMouseLeave,
}: SinglePickFilterProps) {
  return (
    <MultiSelectDropdown
      compact={compact}
      singleSelect
      selected={value === emptyValue ? [] : [value]}
      onChange={(next) => onChange(next[0] ?? emptyValue)}
      allLabel={allLabel}
      placeholder={placeholder}
      options={options}
      title={title}
      minWidth={minWidth}
      closeOnMouseLeave={closeOnMouseLeave}
    />
  );
}
