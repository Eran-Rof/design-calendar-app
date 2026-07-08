// src/utils/errorReporter.ts — browser-side uncaught-error reporter.
//
// Hooks window 'error' + 'unhandledrejection' and batches reports to
// POST /api/internal/client-errors (the internalApiAuth fetch wrapper adds the
// internal token). Server stores them in app_errors; the daily digest emails a
// grouped summary. Deliberately tiny — not a Sentry replacement, just enough
// that a white-screen or crash loop is VISIBLE the next morning instead of
// only living in the user's devtools.
//
// Guardrails: per-session cap, per-message dedupe, 2s debounce batching, and
// reporter failures are swallowed (never recurse into ourselves).

const MAX_PER_SESSION = 20;
const FLUSH_MS = 2000;

type Report = { message: string; stack?: string; route: string; app?: string };

let installed = false;
let sent = 0;
const seen = new Set<string>();
let queue: Report[] = [];
let timer: number | null = null;

function flush(): void {
  timer = null;
  if (queue.length === 0) return;
  const batch = queue.splice(0, 10);
  try {
    void fetch("/api/internal/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ errors: batch }),
      keepalive: true, // survive tab close mid-flush
    }).catch(() => { /* reporter must never throw */ });
  } catch { /* ignore */ }
}

function enqueue(r: Report): void {
  if (sent >= MAX_PER_SESSION) return;
  const key = r.message.slice(0, 120);
  if (seen.has(key)) return;
  seen.add(key);
  sent++;
  queue.push(r);
  if (timer == null) timer = window.setTimeout(flush, FLUSH_MS);
}

export function installErrorReporter(app?: string): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const route = () => window.location.pathname + window.location.search;

  window.addEventListener("error", (ev) => {
    try {
      // Ignore cross-origin "Script error." noise (no actionable detail).
      if (!ev.message || ev.message === "Script error.") return;
      enqueue({ message: String(ev.message), stack: ev.error?.stack ? String(ev.error.stack) : undefined, route: route(), app });
    } catch { /* never throw from the reporter */ }
  });

  window.addEventListener("unhandledrejection", (ev) => {
    try {
      const reason: unknown = ev.reason;
      const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : JSON.stringify(reason ?? "unhandled rejection").slice(0, 300);
      const stack = reason instanceof Error && reason.stack ? String(reason.stack) : undefined;
      enqueue({ message: `Unhandled rejection: ${message}`, stack, route: route(), app });
    } catch { /* never throw from the reporter */ }
  });
}
