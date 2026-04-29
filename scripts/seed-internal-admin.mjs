#!/usr/bin/env node
// Seeds a single admin user in app_data['users'] on whichever Supabase
// project the env points at. Internal PLM auth reads from this row.
//
// Usage: node scripts/seed-internal-admin.mjs [--username admin] [--password <pw>]
//        [--name "Admin"] [--role admin]
// Env:   SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
//
// Loads .env.local + .env.staging.setup automatically.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv(file) {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf-8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadEnv(".env.local");
loadEnv(".env.staging.setup");

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
}

const username = arg("username", "admin");
const password = arg("password", "RofReview2026!");
const displayName = arg("name", "Admin");
const role = arg("role", "admin");

const sha256 = (s) => createHash("sha256").update(s, "utf-8").digest("hex");
const hashed = sha256(password);

const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

console.log(`Target: ${SB_URL}`);
console.log(`User:   ${username} (${displayName}), role=${role}`);

const REST = `${SB_URL}/rest/v1`;
const H = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function getUsersBlob() {
  const r = await fetch(`${REST}/app_data?key=eq.users&select=value`, { headers: H });
  if (!r.ok) throw new Error(`fetch users: HTTP ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  if (!rows.length) return [];
  try { return JSON.parse(rows[0].value) || []; } catch { return []; }
}

async function upsertUsersBlob(users) {
  const value = JSON.stringify(users);
  // Try update first
  const upd = await fetch(`${REST}/app_data?key=eq.users`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ value }),
  });
  if (upd.ok) {
    const body = await upd.json();
    if (Array.isArray(body) && body.length) return;
  }
  // Fall back to insert
  const ins = await fetch(`${REST}/app_data`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ key: "users", value }),
  });
  if (!ins.ok) throw new Error(`insert users: HTTP ${ins.status}: ${await ins.text()}`);
}

const users = await getUsersBlob();
const idx = users.findIndex((u) => (u.username || "").toLowerCase() === username.toLowerCase());
const record = {
  id: users[idx]?.id || randomUUID(),
  username,
  name: displayName,
  password: hashed,
  role,
  color: users[idx]?.color || "#3B82F6",
  initials: users[idx]?.initials || displayName.slice(0, 2).toUpperCase(),
};
if (idx >= 0) users[idx] = record; else users.push(record);

await upsertUsersBlob(users);

console.log(`\n✓ Seeded internal user.`);
console.log(`  URL:      http://localhost:5173/`);
console.log(`  Username: ${username}`);
console.log(`  Password: ${password}`);
console.log(`  Total users in app_data['users']: ${users.length}`);
