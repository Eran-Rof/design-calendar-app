// ── Parse SKU into base part + color (strip size) ─────────────────────────────
export function parseSku(sku: string): { base: string; color: string } {
  // ATS SKUs use " - " (space-dash-space) as separator: "CMO0002 - Black/Red"
  // Xoro raw SKUs use plain "-": "CMO0002-Black/Red-SM"
  const spaceDelim = sku.indexOf(" - ");
  if (spaceDelim !== -1) {
    return {
      base:  sku.slice(0, spaceDelim).trim(),
      color: sku.slice(spaceDelim + 3).trim(),
    };
  }
  // Raw Xoro format: split on "-", strip trailing size segment
  const parts = sku.split("-");
  if (parts.length < 2) return { base: sku.trim(), color: "" };
  const sizeIdx = parts.slice(1).findIndex(p => p.includes("("));
  let colorParts: string[];
  if (sizeIdx !== -1) {
    colorParts = parts.slice(1, sizeIdx + 1);
  } else if (parts.length >= 3) {
    colorParts = parts.slice(1, -1);
  } else {
    colorParts = parts.slice(1);
  }
  return { base: parts[0].trim(), color: colorParts.join("-").trim() };
}

export const INTEREST_RATE            = 0.09;
export const PALLET_PCS               = 864;
export const STORAGE_PER_PALLET_MONTH = 20;
export const DEFAULT_LAST_RECEIVED    = "2024-09-30";

export function calcAgedCosts(totalQty: number, totalVal: number) {
  const intDaily   = totalVal * INTEREST_RATE / 360;
  const intMonthly = totalVal * INTEREST_RATE / 12;
  const intAnnual  = totalVal * INTEREST_RATE;
  const stoDaily   = totalQty / PALLET_PCS * STORAGE_PER_PALLET_MONTH / 30;
  const stoMonthly = totalQty / PALLET_PCS * STORAGE_PER_PALLET_MONTH;
  const stoAnnual  = totalQty / PALLET_PCS * STORAGE_PER_PALLET_MONTH * 12;
  const pctCost    = totalVal > 0 ? (intAnnual + stoAnnual) / totalVal : 0;
  const dolCost    = totalQty > 0 ? (intAnnual + stoAnnual) / totalQty : 0;
  return { intDaily, intMonthly, intAnnual, stoDaily, stoMonthly, stoAnnual, pctCost, dolCost };
}

export function calcAgedDays(lastReceived: string | undefined, today: Date): number {
  const src = lastReceived || DEFAULT_LAST_RECEIVED;
  let iso = src;
  const mmddyyyy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(src);
  if (mmddyyyy) iso = `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2,"0")}-${mmddyyyy[2].padStart(2,"0")}`;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return 0;
  return Math.floor((today.getTime() - d.getTime()) / 86400000);
}
