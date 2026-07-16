// src/tanda/InternalNotificationCenter.tsx
//
// Tangerine P2 Chunk 4 - in-app notification inbox.
// Lists this user's notification_dispatches (channel=in_app), with click-to-
// mark-as-read. user_id is captured via prompt for now; a session-aware
// version lands when the auth surface gains a stable session uuid (P2-4
// follow-up tracked in [[project-tangerine-progress]]).

import { useEffect, useMemo, useState } from "react";
import { getCachedAuthUserId, setCachedAuthUserId } from "../utils/tangerineAuthUser";
import SearchableSelect from "./components/SearchableSelect";
import { useEmployeeOptions } from "./hooks/useEmployeeOptions";
import { notificationTarget, notificationTargetUrl } from "./notificationTarget";
import { readDrillParam, consumeDrillParams } from "./scorecardDrill";

type NotificationEvent = {
  id: string;
  entity_id: string;
  kind: string;
  severity: "info" | "warn" | "error";
  subject: string;
  body: string;
  context_table: string | null;
  context_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};
type NotificationDispatch = {
  id: string;
  event_id: string;
  recipient_user_id: string;
  channel: "in_app" | "email";
  status: "pending" | "sent" | "read" | "failed";
  sent_at: string | null;
  read_at: string | null;
  error_message: string | null;
  created_at: string;
  event: NotificationEvent;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const SEV_COLOR: Record<string, string> = { info: C.textSub, warn: C.warn, error: C.danger };

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};

// Storage moved to src/utils/tangerineAuthUser.ts so this panel reads from the
// MS-OAuth-bridge cache (tangerine.auth_user_id) with the legacy key
// (tangerine.notifications.user_id) as a back-compat fallback.

export default function InternalNotificationCenter() {
  const [user, setUser] = useState<string>(() => getCachedAuthUserId());
  const [rows, setRows] = useState<NotificationDispatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Today drill (?unread=1 → "Unread notifications") opens with read items
  // hidden; the "Show read" checkbox is the visible toggle to bring them back.
  const [showRead, setShowRead] = useState(() => readDrillParam("unread") !== "1");
  // Resolve the cached auth user id to a name (no raw uuid shown). An optional
  // employee picker lets you switch whose inbox you view — never a uuid box.
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
    if (!user || !/^[0-9a-f-]{36}$/i.test(user)) {
      setErr(user ? "Invalid signed-in user" : null);
      setRows([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("user_id", user);
      params.set("channel", "in_app");
      params.set("status", showRead ? "sent,read" : "sent");
      const r = await fetch(`/api/internal/notifications?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [user, showRead]);
  useEffect(() => { consumeDrillParams(["unread"]); }, []);

  function saveUser(u: string) {
    const trimmed = u.trim();
    setUser(trimmed);
    setCachedAuthUserId(trimmed);
  }

  async function markRead(d: NotificationDispatch) {
    if (d.status === "read") return;
    const r = await fetch(`/api/internal/notifications/${d.id}/mark-read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: user }),
    });
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return; }
    void load();
  }

  // Mark read, then deep-link to the actual record the event refers to. The
  // shared notificationTarget resolver maps every known context_table (sales
  // orders, POs, AR/AP invoices, customers/vendors, GL periods, inventory, CRM,
  // RFQs, …) to its Tangerine module + drill params, falling back to opening
  // the relevant module when an exact record can't be addressed. System/run
  // events with no UI home (e.g. xoro mirror runs) just mark-read.
  async function onNotifClick(d: NotificationDispatch) {
    if (d.status === "sent") await markRead(d);
    const url = notificationTargetUrl(d.event);
    if (url) window.location.href = url;
  }

  const unreadCount = rows.filter((d) => d.status === "sent").length;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
          Notifications {unreadCount > 0 && <span style={{ color: C.warn }}>({unreadCount} unread)</span>}
        </h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Your in-app inbox. Email channel deliveries go to your mailbox separately.
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
        <label style={{ color: C.textSub, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={showRead} onChange={(e) => setShowRead(e.target.checked)} />
          Show read
        </label>
      </div>

      {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        {loading && <div style={{ padding: 16, color: C.textMuted }}>Loading…</div>}
        {!loading && rows.length === 0 && (
          <div style={{ padding: 24, color: C.textMuted, textAlign: "center" }}>
            {user ? "No notifications." : "Sign in (or switch user) to see your notifications."}
          </div>
        )}
        {rows.map((d) => {
          const unread = d.status === "sent";
          const navigable = !!notificationTarget(d.event);
          return (
            <div
              key={d.id}
              onClick={() => void onNotifClick(d)}
              style={{
                padding: "12px 16px",
                borderBottom: `1px solid ${C.cardBdr}`,
                cursor: (unread || navigable) ? "pointer" : "default",
                background: unread ? "#0b1220" : "transparent",
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
              }}
              title={unread ? "Click to mark as read" : ""}
            >
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: unread ? SEV_COLOR[d.event.severity] : "transparent", marginTop: 6, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: unread ? 600 : 400 }}>{d.event.subject}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: C.textMuted }}>{d.event.kind}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: C.textSub, whiteSpace: "pre-wrap" }}>
                  {d.event.body.slice(0, 200)}{d.event.body.length > 200 && "…"}
                </div>
                <div style={{ marginTop: 6, fontSize: 11, color: C.textMuted }}>
                  {new Date(d.event.created_at).toLocaleString()}
                  {navigable && (
                    <span style={{ color: C.primary }}> · Open →</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
