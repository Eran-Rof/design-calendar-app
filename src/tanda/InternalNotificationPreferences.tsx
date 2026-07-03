// src/tanda/InternalNotificationPreferences.tsx
//
// Tangerine P2 Chunk 4 - per-user notification preferences.
// Matrix of (kind × channel) with enabled toggles. PUT upserts one row at
// a time; missing rows default to enabled=true (opt-in by default).

import { useEffect, useMemo, useState } from "react";
import { getCachedAuthUserId, setCachedAuthUserId } from "../utils/tangerineAuthUser";
import SearchableSelect from "./components/SearchableSelect";
import { useEmployeeOptions } from "./hooks/useEmployeeOptions";

type Pref = {
  user_id: string;
  kind: string;
  channel: "in_app" | "email";
  enabled: boolean;
  updated_at: string;
};

// Known notification kinds (extend as downstream callers add new events).
const KNOWN_KINDS = [
  "je_posted", "je_reversed", "period_closed", "period_reopened",
  "approval_requested", "approval_approved", "approval_rejected",
  "ap_invoice_received", "ar_invoice_sent",
];

const CHANNELS: Array<"in_app" | "email"> = ["in_app", "email"];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981",
};

const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

// Storage moved to src/utils/tangerineAuthUser.ts so this panel reads from the
// MS-OAuth-bridge cache (tangerine.auth_user_id) with the legacy key
// (tangerine.notifications.user_id) as a back-compat fallback.

export default function InternalNotificationPreferences() {
  const [user, setUser] = useState<string>(() => getCachedAuthUserId());
  const [prefs, setPrefs] = useState<Pref[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Resolve cached auth user id → name (no raw uuid). Optional employee picker
  // to switch whose preferences you edit — never a uuid box.
  const [switching, setSwitching] = useState(false);
  const { employees, options: employeeOptions } = useEmployeeOptions();
  const userLabel = useMemo(() => {
    const me = employees.find((e) => e.id === user);
    if (me) {
      const name = [me.first_name, me.last_name].filter(Boolean).join(" ").trim();
      return (me.code && name) ? `${me.code} — ${name}` : (name || me.email || "Signed-in user");
    }
    return user ? "Signed-in user" : "Not signed in";
  }, [employees, user]);

  async function load() {
    if (!user || !/^[0-9a-f-]{36}$/i.test(user)) { setPrefs([]); return; }
    setErr(null);
    try {
      const r = await fetch(`/api/internal/notification-preferences?user_id=${user}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setPrefs(await r.json());
    } catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { void load(); }, [user]);

  function saveUser(u: string) {
    const trimmed = u.trim();
    setUser(trimmed);
    setCachedAuthUserId(trimmed);
  }

  const prefMap = useMemo(() => {
    const m = new Map<string, Pref>();
    for (const p of prefs) m.set(`${p.kind}|${p.channel}`, p);
    return m;
  }, [prefs]);

  async function toggle(kind: string, channel: "in_app" | "email") {
    if (!user || !/^[0-9a-f-]{36}$/i.test(user)) { setErr("Sign in (or switch user) first"); return; }
    const existing = prefMap.get(`${kind}|${channel}`);
    const nextEnabled = existing ? !existing.enabled : false; // missing row = opt-in; first click opts OUT
    const r = await fetch(`/api/internal/notification-preferences`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: user, kind, channel, enabled: nextEnabled }),
    });
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return; }
    void load();
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Notification preferences</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Defaults are opt-in. Click a toggle to suppress that (kind, channel) pair for your account.
        </span>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
        {!switching ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: C.text, fontSize: 13 }}>Signed in as <strong>{userLabel}</strong></span>
            <button
              type="button"
              style={{ background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
              onClick={() => setSwitching(true)}
            >
              Switch user
            </button>
          </div>
        ) : (
          <div style={{ width: 360, display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <SearchableSelect
                value={user || null}
                onChange={(v) => { saveUser(v || ""); }}
                options={employeeOptions}
                placeholder="Pick an employee…"
                emptyText="No matching employees"
              />
            </div>
            <button
              type="button"
              style={{ background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
              onClick={() => setSwitching(false)}
            >
              Done
            </button>
          </div>
        )}
      </div>

      {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Kind</th>
              {CHANNELS.map((c) => <th key={c} style={th}>{c.replace("_", "-")}</th>)}
            </tr>
          </thead>
          <tbody>
            {KNOWN_KINDS.map((kind) => (
              <tr key={kind}>
                <td style={{ ...td, fontFamily: "monospace" }}>{kind}</td>
                {CHANNELS.map((channel) => {
                  const existing = prefMap.get(`${kind}|${channel}`);
                  const enabled = existing ? existing.enabled : true;
                  return (
                    <td key={channel} style={td}>
                      <button
                        onClick={() => void toggle(kind, channel)}
                        style={{
                          background: "transparent",
                          border: `1px solid ${enabled ? C.success : C.cardBdr}`,
                          color: enabled ? C.success : C.textMuted,
                          padding: "4px 10px", borderRadius: 4,
                          cursor: "pointer", fontSize: 12,
                        }}
                        title={existing ? `Set ${existing.updated_at}` : "Default (opt-in)"}
                      >
                        {enabled ? "On" : "Off"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
