// HistoricalCostCell — read-only popover showing tanda_pos history that
// matches the costing line's style ACROSS ALL VENDORS (including archived
// POs). Renders as a trigger button in the grid; click → popover lists
// ONE row per matching PO with: po_number, vendor_name, qty totals,
// quantity-weighted unit_price, and date (received or planned).
//
// Data: GET /api/internal/costing/lines/:line_id/po-history
//
// Empty / error states are surfaced inline in the popover so the operator
// understands WHY there's no data (no style, no matching POs).

import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { fmtDateDisplay } from "../helpers";
import { usePopoverAnchor } from "../hooks/usePopoverAnchor";

interface Props {
  lineId: string;
}

interface HistoryRow {
  po_number: string | null;
  po_id: string;
  vendor_name: string | null;
  qty_ordered: number | null;
  qty_received: number | null;
  unit_price: number | null;
  qty_per_pack?: number;
  received_date: string | null;
  planned_ddp: string | null;
  status: string | null;
  archived: boolean;
}

interface HistoryResp {
  rows: HistoryRow[];
  reason?: "no_style_code" | "no_pos_for_style";
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
  const popRef = useRef<HTMLDivElement>(null);
  const { anchorRef, pos } = usePopoverAnchor<HTMLButtonElement>({ open, minWidth: 620, align: "right" });

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
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        title="View tanda_pos history for this style across all vendors"
        style={{
          width: "100%", textAlign: "center",
          background: "transparent", color: "#94A3B8",
          border: "1px solid #475569", borderRadius: 3,
          padding: "2px 6px", fontSize: 10, fontWeight: 600,
          cursor: "pointer",
        }}
      >PO Hist</button>
      {open && pos && ReactDOM.createPortal(
        <div
          ref={popRef}
          style={{
            position: "fixed", left: pos.left, top: pos.top, width: pos.width,
            zIndex: 9999, maxHeight: 360, overflowY: "auto",
            background: "#1E293B", border: "1px solid #475569",
            borderRadius: 8, boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{
            padding: "8px 12px", borderBottom: "1px solid #334155",
            position: "sticky", top: 0, background: "#1E293B",
            fontSize: 11, color: "#94A3B8", letterSpacing: ".04em", textTransform: "uppercase",
          }}>
            PO history · same style · all vendors (incl. archived)
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
              {reason === "no_pos_for_style" && "No POs on file for this style yet."}
              {!reason && "No POs match this style."}
            </div>
          )}
          {rows.length > 0 && (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead style={{ background: "#0F172A" }}>
                  <tr>
                    <Th>PO#</Th>
                    <Th>Vendor</Th>
                    <Th align="right">Qty</Th>
                    <Th align="right">Recv</Th>
                    <Th align="right">Pack</Th>
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
                    const packLabel = (r.qty_per_pack != null && r.qty_per_pack > 1)
                      ? String(r.qty_per_pack)
                      : "—";
                    return (
                      <tr key={`${r.po_id}_${i}`} style={{ borderTop: "1px solid #334155", opacity: r.archived ? 0.6 : 1 }}>
                        <Td><span style={{ color: "#60A5FA", fontWeight: 600 }}>{r.po_number || "—"}</span></Td>
                        <Td>{r.vendor_name || "—"}</Td>
                        <Td align="right">{r.qty_ordered != null ? fmtQty.format(r.qty_ordered) : "—"}</Td>
                        <Td align="right">{r.qty_received != null ? fmtQty.format(r.qty_received) : "—"}</Td>
                        <Td align="right"><span style={{ color: packLabel !== "—" ? "#A78BFA" : "#475569" }}>{packLabel}</span></Td>
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
              <div style={{ padding: "5px 10px 6px", borderTop: "1px solid #1E3A5F", fontSize: 9, color: "#475569", fontStyle: "italic" }}>
                Unit $ is per-unit (pack prices exploded by pack size)
              </div>
            </>
          )}
        </div>,
        document.body,
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
