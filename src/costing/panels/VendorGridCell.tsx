// VendorGridCell — inline vendor-picker for the grid's _vendor column.
//
// Two modes:
//   • pick:   <select> listing vendors with existing quotes on this line.
//             Picking one calls selectQuote (becomes winner, triggers
//             cost-write to ip_item_avg_cost via select-quote handler).
//   • add:    VendorPickerCell autocomplete — picking (or freeform-adding
//             via the "+ Add new vendor" sentinel) creates a quote on
//             this line with status='received' + quoted_cost = line.target_cost
//             (or 0 if absent), then immediately calls selectQuote so the
//             new vendor becomes the winner.
//
// "+ Add another quote…" in the dropdown still opens the side
// VendorQuotePanel for operators who want to enter lead time / MOQ /
// dates / status manually instead of using the inline quick-add.

import React, { useState } from "react";
import { useCostingStore } from "../store/costingStore";
import VendorPickerCell from "./VendorPickerCell";
import type { CostingLineVendor } from "../types";
import type { VendorHit } from "../services/costingApi";

interface Props {
  lineId: string;
}

// Stable empty-array reference for the Zustand selector — returning
// a fresh `[]` literal on each render triggers an infinite re-render
// loop (Zustand uses === to detect change; new array ref every render
// → render → new ref → render → React error #185).
const EMPTY: CostingLineVendor[] = [];

export default function VendorGridCell({ lineId }: Props) {
  const quotes = useCostingStore((s) => s.vendorQuotes[lineId] || EMPTY);
  const lines = useCostingStore((s) => s.lines);
  const selectQuote = useCostingStore((s) => s.selectQuote);
  const addQuote = useCostingStore((s) => s.addQuote);
  const setSelectedLine = useCostingStore((s) => s.setSelectedLine);
  const setQuotesPanelOpen = useCostingStore((s) => s.setQuotesPanelOpen);
  const loadQuotes = useCostingStore((s) => s.loadVendorQuotes);
  const setNotice = useCostingStore((s) => s.setNotice);

  const [addingNew, setAddingNew] = useState(false);

  // Lazy-load this line's quotes so the dropdown isn't empty when the
  // operator clicks it. setSelectedLine already loads on select, but the
  // grid renders before any line is selected.
  React.useEffect(() => {
    if (!quotes || quotes.length === 0) loadQuotes(lineId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId]);

  const selected = quotes.find((q) => q.status === "selected");

  const onInlineVendorPicked = async (vendor: VendorHit) => {
    const line = lines.find((l) => l.id === lineId);
    const seedCost = typeof line?.target_cost === "number" ? line.target_cost : 0;
    const created = await addQuote(lineId, {
      vendor_id: vendor.id,
      quoted_cost: seedCost,
      currency: vendor.default_currency || "USD",
      status: "received",
    });
    setAddingNew(false);
    if (created) {
      // Promote to selected so this vendor becomes the line's winner +
      // the cost-write to ip_item_avg_cost fires. The store's selectQuote
      // also surfaces the success/skip toast.
      await selectQuote(lineId, created.id);
    } else {
      setNotice("Could not add quote — see console for details.", "error");
    }
  };

  const onPick = async (value: string) => {
    if (value === "__open__") {
      setSelectedLine(lineId);
      setQuotesPanelOpen(true);
      return;
    }
    if (value === "__newvendor__") {
      setAddingNew(true);
      return;
    }
    if (!value) return;
    await selectQuote(lineId, value);
  };

  // Mode 2 — inline vendor autocomplete (with freeform "+ Add new vendor").
  if (addingNew) {
    return (
      <div style={{ width: "100%", display: "flex", gap: 4, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <VendorPickerCell value={null} onPick={onInlineVendorPicked} placeholder="Vendor name…" />
        </div>
        <button
          type="button"
          onClick={() => setAddingNew(false)}
          title="Cancel"
          style={{
            background: "transparent", color: "#94A3B8",
            border: "1px solid #475569", borderRadius: 3,
            padding: "2px 6px", fontSize: 11, cursor: "pointer",
          }}
        >×</button>
      </div>
    );
  }

  // Mode 1 (empty) — single button that flips to add mode.
  if (quotes.length === 0) {
    return (
      <button
        type="button"
        onClick={() => setAddingNew(true)}
        title="Pick or add a vendor — creates a quote at target cost and selects it"
        style={{
          width: "100%", textAlign: "left",
          background: "transparent", border: "1px dashed #475569",
          color: "#94A3B8", borderRadius: 3,
          padding: "3px 6px", fontSize: 11, cursor: "pointer",
        }}
      >+ pick vendor</button>
    );
  }

  // Mode 1 (populated) — winner-picker select with "+ Add vendor" sentinel.
  return (
    <select
      value={selected?.id || ""}
      onChange={(e) => onPick(e.target.value)}
      style={{
        width: "100%", padding: "4px 6px", fontSize: 11,
        background: "transparent", color: selected ? "#A7F3D0" : "#94A3B8",
        border: "1px solid transparent", borderRadius: 3,
        outline: "none", colorScheme: "dark",
        fontWeight: selected ? 600 : 400,
      }}
      title={selected
        ? `Selected: ${selected.vendor?.legal_name || selected.vendor?.code || "—"} @ ${selected.quoted_cost ?? "?"}`
        : "Pick a vendor to set as winner"}
    >
      {!selected && <option value="">— pick winner —</option>}
      {quotes.map((q) => {
        const name = q.vendor?.legal_name || q.vendor?.code || q.vendor_id || "vendor";
        const cost = typeof q.quoted_cost === "number" ? `$${q.quoted_cost.toFixed(2)}` : "?";
        return <option key={q.id} value={q.id}>{name} @ {cost}</option>;
      })}
      <option disabled>──────────</option>
      <option value="__newvendor__">+ Pick or add vendor (quick)…</option>
      <option value="__open__">+ Add another quote (full form)…</option>
    </select>
  );
}
