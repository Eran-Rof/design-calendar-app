import { useState } from "react";
import { B } from "./theme";
import type { B2BSession } from "./types";

// Authenticated portal shell. Minimal by design — this chunk delivers correct,
// secure auth + the session chokepoint; Catalog / Orders / Account are stubbed
// here and filled by later chunks (P18-C/D/E).
type Tab = "catalog" | "orders" | "account";

const TABS: { key: Tab; label: string }[] = [
  { key: "catalog", label: "Catalog" },
  { key: "orders",  label: "Orders" },
  { key: "account", label: "Account" },
];

export default function B2BShell({
  session,
  onLogout,
}: {
  session: B2BSession;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>("catalog");

  return (
    <div style={{ minHeight: "100vh", background: B.bg, fontFamily: B.font }}>
      <header style={headerBar}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <span style={{ fontWeight: 700, color: B.primary, fontSize: 16 }}>Ring of Fire</span>
          <span style={{ color: B.border }}>|</span>
          <span style={{ color: B.text, fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.customer_name || "Wholesale Portal"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ color: B.textMuted, fontSize: 13, whiteSpace: "nowrap" }}>
            {session.display_name || "Buyer"}
          </span>
          <button type="button" onClick={onLogout} style={logoutBtn}>Logout</button>
        </div>
      </header>

      <nav style={navBar}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={navTab(tab === t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px" }}>
        <ComingSoon tab={tab} />
      </main>
    </div>
  );
}

function ComingSoon({ tab }: { tab: Tab }) {
  const labels: Record<Tab, { title: string; blurb: string }> = {
    catalog: { title: "Catalog",  blurb: "Browse available styles and build your order. Coming soon." },
    orders:  { title: "Orders",   blurb: "Track your orders and order history. Coming soon." },
    account: { title: "Account",  blurb: "Manage your contacts and account details. Coming soon." },
  };
  const { title, blurb } = labels[tab];
  return (
    <div style={panel}>
      <h2 style={{ margin: 0, fontSize: 18, color: B.text }}>{title}</h2>
      <p style={{ color: B.textMuted, fontSize: 14, marginTop: 8 }}>{blurb}</p>
    </div>
  );
}

const headerBar: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 20px", background: B.header, borderBottom: `1px solid ${B.border}`,
  position: "sticky", top: 0, zIndex: 10,
};
const navBar: React.CSSProperties = {
  display: "flex", gap: 4, padding: "0 20px", background: B.surface,
  borderBottom: `1px solid ${B.border}`,
};
const navTab = (active: boolean): React.CSSProperties => ({
  padding: "12px 16px", background: "none", border: "none",
  borderBottom: active ? `2px solid ${B.primary}` : "2px solid transparent",
  color: active ? B.primary : B.textSub, fontWeight: 600, fontSize: 14,
  cursor: "pointer", fontFamily: "inherit",
});
const panel: React.CSSProperties = {
  background: B.surface, border: `1px solid ${B.border}`, borderRadius: 12,
  padding: 28, boxShadow: `0 1px 3px ${B.shadow}`,
};
const logoutBtn: React.CSSProperties = {
  padding: "7px 14px", borderRadius: 8, border: `1px solid ${B.border}`,
  background: B.surface, color: B.textSub, fontWeight: 600, fontSize: 13,
  cursor: "pointer", fontFamily: "inherit",
};
