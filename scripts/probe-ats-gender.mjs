// One-shot: fetch the live ATS blob via anon key, unpack the gzip envelope,
// and report gender values for RYB1477* + overall gender distribution.
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(text.split("\n")
      .filter(l => l.includes("=") && !l.startsWith("#"))
      .map(l => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local"), ...loadEnv(".env") };
const URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_KEY;
if (!URL || !ANON) { console.error("missing supabase url/anon", { URL: !!URL, ANON: !!ANON }); process.exit(1); }

const r = await fetch(`${URL}/rest/v1/app_data?key=eq.ats_excel_data&select=value,updated_at`, {
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
});
const rows = await r.json();
if (!Array.isArray(rows) || !rows.length) { console.error("no blob row", rows); process.exit(1); }
let value = rows[0].value;
function unpack(v) {
  if (v == null) return null;
  if (typeof v === "object") {
    if ("_gz" in v && typeof v._gz === "string") return JSON.parse(gunzipSync(Buffer.from(v._gz, "base64")).toString("utf-8"));
    return v;
  }
  let p; try { p = JSON.parse(v); } catch { return null; }
  if (p && typeof p === "object" && "_gz" in p) return JSON.parse(gunzipSync(Buffer.from(p._gz, "base64")).toString("utf-8"));
  return p;
}
const data = unpack(value);
const skus = data?.skus || data?.rows || [];
console.log("blob updated_at:", rows[0].updated_at, "| syncedAt:", data?.syncedAt, "| sku rows:", skus.length);

// gender distribution overall
const dist = {};
let withGender = 0;
for (const s of skus) {
  const g = (s.gender ?? "").toString().trim();
  dist[g || "(blank)"] = (dist[g || "(blank)"] || 0) + 1;
  if (g) withGender++;
}
console.log(`\nrows with ANY gender: ${withGender} / ${skus.length}`);
console.log("gender distribution:", JSON.stringify(dist, null, 2));

// RYB1477 rows
const hits = skus.filter(s => String(s.sku || "").toUpperCase().includes("RYB1477"));
console.log(`\nRYB1477* rows (${hits.length}):`);
for (const s of hits) {
  console.log(`  sku="${s.sku}" store=${s.store} gender="${s.gender ?? ""}" category="${s.category ?? ""}" master_category="${s.master_category ?? ""}"`);
}
