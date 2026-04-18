// api/debug-env.js — temporary diagnostic endpoint.
// Reports which env vars are present and the first/last 4 chars of each.
// Delete after debugging.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  function preview(v) {
    if (!v) return null;
    return { length: v.length, head: v.slice(0, 4), tail: v.slice(-4) };
  }

  res.status(200).json({
    VITE_XORO_API_KEY:         preview(process.env.VITE_XORO_API_KEY),
    VITE_XORO_API_SECRET:      preview(process.env.VITE_XORO_API_SECRET),
    VITE_SUPABASE_URL:         preview(process.env.VITE_SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: preview(process.env.SUPABASE_SERVICE_ROLE_KEY),
    SEARATES_API_KEY:          preview(process.env.SEARATES_API_KEY),
    deployed_at:               new Date().toISOString(),
  });
}
