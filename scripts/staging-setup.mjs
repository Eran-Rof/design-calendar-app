#!/usr/bin/env node
/**
 * scripts/staging-setup.mjs
 *
 * Sets up a staging environment that mirrors production:
 *   • Same Postgres 17 engine (local Docker or hosted Supabase)
 *   • All 47 migrations applied to a fresh DB
 *   • Comprehensive seed data covering all phases
 *   • Test vendor auth users created via Admin API
 *   • Scrypt-hashed API keys generated for programmatic smoke tests
 *   • .env.staging written with all credentials
 *
 * Usage:
 *   node scripts/staging-setup.mjs --local          # Docker-based (npx supabase start)
 *   node scripts/staging-setup.mjs --remote         # Hosted Supabase staging project
 *   node scripts/staging-setup.mjs --remote --reset # Re-seed without re-running migrations
 */

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHash, randomBytes, scryptSync } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Helpers ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const MODE = args.includes("--remote") ? "remote" : "local";
const RESET_ONLY = args.includes("--reset");

function log(msg) { process.stdout.write(`\n\x1b[36m▶ ${msg}\x1b[0m\n`); }
function ok(msg)  { process.stdout.write(`  \x1b[32m✓ ${msg}\x1b[0m\n`); }
function warn(msg){ process.stdout.write(`  \x1b[33m⚠ ${msg}\x1b[0m\n`); }
function err(msg) { process.stdout.write(`\x1b[31m✗ ${msg}\x1b[0m\n`); }

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, stdio: opts.silent ? "pipe" : "inherit", ...opts });
}

