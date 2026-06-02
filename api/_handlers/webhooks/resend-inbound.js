// api/webhooks/resend-inbound
//
// POST endpoint for Resend inbound email routing. Configured operator-side
// by pointing `cases@<domain>` and `contact@<domain>` MX at Resend and
// setting this URL as the inbound webhook target. Until that's configured,
// the handler sits idle.
//
// Behavior:
//   1. Verify HMAC signature using RESEND_WEBHOOK_SECRET (shared with
//      outbound). Soft-fail if the env var isn't set yet (operator hasn't
//      finished setup).
//   2. Parse the inbound payload. Branch on the `to` address:
//        - `cases@<domain>` (CASES_INBOUND_EMAIL)   → cases / case_comments
//          (P7-9 behavior, unchanged).
//        - `contact@<domain>` (CONTACT_INBOUND_EMAIL) → crm_activities row
//          with activity_type='email_in' (P8-4 extension, arch §4).
//        - anything else → 200 + warning log (idempotent; never error).
//   3. Match sender → customer via customers.billing_address->>'email'.
//      (Architecture doc names this `customer_users.email` for the future
//      portal; today the customer record lives on `customers` with the
//      contact email nested in billing_address. Same code path the cases
//      branch already uses.)
//   4. For cases branch: subject contains [CASE-YYYY-NNNNN] → append a
//      case_comments row; else create a new cases row.
//   5. For contact branch: insert a crm_activities row regardless. Raw
//      Resend event goes into the `payload` JSONB so operator can drill
//      into headers later.
//   6. Always 200 quickly.
//
// Tangerine P7-9 (cases@) + P8-4 (contact@ extension, arch §4).

import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { nextCaseNumber } from "../internal/cases/index.js";

export const config = { maxDuration: 30 };

