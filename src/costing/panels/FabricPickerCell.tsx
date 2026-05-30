// FabricPickerCell — autocomplete cell for the Fabric column.
//
// Sources:
//   1. fabric_codes (DB, Tangerine-owned) via /api/internal/costing/search/fabrics
//   2. costing_fabrics master (app_data JSON blob, costing-owned) via the
//      Zustand store's masters.fabric slice
//
// The two sources are unioned for display. When Tangerine's fabric_codes
// is fully populated, a one-time backfill will merge costing_fabrics
// entries into fabric_codes and we can drop the local master.
//
// Behavior:
//   - Click empty cell → dropdown opens with the full union (first 25 from
//     DB + every entry in the local master). No typing required.
//   - Type → debounced search filters DB hits; local master entries that
//     match are surfaced too.
//   - Typing a new fabric → "+ Add" sentinel saves to costing_fabrics
//     (NOT fabric_codes — that table is Tangerine-owned for now).
//   - Picked value is stored as the fabric CODE (string), matching the
//     shape style_master.base_fabric uses and what style auto-fill writes
//     into line.fabric_code.

import React, { useEffect, useRef, useState } from "react";
import { searchFabrics, type FabricHit } from "../services/costingApi";
import { useCostingStore } from "../store/costingStore";

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
}

export default function FabricPickerCell({ value, onChange }: Props) {
  const [text, setText] = useState(value || "");
  const [open, setOpen] = useState(false);
  const [dbRows, setDbRows] = useState<FabricHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const masterFabrics = useCostingStore((s) => s.masters.fabric);
  const addMaster     = useCostingStore((s) => s.addMaster);
  const setNotice     = useCostingStore((s) => s.setNotice);

  useEffect(() => { setText(value || ""); }, [value]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  // Debounced DB search. Fires unconditionally — the handler returns the
  // first 25 active fabric_codes when q is empty so the operator can
  // browse before typing.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const out = await searchFabrics(text, controller.signal);
        setDbRows(out);
      } catch { /* silent */ }
      finally { setLoading(false); }
    }, 200);
    return () => { window.clearTimeout(t); controller.abort(); };
  }, [text, open]);

  // Filter the local master by the current query; the DB list is already
  // filtered server-side. Union below dedupes by lowercase code.
  const masterMatches = masterFabrics.filter((m) =>
    !text || m.name.toLowerCase().includes(text.toLowerCase()),
  );

  // Dedup: DB hits first (Tangerine-authoritative), then master entries
  // whose name isn't already in the DB list (case-insensitive on code/name).
  const dbCodesLower = new Set(
    dbRows
      .map((r) => (r.code || "").toLowerCase().trim())
      .filter(Boolean),
  );
  const masterOnly = masterMatches.filter((m) => !dbCodesLower.has(m.name.toLowerCase().trim()));

  const lowerText = text.trim().toLowerCase();
  const existsInDb = dbCodesLower.has(lowerText) || dbRows.some((r) => (r.name || "").toLowerCase() === lowerText);
  const existsInMaster = masterFabrics.some((m) => m.name.toLowerCase() === lowerText);
  const canAdd = lowerText.length > 0 && !existsInDb && !existsInMaster;

  const onInlineAdd = async () => {
    const v = text.trim();
    if (!v) return;
    setAdding(true);
    try {
      await addMaster("fabric", v);
      onChange(v);
      setText(v);
      setOpen(false);
      setNotice(`Added "${v}" to fabric master`, "info");
    } catch (e) {
      setNotice(`Could not add fabric: ${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  const onCommit = (next: string | null) => {
    setText(next || "");
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={text}
        placeholder="Fabric"
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        // Open on focus even when empty so the operator can browse the
        // full union of DB + master entries.
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // Defer so click on a dropdown row registers first; preserve
          // free text so style auto-fill (style.base_fabric) survives a
          // blur even when no row matches.
          window.setTimeout(() => { if (!open) onChange(e.target.value || null); }, 100);
        }}
        style={{
          width: "100%", padding: "4px 6px", fontSize: 12,
          background: "transparent", border: "1px solid transparent",
          color: "#E2E8F0", outline: "none",
        }}
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

          {dbRows.map((f) => (
            <button
              key={`db_${f.id}`}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onCommit(f.code); }}
              style={DROPDOWN_BTN_STYLE}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 600 }}>{f.code}</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>
                {f.name || ""}
                {f.fabric_weight_gsm ? ` · ${f.fabric_weight_gsm}gsm` : ""}
                {f.composition_text ? ` · ${f.composition_text}` : ""}
              </div>
            </button>
          ))}

          {masterOnly.length > 0 && (
            <div style={{
              padding: "4px 10px", fontSize: 10, color: "#94A3B8",
              background: "#0F172A", letterSpacing: ".04em", textTransform: "uppercase",
            }}>Costing master</div>
          )}
          {masterOnly.map((m) => (
            <button
              key={`m_${m.id}`}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onCommit(m.name); }}
              style={DROPDOWN_BTN_STYLE}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 600 }}>{m.name}</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>Costing master entry</div>
            </button>
          ))}

          {!loading && dbRows.length === 0 && masterOnly.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>
              {text ? `No fabric matches "${text}".` : "No fabrics yet — type a code/name and click '+ Add'."}
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
                border: "none", color: "#10B981", cursor: adding ? "wait" : "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >{adding ? "Adding…" : `+ Add fabric "${text.trim()}" to costing master`}</button>
          )}
        </div>
      )}
    </div>
  );
}

const DROPDOWN_BTN_STYLE: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left",
  padding: "5px 10px", background: "transparent",
  border: "none", borderBottom: "1px solid #334155",
  color: "#E2E8F0", cursor: "pointer", fontSize: 12,
};
