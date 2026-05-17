// Export Options modal — opens when the user clicks "Export Excel"
// in the Reports menu. Lets the operator pick which extras the
// generated workbook should include (subtotals, avg cost columns,
// implied sale price at a margin, trailing-3 and same-period-last-year
// sales blocks) and optionally narrow trailing/SPLY data to one
// customer.

import React, { useMemo, useState } from "react";
import type { ExcelData } from "../types";

export interface ExportOptions {
  // Per-style subtotal rows. Existing behavior: always emitted when the
  // export spans more than one style and at least one style has 2+
  // variants. Modal flips it off when the operator just wants the data
  // without the subtotal rows.
  subtotals: boolean;
  // Append Avg Cost + Total Cost columns after the Total column.
  // Total Cost = avgCost × row's sum-of-periods total.
  avgCost: boolean;
  // Append a "Sls Prc @ <mrgn>%" column. Implied sale price needed to
  // hit the margin against avgCost (price = avgCost / (1 - mrgn)).
  // Requires avgCost to be meaningful but rendered as a standalone
  // column so callers can pick this without the other two.
  slsPrcAtMrgn: boolean;
  // Margin % used by slsPrcAtMrgn. UI input. Default 21.
  slsMarginPct: number;
  // Trailing-3-months sales block. For each row: qty + avg sales price
  // + (optionally) margin % over the last 3 months from today.
  trailing3: boolean;
  // Same-period-last-year sales block. For each row: qty + avg sales
  // price + (optionally) margin % over the 3-month window ending 12
  // months ago.
  spLY: boolean;
  // Narrow trailing/SPLY data to a single customer. Auto-defaults to
  // whatever's selected in the grid. Search dropdown picks any
  // customer present in excelData.sos.
  customerEnabled: boolean;
  customer: string;
  // Only meaningful when customerEnabled is true. When false the
  // trailing/SPLY blocks drop the margin column. When customer is OFF
  // the margin column is always included.
  showCustomerMargin: boolean;
  // Customer-facing report mode. When true, strips every column that
  // reveals our cost basis or margin (Avg Cost, Total Cost, Sls Prc
  // @ Margin, T3 Mrgn %, LY Mrgn %) plus the Cost / Mrgn $ / Mrgn %
  // rows from the bottom totals stack. Use when the workbook will be
  // shared with the customer themselves.
  customerFacing: boolean;
  // After the workbook is built, drop any column whose body cells are
  // all empty/zero. Always-kept columns: the text identity cols
  // (Category / Sub Cat / Style / Description / Color) plus the
  // spacer cols. Useful when periods or optional cols have nothing
  // to show and would otherwise add visual noise.
  hideZeroColumns: boolean;
  // Drop the entire ATS-data column block: every date (period) column,
  // the Total column, plus Avg Cost / Total Cost / Sls Prc @ Margin.
  // Leaves the identity block + On Hand / On Order / On PO + trailing
  // T3 / LY blocks intact. Pairs with disabling the Sls Prc @ Margin
  // checkbox in the UI — keeping that toggle on alongside this would
  // be a contradiction.
  hideATSData: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (opts: ExportOptions) => void;
  // Build the workbook but show a preview instead of downloading.
  // Operator can choose to download from the preview screen.
  onView: (opts: ExportOptions) => void;
  excelData: ExcelData | null;
  // Auto-default value for the customer dropdown — whatever the grid
  // toolbar currently has selected. Empty string = "no customer".
  defaultCustomer: string;
}