function runSilent(cmd) {
  return execSync(cmd, { cwd: ROOT, stdio: "pipe" }).toString().trim();
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// ── API key generation (mirrors api/_lib/api-key.js) ──────────────────────────

function generateApiKey() {
  const raw = "vnd_" + randomBytes(28).toString("base64url").slice(0, 44);
  const prefix = raw.slice(0, 12);
  const salt = randomBytes(16);
  const hash = scryptSync(raw, salt, 64);
  const keyHash = salt.toString("hex") + ":" + hash.toString("hex");
  return { raw, prefix, keyHash };
}

// ── Supabase Admin API ────────────────────────────────────────────────────────

async function adminFetch(baseUrl, serviceKey, path, opts = {}) {
  const res = await fetch(`${baseUrl}/auth/v1${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Admin API ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function dbFetch(baseUrl, serviceKey, table, opts = {}) {
  const res = await fetch(`${baseUrl}/rest/v1/${table}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Prefer": "return=representation",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`REST ${table} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Step 1: Start or link Supabase ────────────────────────────────────────────

async function startSupabase() {
  if (MODE === "local") {
    log("Starting local Supabase (Docker)…");
    try {
      const status = runSilent("npx supabase status --output json 2>/dev/null");
      const parsed = JSON.parse(status);
      if (parsed?.API_URL) {
        ok("Local Supabase already running.");
        return parsed;
      }
    } catch { /* not running yet */ }
    run("npx supabase start");
    const status = JSON.parse(runSilent("npx supabase status --output json"));
    ok(`Local Supabase running at ${status.API_URL}`);
    return status;
  } else {
    // Remote mode — need SUPABASE_PROJECT_REF
    let ref = process.env.SUPABASE_PROJECT_REF;
    if (!ref) {
      ref = await prompt("Enter your staging Supabase project ref (from dashboard URL): ");
    }
    if (!ref) throw new Error("SUPABASE_PROJECT_REF is required for --remote mode");
    log(`Linking to staging project: ${ref}`);
    run(`npx supabase link --project-ref ${ref}`);
    const url = `https://${ref}.supabase.co`;
    ok(`Linked to ${url}`);
    return { API_URL: url, PROJECT_REF: ref };
  }
}

// ── Step 2: Run migrations + seed ─────────────────────────────────────────────

async function applyMigrationsAndSeed() {
  if (MODE === "local") {
    log("Resetting local DB (migrations + seed)…");
    run("npx supabase db reset");
    ok("47 migrations + seed.sql applied.");
  } else {
    log("Pushing migrations to remote staging project…");
    run("npx supabase db push --include-all");
    ok("Migrations applied.");
    warn("Seed must be applied manually on remote:");
    warn("  npx supabase db seed  (or psql < supabase/seed.sql)");
  }
}

// ── Step 3: Create vendor auth users ─────────────────────────────────────────

const TEST_USERS = [
  { id: "a0000001-0000-0000-0000-000000000001", email: "vendor-a@staging.ringoffireclothing.com", vendorId: "a0000000-0000-0000-0000-000000000001", displayName: "Sunrise Apparel (Test)", role: "primary" },
  { id: "a0000001-0000-0000-0000-000000000002", email: "vendor-b@staging.ringoffireclothing.com", vendorId: "a0000000-0000-0000-0000-000000000002", displayName: "Pacific Thread (Test)",  role: "primary" },
  { id: "a0000001-0000-0000-0000-000000000003", email: "vendor-c@staging.ringoffireclothing.com", vendorId: "a0000000-0000-0000-0000-000000000003", displayName: "Atlas Manufacturing (Test)", role: "primary" },
];

const STAGING_PASSWORD = "Staging@2026!";

async function createVendorUsers(sbUrl, serviceKey) {
  log("Creating test vendor auth users…");
  for (const user of TEST_USERS) {
    // Create auth user
    try {
      await adminFetch(sbUrl, serviceKey, `/admin/users/${user.id}`, { method: "GET" });
      ok(`Auth user already exists: ${user.email}`);
    } catch {
      await adminFetch(sbUrl, serviceKey, "/admin/users", {
        method: "POST",
        body: JSON.stringify({
          user_id: user.id,
          email: user.email,
          password: STAGING_PASSWORD,
          email_confirm: true,
          user_metadata: { display_name: user.displayName },
        }),
      });
      ok(`Created auth user: ${user.email}`);
    }

    // Create vendor_users link row
    try {
      await dbFetch(sbUrl, serviceKey, "vendor_users", {
        method: "POST",
        headers: { "Prefer": "return=minimal,resolution=ignore-duplicates" },
        body: JSON.stringify({
          auth_id: user.id,
          vendor_id: user.vendorId,
          display_name: user.displayName,
          role: user.role,
        }),
      });
      ok(`Linked vendor_users row: ${user.email} → ${user.vendorId}`);
    } catch (e) {
      warn(`vendor_users link may already exist for ${user.email}: ${e.message}`);
    }
  }
}

// ── Step 4: Create staging API keys ───────────────────────────────────────────

async function createApiKeys(sbUrl, serviceKey) {
  log("Generating staging API keys…");
  const keys = {};
  for (const user of TEST_USERS.slice(0, 2)) {
    const { raw, prefix, keyHash } = generateApiKey();
    const label = user.displayName.split(" ")[0].toLowerCase();

    try {
      await dbFetch(sbUrl, serviceKey, "vendor_api_keys", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({
          vendor_id: user.vendorId,
          key_prefix: prefix,
          key_hash: keyHash,
          name: `Staging smoke-test key — ${user.displayName}`,
          scopes: ["*"],
          revoked_at: null,
          expires_at: null,
        }),
      });
      keys[label] = raw;
      ok(`API key created for ${user.displayName}: ${prefix}…`);
    } catch (e) {
      warn(`Could not create API key for ${user.displayName}: ${e.message}`);
    }
  }
  return keys;
}

// ── Step 5: Write .env.staging ────────────────────────────────────────────────

async function writeEnvStaging(sbStatus, apiKeys) {
  log("Writing .env.staging…");

  const sbUrl = sbStatus.API_URL || `https://${sbStatus.PROJECT_REF}.supabase.co`;

  let anonKey = sbStatus.ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
  let serviceKey = sbStatus.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  // Try to get keys from supabase status if local
  if (MODE === "local" && !anonKey) {
    try {
      const rawStatus = runSilent("npx supabase status");
      anonKey = (rawStatus.match(/anon key:\s+(\S+)/) || [])[1] || "";
      serviceKey = (rawStatus.match(/service_role key:\s+(\S+)/) || [])[1] || "";
    } catch { /* leave empty */ }
  }

  // Read existing .env.staging if present to preserve non-Supabase vars
  let existing = "";
  if (existsSync(resolve(ROOT, ".env.staging"))) {
    existing = readFileSync(resolve(ROOT, ".env.staging"), "utf8");
  }

  function getVar(name) {
    const m = existing.match(new RegExp(`^${name}=(.+)$`, "m"));
    return m ? m[1] : "";
  }

  const env = [
    `# Generated by scripts/staging-setup.mjs — ${new Date().toISOString()}`,
    `# Do not commit this file.`,
    ``,
    `# ── Supabase ──────────────────────────────────────────────────────────────`,
    `VITE_SUPABASE_URL=${sbUrl}`,
    `VITE_SUPABASE_ANON_KEY=${anonKey}`,
    `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
    ``,
    `# ── Azure AD (copy from .env.local / Vercel prod vars) ───────────────────`,
    `VITE_AZURE_CLIENT_ID=${getVar("VITE_AZURE_CLIENT_ID") || process.env.VITE_AZURE_CLIENT_ID || "<copy-from-prod>"}`,
    `VITE_AZURE_TENANT_ID=${getVar("VITE_AZURE_TENANT_ID") || process.env.VITE_AZURE_TENANT_ID || "<copy-from-prod>"}`,
    ``,
    `# ── External APIs (staging values or prod read-only) ─────────────────────`,
    `VITE_XORO_API_KEY=${getVar("VITE_XORO_API_KEY") || process.env.VITE_XORO_API_KEY || "<copy-from-prod>"}`,
    `VITE_XORO_API_SECRET=${getVar("VITE_XORO_API_SECRET") || process.env.VITE_XORO_API_SECRET || "<copy-from-prod>"}`,
    `DROPBOX_APP_KEY=${getVar("DROPBOX_APP_KEY") || process.env.DROPBOX_APP_KEY || "<copy-from-prod>"}`,
    `DROPBOX_APP_SECRET=${getVar("DROPBOX_APP_SECRET") || process.env.DROPBOX_APP_SECRET || "<copy-from-prod>"}`,
    `DROPBOX_REFRESH_TOKEN=${getVar("DROPBOX_REFRESH_TOKEN") || process.env.DROPBOX_REFRESH_TOKEN || "<copy-from-prod>"}`,
    ``,
    `# ── Misc ──────────────────────────────────────────────────────────────────`,
    `EDI_INBOUND_SHARED_SECRET=staging-edi-secret-change-me`,
    ``,
    `# ── Smoke test ────────────────────────────────────────────────────────────`,
    `STAGING_API_BASE_URL=${getVar("STAGING_API_BASE_URL") || "http://localhost:3000"}`,
    `STAGING_VENDOR_API_KEY=${apiKeys.sunrise || apiKeys[Object.keys(apiKeys)[0]] || ""}`,
    `STAGING_VENDOR_B_API_KEY=${apiKeys.pacific || ""}`,
    ``,
    `# ── Test accounts (password: ${STAGING_PASSWORD}) ─────────────────────────`,
    ...TEST_USERS.map((u) => `# ${u.email}`),
  ].join("\n");

  writeFileSync(resolve(ROOT, ".env.staging"), env + "\n");
  ok(".env.staging written.");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1m=== Design Calendar — Staging Environment Setup ===\x1b[0m");
  console.log(`Mode: \x1b[33m${MODE.toUpperCase()}\x1b[0m${RESET_ONLY ? " (seed reset only)" : ""}`);

  try {
    const sbStatus = await startSupabase();

    if (!RESET_ONLY) {
      await applyMigrationsAndSeed();
    } else {
      log("Skipping migrations (--reset: seed only).");
      if (MODE === "local") run("npx supabase db reset --db-url $(npx supabase status | grep 'DB URL' | awk '{print $3}')");
    }

    // Resolve service key
    let sbUrl = sbStatus.API_URL;
    let serviceKey = sbStatus.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (MODE === "local" && !serviceKey) {
      try {
        const raw = runSilent("npx supabase status");
        serviceKey = (raw.match(/service_role key:\s+(\S+)/) || [])[1] || "";
        sbStatus.SERVICE_ROLE_KEY = serviceKey;
        sbStatus.ANON_KEY = (raw.match(/anon key:\s+(\S+)/) || [])[1] || "";
      } catch (e) {
        warn(`Could not auto-read service key: ${e.message}`);
      }
    }
    if (!serviceKey) {
      serviceKey = await prompt("Enter SUPABASE_SERVICE_ROLE_KEY for the staging project: ");
    }

    await createVendorUsers(sbUrl, serviceKey);
    const apiKeys = await createApiKeys(sbUrl, serviceKey);
    await writeEnvStaging(sbStatus, apiKeys);

    console.log("\n\x1b[1m\x1b[32m=== Setup complete! ===\x1b[0m");
    console.log("\nNext steps:");
    console.log("  1. Start the API:  npx vercel dev");
    console.log("  2. Smoke test:     node scripts/staging-smoke.mjs");
    console.log(`\nVendor test password: \x1b[33m${STAGING_PASSWORD}\x1b[0m`);
    console.log(`API key written to .env.staging → STAGING_VENDOR_API_KEY\n`);

  } catch (e) {
    err(e.message);
    if (process.env.DEBUG) console.error(e);
    process.exit(1);
  }
}

main();
