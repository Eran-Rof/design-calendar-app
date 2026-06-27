import { useState } from "react";
import { B } from "./theme";
import type { B2BSession, CartLine } from "./types";
import { useCart, formatMoney } from "./useCart";
import B2BCatalog from "./B2BCatalog";
import B2BOrders from "./B2BOrders";
import B2BAccount from "./B2BAccount";

// Authenticated portal shell. Renders the three buyer pages (Catalog / Orders /
// Account) and owns the cart so it persists while the buyer switches tabs.
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
  const cart = useCart(session.customer_id);

  function addToCart(line: CartLine) {
    cart.addLine(line);
  }

  function reorderInto(lines: CartLine[]) {
    cart.replaceAll(lines);
    setTab("orders");
  }

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
          {cart.totalUnits > 0 && (
            <button type="button" onClick={() => setTab("orders")} style={cartChip} title="View cart">
              Cart · {cart.totalUnits} · {formatMoney(cart.totalCents)}
            </button>
          )}
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
            {t.key === "orders" && cart.totalUnits > 0 && (
              <span style={cartBadge}>{cart.totalUnits}</span>
            )}
          </button>
        ))}
      </nav>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px" }}>
        {tab === "catalog" && <B2BCatalog onAdd={addToCart} />}
        {tab === "orders" && (
          <B2BOrders
            session={session}
            cart={cart.lines}
            setQty={cart.setQty}
            removeLine={cart.removeLine}
            clearCart={cart.clear}
            reorderInto={reorderInto}
          />
        )}
        {tab === "account" && <B2BAccount />}
      </main>
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
  display: "inline-flex", alignItems: "center", gap: 8,
  padding: "12px 16px", background: "none", border: "none",
  borderBottom: active ? `2px solid ${B.primary}` : "2px solid transparent",
  color: active ? B.primary : B.textSub, fontWeight: 600, fontSize: 14,
  cursor: "pointer", fontFamily: "inherit",
});
const cartBadge: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
  background: B.primary, color: "#fff", fontSize: 11, fontWeight: 700,
};
const cartChip: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 999, border: `1px solid ${B.primary}`,
  background: B.surface, color: B.primary, fontWeight: 700, fontSize: 13,
  cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
};
const logoutBtn: React.CSSProperties = {
  padding: "7px 14px", borderRadius: 8, border: `1px solid ${B.border}`,
  background: B.surface, color: B.textSub, fontWeight: 600, fontSize: 13,
  cursor: "pointer", fontFamily: "inherit",
};
