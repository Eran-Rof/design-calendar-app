// VendorGridCell — popover vendor picker, modelled on the planning app's
// TbdColorCell (src/inventory-planning/components/cells/TbdColorCell.tsx).
//
// Trigger button shows the currently-selected vendor. Click → popover with
// a search input + scrollable list of all active vendors. Typing filters
// the list in-memory. If the typed value isn't in the list, a "+ Add new
// vendor" row appears at the bottom — clicking it creates a vendors row
// via the existing add-vendor endpoint and selects it.
//
// On pick: writes a costing_line_vendors row with status='selected' (via
// the existing select-quote flow) so RFQ generation + Plan Flow widget
// keep reading the per-line vendor through the existing FK chain.

import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useCostingStore } from "../store/costingStore";
import { addVendor } from "../services/costingApi";
import { usePopoverAnchor } from "../hooks/usePopoverAnchor";
import type { CostingLineVendor } from "../types";
import type { VendorHit } from "../services/costingApi";

interface Props {
  lineId: string;
}

// Stable empty-array reference for the Zustand selector — see PR #577
// (fresh `[]` per render triggers React error #185).
const EMPTY_QUOTES: CostingLineVendor[] = [];
const EMPTY_VENDORS: VendorHit[] = [];

export default function VendorGridCell({ lineId }: Props) {
  const quotes = useCostingStore((s) => s.vendorQuotes[lineId] || EMPTY_QUOTES);
  const vendors = useCostingStore((s) => s.vendorsForPicker || EMPTY_VENDORS);
  const lines = useCostingStore((s) => s.lines);
  const selectQuote = useCostingStore((s) => s.selectQuote);
  const addQuote = useCostingStore((s) => s.addQuote);
  const loadQuotes = useCostingStore((s) => s.loadVendorQuotes);
  const loadVendorsForPicker = useCostingStore((s) => s.loadVendorsForPicker);
  const setNotice = useCostingStore((s) => s.setNotice);
  const addExtraVendor = useCostingStore((s) => s.addExtraVendor);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Portal-render the popover into document.body — grid cells have
  // overflow:hidden which would otherwise clip the popover invisible.
  const { anchorRef, pos } = usePopoverAnchor<HTMLButtonElement>({ open, minWidth: 280 });

  // Lazy-load this line's quotes + the entire vendor list once per mount.
  useEffect(() => {
    if (!quotes || quotes.length === 0) loadQuotes(lineId);
    if (!vendors || vendors.length === 0) loadVendorsForPicker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const selected = quotes.find((q) => q.status === "selected");
  // Resolve display name from vendorsForPicker when the quote's joined
  // `vendor` relation isn't hydrated (store inserts quotes optimistically
  // without the join, so the trigger button was rendering empty right
  // after a pick).
  const lookup = selected?.vendor_id
    ? vendors.find((v) => v.id === selected.vendor_id)
    : null;
  const selectedName =
    selected?.vendor?.legal_name
    || selected?.vendor?.code
    || lookup?.legal_name
    || lookup?.code
    || "";

  // Filtered options for the popover list.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) => {
      const name = (v.legal_name || "").toLowerCase();
      const code = (v.code || "").toLowerCase();
      return name.includes(q) || code.includes(q);
    });
  }, [vendors, query]);

  // Add-new is offered when the typed name doesn't match any existing
  // vendor (case-insensitive on legal_name/code).
  const queryTrim = query.trim();
  const queryIsNew = queryTrim.length > 0
    && !vendors.some((v) =>
      (v.legal_name || "").toLowerCase() === queryTrim.toLowerCase()
      || (v.code || "").toLowerCase() === queryTrim.toLowerCase()
    );

  const commitPick = async (vendor: VendorHit) => {
    if (busy) return;
    setBusy(true);
    try {
      // Planning-only vendors live in ip_vendor_master and don't have a
      // portal vendors row yet — costing_line_vendors.vendor_id is a FK to
      // vendors.id, so we materialize a portal row first via addVendor (it
      // upserts on legal_name + entity, returning the canonical id we can
      // safely use downstream).
      let effective = vendor;
      if (vendor.source === "planning") {
        const created = await addVendor(vendor.legal_name || vendor.code || "Vendor", {
          code: vendor.code || undefined,
          country: vendor.country || undefined,
        });
        effective = { ...created, source: "portal" };
        // Reload the picker list so the materialized portal row replaces
        // the planning entry next time the dropdown opens.
        void loadVendorsForPicker();
      }
      // Reuse an existing quote for this vendor if one already exists;
      // otherwise create a new one + immediately promote it to selected.
      const existing = quotes.find((q) => q.vendor_id === effective.id);
      if (existing) {
        await selectQuote(lineId, existing.id);
      } else {
        const line = lines.find((l) => l.id === lineId);
        const seedCost = typeof line?.target_cost === "number" ? line.target_cost : 0;
        const created = await addQuote(lineId, {
          vendor_id: effective.id,
          quoted_cost: seedCost,
          currency: effective.default_currency || "USD",
          status: "received",
        });
        if (created) await selectQuote(lineId, created.id);
        else {
          // addQuote swallowed the server error into the store — surface the
          // real reason (FK/constraint message) instead of a generic toast.
          const reason = useCostingStore.getState().error || "see console for details";
          setNotice(`Could not record vendor pick: ${reason}`, "error");
        }
      }
      setOpen(false);
    } catch (e) {
      setNotice(`Could not pick vendor: ${(e as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const commitNew = async (name: string) => {
    if (busy || !name) return;
    setBusy(true);
    try {
      const created = await addVendor(name);
      // Mirror to the operator-only freeform vendor master so the entry is
      // editable/deletable from Settings (and auto-pruned when ip_vendor_master
      // gets the same name via the Xoro nightly sync).
      addExtraVendor(name).catch(() => { /* non-blocking */ });
      // Reload the vendor list so the popover knows about the new vendor
      // (also picks it up for any sibling grid cells the operator opens next).
      await loadVendorsForPicker();
      await commitPick(created);
      setNotice(`Added new vendor "${name}"`, "info");
    } catch (e) {
      setNotice(`Could not add vendor: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const popoverContent = open && pos ? (
    <div
      ref={popRef}
      style={{
        position: "fixed", left: pos.left, top: pos.top, width: pos.width,
        zIndex: 9999, maxHeight: 320, overflowY: "auto",
        background: "#1E293B", border: "1px solid #475569",
        borderRadius: 8, boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
      }}
    >
          <div style={{
            padding: 8, borderBottom: "1px solid #334155",
            position: "sticky", top: 0, background: "#1E293B",
          }}>
            <input
              autoFocus
              type="text"
              placeholder="Type to search or add new vendor…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && queryIsNew) { e.preventDefault(); void commitNew(queryTrim); }
              }}
              style={{
                width: "100%", background: "#0F172A", color: "#E2E8F0",
                border: "1px solid #334155", borderRadius: 4,
                padding: "5px 8px", fontSize: 12, outline: "none",
              }}
            />
            <div style={{ marginTop: 4, fontSize: 10, color: "#94A3B8" }}>
              {vendors.length === 0
                ? "No vendors yet — type a name to add one."
                : `${filtered.length} of ${vendors.length} active vendor${vendors.length === 1 ? "" : "s"}`}
            </div>
          </div>
          {filtered.length === 0 && !queryIsNew && (
            <div style={{ padding: 12, color: "#94A3B8", fontSize: 12 }}>No matches</div>
          )}
          {filtered.map((v) => {
            const isCurrent = v.id === selected?.vendor_id;
            const label = v.legal_name || v.code || v.id;
            return (
              <div
                key={v.id}
                role="option"
                tabIndex={0}
                onClick={() => commitPick(v)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitPick(v); } }}
                style={{
                  padding: "6px 12px", cursor: "pointer", fontSize: 12,
                  color: isCurrent ? "#60A5FA" : "#E2E8F0",
                  background: isCurrent ? "#60A5FA11" : undefined,
                  fontWeight: isCurrent ? 600 : undefined,
                  borderBottom: "1px solid #334155",
                }}
                onMouseEnter={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = "#334155"; }}
                onMouseLeave={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ flex: 1 }}>{label}</span>
                  {v.source === "planning" && (
                    <span style={{
                      background: "#F59E0B22", color: "#F59E0B",
                      border: "1px solid #F59E0B", borderRadius: 3,
                      padding: "0 4px", fontSize: 9, fontWeight: 700,
                    }} title="From the planning vendor master (ip_vendor_master). Picking will auto-create the portal vendor row.">planning</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: "#94A3B8" }}>
                  {v.code ? v.code : ""}
                  {v.country ? ` · ${v.country}` : ""}
                  {v.default_currency ? ` · ${v.default_currency}` : ""}
                </div>
              </div>
            );
          })}
          {queryIsNew && (
            <div
              role="option"
              tabIndex={0}
              onClick={() => commitNew(queryTrim)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitNew(queryTrim); } }}
              style={{
                padding: "8px 12px", cursor: busy ? "wait" : "pointer",
                fontSize: 12, color: "#10B981",
                background: "#10B98111",
                borderTop: filtered.length > 0 ? "1px solid #334155" : undefined,
                fontWeight: 600,
              }}
              title="Vendor isn't in the database yet — adds a new vendors row + selects it."
            >
              {busy ? "Adding…" : <>+ Add new vendor: <strong>{queryTrim}</strong></>}
            </div>
          )}
    </div>
  ) : null;

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <button
        type="button"
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        title={selectedName ? `Selected: ${selectedName}` : "Click to pick a vendor"}
        style={{
          width: "100%", textAlign: "left",
          background: "transparent",
          color: selectedName ? "#A7F3D0" : "#94A3B8",
          border: `1px ${selectedName ? "solid" : "dashed"} #475569`,
          borderRadius: 3,
          padding: "3px 8px",
          fontSize: 11,
          cursor: "pointer",
          fontWeight: selectedName ? 600 : 400,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 4,
        }}
      >
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {selectedName || "— pick vendor —"}
        </span>
        <span style={{ color: "#64748B", fontSize: 9 }}>▾</span>
      </button>
      {popoverContent && ReactDOM.createPortal(popoverContent, document.body)}
    </div>
  );
}
