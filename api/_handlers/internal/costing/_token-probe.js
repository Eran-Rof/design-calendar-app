// api/internal/costing/_token-probe
//
// Diagnostic-only. Returns whether server's INTERNAL_API_TOKEN env var
// matches the Authorization Bearer token the browser sent. Never reveals
// the full token — only length + first/last 4 chars. Safe to ship to prod
// for a short window to debug auth mismatches; delete after.

export const config = { maxDuration: 5 };

function summary(s) {
  if (!s) return { present: false };
  return {
    present: true,
    length: s.length,
    first4: s.slice(0, 4),
    last4: s.slice(-4),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const serverToken = process.env.INTERNAL_API_TOKEN || null;
  const header = req.headers?.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  let match = null;
  if (serverToken && presented) {
    match = serverToken === presented;
  }

  return res.status(200).json({
    server: summary(serverToken),
    presented: summary(presented),
    match,
    note: "Diagnostic endpoint — delete after use. Reveals only length + first/last 4 chars.",
  });
}
