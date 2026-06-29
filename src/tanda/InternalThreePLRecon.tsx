// src/tanda/InternalThreePLRecon.tsx
//
// Tangerine — 3PL Inventory Reconciliation. Pick a 3PL provider, ingest its
// on-hand snapshot (paste/upload an EDI 846, a CSV of "sku,qty", or it accepts
// JSON via the API), and see the daily differences vs Tangerine's on-hand
// (inventory_layers) — comparable against the provider's location or total.
//
// Ingest + recon: POST /api/internal/edi/tpl/:provider_id/inventory-advice
// Read differences: GET  /api/internal/edi/tpl/:provider_id/inventory-advice

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify } from "../shared/ui/warn";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

type Provider = {
  id: string; name: string; code: string | null; location_id?: string | null;
  edi_endpoint?: string | null; edi_username?: string | null; edi_credential_ref?: string | null;
  inventory_sftp_path?: string | null; last_inventory_file?: string | null; last_inventory_pulled_at?: string | null;
};
type Snapshot = { id: string; snapshot_date: string; source: string; line_count: number; matched_count: number; created_at: string };
type Diff = { sku_code: string; qty_3pl: number; qty_tangerine_location: number; qty_tangerine_total: number; direction: string };

const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "SFMono-Regular, Menlo, monospace" };
const btn: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnGhost: React.CSSProperties = { background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12 };
const inp: React.CSSProperties = { width: "100%", background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "6px 9px", fontSize: 12, boxSizing: "border-box" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}

