import { useCallback, useEffect, useState } from "react";
import type { CartLine } from "./types";

// Client-side wholesale cart for the B2B portal. Persisted in localStorage,
// keyed per customer so switching accounts (rare) never bleeds lines across.
// Prices here are display-only convenience; the order-create endpoint always
// re-resolves the authoritative price server-side from b2b_price_list.

function storageKey(customerId: string) {
  return `b2b-cart:${customerId}`;
}

function load(customerId: string): CartLine[] {
  try {
    const raw = localStorage.getItem(storageKey(customerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function useCart(customerId: string) {
  const [lines, setLines] = useState<CartLine[]>(() => load(customerId));

  // Reload when the customer changes (defensive — usually stable for a session).
  useEffect(() => { setLines(load(customerId)); }, [customerId]);

  useEffect(() => {
    try { localStorage.setItem(storageKey(customerId), JSON.stringify(lines)); }
    catch { /* quota / disabled storage — keep in-memory state */ }
  }, [customerId, lines]);

  const addLine = useCallback((line: CartLine) => {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.style_id === line.style_id);
      if (i === -1) return [...prev, line];
      const next = [...prev];
      next[i] = { ...next[i], qty: next[i].qty + line.qty, price_cents: line.price_cents };
      return next;
    });
  }, []);

  const setQty = useCallback((styleId: string, qty: number) => {
    setLines((prev) =>
      prev
        .map((l) => (l.style_id === styleId ? { ...l, qty } : l))
        .filter((l) => l.qty > 0),
    );
  }, []);

  const removeLine = useCallback((styleId: string) => {
    setLines((prev) => prev.filter((l) => l.style_id !== styleId));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const replaceAll = useCallback((next: CartLine[]) => setLines(next), []);

  const totalCents = lines.reduce((s, l) => s + l.qty * l.price_cents, 0);
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);

  return { lines, addLine, setQty, removeLine, clear, replaceAll, totalCents, totalUnits };
}

export function formatMoney(cents: number | null, currency = "USD"): string {
  if (cents == null) return "Call for price";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}
