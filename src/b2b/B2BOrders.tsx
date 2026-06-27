import { useCallback, useEffect, useState } from "react";
import { B } from "./theme";
import { apiB2B } from "./apiB2B";
import { formatMoney } from "./useCart";
import type {
  B2BSession, CartLine, OrderSummary, OrderDetail, ShipToLocation,
} from "./types";
import SearchableSelect from "../tanda/components/SearchableSelect";

// P18-D — Cart review + place order, plus the buyer's order history with a
// Reorder action. Cart lives in the parent (App) so it persists across tabs;
// this page receives it + mutators as props.
export default function B2BOrders({
  session,
  cart,
  setQty,
  removeLine,
  clearCart,
  reorderInto,
}: {
  session: B2BSession;
  cart: CartLine[];
  setQty: (styleId: string, qty: number) => void;
  removeLine: (styleId: string) => void;
  clearCart: () => void;
  reorderInto: (lines: CartLine[]) => void;
}) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [ordersErr, setOrdersErr] = useState<string | null>(null);

  const [locations, setLocations] = useState<ShipToLocation[]>([]);
  const [shipTo, setShipTo] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reordering, setReordering] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true);
    setOrdersErr(null);
    try {
      const data = await apiB2B<OrderSummary[]>("/api/b2b/orders");
      setOrders(data || []);
    } catch (e) {
      setOrdersErr(e instanceof Error ? e.message : "Failed to load orders");
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  useEffect(() => { void loadOrders(); }, [loadOrders]);

  // Ship-to options come from the account endpoint (the customer's locations).
  useEffect(() => {
    (async () => {
      try {
        const acct = await apiB2B<{ locations: ShipToLocation[] }>("/api/b2b/account");
        const locs = acct?.locations || [];
        setLocations(locs);
        const def = locs.find((l) => l.is_default);
        if (def) setShipTo(def.id);
      } catch { /* non-blocking — ship-to is optional */ }
    })();
  }, []);

  const cartTotal = cart.reduce((s, l) => s + l.qty * l.price_cents, 0);

  async function submit() {
    if (cart.length === 0) return;
    setSubmitting(true);
    setSubmitErr(null);
    setSuccess(null);
    try {
      const res = await apiB2B<{ id: string; so_number: string | null }>("/api/b2b/orders", {
        method: "POST",
        body: {
          lines: cart.map((l) => ({ style_id: l.style_id, qty: l.qty })),
          ship_to_location_id: shipTo || undefined,
          notes: notes.trim() || undefined,
        },
      });
      clearCart();
      setNotes("");
      setSuccess(`Order submitted${res.so_number ? ` (${res.so_number})` : ""}. Your rep will review it shortly.`);
      void loadOrders();
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : "Failed to submit order");
    } finally {
      setSubmitting(false);
    }
  }

  async function reorder(orderId: string) {
    setReordering(orderId);
    setSubmitErr(null);
    setSuccess(null);
    try {
      const detail = await apiB2B<OrderDetail>(`/api/b2b/orders/${orderId}`);
      // Map each line back to a cart line using the parsed style_id. The unit
      // price shown is the historical price; the server ALWAYS re-resolves the
      // authoritative current price when the order is submitted.
      const lines: CartLine[] = (detail.lines || [])
        .filter((l) => l.qty_ordered > 0 && l.style_id)
        .map((l) => ({
          style_id: l.style_id as string,
          style_code: (l.description || "").split(" — ")[0] || "Style",
          style_name: null,
          qty: l.qty_ordered,
          price_cents: l.unit_price_cents,
          currency: detail.currency || "USD",
        }));
      if (lines.length) {
        reorderInto(lines);
        setSuccess("Items loaded into your cart. Prices will be confirmed at current rates when you submit.");
      } else {
        setSubmitErr("This order has no reorderable items.");
      }
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : "Failed to load order for reorder");
    } finally {
      setReordering(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* ── Cart ── */}
      <section style={panel}>
        <h2 style={h2}>Your cart</h2>
        {success && <div style={okBox}>{success}</div>}
        {cart.length === 0 ? (
          <p style={{ color: B.textMuted, fontSize: 14, marginTop: 8 }}>
            Your cart is empty. Add styles from the Catalog.
          </p>
        ) : (
          <>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Style</th>
                  <th style={thR}>Unit</th>
                  <th style={thC}>Qty</th>
                  <th style={thR}>Line total</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {cart.map((l) => (
                  <tr key={l.style_id}>
                    <td style={td}>
                      <div style={{ fontWeight: 600, color: B.text }}>{l.style_code}</div>
                      {l.style_name && <div style={{ color: B.textMuted, fontSize: 12 }}>{l.style_name}</div>}
                    </td>
                    <td style={tdR}>{formatMoney(l.price_cents, l.currency)}</td>
                    <td style={tdC}>
                      <input
                        type="number"
                        min={0}
                        value={l.qty}
                        onChange={(e) => setQty(l.style_id, Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                        style={{ ...input, width: 64, padding: "5px 7px" }}
                      />
                    </td>
                    <td style={tdR}>{formatMoney(l.qty * l.price_cents, l.currency)}</td>
                    <td style={tdC}>
                      <button type="button" onClick={() => removeLine(l.style_id)} style={linkBtn}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 16, alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label style={label}>Ship to</label>
                <SearchableSelect
                  theme="light"
                  value={shipTo || null}
                  onChange={(v) => setShipTo(v)}
                  options={[
                    { value: "", label: "(no specific location)" },
                    ...locations.map((l) => ({ value: l.id, label: `${l.name}${l.is_default ? " (default)" : ""}` })),
                  ]}
                  inputStyle={{ ...input, width: "100%" }}
                />
              </div>
              <div style={{ flex: 2, minWidth: 220 }}>
                <label style={label}>Notes (optional)</label>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="PO #, instructions…" style={{ ...input, width: "100%" }} />
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 18 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: B.text }}>
                Total: {formatMoney(cartTotal, cart[0]?.currency || "USD")}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" onClick={clearCart} style={secondaryBtn}>Clear</button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={submitting || !session.can_place_orders}
                  style={primaryBtn(submitting || !session.can_place_orders)}
                  title={session.can_place_orders ? undefined : "Your account is not permitted to place orders"}
                >
                  {submitting ? "Submitting…" : "Submit order"}
                </button>
              </div>
            </div>
            {!session.can_place_orders && (
              <p style={{ color: B.textMuted, fontSize: 12, marginTop: 8 }}>
                Your account can browse and build orders, but submitting is disabled. Contact your rep.
              </p>
            )}
            {submitErr && <div style={errBox}>{submitErr}</div>}
          </>
        )}
      </section>

      {/* ── Order history ── */}
      <section style={panel}>
        <h2 style={h2}>Your orders</h2>
        {ordersErr && <div style={errBox}>{ordersErr}</div>}
        {loadingOrders ? (
          <div style={{ color: B.textMuted, fontSize: 14, padding: "16px 0" }}>Loading orders…</div>
        ) : orders.length === 0 ? (
          <p style={{ color: B.textMuted, fontSize: 14, marginTop: 8 }}>No orders yet.</p>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Order</th>
                <th style={th}>Date</th>
                <th style={th}>Status</th>
                <th style={thR}>Total</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td style={td}>{o.so_number || "Draft"}</td>
                  <td style={td}>{(o.order_date || o.created_at || "").slice(0, 10)}</td>
                  <td style={td}><StatusBadge status={o.status} /></td>
                  <td style={tdR}>{formatMoney(o.total_cents, o.currency)}</td>
                  <td style={tdC}>
                    <button type="button" onClick={() => void reorder(o.id)} disabled={reordering === o.id} style={linkBtn}>
                      {reordering === o.id ? "Loading…" : "Reorder"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: B.surfaceAlt, color: B.textSub, border: `1px solid ${B.border}`, textTransform: "capitalize",
    }}>
      {status}
    </span>
  );
}

const panel: React.CSSProperties = {
  background: B.surface, border: `1px solid ${B.border}`, borderRadius: 12,
  padding: 22, boxShadow: `0 1px 3px ${B.shadow}`,
};
const h2: React.CSSProperties = { margin: 0, fontSize: 17, color: B.text };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 14 };
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${B.border}`, color: B.textMuted, fontSize: 12, fontWeight: 600 };
const thR: React.CSSProperties = { ...th, textAlign: "right" };
const thC: React.CSSProperties = { ...th, textAlign: "center" };
const td: React.CSSProperties = { padding: "10px", borderBottom: `1px solid ${B.surfaceAlt}`, color: B.text };
const tdR: React.CSSProperties = { ...td, textAlign: "right" };
const tdC: React.CSSProperties = { ...td, textAlign: "center" };
const input: React.CSSProperties = {
  padding: "9px 11px", borderRadius: 8, border: `1px solid ${B.border}`,
  fontSize: 14, fontFamily: "inherit", background: B.surface, color: B.text, boxSizing: "border-box",
};
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: B.textSub, marginBottom: 6 };
const primaryBtn = (disabled: boolean): React.CSSProperties => ({
  padding: "10px 18px", borderRadius: 8, border: "none",
  background: disabled ? B.textMuted : B.primary, color: "#fff",
  fontWeight: 600, fontSize: 14, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
});
const secondaryBtn: React.CSSProperties = {
  padding: "10px 16px", borderRadius: 8, border: `1px solid ${B.border}`,
  background: B.surface, color: B.textSub, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit",
};
const linkBtn: React.CSSProperties = {
  background: "none", border: "none", color: B.primary, cursor: "pointer",
  fontSize: 13, fontWeight: 600, padding: 0, fontFamily: "inherit",
};
const errBox: React.CSSProperties = {
  color: B.danger, fontSize: 13, marginTop: 14, padding: "10px 12px",
  background: B.dangerBg, border: `1px solid ${B.dangerBdr}`, borderRadius: 8,
};
const okBox: React.CSSProperties = {
  color: "#065F46", fontSize: 13, margin: "12px 0 0", padding: "10px 12px",
  background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 8,
};
