// api/webhooks/plaid
//
// POST. Plaid signs every webhook with a JWS (JSON Web Signature) in the
// `Plaid-Verification` header. We extract the JWK kid, fetch the matching
// verification key from Plaid, verify the JWT, then dispatch on
// webhook_type + webhook_code.
//
// Supported codes (transactions product):
//   SYNC_UPDATES_AVAILABLE  — new txns ready; trigger /transactions/sync
//   INITIAL_UPDATE          — first sync after Item link is ready
//   HISTORICAL_UPDATE       — historical pull complete
//   TRANSACTIONS_REMOVED    — Plaid removed some txns
//   ERROR                   — Item-level error (e.g. ITEM_LOGIN_REQUIRED)
//
// Everything else logs + 200s for visibility. The webhook always returns
// 200 as fast as possible — Plaid retries on non-2xx.
//
// Tangerine P6-2.

import { createClient } from "@supabase/supabase-js";
import { createVerify } from "node:crypto";
import { getWebhookVerificationKey, isPlaidConfigured } from "../_lib/plaid/client.js";
import { runBankFeedSync } from "../cron/bank-feed-sync.js";

export const config = { maxDuration: 60 };

// Cache verification keys by kid for the lifetime of the function instance.
const KEY_CACHE = new Map();

export default async function handler(req, res) {
  // Always 200 fast on bad input — Plaid retries indefinitely otherwise.
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false });
    }
    if (!isPlaidConfigured()) {
      // Don't 5xx — Plaid will keep retrying. Just acknowledge.
      return res.status(200).json({ ok: true, skipped: "Plaid not configured" });
    }

    const rawBody = await readRawBody(req);
    const verifyHeader = req.headers["plaid-verification"];

    if (process.env.PLAID_WEBHOOK_SKIP_VERIFY !== "true") {
      const verified = await verifyPlaidWebhook(verifyHeader, rawBody);
      if (!verified) {
        // Don't loop Plaid forever. Log + 200.
        console.warn("[plaid webhook] signature verification failed; ignoring");
        return res.status(200).json({ ok: true, ignored: "bad signature" });
      }
    }

    let parsed;
    try { parsed = JSON.parse(rawBody); }
    catch { return res.status(200).json({ ok: true, ignored: "invalid JSON" }); }

    const { webhook_type, webhook_code, item_id } = parsed || {};

    const SB_URL = process.env.VITE_SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SB_URL || !SERVICE_KEY) {
      return res.status(200).json({ ok: true, skipped: "supabase not configured" });
    }
    const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

    if (webhook_type === "TRANSACTIONS") {
      if (
        webhook_code === "SYNC_UPDATES_AVAILABLE" ||
        webhook_code === "INITIAL_UPDATE" ||
        webhook_code === "HISTORICAL_UPDATE" ||
        webhook_code === "DEFAULT_UPDATE" ||
        webhook_code === "TRANSACTIONS_REMOVED"
      ) {
        // Find every bank_account belonging to this Item and sync them.
        const { data: accounts } = await admin
          .from("bank_accounts")
          .select("id")
          .eq("plaid_item_id", item_id)
          .eq("is_active", true);
        for (const acct of accounts || []) {
          // Fire-and-forget at handler level — Plaid expects a fast 200.
          // We await here only to bubble errors to console; the per-account
          // sync is short for incremental pulls.
          try {
            await runBankFeedSync(admin, { onlyBankAccountId: acct.id });
          } catch (e) {
            console.warn(`[plaid webhook] sync failed for bank_account ${acct.id}:`, e);
          }
        }
      }
    } else if (webhook_type === "ITEM" && webhook_code === "ERROR") {
      // Item-level error — usually ITEM_LOGIN_REQUIRED (user must re-link).
      // Log for operator visibility; future: notification enqueue.
      console.warn("[plaid webhook] item error:", parsed?.error);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[plaid webhook] handler crashed:", e);
    return res.status(200).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
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

/**
 * Verify the Plaid-Verification JWS. Returns true on success.
 * https://plaid.com/docs/api/webhooks/webhook-verification/
 */
export async function verifyPlaidWebhook(verifyHeader, rawBody) {
  if (!verifyHeader || typeof verifyHeader !== "string") return false;

  // JWS format: base64url(header).base64url(payload).base64url(signature)
  const parts = verifyHeader.split(".");
  if (parts.length !== 3) return false;
  let headerObj;
  try {
    headerObj = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch { return false; }
  if (headerObj.alg !== "ES256") return false;
  const kid = headerObj.kid;
  if (!kid) return false;

  // Fetch + cache the verification key.
  let key = KEY_CACHE.get(kid);
  if (!key) {
    const resp = await getWebhookVerificationKey(kid).catch(() => null);
    if (!resp?.key) return false;
    key = resp.key;
    KEY_CACHE.set(kid, key);
  }

  // Plaid uses the JWS to attest the SHA-256 of the request body. Per
  // their docs, the payload of the JWS is `{ request_body_sha256: <hex> }`.
  let payloadObj;
  try {
    payloadObj = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return false; }

  const { createHash } = await import("node:crypto");
  const expectedSha = createHash("sha256").update(rawBody).digest("hex");
  if (payloadObj.request_body_sha256 !== expectedSha) return false;

  // Verify the signature with the JWK (ES256 = ECDSA P-256 SHA-256).
  // Node's crypto.createPublicKey accepts JWK in modern releases.
  try {
    const { createPublicKey } = await import("node:crypto");
    const pubKey = createPublicKey({ key, format: "jwk" });
    const signingInput = `${parts[0]}.${parts[1]}`;
    const sig = Buffer.from(parts[2], "base64url");
    const verifier = createVerify("SHA256");
    verifier.update(signingInput);
    verifier.end();
    // ECDSA JWS signatures are raw R||S, but Node's verify() wants DER —
    // convert from raw to DER for ES256.
    const derSig = ecdsaJwsToDer(sig);
    return verifier.verify({ key: pubKey, dsaEncoding: "der" }, derSig);
  } catch (e) {
    console.warn("[plaid webhook] verify error:", e);
    return false;
  }
}

// Convert a 64-byte raw R||S ECDSA signature (JWS format) to DER (SEQUENCE
// of two INTEGER). Each half is 32 bytes for P-256.
function ecdsaJwsToDer(rawSig) {
  if (rawSig.length !== 64) return rawSig; // wrong size — let verify reject
  const r = trimZeros(rawSig.subarray(0, 32));
  const s = trimZeros(rawSig.subarray(32, 64));
  const seq = Buffer.concat([
    Buffer.from([0x02, r.length]), r,
    Buffer.from([0x02, s.length]), s,
  ]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}
function trimZeros(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0x00) i++;
  // If high bit is set, prepend 0x00 to keep INTEGER unsigned.
  if (buf[i] & 0x80) return Buffer.concat([Buffer.from([0x00]), buf.subarray(i)]);
  return buf.subarray(i);
}
