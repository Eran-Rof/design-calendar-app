// src/tanda/InternalEDI.tsx
//
// P22 / M14 — EDI dashboard. Surfaces the existing EDI engine (api/_lib/edi/*
// + edi_messages): an operator can enable EDI for a vendor (set the partner /
// ISA sender ID, stored as an erp_integrations row) and watch the inbound /
// outbound X12 message log (850 PO out · 855 ack · 856 ASN · 810 invoice ·
// 820 payment · 997 functional ack). Transport (AS2/SFTP delivery) + the
// customer/retailer side are follow-ups.

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
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const input: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const btnP: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnS: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "7px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const chip = (bg: string): React.CSSProperties => ({ background: bg + "22", color: bg, padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600 });
const tabBtn = (on: boolean): React.CSSProperties => ({ ...btnS, borderColor: on ? C.primary : C.cardBdr, color: on ? C.primary : C.textSub, fontWeight: on ? 700 : 400 });

const TXN_LABEL: Record<string, string> = { "850": "850 PO", "855": "855 PO Ack", "856": "856 ASN", "810": "810 Invoice", "820": "820 Payment", "997": "997 Ack" };
const STAT_COLOR: Record<string, string> = { received: C.primary, processed: C.success, acknowledged: C.success, error: C.danger };

type Partner = { id: string; vendor_id: string; vendor_name: string | null; vendor_code: string | null; partner_id: string; transport: string | null; status: string; last_sync_at: string | null; last_sync_status: string | null; last_sync_error: string | null };
type Message = { id: string; vendor_id: string; vendor_name: string | null; direction: string; transaction_set: string; interchange_id: string | null; status: string; error_message: string | null; created_at: string };
type Vendor = { id: string; name: string; code?: string };

