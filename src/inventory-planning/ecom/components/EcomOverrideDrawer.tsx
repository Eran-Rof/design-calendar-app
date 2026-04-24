// Right-side drawer for an ecom grid row. Shows the "why" of a forecast
// week (method, factors, trailing numbers), the flag toggles, and the
// override form.

import { useEffect, useRef, useState } from "react";
import type { IpEcomGridRow, IpEcomOverrideEvent, IpEcomOverrideReason } from "../types/ecom";
import { S, PAL, formatDate, formatDateTime, formatQty } from "../../components/styles";

const REASON_CODES: IpEcomOverrideReason[] = [
  "promotion", "campaign", "content_push", "influencer",
  "launch_expectation", "markdown_strategy", "planner_estimate",
];

export interface EcomOverrideDrawerProps {
  row: IpEcomGridRow | null;
  overrides: IpEcomOverrideEvent[];
  onClose: () => void;
  onSaveOverride: (args: {
    override_qty: number;
    reason_code: IpEcomOverrideReason;
    note: string | null;
  }) => Promise<void>;
  onToggleFlag: (
    flag: "promo_flag" | "launch_flag" | "markdown_flag",
    value: boolean,
  ) => Promise<void>;
  onUpdateBuyQty: (forecastId: string, qty: number | null) => Promise<void>;
}

