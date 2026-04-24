import React, { useEffect, useRef, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import { formatSscc18Display } from "../services/gtinService";

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 11,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD: React.CSSProperties = {
  padding: "7px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}`,
};
const CARD: React.CSSProperties = {
  background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 20, overflow: "hidden",
};
const CARD_HEAD: React.CSSProperties = {
  padding: "12px 20px", borderBottom: `1px solid ${TH.border}`,
  fontWeight: 600, fontSize: 14, color: TH.textSub,
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    generated: { bg: "#EBF8FF", color: "#2B6CB0" },
    shipped:   { bg: "#FFFBEB", color: "#92400E" },
    received:  { bg: "#F0FFF4", color: "#276749" },
    cancelled: { bg: "#FFF5F5", color: TH.primary },
    matched:   { bg: "#F0FFF4", color: "#276749" },
    variance:  { bg: "#FFF5F5", color: TH.primary },
    expected:  { bg: "#EBF8FF", color: "#2B6CB0" },
    open:      { bg: "#EBF8FF", color: "#2B6CB0" },
  };
  const s = map[status] ?? { bg: TH.surfaceHi, color: TH.textMuted };
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap" }}>
      {status}
    </span>
  );
}

export default function ReceivingPanel() {
  const {
    receivingCarton, receivingContents, receivingExplosion,
    receivingEditedQtys, receivingSessions, receivingSession,
    receivingLoading, receivingError, receivingAlreadyReceived,
    searchBySscc, setReceivingEditedQty, confirmReceive, clearReceiving, loadReceivingSessions,
    bomBuilding, buildBomForReceiving,
  } = useGS1Store();

  const [ssccInput, setSsccInput]     = useState("");
  const [notes, setNotes]             = useState("");
  const [confirming, setConfirming]   = useState(false);
  const [confirmDone, setConfirmDone] = useState(false);
  const [buildingBom, setBuildingBom] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadReceivingSessions();
    inputRef.current?.focus();
  }, []);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!ssccInput.trim()) return;
    setConfirmDone(false);
    await searchBySscc(ssccInput.trim());
  }

  async function handleConfirm() {
    setConfirming(true);
    try {
      await confirmReceive(notes || undefined);
      setConfirmDone(true);
      setNotes("");
    } finally {
      setConfirming(false);
    }
  }

  function handleClear() {
    clearReceiving();
    setSsccInput("");
    setNotes("");
    setConfirmDone(false);
    setBuildingBom(false);
    inputRef.current?.focus();
  }

  async function handleBuildBomNow() {
    setBuildingBom(true);
    try {
      await buildBomForReceiving();
      // Re-run explosion with the same SSCC now that BOMs exist
      if (receivingCarton) await searchBySscc(receivingCarton.sscc);
    } finally {
      setBuildingBom(false);
    }
  }

  const explosion = receivingExplosion;
  const hasResults = !!receivingCarton;
  const canConfirm = hasResults && !receivingAlreadyReceived && !confirming && !confirmDone;

  return (
    <div style={{ padding: "24px 24px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Carton Receiving</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        Scan or enter an SSCC-18 to look up carton contents and confirm receipt.
      </p>

      {/* Already-received / variance warning */}
      {receivingAlreadyReceived && receivingCarton && (
        <div style={{ background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#92400E", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 700 }}>⚠ Already received</span>
          — Carton {receivingCarton.sscc} was previously marked {receivingCarton.status}. Receiving again will create a duplicate session.
        </div>
      )}
      {receivingSession?.status === "variance" && (
        <div style={{ background: "#FFF5F5", border: "1px solid #FEB2B2", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#C53030", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 700 }}>⚠ Variance recorded</span>
          — This session has qty mismatches. Review the lines below and investigate before signing off.
        </div>
      )}

      {/* ── Search bar ─────────────────────────────────────────────────────── */}
      <form onSubmit={handleSearch} style={{ display: "flex", gap: 10, marginBottom: 20, maxWidth: 640 }}>
        <input
          ref={inputRef}
          value={ssccInput}
          onChange={e => setSsccInput(e.target.value)}
          placeholder="Scan or enter SSCC-18 (e.g. 003109270000000017 or (00) ...)"
          style={{
            flex: 1, padding: "10px 14px", border: `2px solid ${TH.border}`, borderRadius: 8,
            fontSize: 14, fontFamily: "monospace", outline: "none", boxSizing: "border-box",
          }}
          disabled={receivingLoading}
          autoComplete="off"
        />
        <button type="submit" disabled={receivingLoading || !ssccInput.trim()}
          style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 8,
            padding: "10px 22px", fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
          {receivingLoading ? "Searching…" : "Search"}
        </button>
        {hasResults && (
          <button type="button" onClick={handleClear}
            style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 8,
              padding: "10px 16px", fontSize: 13, cursor: "pointer" }}>
            Clear
          </button>
        )}
      </form>

      {receivingError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8,
          padding: "10px 16px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {receivingError}
        </div>
      )}

      {/* ── Already received warning ────────────────────────────────────────── */}
      {receivingAlreadyReceived && !confirmDone && (
        <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8,
          padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#92400E" }}>
          <strong>⚠ This carton has already been received.</strong> Duplicate receiving is blocked.
          {/* Override button placeholder — intentionally disabled in Phase 2 */}
          <span style={{ marginLeft: 16, color: TH.textMuted, fontSize: 12 }}>
            (Override: TODO Phase 3)
          </span>
        </div>
      )}

      {confirmDone && receivingSession && (
        <div style={{ background: "#F0FFF4", border: "1px solid #C6F6D5", borderRadius: 8,
          padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#276749" }}>
          <strong>✓ Received</strong> — session <code style={{ fontSize: 11 }}>{receivingSession.id.slice(0, 8)}…</code> &nbsp;
          Status: <StatusBadge status={receivingSession.status} />
        </div>
      )}

      {hasResults && receivingCarton && (
        <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 20, alignItems: "start" }}>

          {/* ── Left: Carton info ─────────────────────────────────────────── */}
          <div>
            <div style={CARD}>
              <div style={CARD_HEAD}>Carton Info</div>
              <div style={{ padding: "14px 20px" }}>
                <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
                  {receivingCarton.sscc}
                </div>
                <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 12 }}>
                  {formatSscc18Display(receivingCarton.sscc)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <StatusBadge status={receivingCarton.status} />
                </div>
                {[
                  ["PO Number", receivingCarton.po_number],
                  ["Carton No", receivingCarton.carton_no],
                  ["Channel",   receivingCarton.channel],
                  ["Style",     receivingCarton.style_no],
                  ["Color",     receivingCarton.color],
                  ["Scale",     receivingCarton.scale_code],
                  ["Total Packs",  receivingCarton.total_packs?.toString()],
                  ["Total Units",  receivingCarton.total_units?.toString()],
                ].map(([label, value]) => value ? (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between",
                    padding: "4px 0", borderBottom: `1px solid ${TH.border}`, fontSize: 13 }}>
                    <span style={{ color: TH.textMuted }}>{label}</span>
                    <span style={{ fontWeight: 600 }}>{value}</span>
                  </div>
                ) : null)}
              </div>
            </div>

            {/* Pack contents summary */}
            {explosion && explosion.contentLines.length > 0 && (
              <div style={CARD}>
                <div style={CARD_HEAD}>Pack Contents ({explosion.contentLines.length})</div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    {["Pack GTIN", "Scale", "Packs"].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {explosion.contentLines.map((c, i) => (
                      <tr key={i}>
                        <td style={{ ...TD, fontFamily: "monospace", fontSize: 11 }}>{c.pack_gtin}</td>
                        <td style={TD}>{c.scale_code || "—"}</td>
                        <td style={{ ...TD, fontWeight: 700 }}>{c.pack_qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Right: UPC breakdown + confirm ───────────────────────────── */}
          <div>
            {/* Missing BOM warnings + Build BOM now */}
            {explosion && explosion.missingBomGtins.length > 0 && (
              <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8,
                padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#92400E" }}>
                <strong>⚠ BOM missing for {explosion.missingBomGtins.length} Pack GTIN(s):</strong>
                {" "}cannot explode to UPC-level receiving.
                <ul style={{ margin: "6px 0 6px 16px", fontSize: 12 }}>
                  {explosion.missingBomGtins.map(g => <li key={g}><code>{g}</code></li>)}
                </ul>
                <button
                  onClick={handleBuildBomNow}
                  disabled={buildingBom || bomBuilding}
                  style={{
                    background: "#92400E", color: "#fff", border: "none", borderRadius: 6,
                    padding: "6px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer", marginTop: 4,
                  }}>
                  {buildingBom ? "Building BOM…" : "Build BOM now"}
                </button>
                <span style={{ marginLeft: 10, fontSize: 11, color: "#A16207" }}>
                  Uses Scale Master + UPC Master to auto-build
                </span>
              </div>
            )}

            {/* UPC receiving lines */}
            {explosion && explosion.aggregated.length > 0 ? (
              <div style={CARD}>
                <div style={{ ...CARD_HEAD, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>UPC Receiving Lines ({explosion.aggregated.length} lines)</span>
                  <span style={{ fontSize: 12, fontWeight: 400, color: TH.textMuted }}>
                    Expected {explosion.totalExpected.toLocaleString()} units &nbsp;·&nbsp;
                    Received {explosion.totalReceived.toLocaleString()} units
                    {explosion.totalReceived !== explosion.totalExpected && (
                      <span style={{ color: TH.primary, fontWeight: 600 }}>
                        {" "}({explosion.totalReceived - explosion.totalExpected > 0 ? "+" : ""}{explosion.totalReceived - explosion.totalExpected})
                      </span>
                    )}
                  </span>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      {["UPC", "Style", "Color", "Size", "Expected", "Received", "Variance", "Status"].map(h => (
                        <th key={h} style={TH_STYLE}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {explosion.aggregated.map(line => {
                        const edited = receivingEditedQtys[line.child_upc] ?? line.expected_qty;
                        const variance = line.variance_qty;
                        return (
                          <tr key={line.child_upc}>
                            <td style={{ ...TD, fontFamily: "monospace", fontSize: 11 }}>{line.child_upc}</td>
                            <td style={TD}>{line.style_no}</td>
                            <td style={TD}>{line.color}</td>
                            <td style={{ ...TD, fontWeight: 600 }}>{line.size}</td>
                            <td style={{ ...TD, fontWeight: 600 }}>{line.expected_qty}</td>
                            <td style={TD}>
                              <input
                                type="number"
                                min={0}
                                value={edited}
                                disabled={receivingAlreadyReceived || confirmDone}
                                onChange={e => setReceivingEditedQty(line.child_upc, parseInt(e.target.value) || 0)}
                                style={{
                                  width: 70, padding: "4px 6px", border: `1px solid ${TH.border}`,
                                  borderRadius: 5, fontSize: 13, fontWeight: 600,
                                  background: receivingAlreadyReceived ? TH.surfaceHi : "#fff",
                                  boxSizing: "border-box",
                                }}
                              />
                            </td>
                            <td style={{ ...TD, fontWeight: 600, color: variance === 0 ? "#276749" : TH.primary }}>
                              {variance === 0 ? "0" : (variance > 0 ? `+${variance}` : `${variance}`)}
                            </td>
                            <td style={TD}><StatusBadge status={line.line_status} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: TH.surfaceHi }}>
                        <td colSpan={4} style={{ ...TD, fontWeight: 700, textAlign: "right", borderTop: `2px solid ${TH.border}` }}>Totals:</td>
                        <td style={{ ...TD, fontWeight: 700, borderTop: `2px solid ${TH.border}` }}>{explosion.totalExpected}</td>
                        <td style={{ ...TD, fontWeight: 700, borderTop: `2px solid ${TH.border}` }}>{explosion.totalReceived}</td>
                        <td style={{ ...TD, fontWeight: 700, color: explosion.totalReceived === explosion.totalExpected ? "#276749" : TH.primary, borderTop: `2px solid ${TH.border}` }}>
                          {explosion.totalReceived - explosion.totalExpected === 0 ? "0" :
                           (explosion.totalReceived - explosion.totalExpected > 0
                             ? `+${explosion.totalReceived - explosion.totalExpected}`
                             : `${explosion.totalReceived - explosion.totalExpected}`)}
                        </td>
                        <td style={{ ...TD, borderTop: `2px solid ${TH.border}` }} />
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Confirm receive section */}
                {!confirmDone && !receivingAlreadyReceived && (
                  <div style={{ padding: "16px 20px", borderTop: `1px solid ${TH.border}`, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase" }}>Notes (optional)</label>
                      <input
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        placeholder="e.g. Short ship on size M"
                        style={{ padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, width: 260, boxSizing: "border-box" }}
                      />
                    </div>
                    <button
                      onClick={handleConfirm}
                      disabled={!canConfirm}
                      style={{
                        background: "#276749", color: "#fff", border: "none", borderRadius: 8,
                        padding: "9px 24px", fontSize: 14, fontWeight: 600, cursor: "pointer",
                        opacity: canConfirm ? 1 : 0.5,
                      }}
                    >
                      {confirming ? "Confirming…" : "Confirm Receive"}
                    </button>
                    {explosion.totalReceived !== explosion.totalExpected && (
                      <span style={{ fontSize: 12, color: "#92400E", alignSelf: "center" }}>
                        ⚠ Variance will be recorded
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : explosion && explosion.contentLines.length > 0 && explosion.missingBomGtins.length > 0 ? (
              <div style={{ ...CARD, padding: 24, color: TH.textMuted, fontSize: 13, textAlign: "center" }}>
                No UPC lines — all Pack GTINs are missing BOM records. Use "Build BOM now" above.
              </div>
            ) : !explosion ? null : (
              <div style={{ ...CARD, padding: 24, color: TH.textMuted, fontSize: 13, textAlign: "center" }}>
                No pack contents found for this carton. Ensure carton_contents are populated or the carton has a pack_gtin assigned.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Receiving session history ─────────────────────────────────────────── */}
      <div style={{ ...CARD, marginTop: hasResults ? 28 : 0 }}>
        <div style={{ ...CARD_HEAD, display: "flex", justifyContent: "space-between" }}>
          <span>Receiving History ({receivingSessions.length})</span>
          <button onClick={() => loadReceivingSessions()}
            style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 5,
              padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>
            Refresh
          </button>
        </div>
        {receivingSessions.length === 0
          ? <p style={{ padding: "16px 20px", color: TH.textMuted, fontSize: 13 }}>No receiving sessions yet.</p>
          : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  {["SSCC", "Status", "Notes", "Received At"].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {receivingSessions.map(s => (
                    <tr key={s.id}>
                      <td style={{ ...TD, fontFamily: "monospace", fontSize: 11 }}>{s.sscc}</td>
                      <td style={TD}><StatusBadge status={s.status} /></td>
                      <td style={{ ...TD, color: TH.textMuted }}>{s.notes ?? "—"}</td>
                      <td style={{ ...TD, color: TH.textMuted, fontSize: 11 }}>
                        {s.received_at ? new Date(s.received_at).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}
