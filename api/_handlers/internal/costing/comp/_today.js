// Shared today() helper for comp handlers — kept off the per-handler
// file so the open-SO helper can share the same "today" reference
// without duplicating the format.
export function todayIsoUTC() {
  return new Date().toISOString().slice(0, 10);
}
