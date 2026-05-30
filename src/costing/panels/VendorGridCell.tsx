// VendorGridCell — inline vendor picker for the grid's _vendor column.
//
// Replaces the old "winner picker among existing quotes" UX. Now it's a
// pure vendor autocomplete — clicking the cell shows the first 25 active
// vendors immediately; typing filters; "+ Add new vendor" creates a new
// vendor row inline.
//
// On pick: creates/updates the per-line vendor selection by writing a
// costing_line_vendors row with status='selected' (the same select-quote
// flow Award→cost-write already uses). The line's selected_vendor_quote_id
// gets stamped so the RFQ generation (and any other "which vendor on
// this line?" consumer) can resolve the vendor without an extra join.

import React, { useEffect, useRef, useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { useVendorSearch } from "../hooks/useStyleSearch";
import { addVendor } from "../services/costingApi";
import type { CostingLineVendor } from "../types";
import type { VendorHit } from "../services/costingApi";

interface Props {
  lineId: string;
}

// Stable empty-array reference for the Zustand selector — fresh `[]`
// literal on each render triggers React error #185 (see PR #577).
const EMPTY: CostingLineVendor[] = [];

export default function VendorGridCell({ lineId }: Props) {
  const quotes = useCostingStore((s) => s.vendorQuotes[lineId] || EMPTY);
  const lines = useCostingStore((s) => s.lines);
  const selectQuote = useCostingStore((s) => s.selectQuote);
  const addQuote = useCostingStore((s) => s.addQuote);
  const loadQuotes = useCostingStore((s) => s.loadVendorQuotes);
  const setNotice = useCostingStore((s) => s.setNotice);

  const { rows: searchRows, loading, search } = useVendorSearch();

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Currently-selected vendor for this line (via the costing_line_vendors
  // row with status='selected'). Renders as the cell's display label.
  const selected = quotes.find((q) => q.status === "selected");
  const selectedLabel = selected?.vendor?.legal_name || selected?.vendor?.code || "";

  // Mirror the selected label into the input when not actively editing,
  // so navigating away + back shows the persisted pick.
  useEffect(() => { if (!open) setText(selectedLabel); }, [selectedLabel, open]);

  // Lazy-load this line's quotes once so `selected` resolves on mount.
  useEffect(() => {
    if (!quotes || quotes.length === 0) loadQuotes(lineId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId]);

  // Outside-click closer.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const canAdd = text.trim().length > 0
    && !loading
    && !searchRows.some((r) => (r.legal_name || r.code || "").toLowerCase() === text.trim().toLowerCase());

  const onPickVendor = async (vendor: VendorHit) => {
    setText(vendor.legal_name || vendor.code || "");
    setOpen(false);
    const line = lines.find((l) => l.id === lineId);
    const seedCost = typeof line?.target_cost === "number" ? line.target_cost : 0;
    // If this vendor already has a quote on the line, just promote that
    // existing quote (no duplicate row).
    const existing = quotes.find((q) => q.vendor_id === vendor.id);
    if (existing) {
      await selectQuote(lineId, existing.id);
      return;
    }
    // Otherwise create a fresh quote row + promote it.
    const created = await addQuote(lineId, {
      vendor_id: vendor.id,
      quoted_cost: seedCost,
      currency: vendor.default_currency || "USD",
      status: "received",
    });
    if (created) {
      await selectQuote(lineId, created.id);
    } else {
      setNotice("Could not record vendor pick — see console for details.", "error");
    }
  };

  const onInlineAdd = async () => {
    const name = text.trim();
    if (!name) return;
    setAdding(true);
    try {
      const created = await addVendor(name);
      await onPickVendor(created);
      setNotice(`Added new vendor "${name}"`, "info");
    } catch (e) {
      setNotice(`Could not add vendor: ${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={text}
        placeholder="Vendor…"
        // Open + fire empty search on focus so the operator sees the full
        // vendor list immediately without typing.
        onFocus={() => { search(text); setOpen(true); }}
        onChange={(e) => { const v = e.target.value; setText(v); search(v); setOpen(true); }}
        style={{
          width: "100%", padding: "4px 6px", fontSize: 11,
          background: "transparent", color: selected ? "#A7F3D0" : "#E2E8F0",
          border: "1px solid transparent", borderRadius: 3, outline: "none",
          fontWeight: selected ? 600 : 400,
        }}
        title={selected ? `Selected: ${selectedLabel}` : "Pick or type a vendor"}
      />
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 50,
          minWidth: 280, maxHeight: 280, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          marginTop: 2,
        }}>
          {loading && <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>Searching…</div>}
          {searchRows.map((v) => (
            <button
              key={v.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onPickVendor(v); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 10px", background: "transparent",
                border: "none", borderBottom: "1px solid #334155",
                color: "#E2E8F0", cursor: "pointer", fontSize: 12,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 600 }}>{v.legal_name || v.code || v.id}</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>
                {v.code ? v.code : ""}
                {v.country ? ` · ${v.country}` : ""}
                {v.default_currency ? ` · ${v.default_currency}` : ""}
              </div>
            </button>
          ))}
          {!loading && searchRows.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>
              {text ? `No vendors match "${text}".` : "No vendors yet — type a name and click '+ Add'."}
            </div>
          )}
          {canAdd && (
            <button
              type="button"
              disabled={adding}
              onMouseDown={(e) => { e.preventDefault(); onInlineAdd(); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 10px", background: "#0F172A",
                border: "none", color: "#10B981",
                cursor: adding ? "wait" : "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >{adding ? "Adding…" : `+ Add new vendor "${text.trim()}"`}</button>
          )}
        </div>
      )}
    </div>
  );
}