export default function EcomOverrideDrawer({ row, overrides, onClose, onSaveOverride, onToggleFlag, onUpdateBuyQty }: EcomOverrideDrawerProps) {
  const [qtyStr, setQtyStr] = useState("");
  const [reason, setReason] = useState<IpEcomOverrideReason>("planner_estimate");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [buyStr, setBuyStr] = useState("");
  const [buyingSaving, setBuyingSaving] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);

  useEffect(() => {
    setQtyStr(row ? String(row.override_qty ?? 0) : "");
    setReason("planner_estimate");
    setNote("");
    setError(null);
    setBuyStr(row?.planned_buy_qty != null ? String(row.planned_buy_qty) : "");
    setBuyError(null);
  }, [row?.forecast_id]);

  if (!row) return null;

  async function save() {
    const n = Number(qtyStr);
    if (!Number.isFinite(n)) { setError("Override qty must be a number"); return; }
    setSaving(true); setError(null);
    try {
      await onSaveOverride({ override_qty: Math.round(n), reason_code: reason, note: note.trim() || null });
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveBuy() {
    const trimmed = buyStr.trim();
    const qty = trimmed === "" ? null : parseInt(trimmed, 10);
    if (qty !== null && !Number.isFinite(qty)) { setBuyError("Must be a whole number"); return; }
    setBuyingSaving(true); setBuyError(null);
    try {
      await onUpdateBuyQty(row!.forecast_id, qty);
    } catch (e) {
      setBuyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuyingSaving(false);
    }
  }

  const fmtPct = (n: number | null | undefined) =>
    n == null ? "–" : `${(n * 100).toFixed(1)}%`;
  const fmtFactor = (n: number | null | undefined) =>
    n == null ? "1.00" : n.toFixed(2) + "×";

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <div>
            <div style={{ fontSize: 13, color: PAL.textMuted }}>{row.channel_name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: PAL.accent }}>
              {row.sku_code}
            </div>
            <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 2 }}>
              {row.sku_description ?? ""} · {row.period_code} · {formatDate(row.week_start)}
            </div>
          </div>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>

        <div style={S.drawerBody}>
          {/* Number breakdown */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 16 }}>
            <MiniCell label="System" value={formatQty(row.system_forecast_qty)} />
            <MiniCell label="Override" value={formatQty(row.override_qty)} />
            <MiniCell label="Final" value={formatQty(row.final_forecast_qty)} accent={PAL.green} />
          </div>
          <div style={{ fontSize: 12, color: PAL.textMuted, marginBottom: 16 }}>
            final = max(0, system + override). Protected ecom qty = final (MVP policy).
          </div>

          {/* Supply context */}
          <SectionLabel>Supply context</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
            <MiniCell label="On Hand" value={formatQty(row.on_hand_qty)} />
            <MiniCell label="ATS" value={formatQty(row.available_supply_qty)} accent={PAL.accent} />
            <MiniCell label="Short" value={row.projected_shortage_qty > 0 ? formatQty(row.projected_shortage_qty) : "–"} accent={row.projected_shortage_qty > 0 ? PAL.red : undefined} />
            <MiniCell label="Excess" value={row.projected_excess_qty > 0 ? formatQty(row.projected_excess_qty) : "–"} accent={row.projected_excess_qty > 0 ? PAL.yellow : undefined} />
          </div>

          {/* Factors */}
          <SectionLabel>Factors</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8 }}>
            <MiniCell label="Trailing 4W" value={formatQty(row.trailing_4w_qty)} />
            <MiniCell label="Trailing 13W" value={formatQty(row.trailing_13w_qty)} />
            <MiniCell label="Return rate" value={fmtPct(row.return_rate)} />
            <MiniCell label="Method" value={row.forecast_method} />
          </div>

          {/* Flags */}
          <SectionLabel>Flags</SectionLabel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <FlagToggle label="Promo" value={row.promo_flag}
                        onChange={(v) => onToggleFlag("promo_flag", v)}
                        color={PAL.accent} />
            <FlagToggle label="Launch" value={row.launch_flag}
                        onChange={(v) => onToggleFlag("launch_flag", v)}
                        color={PAL.green} />
            <FlagToggle label="Markdown" value={row.markdown_flag}
                        onChange={(v) => onToggleFlag("markdown_flag", v)}
                        color={PAL.yellow} />
          </div>

          {/* Buy plan */}
          <SectionLabel>Buy plan</SectionLabel>
          <div style={S.infoCell}>
            <div style={{ fontSize: 12, color: PAL.textMuted, marginBottom: 8 }}>
              Units you intend to buy for this week. Clear to remove.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                style={{ ...S.input, width: 120 }}
                value={buyStr}
                inputMode="numeric"
                placeholder="e.g. 60"
                onChange={(e) => setBuyStr(e.target.value)}
              />
              <button style={S.btnPrimary} onClick={saveBuy} disabled={buyingSaving}>
                {buyingSaving ? "Saving…" : "Save buy qty"}
              </button>
              {row.planned_buy_qty != null && (
                <span style={{ fontFamily: "monospace", fontSize: 13, color: PAL.green }}>
                  Current: {row.planned_buy_qty.toLocaleString()} units
                  {row.item_cost != null && ` · $${(row.planned_buy_qty * row.item_cost).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                </span>
              )}
            </div>
            {buyError && <div style={{ color: PAL.red, marginTop: 6, fontSize: 12 }}>{buyError}</div>}
          </div>

          {/* Override form */}
          <SectionLabel>Set override</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={S.label}>Override qty (signed delta)</label>
              <input style={{ ...S.input, width: "100%" }} value={qtyStr} inputMode="numeric"
                     onChange={(e) => setQtyStr(e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Reason</label>
              <select style={{ ...S.select, width: "100%" }} value={reason}
                      onChange={(e) => setReason(e.target.value as IpEcomOverrideReason)}>
                {REASON_CODES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: "1 / 3" }}>
              <label style={S.label}>Note (optional)</label>
              <input style={{ ...S.input, width: "100%" }} value={note}
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

          {/* Unused factor fields kept visible for transparency */}
          <div style={{ color: PAL.textMuted, fontSize: 11, marginTop: 16 }}>
            seasonality {fmtFactor(null)} · promo {fmtFactor(null)} · launch {fmtFactor(null)} · markdown {fmtFactor(null)}
          </div>
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

function FlagToggle({ label, value, onChange, color }: {
  label: string; value: boolean; onChange: (v: boolean) => void; color: string;
}) {
  return (
    <button onClick={() => onChange(!value)}
            style={{
              border: `1px solid ${value ? color : PAL.border}`,
              background: value ? color + "22" : "transparent",
              color: value ? color : PAL.textDim,
              padding: "6px 12px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}>
      {value ? "✓ " : ""}{label}
    </button>
  );
}
