import { useEffect, useState } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

interface LogEntry {
  id: string;
  endpoint: string;
  method: string;
  status_code: number | null;
  created_at: string;
  duration_ms: number | null;
  error_message: string | null;
}

const SCOPES = [
  "pos:read", "invoices:read", "invoices:write",
  "shipments:write", "catalog:read", "catalog:write",
];

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

function formatLocal(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function VendorApiKeys() {
  const [role, setRole] = useState<string>("primary");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [justCreated, setJustCreated] = useState<{ key: string; name: string } | null>(null);
  const [logsFor, setLogsFor] = useState<ApiKey | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const { data: { user } } = await supabaseVendor.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const { data: vu } = await supabaseVendor.from("vendor_users").select("role").eq("auth_id", user.id).maybeSingle();
      const r = (vu as { role?: string } | null)?.role || "primary";
      setRole(r);
      const t = await token();
      const res = await fetch("/api/vendor/api-keys", { headers: { Authorization: `Bearer ${t}` } });
      if (!res.ok) throw new Error(await res.text());
      setKeys(await res.json() as ApiKey[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function revoke(id: string) {
    if (!confirm("Revoke this key? Existing integrations using it will stop working.")) return;
    const t = await token();
    const r = await fetch(`/api/vendor/api-keys/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  if (loading) return <div style={{ color: TH.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  if (role !== "primary" && role !== "admin") {
    return (
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: 20, color: TH.textSub2 }}>
        API keys are managed by the vendor admin. Please contact your primary user.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#FFFFFF", fontSize: 20 }}>API keys</h2>
        <button onClick={() => setCreate(true)} style={btnPrimary}>+ Create key</button>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 160px 1.5fr 160px 140px 140px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
          <div>Name</div>
          <div>Prefix</div>
          <div>Scopes</div>
          <div>Last used</div>
          <div>Expires</div>
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {keys.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No API keys yet.</div>
        ) : keys.map((k) => (
          <div key={k.id} style={{ display: "grid", gridTemplateColumns: "1.3fr 160px 1.5fr 160px 140px 140px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
            <div style={{ color: TH.text, fontWeight: 600 }}>{k.name}</div>
            <div style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: TH.textSub2 }}>{k.key_prefix}…</div>
            <div style={{ color: TH.textSub2, fontSize: 12 }}>{k.scopes.join(", ")}</div>
            <div style={{ color: TH.textSub2 }}>{formatLocal(k.last_used_at)}</div>
            <div style={{ color: TH.textSub2 }}>{k.expires_at ? formatLocal(k.expires_at) : "Never"}</div>
            <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={() => setLogsFor(k)} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>Logs</button>
              <button onClick={() => void revoke(k.id)} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12, color: TH.primary }}>Revoke</button>
            </div>
          </div>
        ))}
      </div>

      {create && (
        <CreateKeyModal onClose={() => setCreate(false)} onCreated={(k) => { setCreate(false); setJustCreated(k); void load(); }} />
      )}
      {justCreated && (
        <OneTimeKeyModal name={justCreated.name} value={justCreated.key} onClose={() => setJustCreated(null)} />
      )}
      {logsFor && (
        <LogsModal keyRow={logsFor} onClose={() => setLogsFor(null)} />
      )}
    </div>
  );
}

function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (k: { key: string; name: string }) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiry, setExpiry] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!name.trim() || scopes.length === 0) { alert("Name and at least one scope are required."); return; }
    setSubmitting(true);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ name: name.trim(), scopes, expires_at: expiry ? new Date(expiry).toISOString() : undefined }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      onCreated({ key: data.key, name: data.name });
    } catch (e: unknown) {
      alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalBox, width: 520 }}>
        <h3 style={{ margin: "0 0 14px", color: TH.text, fontSize: 16 }}>Create API key</h3>
        <Row label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My ERP integration" style={inp} />
        </Row>
        <Row label="Scopes">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 13 }}>
            {SCOPES.map((s) => (
              <label key={s} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => {
                  setScopes((prev) => e.target.checked ? [...prev, s] : prev.filter((x) => x !== s));
                }} />
                <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{s}</span>
              </label>
            ))}
          </div>
        </Row>
        <Row label="Expires (optional)">
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} style={inp} />
        </Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void submit()} disabled={submitting} style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }}>{submitting ? "Creating…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function OneTimeKeyModal({ name, value, onClose }: { name: string; value: string; onClose: () => void }) {
  return (
    <div style={overlay}>
      <div style={{ ...modalBox, width: 560 }}>
        <h3 style={{ margin: "0 0 10px", color: TH.text, fontSize: 16 }}>Key '{name}' created</h3>
        <div style={{ padding: "10px 12px", background: "#FFFAF0", border: "1px solid #FED7AA", borderRadius: 6, color: "#C05621", fontSize: 13, marginBottom: 12 }}>
          <b>Save this key now.</b> It will not be shown again. If you lose it, revoke it and create a new one.
        </div>
        <div style={{ padding: "10px 12px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12, wordBreak: "break-all", marginBottom: 12 }}>
          {value}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={() => { void navigator.clipboard.writeText(value); alert("Copied"); }} style={btnSecondary}>Copy</button>
          <button onClick={onClose} style={btnPrimary}>I've saved it</button>
        </div>
      </div>
    </div>
  );
}

function LogsModal({ keyRow, onClose }: { keyRow: ApiKey; onClose: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const t = await token();
        const r = await fetch(`/api/vendor/api-keys/${keyRow.id}/logs`, { headers: { Authorization: `Bearer ${t}` } });
        if (r.ok) setLogs(await r.json() as LogEntry[]);
      } finally { setLoading(false); }
    })();
  }, [keyRow.id]);

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalBox, width: 720 }}>
        <h3 style={{ margin: "0 0 14px", color: TH.text, fontSize: 16 }}>Logs — {keyRow.name}</h3>
        {loading ? <div style={{ color: TH.textMuted }}>Loading…</div> : logs.length === 0 ? (
          <div style={{ color: TH.textMuted, fontSize: 13 }}>No log entries yet.</div>
        ) : (
          <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {logs.map((l) => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "80px 1.5fr 80px 90px 140px", gap: 10, padding: "8px 0", borderBottom: `1px solid ${TH.border}`, fontSize: 12, alignItems: "center" }}>
                <div style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: TH.textSub2 }}>{l.method}</div>
                <div style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: TH.textSub2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.endpoint}</div>
                <div style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: l.status_code && l.status_code >= 400 ? TH.primary : TH.textSub2 }}>{l.status_code ?? "—"}</div>
                <div style={{ color: TH.textSub2 }}>{l.duration_ms != null ? `${l.duration_ms}ms` : "—"}</div>
                <div style={{ color: TH.textMuted }}>{formatLocal(l.created_at)}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
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
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modalBox = { background: TH.surface, borderRadius: 10, padding: 22, maxWidth: "92vw", boxShadow: "0 10px 40px rgba(0,0,0,0.3)", maxHeight: "90vh", overflowY: "auto" as const };