export const ExportOptionsModal: React.FC<Props> = ({ open, onClose, onConfirm, onView, excelData, defaultCustomer }) => {
  const [subtotals, setSubtotals]             = useState(true);
  const [avgCost, setAvgCost]                 = useState(false);
  const [slsPrcAtMrgn, setSlsPrcAtMrgn]       = useState(false);
  const [slsMarginPct, setSlsMarginPct]       = useState(21);
  const [trailing3, setTrailing3]             = useState(false);
  const [spLY, setSpLY]                       = useState(false);
  const [customerEnabled, setCustomerEnabled] = useState(false);
  const [customer, setCustomer]               = useState(defaultCustomer);
  const [showCustomerMargin, setShowCustMrgn] = useState(true);
  const [customerFacing, setCustomerFacing]   = useState(false);
  const [hideZeroColumns, setHideZeroColumns] = useState(false);
  const [hideATSData, setHideATSData]         = useState(false);

  const [custDropOpen, setCustDropOpen] = useState(false);
  const [custSearch, setCustSearch]     = useState("");
  // Inline warning when the operator clicks View / Export with the
  // customer checkbox on but no customer name selected. Replaces the
  // previous "disable the button" UX — explicit warning is clearer
  // (the disabled state didn't tell the operator WHY).
  const [missingCustomerWarn, setMissingCustomerWarn] = useState(false);

  // Customers come from SO events — that's the set the trailing /
  // SPLY columns actually filter against. Dedupe + sort.
  const customers = useMemo(() => {
    const set = new Set<string>();
    if (excelData) {
      for (const s of excelData.sos) {
        if (s.customerName) set.add(s.customerName);
      }
    }
    return [...set].sort();
  }, [excelData]);

  const shownCustomers = useMemo(() => {
    const q = custSearch.toLowerCase();
    if (!q) return customers;
    return customers.filter(c => c.toLowerCase().includes(q));
  }, [customers, custSearch]);

  if (!open) return null;

  const collectOptions = (): ExportOptions => ({
    subtotals,
    avgCost,
    // hideATSData wipes the Sls Prc @ Margin column anyway — collapse
    // the toggle here too so the persisted options match what the
    // workbook actually contains.
    slsPrcAtMrgn: hideATSData ? false : slsPrcAtMrgn,
    slsMarginPct: Number.isFinite(slsMarginPct) ? slsMarginPct : 21,
    trailing3,
    spLY,
    customerEnabled,
    customer: customerEnabled ? customer : "",
    showCustomerMargin,
    customerFacing,
    hideZeroColumns,
    hideATSData,
  });

  const handleConfirm = () => {
    if (customerEnabled && !customer) { setMissingCustomerWarn(true); return; }
    onConfirm(collectOptions());
  };
  const handleView = () => {
    if (customerEnabled && !customer) { setMissingCustomerWarn(true); return; }
    onView(collectOptions());
  };

  // Reset every option to its initial-open default. Doesn't close the
  // modal — operator can keep configuring after wiping.
  const handleClear = () => {
    setSubtotals(true);
    setAvgCost(false);
    setSlsPrcAtMrgn(false);
    setSlsMarginPct(21);
    setTrailing3(false);
    setSpLY(false);
    setCustomerEnabled(false);
    setCustomer(defaultCustomer);
    setShowCustMrgn(true);
    setCustomerFacing(false);
    setHideZeroColumns(false);
    setHideATSData(false);
    setCustDropOpen(false);
    setCustSearch("");
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#1E293B", border: "1px solid #334155", borderRadius: 12,
          minWidth: 460, maxWidth: 520, color: "#F1F5F9",
          fontFamily: "inherit", boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#10B981", textTransform: "uppercase", letterSpacing: "0.06em" }}>Export Options</div>
          <button
            style={{ background: "none", border: "none", color: "#64748B", fontSize: 18, cursor: "pointer", padding: "2px 6px", borderRadius: 4 }}
            onClick={onClose}
            title="Cancel"
          >✕</button>
        </div>

        <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          <CheckRow label="Subtotals (per style)" checked={subtotals} onChange={setSubtotals} />

          <CheckRow label="Avg Cost (adds Avg Cost + Total Cost columns)" checked={avgCost} onChange={setAvgCost} />

          <div>
            <CheckRow
              label="Sls Prc @ Margin (adds implied sale-price column)"
              checked={slsPrcAtMrgn && !hideATSData}
              onChange={setSlsPrcAtMrgn}
              disabled={hideATSData}
              disabledTitle="Disabled because Hide ATS data is on — the Sls Prc column lives in the hidden block"
            />
            {slsPrcAtMrgn && !hideATSData && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, marginLeft: 28, fontSize: 12, color: "#94A3B8" }}>
                <span>Margin %</span>
                <input
                  type="number"
                  min={0}
                  max={99}
                  step="0.1"
                  value={slsMarginPct}
                  onChange={e => setSlsMarginPct(parseFloat(e.target.value))}
                  style={{ width: 70, background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", color: "#F1F5F9", fontSize: 12 }}
                />
                <span style={{ fontSize: 11, color: "#64748B" }}>price = avgCost / (1 − margin)</span>
              </div>
            )}
          </div>

          {/*
            One checkbox drives both Trailing-3 and SP-LY together —
            they're rarely meaningful in isolation (the YoY comparison
            is the point) and the operator wanted a single toggle.
            The underlying ExportOptions still carries two booleans
            so the export's column emission can stay column-by-column;
            we just flip them as a pair.
          */}
          <CheckRow
            label="Trailing 3 & SP LY sales (Qty / Sls Price / Mrgn % for both windows)"
            checked={trailing3 && spLY}
            onChange={(v) => { setTrailing3(v); setSpLY(v); }}
          />

          <CheckRow
            label="Customer Facing (hide all cost + margin data — Avg Cost, Total Cost, Sls Prc @ Mrgn, T3/LY Mrgn %)"
            checked={customerFacing}
            onChange={setCustomerFacing}
          />

          <CheckRow
            label="Hide zero columns (drop any data column whose body is empty / all zero)"
            checked={hideZeroColumns}
            onChange={setHideZeroColumns}
          />

          <CheckRow
            label="Hide ATS data (drop date columns, Total, Avg Cost, Total Cost, Sls Prc @ Mrgn)"
            checked={hideATSData}
            onChange={setHideATSData}
          />

          <div>
            <CheckRow label="By Customer (narrow trailing / SPLY to one customer)" checked={customerEnabled} onChange={setCustomerEnabled} />
            {customerEnabled && (
              <div style={{ marginTop: 8, marginLeft: 28, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ position: "relative" }}>
                  <button
                    style={{
                      background: "#0F172A", border: "1px solid #334155", borderRadius: 6,
                      padding: "7px 10px", color: "#F1F5F9", fontSize: 12, cursor: "pointer",
                      width: 280, textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center",
                    }}
                    onClick={() => setCustDropOpen(o => !o)}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {customer || "Pick a customer…"}
                    </span>
                    <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
                  </button>
                  {custDropOpen && (
                    <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, zIndex: 100, width: 320, maxHeight: 340, display: "flex", flexDirection: "column", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                      <div style={{ padding: "8px 10px", borderBottom: "1px solid #334155" }}>
                        <input
                          type="text"
                          placeholder="Search customers…"
                          value={custSearch}
                          onChange={e => setCustSearch(e.target.value)}
                          autoFocus
                          style={{ width: "100%", boxSizing: "border-box", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#F1F5F9", fontSize: 12, fontFamily: "inherit", outline: "none" }}
                        />
                      </div>
                      <div style={{ overflowY: "auto", flex: 1 }}>
                        {shownCustomers.length === 0 && (
                          <div style={{ padding: "10px 14px", fontSize: 12, color: "#64748B", fontStyle: "italic" }}>No customers match.</div>
                        )}
                        {shownCustomers.map(c => (
                          <div
                            key={c}
                            style={{
                              padding: "7px 14px", cursor: "pointer", fontSize: 12,
                              color: customer === c ? "#6EE7B7" : "#CBD5E1",
                              background: customer === c ? "rgba(16,185,129,0.08)" : "transparent",
                              fontWeight: customer === c ? 600 : 400,
                            }}
                            onClick={() => { setCustomer(c); setCustDropOpen(false); setCustSearch(""); }}
                            onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                            onMouseLeave={e => (e.currentTarget.style.background = customer === c ? "rgba(16,185,129,0.08)" : "transparent")}
                          >{c}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#94A3B8", cursor: "pointer" }}>
                  <input type="checkbox" checked={showCustomerMargin} onChange={e => setShowCustMrgn(e.target.checked)} />
                  Show margin column for trailing / SPLY
                </label>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid #334155", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            style={{ background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "7px 14px", color: "#CBD5E1", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
            onClick={onClose}
          >Cancel</button>
          <button
            style={{ background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "7px 14px", color: "#CBD5E1", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
            onClick={handleClear}
            title="Reset all options to defaults"
          >Clear</button>
          <button
            style={{ background: "transparent", border: "1px solid #60A5FA", borderRadius: 6, padding: "7px 16px", color: "#60A5FA", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
            onClick={handleView}
            title="Preview the workbook before downloading"
          >View</button>
          <button
            style={{ background: "#10B981", border: "1px solid #10B981", borderRadius: 6, padding: "7px 16px", color: "#0F172A", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
            onClick={handleConfirm}
          >Export</button>
        </div>

        {missingCustomerWarn && (
          <div
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1100,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
            onClick={() => setMissingCustomerWarn(false)}
          >
            <div
              style={{
                background: "#1E293B", border: "1px solid #F59E0B", borderRadius: 12,
                minWidth: 360, maxWidth: 420, color: "#F1F5F9",
                fontFamily: "inherit", boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
              }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#F59E0B", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Missing customer selection
                </div>
                <button
                  style={{ background: "none", border: "none", color: "#64748B", fontSize: 18, cursor: "pointer", padding: "2px 6px", borderRadius: 4 }}
                  onClick={() => setMissingCustomerWarn(false)}
                  title="Dismiss"
                >✕</button>
              </div>
              <div style={{ padding: "16px 18px", fontSize: 13, lineHeight: 1.5, color: "#CBD5E1" }}>
                The <strong style={{ color: "#F1F5F9" }}>By Customer</strong> checkbox is on but no customer has been picked yet. Open the dropdown and select a customer, then try again — or uncheck "By Customer" to run the report across every customer.
              </div>
              <div style={{ padding: "10px 16px", borderTop: "1px solid #334155", display: "flex", justifyContent: "flex-end" }}>
                <button
                  style={{ background: "#F59E0B", border: "1px solid #F59E0B", borderRadius: 6, padding: "7px 18px", color: "#0F172A", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                  onClick={() => setMissingCustomerWarn(false)}
                >Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

interface CheckRowProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  disabledTitle?: string;
}
const CheckRow: React.FC<CheckRowProps> = ({ label, checked, onChange, disabled, disabledTitle }) => (
  <label
    style={{
      display: "flex", alignItems: "center", gap: 10, fontSize: 13,
      color: disabled ? "#64748B" : "#E2E8F0",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.55 : 1,
    }}
    title={disabled ? disabledTitle : undefined}
  >
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={e => onChange(e.target.checked)}
    />
    {label}
  </label>
);
