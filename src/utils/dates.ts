import { BRANDS, MONTHS } from "./constants";

export function uid(): string {
  return Math.random().toString(36).substr(2, 9);
}

export function getBrand(id: string) {
  return BRANDS.find((b) => b.id === id) || BRANDS[0];
}

// Parse YYYY-MM-DD without timezone shift
export function parseLocalDate(ds: string): Date {
  if (!ds) return new Date();
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function getDaysUntil(d: string): number {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((parseLocalDate(d).getTime() - t.getTime()) / 86400000);
}

export function formatDate(d: string): string {
  if (!d) return "";
  const x = parseLocalDate(d);
  return `${MONTHS[x.getMonth()]} ${x.getDate()}, ${x.getFullYear()}`;
}

export function formatDT(d: string): string {
  if (!d) return "";
  const x = new Date(d);
  return `${MONTHS[x.getMonth()]} ${x.getDate()} ${x.getHours()}:${String(
    x.getMinutes()
  ).padStart(2, "0")}`;
}

export function addDays(ds: string, n: number): string {
  const d = parseLocalDate(ds);
  d.setDate(d.getDate() + n);
  const mm = String(d.getMonth() + 1).padStart(2, "0"),
    dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseLocalDate(a).getTime() - parseLocalDate(b).getTime()) / 86400000);
}

// ── Business-day helpers (Mon–Thu=1, Fri=0.5, Sat/Sun/Holiday=0) ─────────────
export const HOLIDAYS = new Set([
  "2024-01-01","2024-01-15","2024-02-19","2024-05-27","2024-06-19","2024-07-04",
  "2024-09-02","2024-10-14","2024-11-11","2024-11-28","2024-12-25",
  "2025-01-01","2025-01-20","2025-02-17","2025-05-26","2025-06-19","2025-07-04",
  "2025-09-01","2025-10-13","2025-11-11","2025-11-27","2025-12-25",
  "2026-01-01","2026-01-19","2026-02-16","2026-05-25","2026-06-19","2026-07-04",
  "2026-09-07","2026-10-12","2026-11-11","2026-11-26","2026-12-25",
]);

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export function dayWeight(d: Date): number {
  const ds = toDateStr(d);
  if (HOLIDAYS.has(ds)) return 0;
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return 0;
  return dow === 5 ? 0.5 : 1;
}

export function diffBusinessDays(a: string, b: string): number {
  const da = parseLocalDate(a), db = parseLocalDate(b);
  if (toDateStr(da) === toDateStr(db)) return 0;
  let days = 0;
  const d = new Date(db);
  const dir = da > db ? 1 : -1;
  while (toDateStr(d) !== toDateStr(da)) {
    d.setDate(d.getDate() + dir);
    days += dir * dayWeight(d);
  }
  return days;
}

export function addBusinessDays(ds: string, n: number): string {
  if (n === 0) return ds;
  const d = parseLocalDate(ds);
  let remaining = Math.abs(n);
  const dir = n > 0 ? 1 : -1;
  while (remaining > 0) {
    d.setDate(d.getDate() + dir);
    remaining = Math.max(0, remaining - dayWeight(d));
  }
  return toDateStr(d);
}

export function snapToBusinessDay(ds: string): string {
  const d = parseLocalDate(ds);
  while (dayWeight(d) === 0) d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

export function getBusinessDaysUntil(ds: string): number {
  const today = new Date(); today.setHours(0,0,0,0);
  return diffBusinessDays(ds, toDateStr(today));
}

// ── Phase day-counting mode ───────────────────────────────────────────────────
// Phases from Production onwards (post-PO) use plain calendar days.
// All earlier phases (up to and including Purchase Order) use business days
// where Mon–Thu = 1 day, Friday = 0.5 day, weekends/holidays = 0.
export const POST_PO_PHASES = new Set(["Production", "QC", "Ship Date", "DDP"]);

export function isPostPO(phase: string): boolean { return POST_PO_PHASES.has(phase); }

export function addDaysForPhase(ds: string, n: number, phase: string): string {
  return isPostPO(phase) ? addDays(ds, n) : addBusinessDays(ds, n);
}

export function diffDaysForPhase(a: string, b: string, phase: string): number {
  return isPostPO(phase) ? diffDays(a, b) : diffBusinessDays(a, b);
}

export function getDaysUntilForPhase(ds: string, phase: string): number {
  return isPostPO(phase) ? getDaysUntil(ds) : getBusinessDaysUntil(ds);
}
