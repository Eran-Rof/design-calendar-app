#!/usr/bin/env node
// scripts/regenerate-schema-doc.mjs
//
// Tangerine cross-cutter T5 — generate docs/tangerine/CURRENT-SCHEMA.md
// from supabase/migrations/*.sql.
//
// Purpose: a single source of truth for "what columns currently exist on
// what tables" so future SQL bundles don't reference made-up column
// names (the bug class that hit P7-1 with payment_method vs
// customer_payment_method, and P7-1/P7-4 with is_active vs status).
//
// Run: node scripts/regenerate-schema-doc.mjs
//      (re-runs are idempotent; output is deterministic)
//
// Strategy: regex-find every `CREATE TABLE ... (`, then paren-balance-scan
// to find the matching `)`. Same for `ALTER TABLE ADD/DROP COLUMN`. Skip
// CREATE INDEX / FUNCTION / TRIGGER / VIEW / DO / NOTIFY / COMMENT etc.
// since those don't help avoid column-name bugs.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase/migrations");
const OUT_PATH = resolve(REPO_ROOT, "docs/tangerine/CURRENT-SCHEMA.md");

// ─── Find matching close-paren respecting nested parens + quoted strings ──
//
// Given a string and the index of an opening `(`, return the index of the
// matching `)`. Handles nested parens, single-quoted strings ('...''...'),
// and dollar-quoted bodies ($$...$$ or $tag$...$tag$).
function findMatchingClose(s, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "'") {
      i += 1;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue; }
        if (s[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === "$") {
      const m = s.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (m) {
        const tag = m[0];
        i += tag.length;
        const closeIdx = s.indexOf(tag, i);
        if (closeIdx === -1) return -1; // unterminated
        i = closeIdx + tag.length;
        continue;
      }
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    i += 1;
  }
  return depth === 0 ? i - 1 : -1;
}

function stripLineComments(sql) {
  // Strip -- comments but preserve newlines so positions stay aligned.
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

// ─── Find every CREATE TABLE block ─────────────────────────────────────────

function findCreateTables(sql) {
  const out = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_.]*)"?\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const openIdx = m.index + m[0].length - 1; // index of "("
    const closeIdx = findMatchingClose(sql, openIdx);
    if (closeIdx === -1) continue;
    const inner = sql.slice(openIdx + 1, closeIdx);
    const name = m[1].replace(/^public\./, "");
    out.push({ name, inner });
    re.lastIndex = closeIdx + 1;
  }
  return out;
}

// ─── Find every ALTER TABLE block (ADD COLUMN / DROP COLUMN / ADD CONSTRAINT CHECK) ──

function findAlterTables(sql) {
  const out = [];
  const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_.]*)"?\s+([^;]*?)(?=;|$)/gis;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].replace(/^public\./, "");
    const body = m[2].trim();
    if (!body) continue;
    out.push({ name, body });
  }
  return out;
}

// ─── Split a column list by top-level commas ───────────────────────────────

