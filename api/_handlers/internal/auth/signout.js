// api/internal/auth/signout
//
// P27 4b/4c — clear the httpOnly per-user JWT cookie (tg_jwt) set by
// /auth/provision. An httpOnly cookie can't be removed by client JS, so
// sign-out must hit this endpoint. Idempotent, unauthenticated (clearing a
// credential needs no credential), POST-only.

export const config = { maxDuration: 5 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Expire the cookie (Max-Age=0). Attributes must match the set so the browser
  // overwrites the right cookie.
  res.setHeader("Set-Cookie", "tg_jwt=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return res.status(200).json({ ok: true });
}
