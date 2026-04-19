// Right-side drawer with the "why" of a forecast number: history
// summary, method, buyer request details, override trail, supply context,
// and a place to save a new override.

import { useEffect, useState } from "react";
import type {
  IpOverrideReasonCode,
  IpPlannerOverride,
  IpPlanningGridRow,
} from "../types/wholesale";
import { S, ACTION_COLOR, CONFIDENCE_COLOR, PAL, formatQty, formatDate, formatDateTime, formatPeriodCode } from "./styles";

const REASON_CODES: IpOverrideReasonCode[] = [
  "buyer_request",
  "planner_estimate",
  "management_input",
  "launch_expectation",
  "customer_expansion",
  "supply_adjustment",
];

export interface ForecastDetailDrawerProps {
  row: IpPlanningGridRow | null;
  overrides: IpPlannerOverride[]; // this grain, newest first
  onClose: () => void;
  onSaveOverride: (args: {
    override_qty: number;
    reason_code: IpOverrideReasonCode;
    note: string | null;
  }) => Promise<void>;
}

export default function ForecastDetailDrawer({
  row, overrides, onClose, onSaveOverride,
}: ForecastDetailDrawerProps) {
  const [qtyStr, setQtyStr] = useState("");
  const [reason, setReason] = useState<IpOverrideReasonCode>("planner_estimate");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQtyStr(row ? String(row.override_qty ?? 0) : "");
    setReason("planner_estimate");
    setNote("");
    setError(null);
  }, [row?.forecast_id]);

  if (!row) return null;

  async function save() {
    const n = Number(qtyStr);
    if (!Number.isFinite(n)) { setError("Override qty must be a number"); return; }
    setSaving(true); setError(null);
    try {
      await onSaveOverride({
        override_qty: Math.round(n),
        reason_code: reason,
        note: note.trim() || null,
      });
      setNote("");
    } catch (e) {
      // Surface errors inline since the drawer may sit above the toast.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const system = row.system_forecast_qty;
  const buyer = row.buyer_request_qty;
  const override = row.override_qty;
  const finalQ = row.final_forecast_qty;

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <div>
            <div style={{ fontSize: 13, color: PAL.textMuted }}>{row.customer_name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: PAL.accent }}>
              {row.sku_code}
            </div>
            <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 2 }}>
              {row.sku_description ?? ""} · {formatPeriodCode(row.period_code)}
            </div>
          </div>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>

        <div style={S.drawerBody}>
          {/* Number breakdown */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 16 }}>
            <MiniCell label="System" value={formatQty(system)} />
            <MiniCell label="Buyer req." value={formatQty(buyer)} />
            <MiniCell label="Override" value={formatQty(override)} />
            <MiniCell label="Final" value={formatQty(finalQ)} accent={PAL.green} />
          </div>

          <div style={{ fontSize: 12, color: PAL.textMuted, marginBottom: 16 }}>
            final = max(0, system + buyer_request + override). Override is an additive delta.
          </div>

          {/* Method + confidence */}
          <SectionLabel>Method</SectionLabel>
          <div style={S.infoCell}>
            <div style={{ ...S.infoValue, fontFamily: "monospace", fontSize: 13 }}>{row.forecast_method}</div>
            <div style={{ marginTop: 6 }}>
              <span style={{ ...S.chip, background: CONFIDENCE_COLOR[row.confidence_level] + "33", color: CONFIDENCE_COLOR[row.confidence_level] }}>
                {row.confidence_level}
              </span>
            </div>
          </div>

          {/* Trailing history */}
          <SectionLabel>History (trailing 3 mo)</SectionLabel>
          <div style={S.infoCell}>
            <div style={S.infoValue}>{formatQty(row.historical_trailing_qty)} units</div>
            <div style={{ fontSize: 12, color: PAL.textMuted }}>
              Sum of {row.customer_name} × {row.sku_code} shipped in the 3 months before the snapshot.
            </div>
          </div>

          {/* Supply */}
          <SectionLabel>Supply context</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
            <MiniCell label="On hand" value={formatQty(row.on_hand_qty)} />
            <MiniCell label="On PO" value={formatQty(row.on_po_qty)} />
            <MiniCell label="Receipts due" value={formatQty(row.receipts_due_qty)} />
            <MiniCell label="Available" value={formatQty(row.available_supply_qty)} accent={PAL.accent} />
          </div>

          {/* Recommendation */}
          <SectionLabel>Recommendation</SectionLabel>
          <div style={S.infoCell}>
            <div style={{ marginBottom: 6 }}>
              <span style={{ ...S.chip, background: (ACTION_COLOR[row.recommended_action] ?? PAL.textMuted) + "33", color: ACTION_COLOR[row.recommended_action] ?? PAL.textMuted }}>
                {row.recommended_action}
              </span>
              {row.recommended_qty != null && (
                <span style={{ marginLeft: 8, fontFamily: "monospace", color: PAL.text }}>
                  {formatQty(row.recommended_qty)} units
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: PAL.textMuted }}>{row.action_reason ?? ""}</div>
          </div>

          {/* Override form */}
          <SectionLabel>Set override</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={S.label}>Override qty (signed delta)</label>
              <input style={{ ...S.input, width: "100%" }}
                     value={qtyStr}
                     inputMode="numeric"
                     onChange={(e) => setQtyStr(e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Reason</label>
              <select style={{ ...S.select, width: "100%" }}
                      value={reason}
                      onChange={(e) => setReason(e.target.value as IpOverrideReasonCode)}>
                {REASON_CODES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: "1 / 3" }}>
              <label style={S.label}>Note (optional)</label>
              <input style={{ ...S.input, width: "100%" }}
                     value={note}
                     onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          {error && <div style={{ color: PAL.red, marginTop: 8, fontSize: 12 }}>{error}</div>}
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button style={S.btnSecondary} onClick={onClose}>Close</button>
            <button style={S.btnPrimary} onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save override"}
            </button>
          </div>

          {/* Override history */}
          {overrides.length > 0 && (
            <>
              <SectionLabel>Override trail</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {overrides.map((o) => (
                  <div key={o.id} style={{ ...S.infoCell, padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700 }}>
                        {o.override_qty >= 0 ? "+" : ""}{formatQty(o.override_qty)}
                      </span>
                      <span style={{ fontSize: 11, color: PAL.textMuted }}>
                        {formatDateTime(o.created_at)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 4 }}>
                      <span style={{ ...S.chip, background: PAL.chipBg, color: PAL.textDim, marginRight: 6 }}>
                        {o.reason_code}
                      </span>
                      {o.note ?? ""}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{ color: PAL.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 8px" }}>
      {children}
    </div>
  );
}

function MiniCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ ...S.infoCell, padding: "10px 12px" }}>
      <div style={S.infoLabel}>{label}</div>
      <div style={{ ...S.infoValue, fontFamily: "monospace", color: accent ?? PAL.text }}>{value}</div>
    </div>
  );
}