function splitTopLevelCommas(s) {
  const out = [];
  let buf = "";
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      buf += c;
      i += 1;
      while (i < s.length) {
        buf += s[i];
        if (s[i] === "'" && s[i + 1] === "'") { buf += s[i + 1]; i += 2; continue; }
        if (s[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === "(") { depth += 1; buf += c; i += 1; continue; }
    if (c === ")") { depth -= 1; buf += c; i += 1; continue; }
    if (c === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// ─── Column-def parser ─────────────────────────────────────────────────────

const RESERVED = new Set([
  "constraint", "primary", "foreign", "unique", "check", "exclude", "like",
]);

function parseColumnDef(raw) {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  if (RESERVED.has(firstWord)) return null;
  const m = trimmed.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+(.+)$/);
  if (!m) return null;
  const name = m[1];
  const rest = m[2];

  // Find inline CHECK (...) with paren balance
  let check = null;
  const checkIdx = rest.search(/\bCHECK\s*\(/i);
  if (checkIdx >= 0) {
    const openIdx = rest.indexOf("(", checkIdx);
    const closeIdx = findMatchingClose(rest, openIdx);
    if (closeIdx > 0) check = rest.slice(openIdx + 1, closeIdx).trim();
  }

  const type = extractType(rest);
  const notNull = /\bNOT\s+NULL\b/i.test(rest);
  const defaultMatch = rest.match(/\bDEFAULT\s+(.+?)(?=\s+(?:NOT\s+NULL|REFERENCES|CHECK|UNIQUE|PRIMARY|GENERATED)\b|$)/i);
  const def = defaultMatch ? defaultMatch[1].trim() : null;
  const refMatch = rest.match(/\bREFERENCES\s+"?([a-zA-Z_][a-zA-Z0-9_.]*)"?/i);
  const ref = refMatch ? refMatch[1].replace(/^public\./, "") : null;
  const pk = /\bPRIMARY\s+KEY\b/i.test(rest);
  return { name, type, notNull, default: def, check, ref, pk };
}

function extractType(rest) {
  // Read tokens until a column-clause keyword.
  const tokens = rest.split(/\s+/);
  const stopRe = /^(NOT|DEFAULT|REFERENCES|CHECK|UNIQUE|PRIMARY|GENERATED|COLLATE|CONSTRAINT|ON)$/i;
  const out = [];
  for (const t of tokens) {
    if (stopRe.test(t)) break;
    out.push(t);
  }
  return out.join(" ").trim();
}

function formatColumn(col) {
  const parts = [`\`${col.name}\` ${col.type}`];
  if (col.pk) parts.push("PK");
  if (col.ref) parts.push(`→ \`${col.ref}\``);
  if (col.notNull) parts.push("NOT NULL");
  if (col.default) parts.push(`DEFAULT ${col.default}`);
  if (col.check) parts.push(`CHECK \`${col.check}\``);
  return parts.join(" ");
}

// ─── State machine — accumulate tables across all migration files ──────────

function tagFromFilename(filename) {
  const m = filename.match(/_p(\d+)_chunk(\d+)/i);
  if (m) return `P${m[1]}-${m[2]}`;
  const m2 = filename.match(/_p(\d+)_/i);
  if (m2) return `P${m2[1]}`;
  return "(pre-P)";
}

function applyCreate(tables, origin, ct, tag) {
  const cols = new Map();
  for (const part of splitTopLevelCommas(ct.inner)) {
    const col = parseColumnDef(part);
    if (col) cols.set(col.name, col);
  }
  if (!tables.has(ct.name)) {
    tables.set(ct.name, { columns: cols });
    origin.set(ct.name, tag);
  } else {
    // Merge — keep first-seen definition
    const t = tables.get(ct.name);
    for (const [k, v] of cols) if (!t.columns.has(k)) t.columns.set(k, v);
  }
}

function applyAlter(tables, origin, alt, tag) {
  // Multiple "ADD COLUMN" clauses separated by commas
  const body = alt.body;
  if (/^DROP\s+COLUMN\s+/i.test(body)) {
    const m = body.match(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i);
    if (m && tables.has(alt.name)) tables.get(alt.name).columns.delete(m[1]);
    return;
  }
  if (/^ADD\s+CONSTRAINT/i.test(body)) {
    // ADD CONSTRAINT ... CHECK (col IN (...)) — attach to col if single-col
    const cm = body.match(/CHECK\s*\(([\s\S]+)\)\s*$/i);
    if (cm) {
      const inside = cm[1].trim();
      const colMatch = inside.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+(?:IS\s+NULL\s+OR\s+\1\s+)?IN\s*\(([^)]+)\)/i);
      if (colMatch && tables.has(alt.name)) {
        const t = tables.get(alt.name);
        if (t.columns.has(colMatch[1])) {
          t.columns.get(colMatch[1]).check = `IN (${colMatch[2].trim()})`;
        }
      }
    }
    return;
  }
  // ADD COLUMN (one or many)
  if (!tables.has(alt.name)) {
    tables.set(alt.name, { columns: new Map() });
    origin.set(alt.name, `${tag} (alter only)`);
  }
  const t = tables.get(alt.name);
  const adds = body.split(/,\s*(?=ADD\s+COLUMN)/i);
  for (const a of adds) {
    const m = a.match(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(.+)$/is);
    if (!m) continue;
    const col = parseColumnDef(m[1].trim());
    if (col && !t.columns.has(col.name)) t.columns.set(col.name, col);
  }
}

function main() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const tables = new Map();
  const origin = new Map();
  let totalCreate = 0;
  let totalAlter = 0;

  for (const f of files) {
    const tag = tagFromFilename(f);
    const sql = stripLineComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
    const cts = findCreateTables(sql);
    for (const ct of cts) {
      applyCreate(tables, origin, ct, tag);
      totalCreate += 1;
    }
    const alts = findAlterTables(sql);
    for (const alt of alts) {
      applyAlter(tables, origin, alt, tag);
      totalAlter += 1;
    }
  }

  const names = [...tables.keys()].sort();
  const last = files[files.length - 1];

  const lines = [];
  lines.push("# Tangerine — Current Schema Snapshot");
  lines.push("");
  lines.push("> **AUTO-GENERATED — DO NOT EDIT BY HAND.** Run `node scripts/regenerate-schema-doc.mjs` to refresh.");
  lines.push(">");
  lines.push(`> Generated from \`supabase/migrations/*.sql\` (${files.length} migration files). Latest: \`${last}\`.`);
  lines.push("");
  lines.push("**Purpose:** quick-reference for column names, types, defaults, and CHECK constraints across all currently-shipped Tangerine tables. Read this BEFORE writing any SQL bundle that references existing tables — column-name bugs (`is_active` vs `status`, `payment_method` vs `customer_payment_method`) waste paste cycles.");
  lines.push("");
  lines.push("**Scope of the parser:**");
  lines.push("- ✅ `CREATE TABLE`, `ALTER TABLE ADD/DROP COLUMN`, single-column `ADD CONSTRAINT CHECK ... IN (...)`.");
  lines.push("- ❌ Indexes, triggers, functions/RPCs, RLS policies, views, generated columns, INSERT seeds, COMMENT ON — these don't help avoid column-name bugs and aren't reflected here. For function bodies / RPC signatures, search the migrations directly.");
  lines.push("");
  lines.push(`**Stats:** ${names.length} tables · ${totalCreate} CREATE TABLE · ${totalAlter} ALTER TABLE`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const n of names) {
    const t = tables.get(n);
    lines.push(`## \`${n}\`  _(${origin.get(n) || "(pre-P)"})_`);
    lines.push("");
    if (t.columns.size === 0) {
      lines.push("_(no columns parsed)_");
    } else {
      for (const col of t.columns.values()) lines.push(`- ${formatColumn(col)}`);
    }
    lines.push("");
  }

  writeFileSync(OUT_PATH, lines.join("\n") + "\n");
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  ${names.length} tables · ${totalCreate} CREATE TABLE · ${totalAlter} ALTER TABLE`);
}

main();
