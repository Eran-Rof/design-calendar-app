// Shipment utilities: container-number validation and Searates response
// mapping. Pure functions — easy to unit-test without network access.

// ─── ISO 6346 container number validator ─────────────────────────────────────
// Format: 4 letters (owner + category) + 6 digits + 1 check digit
//   e.g. MSKU1234567, ECMU7336714
//
// The check digit is computed from the first 10 characters. Each letter maps
// to a numeric value (A=10 skipping multiples of 11: A=10, B=12, C=13, ...),
// each digit to its face value. Multiply each by 2^position (pos 0..9),
// sum, mod 11, mod 10. That value must equal the 11th character.

const LETTER_VALUES: Record<string, number> = (() => {
  // A=10, B=12, C=13, D=14, E=15, F=16, G=17, H=18, I=19, J=20, K=21,
  // skip 22 (multiple of 11), L=23, M=24, ... and so on.
  // See BIC/ISO 6346 reference tables.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const map: Record<string, number> = {};
  let n = 10;
  for (const ch of alphabet) {
    if (n % 11 === 0) n++;
    map[ch] = n;
    n++;
  }
  return map;
})();

export function isValidContainerNumber(input: string): boolean {
  if (typeof input !== "string") return false;
  const s = input.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{4}\d{6}\d$/.test(s)) return false;

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = s[i];
    const v = /[A-Z]/.test(ch) ? LETTER_VALUES[ch] : Number(ch);
    if (v == null || Number.isNaN(v)) return false;
    sum += v * Math.pow(2, i);
  }
  let check = sum % 11;
  if (check === 10) check = 0;
  return check === Number(s[10]);
}

// ─── Response mapping ────────────────────────────────────────────────────────
// Flatten the Searates /tracking response into our shipments + shipment_events
// row shapes.

export interface SearatesLocation {
  id: number;
  locode?: string | null;
  name?: string | null;
}

export interface SearatesFacility {
  id: number;
  name?: string | null;
  locode?: string | null;
}

export interface SearatesEvent {
  order_id?: number;
  location?: number | null;
  facility?: number | null;
  description?: string | null;
  event_type?: string | null;
  event_code?: string | null;
  status?: string | null;
  date?: string | null;
  actual?: boolean | null;
}

export interface SearatesContainer {
  number: string;
  iso_code?: string | null;
  size_type?: string | null;
  status?: string | null;
  events?: SearatesEvent[];
}

export interface SearatesRoute {
  prepol?: { location?: number | null; date?: string | null; actual?: boolean | null } | null;
  pol?: { location?: number | null; date?: string | null; actual?: boolean | null } | null;
  pod?: { location?: number | null; date?: string | null; actual?: boolean | null } | null;
  postpod?: { location?: number | null; date?: string | null; actual?: boolean | null } | null;
}

export interface SearatesResponse {
  status?: string;
  message?: string;
  data?: {
    metadata?: {
      type?: string;
      number?: string;
      sealine?: string | null;
      sealine_name?: string | null;
      status?: string | null;
      updated_at?: string | null;
    };
    locations?: SearatesLocation[];
    facilities?: SearatesFacility[];
    route?: SearatesRoute;
    containers?: SearatesContainer[];
  };
}

export interface ShipmentRow {
  number: string;
  number_type: string;
  sealine_scac: string | null;
  sealine_name: string | null;
  pol_locode: string | null;
  pod_locode: string | null;
  pol_date: string | null;
  pod_date: string | null;
  eta: string | null;
  ata: string | null;
  current_status: string | null;
  last_tracked_at: string | null;
}

export interface EventRow {
  container_number: string | null;
  order_id: number | null;
  event_code: string | null;
  event_type: string | null;
  status: string | null;
  description: string | null;
  location_locode: string | null;
  facility_name: string | null;
  event_date: string | null;
  is_actual: boolean;
  raw_json: SearatesEvent;
}

/**
 * Convert a Searates /tracking response into a shipment summary row (no DB
 * ids — just the payload to upsert).
 */
export function mapShipment(r: SearatesResponse): ShipmentRow | null {
  const meta = r?.data?.metadata;
  if (!meta?.number || !meta?.type) return null;

  const locById = new Map<number, SearatesLocation>();
  for (const l of r.data?.locations ?? []) locById.set(l.id, l);

  const pol = r.data?.route?.pol;
  const pod = r.data?.route?.pod;
  const polLoc = pol?.location != null ? locById.get(pol.location) : null;
  const podLoc = pod?.location != null ? locById.get(pod.location) : null;

  // ETA = pod.date when pod.actual=false; ATA = pod.date when pod.actual=true.
  const podActual = !!pod?.actual;
  const eta = !podActual ? pod?.date ?? null : null;
  const ata = podActual ? pod?.date ?? null : null;

  return {
    number: meta.number,
    number_type: meta.type,
    sealine_scac: meta.sealine ?? null,
    sealine_name: meta.sealine_name ?? null,
    pol_locode: polLoc?.locode ?? null,
    pod_locode: podLoc?.locode ?? null,
    pol_date: pol?.date ?? null,
    pod_date: pod?.date ?? null,
    eta,
    ata,
    current_status: meta.status ?? null,
    last_tracked_at: meta.updated_at ?? null,
  };
}

/**
 * Convert the events nested inside each container into flat rows, preserving
 * container attribution. Location/facility ids are resolved to locodes/names
 * via the shared dictionaries.
 */
export function mapEvents(r: SearatesResponse): EventRow[] {
  const locById = new Map<number, SearatesLocation>();
  for (const l of r?.data?.locations ?? []) locById.set(l.id, l);
  const facById = new Map<number, SearatesFacility>();
  for (const f of r?.data?.facilities ?? []) facById.set(f.id, f);

  const out: EventRow[] = [];
  for (const c of r?.data?.containers ?? []) {
    for (const e of c.events ?? []) {
      const loc = e.location != null ? locById.get(e.location) : null;
      const fac = e.facility != null ? facById.get(e.facility) : null;
      out.push({
        container_number: c.number ?? null,
        order_id: e.order_id ?? null,
        event_code: e.event_code ?? null,
        event_type: e.event_type ?? null,
        status: e.status ?? null,
        description: e.description ?? null,
        location_locode: loc?.locode ?? null,
        facility_name: fac?.name ?? null,
        event_date: e.date ?? null,
        is_actual: !!e.actual,
        raw_json: e,
      });
    }
  }
  return out;
}
