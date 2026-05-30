// VendorGridCell — inline vendor-picker dropdown for the grid's _vendor
// column. Lists vendors that already have quotes on this line; selecting
// one calls selectQuote (which becomes the line's winner and triggers the
// cost-write to ip_item_avg_cost via the select-quote handler).
//
// "+ Add new vendor…" opens the VendorQuotePanel for this line so the
// operator can add a quote with cost / lead time / status. We don't try
// to add quotes inline because they need quoted_cost and a few other
// fields the grid cell doesn't have room for.

import React from "react";
import { useCostingStore } from "../store/costingStore";

interface Props {
  lineId: string;
}

export default function VendorGridCell({ lineId }: Props) {
  const quotes = useCostingStore((s) => s.vendorQuotes[lineId] || []);
  const selectQuote = useCostingStore((s) => s.selectQuote);
  const setSelectedLine = useCostingStore((s) => s.setSelectedLine);
  const setQuotesPanelOpen = useCostingStore((s) => s.setQuotesPanelOpen);
  const loadQuotes = useCostingStore((s) => s.loadVendorQuotes);

  // Lazy-load this line's quotes so the dropdown isn't empty when the
  // operator clicks it. setSelectedLine already loads on select, but the
  // grid renders before any line is selected.
  React.useEffect(() => {
    if (!quotes || quotes.length === 0) loadQuotes(lineId);
    // We intentionally only fire when lineId changes — calling loadQuotes
    // on every render would re-fetch endlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId]);

  const selected = quotes.find((q) => q.status === "selected");

  const onPick = async (value: string) => {
    if (value === "__open__") {
      setSelectedLine(lineId);
      setQuotesPanelOpen(true);
      return;
    }
    if (!value) return;
    await selectQuote(lineId, value);
  };

  if (quotes.length === 0) {
    return (
      <button
        type="button"
        onClick={() => { setSelectedLine(lineId); setQuotesPanelOpen(true); }}
        title="No quotes yet — click to open Quotes panel and add one"
        style={{
          width: "100%", textAlign: "left",
          background: "transparent", border: "1px dashed #475569",
          color: "#94A3B8", borderRadius: 3,
          padding: "3px 6px", fontSize: 11, cursor: "pointer",
        }}
      >+ add quote</button>
    );
  }

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
      <option value="__open__">+ Add another quote…</option>
    </select>
  );
}
