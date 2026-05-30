// HistoricalCostCell — read-only popover showing tanda_pos history that
// matches the costing line's style + selected vendor (including archived
// POs). Renders as a trigger button in the grid; click → popover lists
// every matching PO line with: po_number, received_date (or planned_ddp
// if not yet received), and unit_price.
//
// Data: GET /api/internal/costing/lines/:line_id/po-history
//
// Empty / error states are surfaced inline in the popover so the operator
// understands WHY there's no data (no style, no vendor, no matching POs).

import React, { useEffect, useRef, useState } from "react";
import { fmtDateDisplay } from "../helpers";

interface Props {
  lineId: string;
}

interface HistoryRow {
  po_number: string | null;
  po_id: string;
  item_number: string | null;
  description: string | null;
  qty_ordered: number | null;
  qty_received: number | null;
  unit_price: number | null;
  received_date: string | null;
  planned_ddp: string | null;
  status: string | null;
  archived: boolean;
}

interface HistoryResp {
  rows: HistoryRow[];
  reason?: "no_style_code" | "no_selected_vendor" | "no_pos_for_vendor";
}

const fmtMoney = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty   = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export default function HistoricalCostCell({ lineId }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Load on open so we don't hammer the endpoint for every grid row at
  // mount. Reloads each open so it always reflects the latest selection.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/internal/costing/lines/${lineId}/po-history`, { signal: controller.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const data = await res.json() as HistoryResp;
        if (!controller.signal.aborted) {
          setRows(data.rows || []);
          setReason(data.reason || null);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [open, lineId]);

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="View tanda_pos history for this style + vendor"
        style={{
          width: "100%", textAlign: "center",
          background: "transparent", color: "#94A3B8",
          border: "1px solid #475569", borderRadius: 3,
          padding: "2px 6px", fontSize: 10, fontWeight: 600,
          cursor: "pointer",
        }}
      >📋 PO Hist</button>
      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0,
            zIndex: 60, minWidth: 460, maxHeight: 360, overflowY: "auto",
            background: "#1E293B", border: "1px solid #475569",
            borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{
            padding: "8px 12px", borderBottom: "1px solid #334155",
            position: "sticky", top: 0, background: "#1E293B",
            fontSize: 11, color: "#94A3B8", letterSpacing: ".04em", textTransform: "uppercase",
          }}>
            PO history · same style + vendor (incl. archived)
          </div>
          {loading && <div style={{ padding: 12, fontSize: 12, color: "#94A3B8" }}>Loading…</div>}
          {error && (
            <div style={{ padding: 12, fontSize: 12, color: "#F87171" }}>
              Could not load history: {error}
            </div>
          )}
          {!loading && !error && rows.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: "#94A3B8", fontStyle: "italic" }}>
              {reason === "no_style_code" && "Pick a style on this line first."}
              {reason === "no_selected_vendor" && "Pick a vendor on this line first."}
              {reason === "no_pos_for_vendor" && "No POs on file for this vendor yet."}
              {!reason && "No POs match this style + vendor."}
            </div>
          )}
          {rows.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead style={{ background: "#0F172A" }}>
                <tr>
                  <Th>PO#</Th>
                  <Th>Item</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Recv</Th>
                  <Th align="right">Unit $</Th>
                  <Th>Date</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const dateLabel = r.received_date
                    ? `${fmtDateDisplay(r.received_date)} (recv)`
                    : r.planned_ddp
                      ? `${fmtDateDisplay(r.planned_ddp)} (plan)`
                      : "—";
                  return (
                    <tr key={`${r.po_id}_${i}`} style={{ borderTop: "1px solid #334155", opacity: r.archived ? 0.6 : 1 }}>
                      <Td><span style={{ color: "#60A5FA", fontWeight: 600 }}>{r.po_number || "—"}</span></Td>
                      <Td>{r.item_number || "—"}</Td>
                      <Td align="right">{r.qty_ordered != null ? fmtQty.format(r.qty_ordered) : "—"}</Td>
                      <Td align="right">{r.qty_received != null ? fmtQty.format(r.qty_received) : "—"}</Td>
                      <Td align="right">{r.unit_price != null ? `$${fmtMoney.format(r.unit_price)}` : "—"}</Td>
                      <Td>{dateLabel}</Td>
                      <Td>
                        {r.archived && (
                          <span style={{ background: "#F59E0B22", color: "#F59E0B", border: "1px solid #F59E0B", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 700, marginRight: 4 }}>archived</span>
                        )}
                        <span style={{ color: "#94A3B8" }}>{r.status || ""}</span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <th style={{ textAlign: align || "left", padding: "5px 8px", fontWeight: 600, fontSize: 9, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em" }}>{children}</th>;
}
function Td({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <td style={{ padding: "5px 8px", color: "#E2E8F0", textAlign: align || "left", whiteSpace: "nowrap" }}>{children}</td>;
}