const DEFAULT_CASES_INBOUND_EMAIL   = "cases@ringoffireclothing.com";
const DEFAULT_CONTACT_INBOUND_EMAIL = "contact@ringoffireclothing.com";

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  // Always 200 fast on bad input — Resend retries non-2xx.
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false });
    }

    const rawBody = await readRawBody(req);

    // Signature verification. If RESEND_WEBHOOK_SECRET isn't configured yet,
    // log a warning + skip — this is the "idle until configured" mode the
    // chunk spec asks for.
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (secret && process.env.RESEND_WEBHOOK_SKIP_VERIFY !== "true") {
      const sigHeader =
        req.headers["resend-signature"] ||
        req.headers["svix-signature"] ||
        req.headers["x-resend-signature"];
      const ok = verifyResendSignature(sigHeader, rawBody, secret);
      if (!ok) {
        console.warn("[resend inbound] signature verification failed; ignoring");
        return res.status(200).json({ ok: true, ignored: "bad signature" });
      }
    } else if (!secret) {
      console.warn("[resend inbound] RESEND_WEBHOOK_SECRET not set; skipping signature check");
    }

    let parsed;
    try { parsed = JSON.parse(rawBody); }
    catch { return res.status(200).json({ ok: true, ignored: "invalid JSON" }); }

    const event = extractInboundEvent(parsed);
    if (!event) {
      return res.status(200).json({ ok: true, ignored: "no inbound payload" });
    }

    const casesTarget   = (process.env.CASES_INBOUND_EMAIL   || DEFAULT_CASES_INBOUND_EMAIL).toLowerCase();
    const contactTarget = (process.env.CONTACT_INBOUND_EMAIL || DEFAULT_CONTACT_INBOUND_EMAIL).toLowerCase();
    const route = routeForToList(event.toList, { casesTarget, contactTarget });
    if (!route) {
      console.warn(
        "[resend inbound] to does not match cases@ or contact@ target; ignoring",
        { to: event.toList, casesTarget, contactTarget },
      );
      return res.status(200).json({ ok: true, ignored: "to does not match cases or contact address" });
    }

    const admin = client();
    if (!admin) {
      return res.status(200).json({ ok: true, skipped: "supabase not configured" });
    }

    // Resolve default entity (ROF) — required FK on cases.entity_id /
    // crm_activities.entity_id.
    const { data: entity } = await admin
      .from("entities")
      .select("id")
      .eq("code", "ROF")
      .maybeSingle();
    if (!entity) {
      console.warn("[resend inbound] default entity ROF missing; cannot route");
      return res.status(200).json({ ok: true, skipped: "entity not found" });
    }
    const entityId = entity.id;

    // Best-effort customer match via billing_address->>'email'. Same lookup
    // used by both branches — the architecture doc names the future
    // `customer_users.email` here, but until that portal table ships we
    // dereference the email out of the customers row.
    let customerId = null;
    if (event.fromEmail) {
      const { data: cust } = await admin
        .from("customers")
        .select("id")
        .eq("entity_id", entityId)
        .filter("billing_address->>email", "ilike", event.fromEmail)
        .limit(1)
        .maybeSingle();
      if (cust) customerId = cust.id;
    }

    // ── contact@ branch (P8-4) — log to crm_activities, return. ──────────
    if (route === "contact") {
      const { data: inserted, error: insErr } = await admin
        .from("crm_activities")
        .insert({
          entity_id: entityId,
          customer_id: customerId,
          activity_type: "email_in",
          subject: (event.subject || "(no subject)").slice(0, 500),
          body: event.text || null,
          external_email: event.fromEmail,
          payload: parsed && typeof parsed === "object" ? parsed : {},
        })
        .select()
        .single();
      if (insErr) {
        console.warn("[resend inbound] failed to insert crm_activity:", insErr.message);
        return res.status(200).json({ ok: true, error: insErr.message });
      }
      return res.status(200).json({
        ok: true,
        action: "activity_logged",
        activity_id: inserted.id,
        customer_id: customerId,
      });
    }

    // ── cases@ branch (P7-9, unchanged below) ────────────────────────────
    // Subject-line case-number extraction. Append to existing open case if
    // we find one; else create.
    const caseNumber = extractCaseNumber(event.subject);
    if (caseNumber) {
      const { data: existing } = await admin
        .from("cases")
        .select("id, status")
        .eq("entity_id", entityId)
        .eq("case_number", caseNumber)
        .maybeSingle();
      if (existing) {
        const { error: insErr } = await admin
          .from("case_comments")
          .insert({
            case_id: existing.id,
            body: event.text || "(empty body)",
            is_internal: false,
            external_email: event.fromEmail,
          });
        if (insErr) {
          console.warn("[resend inbound] failed to append comment:", insErr.message);
          return res.status(200).json({ ok: true, error: insErr.message });
        }
        // Touch parent so updated_at refreshes (trigger does this on UPDATE).
        await admin
          .from("cases")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", existing.id);
        return res.status(200).json({
          ok: true,
          action: "comment_appended",
          case_id: existing.id,
          case_number: caseNumber,
        });
      }
      // Fall through to creating a fresh case if the tagged one isn't found.
    }

    const year = new Date().getUTCFullYear();
    const newCaseNumber = await nextCaseNumber(admin, entityId, year);
    const { data: inserted, error: insErr } = await admin
      .from("cases")
      .insert({
        entity_id: entityId,
        case_number: newCaseNumber,
        customer_id: customerId,
        status: "open",
        severity: "normal",
        subject: (event.subject || "(no subject)").slice(0, 500),
        body: event.text || null,
        external_email: event.fromEmail,
      })
      .select()
      .single();
    if (insErr) {
      console.warn("[resend inbound] failed to create case:", insErr.message);
      return res.status(200).json({ ok: true, error: insErr.message });
    }

    return res.status(200).json({
      ok: true,
      action: "case_created",
      case_id: inserted.id,
      case_number: inserted.case_number,
    });
  } catch (e) {
    console.error("[resend inbound] handler crashed:", e);
    // Don't loop Resend retries on a server bug — 200 + error body.
    return res.status(200).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

/**
 * Decide which inbound branch (cases vs contact) handles a Resend payload's
 * `to` list. Returns "cases" / "contact" / null. Exported for tests.
 *
 * Exact-match against the configured target addresses (already lowercased
 * by the caller). If both happen to appear (e.g. operator BCCs both
 * mailboxes — Resend would normally split these), cases@ wins so we don't
 * silently drop a real case into the generic activity log.
 */
export function routeForToList(toList, { casesTarget, contactTarget }) {
  if (!Array.isArray(toList) || toList.length === 0) return null;
  const lower = toList.map((s) => String(s || "").toLowerCase()).filter(Boolean);
  if (casesTarget && lower.includes(casesTarget)) return "cases";
  if (contactTarget && lower.includes(contactTarget)) return "contact";
  return null;
}

/**
 * Pull the [CASE-YYYY-NNNNN] tag out of a subject like
 * "Re: [CASE-2026-00042] Order issue". Returns null if not present.
 */
export function extractCaseNumber(subject) {
  if (!subject || typeof subject !== "string") return null;
  const m = /\[(CASE-\d{4}-\d{5,})\]/i.exec(subject);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Normalize a Resend inbound payload to the fields this handler uses.
 *
 * Resend's inbound shape (subject to change in their API):
 *   {
 *     type: "email.inbound" | "email.received" | ...,
 *     data: {
 *       from: { email, name } | string,
 *       to:   [ { email, name } | string ],
 *       subject: string,
 *       text:    string,
 *       html:    string,
 *       message_id: string,
 *       headers: { ... },
 *     }
 *   }
 *
 * We also accept a flatter shape where the inbound object IS the payload
 * (no `data` wrapper) — keeps the handler resilient to provider changes.
 */
export function extractInboundEvent(payload) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  if (!data) return null;

  const fromEmail = extractEmail(data.from);
  const toList = extractEmails(data.to);
  const subject = typeof data.subject === "string" ? data.subject : "";
  const text = typeof data.text === "string"
    ? data.text
    : (typeof data.html === "string" ? stripTags(data.html) : "");

  // Nothing-to-do shape check: if there's no recipient list at all, skip.
  if (toList.length === 0 && !subject && !fromEmail) return null;

  return { fromEmail, toList, subject, text };
}

function extractEmail(field) {
  if (!field) return null;
  if (typeof field === "string") {
    // "Name <addr@x>" or "addr@x"
    const m = /<([^>]+)>/.exec(field);
    return (m ? m[1] : field).trim().toLowerCase();
  }
  if (typeof field === "object" && field.email) return String(field.email).trim().toLowerCase();
  return null;
}

function extractEmails(field) {
  if (!field) return [];
  if (Array.isArray(field)) {
    return field.map(extractEmail).filter(Boolean);
  }
  const single = extractEmail(field);
  return single ? [single] : [];
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Verify Resend's signature header against the raw body using HMAC-SHA256
 * with the shared webhook secret. The header is expected to be either the
 * raw hex digest or `sha256=<hex>` (Resend uses the Svix convention in
 * practice — accept both forms).
 */
export function verifyResendSignature(sigHeader, rawBody, secret) {
  if (!sigHeader || !rawBody || !secret) return false;
  const provided = String(Array.isArray(sigHeader) ? sigHeader[0] : sigHeader).trim();
  if (!provided) return false;

  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");

  // Strip optional "sha256=" / "v1," prefixes; also handle Svix's
  // "v1,<base64>" multi-sig comma-separated format.
  const candidates = provided
    .split(/[\s,]+/)
    .map((s) => s.replace(/^sha256=/i, "").replace(/^v1=?/i, "").trim())
    .filter(Boolean);

  for (const cand of candidates) {
    // Try hex compare.
    if (cand.length === expectedHex.length) {
      try {
        const a = Buffer.from(cand, "hex");
        const b = Buffer.from(expectedHex, "hex");
        if (a.length === b.length && timingSafeEqual(a, b)) return true;
      } catch { /* malformed hex; fall through */ }
    }
    // Try base64 compare.
    try {
      const expectedB64 = createHmac("sha256", secret).update(rawBody).digest("base64");
      if (cand === expectedB64) return true;
    } catch { /* ignore */ }
  }
  return false;
}

async function readRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