const fmtQty = (v: number) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function InternalThreePLRecon() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [diffs, setDiffs] = useState<Diff[]>([]);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [hasLocation, setHasLocation] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [basis, setBasis] = useState<"location" | "total">("total");
  const [mismatchOnly, setMismatchOnly] = useState(true);
  const [paste, setPaste] = useState("");
  const [ingesting, setIngesting] = useState(false);

  // SFTP auto-pull settings (per provider) — the nightly cron reads these.
  const [showSftp, setShowSftp] = useState(false);
  const [savingSftp, setSavingSftp] = useState(false);
  const [sftp, setSftp] = useState({ edi_endpoint: "", edi_username: "", edi_credential_ref: "", inventory_sftp_path: "" });
  const selectedProvider = providers.find((p) => p.id === providerId) || null;
  useEffect(() => {
    if (!selectedProvider) return;
    setSftp({
      edi_endpoint: selectedProvider.edi_endpoint || "",
      edi_username: selectedProvider.edi_username || "",
      edi_credential_ref: selectedProvider.edi_credential_ref || "",
      inventory_sftp_path: selectedProvider.inventory_sftp_path || "",
    });
  }, [providerId, providers]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveSftp() {
    if (!providerId) return;
    setSavingSftp(true); setErr(null);
    try {
      const r = await fetch("/api/internal/tpl-providers", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: providerId, edi_protocol: "SFTP", ...sftp }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify("SFTP auto-pull settings saved.", "success");
      // refresh providers so selectedProvider reflects the new values
      const d = await fetch("/api/internal/tpl-providers").then((x) => x.json());
      setProviders(Array.isArray(d) ? d : (d.providers || d.rows || []));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSavingSftp(false); }
  }

  useEffect(() => {
    fetch("/api/internal/tpl-providers")
      .then((r) => r.json())
      .then((d) => {
        const rows: Provider[] = Array.isArray(d) ? d : (d.providers || d.rows || []);
        setProviders(rows);
        if (rows.length && !providerId) setProviderId(rows[0].id);
      })
      .catch(() => {/* non-fatal */});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadDiffs(pid: string) {
    if (!pid) { setSnapshot(null); setDiffs([]); setHistory([]); return; }
    setLoading(true); setErr(null);
    try {
      const [latest, list] = await Promise.all([
        fetch(`/api/internal/edi/tpl/${pid}/inventory-advice`).then((r) => r.json()),
        fetch(`/api/internal/edi/tpl/${pid}/inventory-advice?list=1`).then((r) => r.json()),
      ]);
      setSnapshot(latest.snapshot || null);
      setDiffs(latest.differences || []);
      setHasLocation(!!latest.provider?.has_location);
      setHistory(list.snapshots || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void loadDiffs(providerId); }, [providerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ingest() {
    if (!providerId || !paste.trim()) return;
    setIngesting(true); setErr(null);
    try {
      const text = paste.trim();
      const isX12 = /\bISA\b|\bLIN\b\*/.test(text) || text.includes("~");
      const r = await fetch(`/api/internal/edi/tpl/${providerId}/inventory-advice`, {
        method: "POST",
        headers: { "Content-Type": isX12 ? "text/plain" : "application/json" },
        body: isX12 ? text : JSON.stringify({ csv: text }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Snapshot ingested.", "success");
      setPaste("");
      await loadDiffs(providerId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setIngesting(false); }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setPaste(String(reader.result || ""));
    reader.readAsText(f);
    e.target.value = "";
  }

  const tangerineOf = (d: Diff) => basis === "location" ? d.qty_tangerine_location : d.qty_tangerine_total;
  const rows = useMemo(() => {
    const mapped = diffs.map((d) => {
      const tan = tangerineOf(d);
      return { ...d, tangerine: tan, variance: (Number(d.qty_3pl) || 0) - (Number(tan) || 0) };
    });
    const filtered = mismatchOnly ? mapped.filter((r) => r.variance !== 0) : mapped;
    return filtered.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  }, [diffs, basis, mismatchOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // #5 — universal per-column sort (tri-state asc → desc → off, persisted).
  // Default (unsorted) preserves the variance-magnitude order `rows` builds.
  // Every column key maps 1:1 to the mapped row, so no accessors are needed.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:tplrecon:sort",
  });

  const totals = useMemo(() => {
    let over = 0, under = 0, net = 0;
    for (const r of rows) { net += r.variance; if (r.variance > 0) over += r.variance; else under += -r.variance; }
    return { over, under, net, count: rows.length };
  }, [rows]);

  const exportCols: ExportColumn<Record<string, unknown>>[] = [
    { key: "sku_code", header: "SKU" },
    { key: "qty_3pl", header: "3PL On-Hand", format: "number" },
    { key: "tangerine", header: `Tangerine (${basis})`, format: "number" },
    { key: "variance", header: "Variance (3PL − Tangerine)", format: "number" },
    { key: "direction", header: "Type" },
  ];

  // #23 — append the on-screen totals footer to the export. Mirrors the grid's
  // <tfoot>: SKU label carries the differing-SKU count, the numeric columns sum,
  // and Variance carries the net (the same number the footer prints).
  const exportRows = useMemo(() => {
    const body: Array<Record<string, unknown>> = sorted.map((r) => ({
      sku_code: r.sku_code, qty_3pl: r.qty_3pl, tangerine: r.tangerine,
      variance: r.variance, direction: r.direction,
    }));
    if (body.length) {
      body.push({
        sku_code: `TOTAL (${totals.count} differing SKU${totals.count === 1 ? "" : "s"})`,
        qty_3pl: rows.reduce((s, r) => s + (Number(r.qty_3pl) || 0), 0),
        tangerine: rows.reduce((s, r) => s + (Number(r.tangerine) || 0), 0),
        variance: totals.net,
        direction: "",
      });
    }
    return body;
  }, [sorted, rows, totals]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>3PL Inventory Recon</h2>
        <div style={{ minWidth: 240 }}>
          <SearchableSelect
            options={providers.map((p) => ({ value: p.id, label: p.name, searchHaystack: `${p.name} ${p.code || ""}` }))}
            value={providerId}
            onChange={setProviderId}
            placeholder="3PL provider…"
          />
        </div>
      </div>

      {/* Ingest */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: C.textSub, marginBottom: 6 }}>
          Ingest the 3PL's on-hand snapshot — paste an <strong>EDI 846</strong>, or a <strong>CSV</strong> of <code>sku,qty</code> rows (header optional), or upload a file.
        </div>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={"SKU,QTY\nRYB086930-BLACK-30,120\nRYB086930-BLACK-32,80\n…  (or paste a raw X12 846)"}
          style={{ width: "100%", minHeight: 96, background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, fontSize: 12, fontFamily: "SFMono-Regular, Menlo, monospace", boxSizing: "border-box", resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <button style={btn} onClick={() => void ingest()} disabled={ingesting || !providerId || !paste.trim()}>{ingesting ? "Reconciling…" : "Ingest & reconcile"}</button>
          <label style={{ ...btnGhost, display: "inline-flex", alignItems: "center", gap: 6 }}>
            Upload file
            <input type="file" accept=".csv,.txt,.edi,.x12,text/plain" onChange={onFile} style={{ display: "none" }} />
          </label>
          <span style={{ fontSize: 11, color: C.textMuted }}>Each ingest stores a dated snapshot and recomputes the differences.</span>
        </div>
      </div>

      {/* SFTP auto-pull settings (nightly cron) */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, marginBottom: 14 }}>
        <button onClick={() => setShowSftp((v) => !v)} style={{ width: "100%", textAlign: "left", background: "transparent", border: 0, color: C.textSub, cursor: "pointer", padding: "10px 14px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          {showSftp ? "▾" : "▸"} Auto-pull (SFTP) — runs nightly at 02:30 UTC
          {selectedProvider?.last_inventory_pulled_at && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: C.textMuted, fontWeight: 400 }}>
              last pulled {new Date(selectedProvider.last_inventory_pulled_at).toLocaleString()} {selectedProvider.last_inventory_file ? `· ${selectedProvider.last_inventory_file}` : ""}
            </span>
          )}
        </button>
        {showSftp && (
          <div style={{ padding: "0 14px 14px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            <Field label="SFTP host[:port]"><input style={inp} value={sftp.edi_endpoint} onChange={(e) => setSftp({ ...sftp, edi_endpoint: e.target.value })} placeholder="sftp.my3pl.com:22" /></Field>
            <Field label="Username"><input style={inp} value={sftp.edi_username} onChange={(e) => setSftp({ ...sftp, edi_username: e.target.value })} placeholder="ringoffire" /></Field>
            <Field label="Credential env-var name"><input style={inp} value={sftp.edi_credential_ref} onChange={(e) => setSftp({ ...sftp, edi_credential_ref: e.target.value })} placeholder="TPL_ACME_SFTP_KEY" /></Field>
            <Field label="Inventory directory (remote)"><input style={inp} value={sftp.inventory_sftp_path} onChange={(e) => setSftp({ ...sftp, inventory_sftp_path: e.target.value })} placeholder="/outbox/inventory" /></Field>
            <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10 }}>
              <button style={btn} onClick={() => void saveSftp()} disabled={savingSftp || !providerId}>{savingSftp ? "Saving…" : "Save SFTP settings"}</button>
              <span style={{ fontSize: 11, color: C.textMuted }}>The secret (password or SSH key) lives in the named environment variable — never stored in the DB. The cron pulls the newest file in the directory each night and reconciles it.</span>
            </div>
          </div>
        )}
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      {/* Snapshot meta + controls */}
      {snapshot && (
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 10, fontSize: 12, color: C.textMuted }}>
          <span>Snapshot <strong style={{ color: C.textSub }}>{snapshot.snapshot_date}</strong></span>
          <span>source <strong style={{ color: C.textSub }}>{snapshot.source}</strong></span>
          <span><strong style={{ color: C.textSub }}>{snapshot.matched_count}</strong>/{snapshot.line_count} SKUs matched</span>
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
            Compare vs
            <button style={{ ...btnGhost, ...(basis === "location" ? { borderColor: C.primary, color: "#c4b5fd" } : {}) }} onClick={() => setBasis("location")} disabled={!hasLocation} title={hasLocation ? "" : "This provider has no inventory_locations link"}>Location</button>
            <button style={{ ...btnGhost, ...(basis === "total" ? { borderColor: C.primary, color: "#c4b5fd" } : {}) }} onClick={() => setBasis("total")}>Total on-hand</button>
          </span>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", color: C.textSub }}>
            <input type="checkbox" checked={mismatchOnly} onChange={(e) => setMismatchOnly(e.target.checked)} /> Mismatches only
          </label>
          <ExportButton rows={exportRows} columns={exportCols} filename={`tpl-recon-${snapshot.snapshot_date}`} sheetName="3PL Differences" />
        </div>
      )}

      {!hasLocation && snapshot && basis === "location" && (
        <div style={{ background: "rgba(245,158,11,0.12)", border: `1px solid ${C.warn}`, color: "#FCD34D", padding: "8px 12px", borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
          This provider isn't linked to an inventory location, so "Location" on-hand is 0 for everything — compare vs <strong>Total on-hand</strong> instead, or set the provider's location.
        </div>
      )}

      {/* Differences */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : !snapshot ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No snapshot yet — ingest one above to see differences.</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.success }}>✓ No differences{mismatchOnly ? " — 3PL matches Tangerine for every reported SKU." : "."}</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="SKU" sortKey="sku_code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                <SortableTh label="3PL On-Hand" sortKey="qty_3pl" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
                <SortableTh label={`Tangerine (${basis})`} sortKey="tangerine" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
                <SortableTh label="Variance" sortKey="variance" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
                <SortableTh label="Type" sortKey="direction" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={`${r.sku_code}-${r.direction}`}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.sku_code}</td>
                  <td style={tdNum}>{fmtQty(r.qty_3pl)}</td>
                  <td style={tdNum}>{fmtQty(r.tangerine)}</td>
                  <td style={{ ...tdNum, color: r.variance === 0 ? C.textMuted : r.variance > 0 ? C.warn : C.danger, fontWeight: 700 }}>
                    {r.variance > 0 ? "+" : ""}{fmtQty(r.variance)}
                  </td>
                  <td style={{ ...td, color: C.textMuted, fontSize: 11 }}>{r.direction === "only_tangerine" ? "Tangerine only" : r.direction === "only_3pl" ? "3PL only" : "both"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#111827" }}>
                <td style={{ ...td, fontWeight: 700, color: C.textSub }}>{totals.count} differing SKU{totals.count === 1 ? "" : "s"}</td>
                <td style={td} />
                <td style={{ ...tdNum, color: C.textMuted }}>net</td>
                <td style={{ ...tdNum, fontWeight: 800, color: totals.net === 0 ? C.textMuted : totals.net > 0 ? C.warn : C.danger }}>{totals.net > 0 ? "+" : ""}{fmtQty(totals.net)}</td>
                <td style={{ ...td, color: C.textMuted, fontSize: 11 }}>+{fmtQty(totals.over)} / −{fmtQty(totals.under)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* History */}
      {history.length > 1 && (
        <div style={{ marginTop: 14, fontSize: 12, color: C.textMuted }}>
          <div style={{ marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Recent snapshots</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {history.slice(0, 14).map((s) => (
              <span key={s.id} style={{ background: C.card, border: `1px solid ${snapshot?.id === s.id ? C.primary : C.cardBdr}`, borderRadius: 6, padding: "3px 8px", fontFamily: "monospace" }}>
                {s.snapshot_date} · {s.source} · {s.matched_count}/{s.line_count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
