// MasterSelectCell — dropdown for grid cells whose options come from a
// costing master list (fit / closure / waist / comment). Renders a
// native <select> populated from the matching master, plus a sentinel
// "+ Add new…" option that triggers a prompt-style flow to add to the
// master and pick the new value.

import React from "react";
import { useCostingStore, type MasterKind } from "../store/costingStore";
import { promptDialog } from "../../shared/ui/warn";
import SearchableSelect from "../../tanda/components/SearchableSelect";

interface Props {
  kind: MasterKind;
  value: string | null;
  onChange: (next: string | null) => void;
  cellStyle?: React.CSSProperties;
}

export default function MasterSelectCell({ kind, value, onChange, cellStyle }: Props) {
  const entries = useCostingStore((s) => s.masters[kind]);
  const addMaster = useCostingStore((s) => s.addMaster);
  const setNotice = useCostingStore((s) => s.setNotice);

  // If the current value isn't in the master, surface it anyway so the
  // dropdown reflects what's actually on the line.
  const includesValue = !!value && entries.some((e) => e.name === value);

  const onSelect = async (raw: string) => {
    if (raw === "__add__") {
      const newName = await promptDialog(`Add new ${kind}:`, { title: `New ${kind}`, required: true });
      if (!newName || !newName.trim()) return;
      const clean = newName.trim();
      await addMaster(kind, clean);
      onChange(clean);
      setNotice(`Added "${clean}" to ${kind} master`, "info");
      return;
    }
    onChange(raw || null);
  };

  return (
    <SearchableSelect
      value={value || null}
      onChange={(v) => onSelect(v)}
      options={[
        { value: "", label: "—" },
        ...(value && !includesValue ? [{ value, label: `${value} (legacy)` }] : []),
        ...entries.map((e) => ({ value: e.name, label: e.name })),
        { value: "──────────", label: "──────────", disabled: true },
        { value: "__add__", label: "+ Add new…" },
      ]}
      inputStyle={{
        // 4px 6px matches the default numeric/text input padding so the
        // text inside this select aligns with the header label and other
        // cell contents (header padding 8px 10px, cell padding 0 4px,
        // inner padding 4px 6px → 10px from cell edge).
        width: "100%", padding: "4px 6px", fontSize: 12,
        background: "transparent", border: "1px solid transparent",
        color: "#E2E8F0", outline: "none",
        ...cellStyle,
      }}
    />
  );
}
