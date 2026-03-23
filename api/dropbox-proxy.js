// api/dropbox-proxy.js — Vercel Serverless Function for Dropbox file operations
// Handles token refresh automatically using the refresh token

export const config = { maxDuration: 60 };


let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const appKey = (process.env.DROPBOX_APP_KEY || "").trim();
  const appSecret = (process.env.DROPBOX_APP_SECRET || "").trim();
  const refreshToken = (process.env.DROPBOX_REFRESH_TOKEN || "").trim();
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(appKey)}&client_secret=${encodeURIComponent(appSecret)}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Token refresh failed: " + text);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000; // refresh 5 min early
  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Dropbox-Path, X-Dropbox-Action");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const token = await getAccessToken();
    const action = req.headers["x-dropbox-action"] || req.query.action;
    const dbxPath = req.headers["x-dropbox-path"] || req.query.path;

    if (action === "upload") {
      // Upload file
      if (!dbxPath) return res.status(400).json({ error: "Missing path" });

      // Get raw file bytes — handle both parsed and unparsed body
      let fileBody;
      try {
        fileBody = await getRawBody(req);
      } catch (e) {
        // Body may have been consumed by Vercel's parser
        if (req.body) {
          fileBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
        } else {
          fileBody = Buffer.alloc(0);
        }
      }

      const dbxRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Dropbox-API-Arg": JSON.stringify({
            path: dbxPath,
            mode: "overwrite",
            autorename: true,
            mute: false,
          }),
          "Content-Type": "application/octet-stream",
        },
        body: fileBody,
      });

      const data = await dbxRes.json();
      if (!dbxRes.ok) return res.status(dbxRes.status).json(data);

      // Create shared link for the file
      let url = "";
      try {
        const linkRes = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: data.path_display,
            settings: { requested_visibility: "public", audience: "public", access: "viewer" },
          }),
        });
        const linkData = await linkRes.json();
        if (linkData.url) {
          url = linkData.url.replace("dl=0", "raw=1");
        } else if (linkData.error && linkData.error[".tag"] === "shared_link_already_exists") {
          // Get existing shared link
          const existRes = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ path: data.path_display, direct_only: true }),
          });
          const existData = await existRes.json();
          if (existData.links && existData.links.length > 0) {
            url = existData.links[0].url.replace("dl=0", "raw=1");
          }
        }
      } catch (e) {
        console.warn("Shared link creation failed:", e.message);
      }

      return res.status(200).json({ ...data, shared_url: url });

    } else if (action === "delete") {
      if (!dbxPath) return res.status(400).json({ error: "Missing path" });

      const dbxRes = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: dbxPath }),
      });

      const data = await dbxRes.json();
      return res.status(200).json(data);

    } else if (action === "list") {
      if (!dbxPath) return res.status(400).json({ error: "Missing path" });

      const dbxRes = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: dbxPath, recursive: false }),
      });

      const data = await dbxRes.json();
      return res.status(200).json(data);

    } else {
      return res.status(400).json({ error: "Unknown action. Use: upload, delete, list" });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Helper to read raw body from request
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
