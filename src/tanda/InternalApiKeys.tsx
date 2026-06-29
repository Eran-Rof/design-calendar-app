// src/tanda/InternalApiKeys.tsx
//
// Tangerine M15 — External / Partner API key admin panel (Admin group).
//
// Manages the keys that authenticate the READ-ONLY external REST API
// (/api/external/v1/*). Wraps /api/internal/api-keys and
// /api/internal/api-keys/:id.
//
//   • List   — label, key_prefix, scopes, last used, active. NEVER the secret.
//   • Create — generates a key; the FULL plaintext is shown EXACTLY ONCE in a
//              modal with a copy button + a clear "won't be shown again"
//              warning. Only the sha-256 hash + prefix are stored server-side.
//   • Revoke — sets is_active=false (soft; the secret was never stored, so a
//              revoked key can never be used again).

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

type ApiKey = {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13,
};
const modalOverlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16,
};
const modalCard: React.CSSProperties = {
  background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20,
  color: C.text, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
};

function fmtWhen(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function InternalApiKeys() {
  const [rows, setRows] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ label: string; api_key: string } | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/api-keys");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as ApiKey[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function revoke(k: ApiKey) {
    if (!(await confirmDialog(`Revoke API key "${k.label}" (${k.key_prefix}…)?\n\nAny integration using this key will immediately stop working. This cannot be undone.`))) return;
    try {
      const r = await fetch(`/api/internal/api-keys/${k.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Revoke failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>API Keys</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Create key</button>
      </div>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: C.textMuted, maxWidth: 720 }}>
        Keys authenticate the read-only external/partner API at{" "}
        <code style={{ color: C.textSub }}>/api/external/v1</code>. Send the key as{" "}
        <code style={{ color: C.textSub }}>Authorization: Bearer &lt;key&gt;</code>. Only the key prefix and a
        one-way hash are stored — the full key is shown once at creation and can never be retrieved again.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="external-api-keys"
          sheetName="API Keys"
          columns={[
            { key: "label",        header: "Label" },
            { key: "key_prefix",   header: "Prefix" },
            { key: "scopes",       header: "Scopes" },
            { key: "is_active",    header: "Active" },
            { key: "last_used_at", header: "Last used", format: "datetime" },
            { key: "created_at",   header: "Created", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No API keys yet. Create one with &quot;+ Create key&quot; to let a partner integration read your data.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Label</th>
                <th style={th}>Prefix</th>
                <th style={th}>Scopes</th>
                <th style={th}>Last used</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 110 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id} style={!k.is_active ? { opacity: 0.5 } : undefined}>
                  <td style={td}>{k.label}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{k.key_prefix}…</td>
                  <td style={{ ...td, color: C.textSub }}>{(k.scopes || []).join(", ")}</td>
                  <td style={{ ...td, color: C.textSub }}>{fmtWhen(k.last_used_at)}</td>
                  <td style={td}>{k.is_active ? "yes" : "revoked"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {k.is_active && (
                      <button onClick={() => void revoke(k)} style={btnDanger}>Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && (
        <CreateKeyModal
          onClose={() => setAddOpen(false)}
          onCreated={(created) => {
            setAddOpen(false);
            setRevealed({ label: created.label, api_key: created.api_key });
            void load();
          }}
        />
      )}
      {revealed && <RevealKeyModal label={revealed.label} apiKey={revealed.api_key} onClose={() => setRevealed(null)} />}
    </div>
  );
}

function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: { label: string; api_key: string }) => void }) {
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), scopes: ["read"] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onCreated({ label: j.label, api_key: j.api_key });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={modalOverlay}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>Create API key</h3>
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Label *
        </div>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && label.trim() && void submit()}
          placeholder="e.g. Acme 3PL integration"
          style={inputStyle}
          autoFocus
        />
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>
          Scope: <strong style={{ color: C.textSub }}>read</strong> (the external API is read-only).
        </div>
        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            {err}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !label.trim()}>
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RevealKeyModal({ label, apiKey, onClose }: { label: string; apiKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify("Could not copy automatically — select the key and copy it manually.", "error");
    }
  }

  return (
    <div onClick={onClose} style={modalOverlay}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>API key created — copy it now</h3>
        <div style={{ background: "#78350f", color: "#fed7aa", padding: "10px 12px", borderRadius: 6, fontSize: 13, marginBottom: 14, border: "1px solid #b45309" }}>
          This is the only time the full key for <strong>{label}</strong> will be shown. Store it somewhere safe.
          It cannot be retrieved again — if you lose it, revoke this key and create a new one.
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
          API key
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <code
            style={{
              flex: 1, background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
              padding: "10px 12px", borderRadius: 6, fontSize: 13, wordBreak: "break-all",
              fontFamily: "SFMono-Regular, Menlo, monospace",
            }}
          >
            {apiKey}
          </code>
          <button onClick={() => void copy()} style={{ ...btnPrimary, whiteSpace: "nowrap" }}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <div style={{ marginTop: 14, fontSize: 12, color: C.textMuted }}>
          Use it as a Bearer token:{" "}
          <code style={{ color: C.textSub }}>Authorization: Bearer {apiKey.slice(0, apiKey.indexOf(".") + 1)}…</code>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnPrimary}>Done</button>
        </div>
      </div>
    </div>
  );
}
