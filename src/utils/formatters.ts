// ── Shared formatting helpers ─────────────────────────────────────────────────
// Used across Design Calendar, PO WIP, ATS, and Tech Packs.

/** Format a date string as MM/DD/YYYY. Handles ISO and US date formats. */
export function fmtDateMMDDYYYY(d?: string | null): string {
  if (!d) return "—";
  const dt = new Date(d.includes("T") ? d : d + "T00:00:00");
  if (isNaN(dt.getTime())) return d;
  return `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}/${dt.getFullYear()}`;
}

/** Format a number as currency. Supports nullable input and custom currency codes. */
export function fmtCurrencyUSD(n?: number | null, code = "USD"): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);
}

/** Generate a unique ID string. */
export function genId(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Get effective qty for a PO line item: QtyRemaining for partially received, QtyOrder otherwise. */
export function itemQty(item: any): number {
  if (item.QtyRemaining != null) return item.QtyRemaining;
  if (item.QtyReceived != null && item.QtyReceived > 0) return (item.QtyOrder ?? 0) - item.QtyReceived;
  return item.QtyOrder ?? 0;
}

/** Convert Xoro SKU format (BASE-COLOR-SIZE) to Excel format (BASE - COLOR). */
export function xoroSkuToExcel(rawSku: string): string {
  const parts = rawSku.split("-");
  if (parts.length < 2) return rawSku;
  // Sizes like "Xs(5-6)" contain a dash, so splitting naively yields multiple segments.
  // Detect the size start by finding the first segment (after index 0) that contains "(".
  const sizeIdx = parts.slice(1).findIndex(p => p.includes("("));
  if (sizeIdx !== -1) {
    const colorParts = parts.slice(1, sizeIdx + 1);
    return colorParts.length > 0 ? parts[0] + " - " + colorParts.join(" - ") : parts[0];
  }
  if (parts.length >= 3) return parts[0] + " - " + parts.slice(1, -1).join(" - ");
  return parts[0] + " - " + parts[1];
}