export default function InternalEDI() {
  const [tab, setTab] = useState<"partners" | "messages">("partners");
  const [partners, setPartners] = useState<Partner[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [vendId, setVendId] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [transport, setTransport] = useState("");
  const [dir, setDir] = useState("");
  const [txn, setTxn] = useState("");

  async function loadPartners() {
    const r = await fetch("/api/internal/edi-partners").then((x) => x.json()).catch(() => ({}));
    setPartners(Array.isArray(r.partners) ? r.partners : []);
  }
  async function loadMessages() {
    const p = new URLSearchParams();
    if (dir) p.set("direction", dir);
    if (txn) p.set("transaction_set", txn);
    const r = await fetch(`/api/internal/edi-messages?${p.toString()}`).then((x) => x.json()).catch(() => ({}));
    setMessages(Array.isArray(r.messages) ? r.messages : []);
  }
  useEffect(() => { (async () => { setLoading(true); await Promise.all([loadPartners(), loadMessages()]); setLoading(false); })(); }, []);
  useEffect(() => { void loadMessages(); /* eslint-disable-next-line */ }, [dir, txn]);
  useEffect(() => { fetch("/api/internal/vendor-master?limit=1000").then((r) => r.json()).then((a) => { if (Array.isArray(a)) setVendors(a as Vendor[]); }).catch(() => {}); }, []);

  const vendName = useMemo(() => new Map(vendors.map((v) => [v.id, v.name])), [vendors]);

  // #5 — tri-state column sort for the two LIST tables. Vendor / document /
  // when columns resolve through derived accessors (display values).
  const {
    sorted: sortedPartners,
    sortKey: partnersSortKey,
    sortDir: partnersSortDir,
    onHeaderClick: onPartnersSort,
  } = useSort(partners, {
    persistKey: "tangerine:edi-partners:sort",
    accessors: {
      vendor: (p) => p.vendor_name || vendName.get(p.vendor_id) || "",
      partner_id: (p) => p.partner_id,
      transport: (p) => p.transport || "",
      status: (p) => p.status,
      last_sync: (p) => p.last_sync_at || "",
    },
  });
  const {
    sorted: sortedMessages,
    sortKey: messagesSortKey,
    sortDir: messagesSortDir,
    onHeaderClick: onMessagesSort,
  } = useSort(messages, {
    persistKey: "tangerine:edi-messages:sort",
    accessors: {
      when: (m) => m.created_at,
      vendor: (m) => m.vendor_name || vendName.get(m.vendor_id) || "",
      direction: (m) => m.direction,
      document: (m) => TXN_LABEL[m.transaction_set] || m.transaction_set,
      interchange: (m) => m.interchange_id || "",
      status: (m) => m.status,
    },
  });

  async function enable() {
    if (!vendId) { notify("Pick a vendor", "error"); return; }
    if (!partnerId.trim()) { notify("Partner / ISA sender ID required", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/edi-partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vendor_id: vendId, partner_id: partnerId.trim(), transport: transport.trim() || undefined }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      notify(j.message || "EDI enabled", "success");
      setEnabling(false); setVendId(""); setPartnerId(""); setTransport("");
      await loadPartners();
    } catch (e) { notify("Failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setBusy(false); }
  }

  const pCols: ExportColumn<{ vendor: string; partner_id: string; transport: string; status: string; last_sync: string }>[] =
    [{ key: "vendor", header: "Vendor" }, { key: "partner_id", header: "Partner ID" }, { key: "transport", header: "Transport" }, { key: "status", header: "Status" }, { key: "last_sync", header: "Last sync" }];
  const pRows = partners.map((p) => ({ vendor: p.vendor_name || vendName.get(p.vendor_id) || "", partner_id: p.partner_id, transport: p.transport || "", status: p.status, last_sync: p.last_sync_at || "" }));

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>EDI</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>X12 trading-partner exchange (vendor PO / ack / ASN / invoice)</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button style={tabBtn(tab === "partners")} onClick={() => setTab("partners")}>Partners ({partners.length})</button>
          <button style={tabBtn(tab === "messages")} onClick={() => setTab("messages")}>Messages ({messages.length})</button>
        </div>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : tab === "partners" ? (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <ExportButton rows={pRows} columns={pCols} filename="edi-partners" />
            <button style={btnP} onClick={() => setEnabling((v) => !v)}>{enabling ? "Cancel" : "+ Enable EDI for vendor"}</button>
          </div>
          {enabling && (
            <div style={{ background: C.card, border: `1px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ minWidth: 220 }}><SearchableSelect options={vendors.map((v) => ({ value: v.id, label: v.name, searchHaystack: `${v.name} ${v.code || ""}` }))} value={vendId} onChange={setVendId} placeholder="Vendor…" /></div>
              <input style={{ ...input, minWidth: 180 }} placeholder="Partner / ISA sender ID *" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} />
              <SearchableSelect
                value={transport || null}
                onChange={(v) => setTransport(v)}
                options={[{ value: "", label: "Transport…" }, { value: "as2", label: "AS2" }, { value: "sftp", label: "SFTP" }, { value: "van", label: "VAN" }]}
                inputStyle={input}
              />
              <button style={btnP} disabled={busy} onClick={enable}>Enable</button>
              <span style={{ color: C.textMuted, fontSize: 12 }}>The engine resolves inbound X12 by matching GS02 to this partner ID.</span>
            </div>
          )}
          <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <SortableTh label="Vendor" sortKey="vendor" activeKey={partnersSortKey} dir={partnersSortDir} onSort={onPartnersSort} style={th} />
              <SortableTh label="Partner ID" sortKey="partner_id" activeKey={partnersSortKey} dir={partnersSortDir} onSort={onPartnersSort} style={th} />
              <SortableTh label="Transport" sortKey="transport" activeKey={partnersSortKey} dir={partnersSortDir} onSort={onPartnersSort} style={th} />
              <SortableTh label="Status" sortKey="status" activeKey={partnersSortKey} dir={partnersSortDir} onSort={onPartnersSort} style={th} />
              <SortableTh label="Last sync" sortKey="last_sync" activeKey={partnersSortKey} dir={partnersSortDir} onSort={onPartnersSort} style={th} />
            </tr></thead>
            <tbody>
              {partners.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={5}>No EDI partners configured yet.</td></tr>}
              {sortedPartners.map((p) => (
                <tr key={p.id}>
                  <td style={td}>{p.vendor_name || vendName.get(p.vendor_id) || "—"}{p.vendor_code ? ` (${p.vendor_code})` : ""}</td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{p.partner_id}</td>
                  <td style={td}>{p.transport || "—"}</td>
                  <td style={td}><span style={chip(p.status === "active" ? C.success : C.textMuted)}>{p.status}</span></td>
                  <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>{p.last_sync_at ? new Date(p.last_sync_at).toLocaleString() : "—"}{p.last_sync_error ? ` · ${p.last_sync_error}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
            <SearchableSelect value={dir || null} onChange={(v) => setDir(v)} options={[{ value: "", label: "All directions" }, { value: "inbound", label: "Inbound" }, { value: "outbound", label: "Outbound" }]} inputStyle={input} />
            <SearchableSelect value={txn || null} onChange={(v) => setTxn(v)} options={[{ value: "", label: "All documents" }, ...Object.entries(TXN_LABEL).map(([k, v]) => ({ value: k, label: v }))]} inputStyle={input} />
            <span style={{ color: C.textMuted, fontSize: 12, marginLeft: "auto" }}>{messages.length} message{messages.length === 1 ? "" : "s"}</span>
          </div>
          <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <SortableTh label="When" sortKey="when" activeKey={messagesSortKey} dir={messagesSortDir} onSort={onMessagesSort} style={th} />
              <SortableTh label="Vendor" sortKey="vendor" activeKey={messagesSortKey} dir={messagesSortDir} onSort={onMessagesSort} style={th} />
              <SortableTh label="Dir" sortKey="direction" activeKey={messagesSortKey} dir={messagesSortDir} onSort={onMessagesSort} style={th} />
              <SortableTh label="Document" sortKey="document" activeKey={messagesSortKey} dir={messagesSortDir} onSort={onMessagesSort} style={th} />
              <SortableTh label="Interchange" sortKey="interchange" activeKey={messagesSortKey} dir={messagesSortDir} onSort={onMessagesSort} style={th} />
              <SortableTh label="Status" sortKey="status" activeKey={messagesSortKey} dir={messagesSortDir} onSort={onMessagesSort} style={th} />
            </tr></thead>
            <tbody>
              {messages.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={6}>No EDI messages yet — they appear here once partners exchange X12.</td></tr>}
              {sortedMessages.map((m) => (
                <tr key={m.id}>
                  <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>{new Date(m.created_at).toLocaleString()}</td>
                  <td style={td}>{m.vendor_name || vendName.get(m.vendor_id) || "—"}</td>
                  <td style={td}>{m.direction === "inbound" ? "↘ in" : "↗ out"}</td>
                  <td style={td}>{TXN_LABEL[m.transaction_set] || m.transaction_set}</td>
                  <td style={{ ...td, fontFamily: "monospace", color: C.textMuted, fontSize: 12 }}>{m.interchange_id || "—"}</td>
                  <td style={td}><span style={chip(STAT_COLOR[m.status] || C.textMuted)}>{m.status}</span>{m.error_message ? <span style={{ color: C.danger, fontSize: 11 }}> · {m.error_message}</span> : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
