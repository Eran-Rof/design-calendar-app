// POST /api/internal/client-errors — browser error intake.
//
// src/utils/errorReporter.ts hooks window 'error' + 'unhandledrejection' and
// batches uncaught browser errors here (the internalApiAuth fetch wrapper
// injects the internal token automatically). Rows land in app_errors
// (source='client') and surface in the daily app-errors-digest bell+email.
//
// Defensive: capped batch size, truncated fields, per-token rate limit —
// a crash loop in one tab must not flood the table.

import { authenticateInternalCaller, rateLimit } from "../../_lib/auth.js";
import { captureError } from "../../_lib/errorCapture.js";

export const config = { maxDuration: 15 };

const MAX_BATCH = 10;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const tokenTail = (req.headers["x-internal-token"] || req.headers.authorization || "").slice(-8) || "anon";
  const rl = rateLimit(`client-errors:${tokenTail}`, { limit: 60, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const errors = Array.isArray(body?.errors) ? body.errors.slice(0, MAX_BATCH) : [];
  if (errors.length === 0) return res.status(400).json({ error: "errors: [] required" });

  let stored = 0;
  for (const e of errors) {
    if (!e || typeof e !== "object" || !e.message) continue;
    await captureError({
      source: "client",
      route: String(e.route || e.url || "").slice(0, 300),
      message: String(e.message).slice(0, 2000),
      stack: e.stack ? String(e.stack).slice(0, 6000) : undefined,
      context: {
        app: String(e.app || "").slice(0, 50) || undefined,
        user_agent: String(req.headers["user-agent"] || "").slice(0, 200),
      },
    });
    stored++;
  }
  return res.status(200).json({ stored });
}
