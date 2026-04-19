import { useEffect, useState } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import StatusBadge from "./StatusBadge";

interface Integration {
  id: string;
  type: string;
  status: "active" | "paused" | "error";
  config: { partner_id: string | null; has_api_token: boolean; has_webhook_url: boolean };
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SyncLog {
  id: string;
  direction: "inbound" | "outbound";
  entity_type: string;
  status: "success" | "error" | "skipped";
  error_message: string | null;
  created_at: string;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

function statusTone(s: string) {
  if (s === "active" || s === "success") return "ok" as const;
  if (s === "error") return "danger" as const;
  if (s === "paused" || s === "skipped") return "muted" as const;
  return "info" as const;
}

const TYPE_LABELS: Record<string, string> = {
  sap: "SAP", oracle: "Oracle", netsuite: "NetSuite",
  quickbooks: "QuickBooks", sage: "Sage", custom: "Custom",
};

export default function VendorErp() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/erp", { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      const list = (await r.json()) as Integration[];
      setIntegrations(list);
      const ids = list.map((i) => i.id);
      if (ids.length > 0) {
        const { data } = await supabaseVendor
          .from("erp_sync_logs")
          .select("id, direction, entity_type, status, error_message, created_at")
          .in("integration_id", ids)
          .order("created_at", { ascending: false })
          .limit(20);
        setLogs((data || []) as SyncLog[]);
      } else {
        setLogs([]);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function disconnect(id: string) {
    if (!confirm("Pause this integration? Inbound EDI will stop being mapped until you reactivate.")) return;
    const t = await token();
    const r = await fetch(`/api/vendor/erp?id=${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  async function manualSync(id: string) {
    // No real sync worker today — this is a placeholder that writes a
    // skipped log entry so the action is auditable. A real sync would
    // call an outbound sync endpoint scoped to the integration.
    const t = await token();
    try {
      const r = await fetch(`/api/internal/edi/${integrations.find((x) => x.id === id)?.id || ""}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error("Manual sync isn't wired up for vendor callers — contact your account team.");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) return <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  const primary = integrations[0] || null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ color: "#FFFFFF", fontSize: 20, margin: 0 }}>ERP integration</h2>
        {!primary && (
          <button onClick={() => setEditOpen(true)} style={btnPrimary}>+ Connect ERP</button>
        )}
      </div>

      {primary ? (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "18px 20px", marginBottom: 20, boxShadow: `0 1px 2px ${TH.shadow}` }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 180px", gap: 16, alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.05 }}>System</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: TH.text, marginTop: 2 }}>{TYPE_LABELS[primary.type] || primary.type}</div>
              <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>Partner ID: <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{primary.config.partner_id || "—"}</span></div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.05 }}>Status</div>
              <div style={{ marginTop: 4 }}>
                <StatusBadge label={primary.status[0].toUpperCase() + primary.status.slice(1)} tone={statusTone(primary.status)} />
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.05 }}>Last sync</div>
              <div style={{ fontSize: 13, color: TH.textSub2, marginTop: 4 }}>{primary.last_sync_at ? new Date(primary.last_sync_at).toLocaleString() : "Never"}</div>
              {primary.last_sync_status && <div style={{ fontSize: 11, color: primary.last_sync_status === "error" ? TH.primary : TH.textMuted, marginTop: 2 }}>{primary.last_sync_status}</div>}
            </div>
            <div>
              <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.05 }}>Secrets</div>
              <div style={{ fontSize: 12, color: TH.textSub2, marginTop: 4 }}>
                {primary.config.has_api_token ? "✓ API token" : "— no token"}<br />
                {primary.config.has_webhook_url ? "✓ Webhook URL" : "— no webhook"}
              </div>
            </div>
            <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={() => setEditOpen(true)} style={btnSecondary}>Edit</button>
              <button onClick={() => void manualSync(primary.id)} style={btnSecondary} disabled={connecting}>Sync now</button>
              <button onClick={() => void disconnect(primary.id)} style={{ ...btnSecondary, color: TH.primary }}>Disconnect</button>
            </div>
          </div>
          {primary.last_sync_error && (
            <div style={{ marginTop: 14, padding: "8px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, color: TH.primary, fontSize: 12 }}>
              <b>Last error:</b> {primary.last_sync_error}
            </div>
          )}
        </div>
      ) : (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "30px 22px", textAlign: "center", marginBottom: 20, color: TH.textMuted }}>
          No ERP connected yet. Click <b>Connect ERP</b> to wire up an inbound EDI integration or an API-based sync.
        </div>
      )}

      <h3 style={{ color: "rgba(255,255,255,0.9)", fontSize: 14, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 0.3 }}>Recent sync log</h3>
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "100px 130px 130px 180px 1fr", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
          <div>Dir</div>
          <div>Entity</div>
          <div>Status</div>
          <div>When</div>
          <div>Error</div>
        </div>
        {logs.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No sync activity yet.</div>
        ) : logs.map((l) => (
          <div key={l.id} style={{ display: "grid", gridTemplateColumns: "100px 130px 130px 180px 1fr", padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 12, alignItems: "center" }}>
            <div style={{ color: l.direction === "inbound" ? "#2B6CB0" : "#C05621", fontWeight: 600, textTransform: "uppercase", fontSize: 11 }}>
              {l.direction === "inbound" ? "← IN" : "OUT →"}
            </div>
            <div style={{ color: TH.textSub2, textTransform: "capitalize" }}>{l.entity_type}</div>
            <div><StatusBadge label={l.status[0].toUpperCase() + l.status.slice(1)} tone={statusTone(l.status)} /></div>
            <div style={{ color: TH.textMuted }}>{new Date(l.created_at).toLocaleString()}</div>
            <div style={{ color: TH.primary, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.error_message || ""}</div>
          </div>
        ))}
      </div>

      {editOpen && (
        <ErpEditModal
          existing={primary}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); void load(); }}
        />
      )}
    </div>
  );
}

function ErpEditModal({ existing, onClose, onSaved }: { existing: Integration | null; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState(existing?.type || "custom");
  const [partnerId, setPartnerId] = useState(existing?.config.partner_id || "");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!partnerId.trim()) { alert("Partner ID is required."); return; }
    setSaving(true);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/erp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          id: existing?.id,
          type,
          partner_id: partnerId.trim(),
          webhook_url: webhookUrl.trim() || undefined,
          api_token: apiToken.trim() || undefined,
          active: true,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: TH.surface, borderRadius: 10, padding: 22, width: 520, maxWidth: "92vw", boxShadow: "0 10px 40px rgba(0,0,0,0.3)" }}>
        <h3 style={{ margin: "0 0 14px", color: TH.text, fontSize: 16 }}>{existing ? "Update ERP connection" : "Connect ERP"}</h3>
        <Field label="System">
          <select value={type} onChange={(e) => setType(e.target.value)} style={inp}>
            {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Partner / EDI ID (GS02)"><input value={partnerId} onChange={(e) => setPartnerId(e.target.value)} placeholder="e.g. ACME01" style={inp} /></Field>
        <Field label="Webhook URL (optional)"><input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://your-erp.example.com/webhook" style={inp} /></Field>
        <Field label="API token (optional)"><input value={apiToken} onChange={(e) => setApiToken(e.target.value)} placeholder="keep blank to reuse existing" type="password" style={inp} /></Field>
        <div style={{ fontSize: 11, color: TH.textMuted, marginBottom: 12 }}>
          Webhook URL and API token are AES-256-GCM encrypted before storage. Leave blank on edit to keep the existing value.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void submit()} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 16px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
