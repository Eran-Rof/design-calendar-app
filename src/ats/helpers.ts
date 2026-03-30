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

export function xoroSkuToExcel(rawSku: string): string {
  const parts = rawSku.split("-");
  if (parts.length >= 3) return parts[0] + " - " + parts.slice(1, -1).join(" - ");
  if (parts.length === 2) return parts[0] + " - " + parts[1];
  return rawSku;
}
