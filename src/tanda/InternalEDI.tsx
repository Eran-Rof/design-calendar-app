// src/tanda/InternalEDI.tsx
//
// P22 / M14 — EDI dashboard. Three tabs:
//   • Partners     — vendor X12 trading partners (erp_integrations).
//   • 3PL Connections — the warehouse/3PL SFTP EDI connection on each
//                    tpl_provider: transport, host/port, write-only secret,
//                    remote dirs, ISA/GS ids, enabled docs, poll flag +
//                    a live "Test connection" button.
//   • Messages     — the real inbound/outbound X12 log over edi_messages
//                    (850/855/856/810/820/997 vendor + 940/944/945/846 3PL),
//                    full-row-click detail with raw payload, 997 ack status,
//                    and a retry action for failed outbound.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155", panel: "#0b1220",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const input: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const label: React.CSSProperties = { color: C.textMuted, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4, display: "block" };
const btnP: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnS: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "7px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const chip = (bg: string): React.CSSProperties => ({ background: bg + "22", color: bg, padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" });
const tabBtn = (on: boolean): React.CSSProperties => ({ ...btnS, borderColor: on ? C.primary : C.cardBdr, color: on ? C.primary : C.textSub, fontWeight: on ? 700 : 400 });
const linkCell: React.CSSProperties = { color: C.primary, fontWeight: 600, cursor: "pointer" };

const TXN_LABEL: Record<string, string> = {
  "850": "850 PO", "855": "855 PO Ack", "856": "856 ASN", "810": "810 Invoice", "820": "820 Payment", "997": "997 Ack",
  "940": "940 Ship Order", "944": "944 Receipt Adv", "945": "945 Ship Adv", "846": "846 Inventory",
};
const STAT_COLOR: Record<string, string> = {
  received: C.primary, processed: C.success, acknowledged: C.success, applied: C.success, sent: C.success,
  staged: C.violet, parsed: C.primary, generated: C.textMuted, queued: C.warn, failed: C.danger, error: C.danger,
};
const DOC_TYPES = ["940", "944", "945", "846", "997"];
const fmtDT = (s: string | null) => (s ? new Date(s).toLocaleString("en-US") : "—");

type Partner = { id: string; vendor_id: string; vendor_name: string | null; vendor_code: string | null; partner_id: string; transport: string | null; status: string; last_sync_at: string | null; last_sync_status: string | null; last_sync_error: string | null };
type Message = { id: string; vendor_id: string; vendor_name: string | null; tpl_provider_id: string | null; tpl_provider_name: string | null; direction: string; transaction_set: string; interchange_id: string | null; status: string; attempts: number | null; transmitted: boolean | null; ack_status: string | null; file_name: string | null; error_message: string | null; created_at: string };
type Vendor = { id: string; name: string; code?: string };
type Provider = {
  id: string; name: string; code?: string; is_active?: boolean;
  edi_protocol: string | null; edi_endpoint: string | null; edi_port: number | null; edi_username: string | null;
  edi_secret_set?: boolean; edi_outbound_dir: string | null; edi_inbound_dir: string | null; edi_archive_dir: string | null;
  partner_isa_qualifier: string | null; partner_isa_id: string | null; partner_gs_id: string | null;
  enabled_doc_types: string[] | null; edi_poll_enabled?: boolean; edi_last_polled_at: string | null;
};
type MsgDetail = Message & { group_control_number?: string | null; transport_detail?: string | null; last_error?: string | null; raw_content?: string | null; parsed_content?: unknown; next_attempt_at?: string | null; acked_at?: string | null; updated_at?: string | null };

