// Temporary one-shot migration runner — delete after use.
// POST /api/run-migrations  { "dbUrl": "postgresql://...", "secret": "..." }

const ALLOWED_SECRET = "gs1-migrate-2026";

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  let body = "";
  await new Promise(r => { req.on("data", d => body += d); req.on("end", r); });
  let payload;
  try { payload = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); }

  if (payload.secret !== ALLOWED_SECRET) return res.status(403).json({ error: "forbidden" });

  const { Client } = require("pg");
  const fs = require("fs");
  const path = require("path");

  const dbUrl = payload.dbUrl;
  if (!dbUrl) return res.status(400).json({ error: "dbUrl required" });

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });

  try {
    await client.connect();

    // Ensure migration tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _gs1_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz DEFAULT now()
      )
    `);

    const { rows: applied } = await client.query("SELECT version FROM _gs1_migrations");
    const appliedSet = new Set(applied.map(r => r.version));

    const migrationsDir = path.join(__dirname, "../supabase/migrations");
    const files = fs.readdirSync(migrationsDir).sort().filter(f => f.endsWith(".sql"));

    const results = [];
    for (const file of files) {
      const version = file.replace(".sql", "");
      if (appliedSet.has(version)) { results.push({ file, status: "skipped" }); continue; }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _gs1_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", [version]);
        results.push({ file, status: "applied" });
      } catch (e) {
        results.push({ file, status: "error", error: e.message.slice(0, 300) });
        // Continue with remaining migrations
      }
    }

    await client.end();
    res.json({ ok: true, results });
  } catch (e) {
    await client.end().catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  }
};
