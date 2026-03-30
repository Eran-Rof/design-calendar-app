export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export function fmtDateShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDateDisplay(dateStr: string): string {
  if (!dateStr) return "—";
  const d = dateStr.includes("-") ? new Date(dateStr + "T00:00:00") : new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;
}

export function fmtDateHeader(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  return `${day}\n${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export function isToday(iso: string): boolean {
  return iso === fmtDate(new Date());
}

export function isWeekend(iso: string): boolean {
  const d = new Date(iso + "T00:00:00");
  const day = d.getDay();
  return day === 0 || day === 6;
}

export function getQtyColor(qty: number): string {
  if (qty <= 0) return "#EF4444";
  if (qty <= 10) return "#F59E0B";
  if (qty <= 50) return "#3B82F6";
  return "#10B981";
}

export function getQtyBg(qty: number): string {
  if (qty <= 0) return "rgba(239,68,68,0.15)";
  if (qty <= 10) return "rgba(245,158,11,0.15)";
  if (qty <= 50) return "rgba(59,130,246,0.12)";
  return "rgba(16,185,129,0.1)";
}

/** Normalize SKU string: collapse multiple spaces, standardize dash spacing, title case color names.
 *  "RYB059430PPK - Bark  -  Grey w Tint" → "RYB059430PPK - Bark - Grey w Tint"
 *  "RYB0412 - ESPRESSO" → "RYB0412 - Espresso"  */
export function normalizeSku(sku: string): string {
  // 1. Collapse all whitespace runs to single space
  let s = sku.replace(/\s+/g, " ").trim();
  // 2. Standardize dash spacing: any combo of spaces/dashes → " - "
  s = s.replace(/\s*-\s*/g, " - ");
  // 3. Title-case the color/wash portion (everything after first " - ")
  const firstDash = s.indexOf(" - ");
  if (firstDash >= 0) {
    const base = s.slice(0, firstDash); // keep base part as-is (e.g. RYB059430PPK)
    const rest = s.slice(firstDash + 3); // color portion
    const titleCased = rest.replace(/\b\w+/g, (word) => {
      // Keep small words lowercase: w, of, lt, dk, md — unless first word
      const lower = word.toLowerCase();
      const smallWords = new Set(["w", "of", "lt", "dk", "md"]);
      if (smallWords.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
    s = base + " - " + titleCased;
  }
  return s;
}

export function xoroSkuToExcel(rawSku: string): string {
  const parts = rawSku.split("-");
  if (parts.length >= 3) return parts[0] + " - " + parts.slice(1, -1).join(" - ");
  if (parts.length === 2) return parts[0] + " - " + parts[1];
  return rawSku;
}
