// api/_lib/edi/sftpPull.js
//
// Inbound SFTP pull for 3PL inventory files. Connects to the provider's SFTP
// (host/user/credential from the same edi_* config as outbound transport), lists
// its inventory_sftp_path directory, and returns the NEWEST file that hasn't been
// ingested yet (name ≠ provider.last_inventory_file). The nightly recon cron
// then parses + reconciles it.
//
// Reuses the optional 'ssh2-sftp-client' dependency (dynamic import) — if it's
// absent the pull degrades to a clear "not installed" detail instead of throwing.

import { providerEdiConfig } from "./transport.js";

// Parse host[:port] from edi_endpoint (its trailing /dir is for OUTBOUND; the
// inbound directory comes from inventory_sftp_path).
function hostPort(endpoint) {
  const m = String(endpoint || "").match(/^([^/:]+)(?::(\d+))?/);
  return { host: m?.[1] || null, port: m?.[2] ? Number(m[2]) : 22 };
}

/**
 * Pull the newest un-ingested inventory file for a provider.
 * @returns {Promise<{ ok:boolean, file?:{name,content,mtime}, detail:string }>}
 */
export async function pullLatestInventoryFile(provider) {
  const cfg = providerEdiConfig(provider);
  if ((cfg.protocol || "SFTP") !== "SFTP") return { ok: false, detail: `skip: edi_protocol=${cfg.protocol} (only SFTP pull supported)` };
  if (!provider.inventory_sftp_path) return { ok: false, detail: "skip: no inventory_sftp_path set on the provider" };
  if (!cfg.endpoint) return { ok: false, detail: "skip: no edi_endpoint (SFTP host) set" };
  if (!cfg.credential) return { ok: false, detail: `skip: credential env var ${cfg.credentialRef ? `'${cfg.credentialRef}'` : "(edi_credential_ref unset)"} not set` };

  let SftpClient;
  try {
    ({ default: SftpClient } = await import("ssh2-sftp-client"));
  } catch {
    return { ok: false, detail: "skip: 'ssh2-sftp-client' dependency not installed — run 'npm i ssh2-sftp-client' to enable SFTP pull" };
  }

  const { host, port } = hostPort(cfg.endpoint);
  const dir = String(provider.inventory_sftp_path).replace(/\/$/, "") || "/";
  const isKey = /BEGIN [A-Z ]*PRIVATE KEY/.test(cfg.credential);
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host, port, username: cfg.username || undefined, ...(isKey ? { privateKey: cfg.credential } : { password: cfg.credential }) });
    const entries = (await sftp.list(dir)) || [];
    // Files only; prefer inventory-ish names; newest by modifyTime.
    const files = entries
      .filter((e) => e.type === "-")
      .filter((e) => /\.(csv|txt|edi|x12|846|dat)$/i.test(e.name) || /(inv|inventory|onhand|846|stock)/i.test(e.name))
      .sort((a, b) => (b.modifyTime || 0) - (a.modifyTime || 0));
    if (files.length === 0) { await sftp.end(); return { ok: false, detail: `no inventory files in ${host}:${port}${dir}` }; }
    const newest = files[0];
    if (provider.last_inventory_file && newest.name === provider.last_inventory_file) {
      await sftp.end();
      return { ok: false, detail: `already ingested latest file '${newest.name}'` };
    }
    const buf = await sftp.get(`${dir}/${newest.name}`);
    await sftp.end();
    const content = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    return { ok: true, file: { name: newest.name, content, mtime: newest.modifyTime }, detail: `pulled ${newest.name} (${content.length} bytes) from ${host}:${port}${dir}` };
  } catch (e) {
    try { await sftp.end(); } catch { /* ignore */ }
    return { ok: false, detail: `SFTP pull failed (${host}:${port}${dir}): ${e?.message || e}` };
  }
}