export default function InternalEDI() {
  const [tab, setTab] = useState<"partners" | "connections" | "messages">("partners");
  const [partners, setPartners] = useState<Partner[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [vendId, setVendId] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [transport, setTransport] = useState("");
  const [dir, setDir] = useState("");
  const [txn, setTxn] = useState("");

  // Connection editor + message detail modal state.
  const [editProvider, setEditProvider] = useState<Provider | null>(null);
  const [detail, setDetail] = useState<MsgDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  async function loadPartners() {
    const r = await fetch("/api/internal/edi-partners").then((x) => x.json()).catch(() => ({}));
    setPartners(Array.isArray(r.partners) ? r.partners : []);
  }
  async function loadProviders() {
    const r = await fetch("/api/internal/tpl-providers").then((x) => x.json()).catch(() => ({}));
    setProviders(Array.isArray(r.providers) ? r.providers : []);
  }
  async function loadMessages() {
    const p = new URLSearchParams();
    if (dir) p.set("direction", dir);
    if (txn) p.set("transaction_set", txn);
    const r = await fetch(`/api/internal/edi-messages?${p.toString()}`).then((x) => x.json()).catch(() => ({}));
    setMessages(Array.isArray(r.messages) ? r.messages : []);
  }
  useEffect(() => { (async () => { setLoading(true); await Promise.all([loadPartners(), loadProviders(), loadMessages()]); setLoading(false); })(); }, []);
  useEffect(() => { void loadMessages(); /* eslint-disable-next-line */ }, [dir, txn]);
  useEffect(() => { fetch("/api/internal/vendor-master?limit=1000").then((r) => r.json()).then((a) => { if (Array.isArray(a)) setVendors(a as Vendor[]); }).catch(() => {}); }, []);

  const vendName = useMemo(() => new Map(vendors.map((v) => [v.id, v.name])), [vendors]);

  const { sorted: sortedPartners, sortKey: pk, sortDir: pd, onHeaderClick: onPSort } = useSort(partners, {
    persistKey: "tangerine:edi-partners:sort",
    accessors: { vendor: (p) => p.vendor_name || vendName.get(p.vendor_id) || "", partner_id: (p) => p.partner_id, transport: (p) => p.transport || "", status: (p) => p.status, last_sync: (p) => p.last_sync_at || "" },
  });
  const { sorted: sortedMessages, sortKey: mk, sortDir: md, onHeaderClick: onMSort } = useSort(messages, {
    persistKey: "tangerine:edi-messages:sort",
    accessors: {
      when: (m) => m.created_at, party: (m) => m.tpl_provider_name || m.vendor_name || vendName.get(m.vendor_id) || "",
      direction: (m) => m.direction, document: (m) => TXN_LABEL[m.transaction_set] || m.transaction_set,
      interchange: (m) => m.interchange_id || "", status: (m) => m.status, ack: (m) => m.ack_status || "",
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

  async function openDetail(id: string) {
    setDetailBusy(true);
    try {
      const r = await fetch(`/api/internal/edi-messages/${id}`).then((x) => x.json());
      if (r.message) setDetail(r.message as MsgDetail);
      else notify("Could not load message", "error");
    } catch { notify("Could not load message", "error"); }
    finally { setDetailBusy(false); }
  }
  async function retryMessage(id: string) {
    if (!(await confirmDialog("Re-queue this message for the next transport pass?", { confirmText: "Re-queue" }))) return;
    try {
      const r = await fetch(`/api/internal/edi-messages/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry" }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      notify(j.message || "Re-queued", "success");
      setDetail(null); await loadMessages();
    } catch (e) { notify("Retry failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
  }

  const pCols: ExportColumn<{ vendor: string; partner_id: string; transport: string; status: string; last_sync: string }>[] =
    [{ key: "vendor", header: "Vendor" }, { key: "partner_id", header: "Partner ID" }, { key: "transport", header: "Transport" }, { key: "status", header: "Status" }, { key: "last_sync", header: "Last sync" }];
  const pRows = partners.map((p) => ({ vendor: p.vendor_name || vendName.get(p.vendor_id) || "", partner_id: p.partner_id, transport: p.transport || "", status: p.status, last_sync: p.last_sync_at || "" }));

  const mCols: ExportColumn<Record<string, string>>[] = [
    { key: "when", header: "When" }, { key: "party", header: "Partner" }, { key: "direction", header: "Direction" },
    { key: "document", header: "Document" }, { key: "interchange", header: "Interchange" }, { key: "status", header: "Status" }, { key: "ack", header: "Ack" },
  ];
  const mRows = messages.map((m) => ({
    when: fmtDT(m.created_at), party: m.tpl_provider_name || m.vendor_name || vendName.get(m.vendor_id) || "",
    direction: m.direction, document: TXN_LABEL[m.transaction_set] || m.transaction_set, interchange: m.interchange_id || "",
    status: m.status, ack: m.ack_status || "",
  }));

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>EDI</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>X12 trading-partner exchange — vendors + 3PL warehouse</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button style={tabBtn(tab === "partners")} onClick={() => setTab("partners")}>Partners ({partners.length})</button>
          <button style={tabBtn(tab === "connections")} onClick={() => setTab("connections")}>3PL Connections ({providers.length})</button>
          <button style={tabBtn(tab === "messages")} onClick={() => setTab("messages")}>Messages ({messages.length})</button>
        </div>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : tab === "partners" ? (
        <PartnersTab {...{ partners, sortedPartners, pk, pd, onPSort, vendName, vendors, enabling, setEnabling, vendId, setVendId, partnerId, setPartnerId, transport, setTransport, busy, enable, pRows, pCols }} />
      ) : tab === "connections" ? (
        <ConnectionsTab providers={providers} onEdit={setEditProvider} />
      ) : (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
            <ExportButton rows={mRows} columns={mCols} filename="edi-messages" />
            <SearchableSelect value={dir || null} onChange={(v) => setDir(v)} options={[{ value: "", label: "All directions" }, { value: "inbound", label: "Inbound" }, { value: "outbound", label: "Outbound" }]} inputStyle={input} />
            <SearchableSelect value={txn || null} onChange={(v) => setTxn(v)} options={[{ value: "", label: "All documents" }, ...Object.entries(TXN_LABEL).map(([k, v]) => ({ value: k, label: v }))]} inputStyle={input} />
            <span style={{ color: C.textMuted, fontSize: 12, marginLeft: "auto" }}>{messages.length} message{messages.length === 1 ? "" : "s"} · click a row for detail</span>
          </div>
          <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <SortableTh label="When" sortKey="when" activeKey={mk} dir={md} onSort={onMSort} style={th} />
              <SortableTh label="Partner" sortKey="party" activeKey={mk} dir={md} onSort={onMSort} style={th} />
              <SortableTh label="Dir" sortKey="direction" activeKey={mk} dir={md} onSort={onMSort} style={th} />
              <SortableTh label="Document" sortKey="document" activeKey={mk} dir={md} onSort={onMSort} style={th} />
              <SortableTh label="Interchange" sortKey="interchange" activeKey={mk} dir={md} onSort={onMSort} style={th} />
              <SortableTh label="Status" sortKey="status" activeKey={mk} dir={md} onSort={onMSort} style={th} />
              <SortableTh label="997 Ack" sortKey="ack" activeKey={mk} dir={md} onSort={onMSort} style={th} />
            </tr></thead>
            <tbody>
              {messages.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={7}>No EDI messages yet — they appear here once partners exchange X12.</td></tr>}
              {sortedMessages.map((m) => (
                <tr key={m.id} onClick={() => openDetail(m.id)} style={{ cursor: "pointer" }}>
                  <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>{fmtDT(m.created_at)}</td>
                  <td style={{ ...td, ...linkCell }}>{m.tpl_provider_name || m.vendor_name || vendName.get(m.vendor_id) || "—"}</td>
                  <td style={td}>{m.direction === "inbound" ? "in" : "out"}</td>
                  <td style={td}>{TXN_LABEL[m.transaction_set] || m.transaction_set}</td>
                  <td style={{ ...td, fontFamily: "monospace", color: C.textMuted, fontSize: 12 }}>{m.interchange_id || "—"}</td>
                  <td style={td}><span style={chip(STAT_COLOR[m.status] || C.textMuted)}>{m.status}</span>{(m.attempts || 0) > 1 ? <span style={{ color: C.textMuted, fontSize: 11 }}> ·{m.attempts}×</span> : ""}</td>
                  <td style={td}>{m.ack_status ? <span style={chip(m.ack_status === "accepted" ? C.success : m.ack_status === "rejected" ? C.danger : C.warn)}>{m.ack_status}</span> : <span style={{ color: C.textMuted }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {editProvider && <ConnectionModal provider={editProvider} onClose={() => setEditProvider(null)} onSaved={async () => { setEditProvider(null); await loadProviders(); }} />}
      {(detail || detailBusy) && <MessageDetailModal detail={detail} busy={detailBusy} onClose={() => setDetail(null)} onRetry={retryMessage} />}
    </div>
  );
}

// ── Partners tab (unchanged behaviour, extracted for readability) ─────────────
function PartnersTab(p: any) {
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <ExportButton rows={p.pRows} columns={p.pCols} filename="edi-partners" />
        <button style={btnP} onClick={() => p.setEnabling((v: boolean) => !v)}>{p.enabling ? "Cancel" : "+ Enable EDI for vendor"}</button>
      </div>
      {p.enabling && (
        <div style={{ background: C.card, border: `1px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ minWidth: 220 }}><SearchableSelect options={p.vendors.map((v: Vendor) => ({ value: v.id, label: v.name, searchHaystack: `${v.name} ${v.code || ""}` }))} value={p.vendId} onChange={p.setVendId} placeholder="Vendor…" /></div>
          <input style={{ ...input, minWidth: 180 }} placeholder="Partner / ISA sender ID *" value={p.partnerId} onChange={(e) => p.setPartnerId(e.target.value)} />
          <SearchableSelect value={p.transport || null} onChange={(v: string) => p.setTransport(v)} options={[{ value: "", label: "Transport…" }, { value: "as2", label: "AS2" }, { value: "sftp", label: "SFTP" }, { value: "van", label: "VAN" }]} inputStyle={input} />
          <button style={btnP} disabled={p.busy} onClick={p.enable}>Enable</button>
          <span style={{ color: C.textMuted, fontSize: 12 }}>The engine resolves inbound X12 by matching GS02 to this partner ID.</span>
        </div>
      )}
      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <SortableTh label="Vendor" sortKey="vendor" activeKey={p.pk} dir={p.pd} onSort={p.onPSort} style={th} />
          <SortableTh label="Partner ID" sortKey="partner_id" activeKey={p.pk} dir={p.pd} onSort={p.onPSort} style={th} />
          <SortableTh label="Transport" sortKey="transport" activeKey={p.pk} dir={p.pd} onSort={p.onPSort} style={th} />
          <SortableTh label="Status" sortKey="status" activeKey={p.pk} dir={p.pd} onSort={p.onPSort} style={th} />
          <SortableTh label="Last sync" sortKey="last_sync" activeKey={p.pk} dir={p.pd} onSort={p.onPSort} style={th} />
        </tr></thead>
        <tbody>
          {p.partners.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={5}>No EDI partners configured yet.</td></tr>}
          {p.sortedPartners.map((row: Partner) => (
            <tr key={row.id}>
              <td style={td}>{row.vendor_name || p.vendName.get(row.vendor_id) || "—"}{row.vendor_code ? ` (${row.vendor_code})` : ""}</td>
              <td style={{ ...td, fontFamily: "monospace" }}>{row.partner_id}</td>
              <td style={td}>{row.transport || "—"}</td>
              <td style={td}><span style={chip(row.status === "active" ? C.success : C.textMuted)}>{row.status}</span></td>
              <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>{row.last_sync_at ? fmtDT(row.last_sync_at) : "—"}{row.last_sync_error ? ` · ${row.last_sync_error}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

// ── 3PL Connections tab ───────────────────────────────────────────────────────
function ConnectionsTab({ providers, onEdit }: { providers: Provider[]; onEdit: (p: Provider) => void }) {
  const cols: ExportColumn<Record<string, string>>[] = [
    { key: "name", header: "3PL" }, { key: "protocol", header: "Transport" }, { key: "host", header: "Host" },
    { key: "docs", header: "Docs" }, { key: "poll", header: "Poll" }, { key: "secret", header: "Secret" }, { key: "polled", header: "Last poll" },
  ];
  const rows = providers.map((p) => ({
    name: p.name, protocol: p.edi_protocol || "", host: p.edi_endpoint || "", docs: (p.enabled_doc_types || []).join(" "),
    poll: p.edi_poll_enabled ? "on" : "off", secret: p.edi_secret_set ? "set" : "—", polled: p.edi_last_polled_at || "",
  }));
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <ExportButton rows={rows} columns={cols} filename="edi-3pl-connections" />
        <span style={{ color: C.textMuted, fontSize: 12, marginLeft: "auto" }}>Click a 3PL to configure its EDI connection. Create providers in the 3PL module.</span>
      </div>
      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            {["3PL", "Transport", "Host", "Enabled docs", "Poll", "Secret", "Last poll"].map((h) => <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {providers.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={7}>No 3PL providers yet — add one in the 3PL module, then configure EDI here.</td></tr>}
            {providers.map((p) => (
              <tr key={p.id} onClick={() => onEdit(p)} style={{ cursor: "pointer" }}>
                <td style={{ ...td, ...linkCell }}>{p.name}</td>
                <td style={td}>{p.edi_protocol ? <span style={chip(C.primary)}>{p.edi_protocol}</span> : <span style={{ color: C.textMuted }}>not set</span>}</td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>{p.edi_endpoint || "—"}{p.edi_port ? `:${p.edi_port}` : ""}</td>
                <td style={{ ...td, fontSize: 12 }}>{(p.enabled_doc_types || []).join(", ") || "—"}</td>
                <td style={td}>{p.edi_poll_enabled ? <span style={chip(C.success)}>on</span> : <span style={chip(C.textMuted)}>off</span>}</td>
                <td style={td}>{p.edi_secret_set ? <span style={chip(C.success)}>set</span> : <span style={chip(C.warn)}>none</span>}</td>
                <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>{fmtDT(p.edi_last_polled_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Connection editor modal ───────────────────────────────────────────────────
function ConnectionModal({ provider, onClose, onSaved }: { provider: Provider; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    edi_protocol: provider.edi_protocol || "SFTP",
    edi_endpoint: provider.edi_endpoint || "",
    edi_port: provider.edi_port ? String(provider.edi_port) : "22",
    edi_username: provider.edi_username || "",
    edi_secret: "",
    edi_outbound_dir: provider.edi_outbound_dir || "",
    edi_inbound_dir: provider.edi_inbound_dir || "",
    edi_archive_dir: provider.edi_archive_dir || "",
    partner_isa_qualifier: provider.partner_isa_qualifier || "",
    partner_isa_id: provider.partner_isa_id || "",
    partner_gs_id: provider.partner_gs_id || "",
    edi_poll_enabled: provider.edi_poll_enabled !== false,
  });
  const [docs, setDocs] = useState<string[]>(provider.enabled_doc_types || DOC_TYPES);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const set = (k: string, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        id: provider.id, ...f, edi_port: f.edi_port, enabled_doc_types: docs,
      };
      if (f.edi_secret.trim() === "") delete body.edi_secret; // don't clobber existing secret with empty
      const r = await fetch("/api/internal/tpl-providers", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      notify("Connection saved", "success");
      onSaved();
    } catch (e) { notify("Save failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setSaving(false); }
  }
  async function test() {
    setTesting(true); setTestResult(null);
    try {
      // Save first so the test uses the latest config (incl. a freshly typed secret).
      await save();
      const r = await fetch("/api/internal/tpl-providers/test-connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: provider.id }) });
      const j = await r.json();
      setTestResult({ ok: !!j.ok, detail: j.detail || j.error || "no response" });
    } catch (e) { setTestResult({ ok: false, detail: e instanceof Error ? e.message : String(e) }); }
    finally { setTesting(false); }
  }

  const field = (l: string, k: keyof typeof f, ph = "", w = 160) => (
    <div style={{ minWidth: w, flex: `1 1 ${w}px` }}>
      <label style={label}>{l}</label>
      <input style={{ ...input, width: "100%" }} value={String(f[k])} placeholder={ph} onChange={(e) => set(k, e.target.value)} />
    </div>
  );

  return (
    <Modal title={`3PL EDI connection — ${provider.name}`} onClose={onClose} footer={
      <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
        <button style={btnS} disabled={testing || saving} onClick={test}>{testing ? "Testing…" : "Test connection"}</button>
        {testResult && <span style={{ fontSize: 12, color: testResult.ok ? C.success : C.danger, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{testResult.ok ? "✓ " : "✕ "}{testResult.detail}</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button style={btnS} onClick={onClose}>Close</button>
          <button style={btnP} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    }>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div style={{ minWidth: 140, flex: "1 1 140px" }}>
          <label style={label}>Transport</label>
          <SearchableSelect value={f.edi_protocol} onChange={(v) => set("edi_protocol", v)} options={[{ value: "SFTP", label: "SFTP" }, { value: "AS2", label: "AS2 (soon)" }, { value: "VAN", label: "VAN (soon)" }]} inputStyle={input} />
        </div>
        {field("SFTP host", "edi_endpoint", "sftp.3pl.com")}
        {field("Port", "edi_port", "22", 90)}
        {field("Username", "edi_username", "ringoffire")}
        <div style={{ minWidth: 200, flex: "1 1 200px" }}>
          <label style={label}>Password / private key {provider.edi_secret_set ? "(configured — leave blank to keep)" : ""}</label>
          <input type="password" autoComplete="new-password" style={{ ...input, width: "100%" }} value={f.edi_secret} placeholder={provider.edi_secret_set ? "••••••••" : "SFTP password or PEM key"} onChange={(e) => set("edi_secret", e.target.value)} />
        </div>
        {field("Outbound dir (we upload 940s)", "edi_outbound_dir", "/inbound", 200)}
        {field("Inbound dir (partner drops files)", "edi_inbound_dir", "/outbound", 200)}
        {field("Archive dir (processed)", "edi_archive_dir", "/archive", 200)}
        {field("Their ISA qualifier", "partner_isa_qualifier", "ZZ", 130)}
        {field("Their ISA ID", "partner_isa_id", "3PLWAREHOUSE", 160)}
        {field("Their GS ID", "partner_gs_id", "3PLWH", 130)}
        <div style={{ flexBasis: "100%" }}>
          <label style={label}>Enabled documents</label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {DOC_TYPES.map((d) => (
              <label key={d} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.textSub, cursor: "pointer" }}>
                <input type="checkbox" checked={docs.includes(d)} onChange={(e) => setDocs((s) => e.target.checked ? [...new Set([...s, d])] : s.filter((x) => x !== d))} />
                {TXN_LABEL[d] || d}
              </label>
            ))}
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.textSub, cursor: "pointer", flexBasis: "100%" }}>
          <input type="checkbox" checked={f.edi_poll_enabled} onChange={(e) => set("edi_poll_enabled", e.target.checked)} />
          Poll this 3PL's inbound directory on the transport cron (every 15 min)
        </label>
      </div>
    </Modal>
  );
}

// ── Message detail modal ──────────────────────────────────────────────────────
function MessageDetailModal({ detail, busy, onClose, onRetry }: { detail: MsgDetail | null; busy: boolean; onClose: () => void; onRetry: (id: string) => void }) {
  if (busy && !detail) return <Modal title="EDI message" onClose={onClose}><div style={{ color: C.textMuted }}>Loading…</div></Modal>;
  if (!detail) return null;
  const canRetry = detail.direction === "outbound" && ["failed", "queued", "generated"].includes(detail.status);
  const row = (k: string, v: React.ReactNode) => (
    <div style={{ display: "flex", gap: 10, padding: "4px 0", fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>
      <div style={{ color: C.textMuted, width: 150, flexShrink: 0 }}>{k}</div>
      <div style={{ color: C.text, wordBreak: "break-word" }}>{v}</div>
    </div>
  );
  const parsedStr = detail.parsed_content ? JSON.stringify(detail.parsed_content, null, 2) : null;
  return (
    <Modal title={`${TXN_LABEL[detail.transaction_set] || detail.transaction_set} — ${detail.direction}`} onClose={onClose} footer={
      <div style={{ display: "flex", gap: 8, width: "100%" }}>
        {canRetry && <button style={btnP} onClick={() => onRetry(detail.id)}>Re-queue / retry</button>}
        <button style={{ ...btnS, marginLeft: "auto" }} onClick={onClose}>Close</button>
      </div>
    }>
      <div style={{ marginBottom: 12 }}>
        {row("Partner", detail.tpl_provider_name || detail.vendor_name || "—")}
        {row("Status", <span style={chip(STAT_COLOR[detail.status] || C.textMuted)}>{detail.status}</span>)}
        {row("Interchange #", <span style={{ fontFamily: "monospace" }}>{detail.interchange_id || "—"}</span>)}
        {detail.group_control_number ? row("Group control #", <span style={{ fontFamily: "monospace" }}>{detail.group_control_number}</span>) : null}
        {row("Attempts", String(detail.attempts ?? 0))}
        {detail.ack_status ? row("997 ack", <span style={chip(detail.ack_status === "accepted" ? C.success : detail.ack_status === "rejected" ? C.danger : C.warn)}>{detail.ack_status}</span>) : null}
        {detail.file_name ? row("File", detail.file_name) : null}
        {detail.transport_detail ? row("Transport", detail.transport_detail) : null}
        {detail.next_attempt_at ? row("Next attempt", fmtDT(detail.next_attempt_at)) : null}
        {(detail.last_error || detail.error_message) ? row("Error", <span style={{ color: C.danger }}>{detail.last_error || detail.error_message}</span>) : null}
        {row("Created", fmtDT(detail.created_at))}
      </div>
      {parsedStr && (
        <div style={{ marginBottom: 12 }}>
          <label style={label}>Parsed</label>
          <pre style={{ background: C.panel, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, fontSize: 11, color: C.textSub, overflow: "auto", maxHeight: 200, margin: 0 }}>{parsedStr}</pre>
        </div>
      )}
      <div>
        <label style={label}>Raw X12</label>
        <pre style={{ background: C.panel, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, fontSize: 11, color: C.textSub, overflow: "auto", maxHeight: 240, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{detail.raw_content || "—"}</pre>
      </div>
    </Modal>
  );
}

// ── Shared responsive modal ───────────────────────────────────────────────────
function Modal({ title, children, footer, onClose }: { title: string; children: React.ReactNode; footer?: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(720px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.cardBdr}`, display: "flex", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 15, color: C.text }}>{title}</h3>
          <button onClick={onClose} style={{ marginLeft: "auto", background: "transparent", border: 0, color: C.textMuted, fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: 16, overflow: "auto", flex: 1 }}>{children}</div>
        {footer && <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.cardBdr}`, display: "flex", background: C.card }}>{footer}</div>}
      </div>
    </div>
  );
}
