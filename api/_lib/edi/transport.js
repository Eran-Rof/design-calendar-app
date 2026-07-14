// api/_lib/edi/transport.js
//
// EDI transport to/from a 3PL warehouse. SFTP is LIVE (ssh2-sftp-client, a pure-
// JS client that runs on Vercel serverless — bundled in package.json). AS2/VAN
// are reserved enum values that still store + queue until implemented.
//
// Credentials are resolved, in priority order:
//   1. provider.edi_secret_ciphertext — AES-256-GCM at rest (api/_lib/crypto.js,
//      key VENDOR_DATA_ENCRYPTION_KEY). This is the primary, UI-managed path.
//   2. process.env[provider.edi_credential_ref] — legacy env-var indirection.
// If neither resolves, every operation degrades GRACEFULLY to a clear
// "no credentials configured" outcome — nothing throws, nothing transmits.
//
// Connection shape resolved from the provider row:
//   host      ← edi_endpoint host part
//   port      ← edi_port, else :port in edi_endpoint, else 22
//   username  ← edi_username
//   credential← decrypted secret (password or PEM private key)
//   outboundDir ← edi_outbound_dir, else path suffix of edi_endpoint, else "/"
//   inboundDir  ← edi_inbound_dir  (partner drop dir we poll)
//   archiveDir  ← edi_archive_dir  (where processed inbound files are moved)

import { decryptFieldValue } from "../crypto.js";

const CONNECT_TIMEOUT_MS = 15000;
const OP_TIMEOUT_MS = 60000;

/** Resolve the stored SFTP secret (ciphertext first, env-var ref fallback). */
function resolveCredential(provider) {
  if (!provider) return null;
  if (provider.edi_secret_ciphertext) {
    try {
      const pt = decryptFieldValue(provider.edi_secret_ciphertext);
      if (pt) return pt;
    } catch { /* bad/absent key → fall through to env ref */ }
  }
  if (provider.edi_credential_ref && process.env[provider.edi_credential_ref]) {
    return process.env[provider.edi_credential_ref];
  }
  return null;
}

/**
 * Read a provider's EDI connection config into a normalized shape.
 * Back-compatible superset of the original (sftpPull.js relies on
 * protocol/endpoint/username/credential/credentialRef).
 * @param {object} provider - a tpl_providers row
 */
export function providerEdiConfig(provider) {
  if (!provider) {
    return { protocol: null, endpoint: null, username: null, credentialRef: null, credential: null, host: null, port: 22, outboundDir: "/", inboundDir: null, archiveDir: null, isKey: false };
  }
  const protocol = provider.edi_protocol ? String(provider.edi_protocol).toUpperCase() : null;
  const credentialRef = provider.edi_credential_ref || null;
  const credential = resolveCredential(provider);
  const endpoint = provider.edi_endpoint || null;
  // endpoint format: host[:port][/remote/dir]
  const m = String(endpoint || "").match(/^([^/:]+)(?::(\d+))?(\/.*)?$/);
  const host = m?.[1] || null;
  const port = provider.edi_port || (m?.[2] ? Number(m[2]) : 22);
  const endpointDir = m?.[3] || null;
  const outboundDir = (provider.edi_outbound_dir || endpointDir || "/").replace(/\/$/, "") || "/";
  const inboundDir = provider.edi_inbound_dir ? String(provider.edi_inbound_dir).replace(/\/$/, "") || "/" : null;
  const archiveDir = provider.edi_archive_dir ? String(provider.edi_archive_dir).replace(/\/$/, "") || "/" : null;
  const isKey = credential ? /BEGIN [A-Z ]*PRIVATE KEY/.test(credential) : false;
  return { protocol, endpoint, username: provider.edi_username || null, credentialRef, credential, host, port, outboundDir, inboundDir, archiveDir, isKey };
}

async function loadSftpClient() {
  try {
    const mod = await import("ssh2-sftp-client");
    return mod.default || mod;
  } catch {
    return null;
  }
}

/** Open a connected SFTP client for a config, or throw with a clear message. */
async function openSftp(cfg) {
  const SftpClient = await loadSftpClient();
  if (!SftpClient) throw new Error("'ssh2-sftp-client' dependency not installed");
  const sftp = new SftpClient();
  await sftp.connect({
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.username || undefined,
    readyTimeout: CONNECT_TIMEOUT_MS,
    ...(cfg.isKey ? { privateKey: cfg.credential } : { password: cfg.credential }),
  });
  return sftp;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/** Reasons a provider isn't ready to transmit (null = ready). */
function notReadyReason(cfg) {
  if (!cfg.protocol) return "no edi_protocol configured on the 3PL provider";
  if (cfg.protocol !== "SFTP") return `edi_protocol=${cfg.protocol} configured but only SFTP transport is implemented (AS2/VAN reserved). Payload stored for retry.`;
  if (!cfg.host) return "no edi_endpoint (SFTP host) set on the 3PL provider";
  if (!cfg.credential) return "no SFTP credential configured (set the secret in the 3PL connection form, or edi_credential_ref env var)";
  return null;
}

/**
 * Transmit an EDI payload to a 3PL over SFTP.
 * @returns {Promise<{transmitted:boolean, detail:string}>}
 */
export async function transmitEdi({ payload, provider, filename }) {
  const cfg = providerEdiConfig(provider);
  const reason = notReadyReason(cfg);
  if (reason) return { transmitted: false, detail: `queued: ${reason}` };

  const remotePath = `${cfg.outboundDir.replace(/\/$/, "")}/${filename || `940_${Date.now()}.edi`}`;
  let sftp;
  try {
    sftp = await openSftp(cfg);
    await withTimeout(sftp.put(Buffer.from(payload, "utf8"), remotePath), OP_TIMEOUT_MS, "SFTP put");
    await sftp.end();
    return { transmitted: true, detail: `SFTP upload OK → ${cfg.host}:${cfg.port}${remotePath}` };
  } catch (e) {
    try { if (sftp) await sftp.end(); } catch { /* ignore */ }
    return { transmitted: false, detail: `SFTP upload failed (${cfg.host}:${cfg.port}): ${e?.message || e}. Payload stored for retry.` };
  }
}

/**
 * Test an SFTP connection: connect + list the outbound (and inbound, if set)
 * directory. Never throws — returns a structured result for the UI button.
 * @returns {Promise<{ok:boolean, detail:string, dirs?:object}>}
 */
export async function testConnection(provider) {
  const cfg = providerEdiConfig(provider);
  if (!cfg.protocol) return { ok: false, detail: "No transport configured — set the protocol (SFTP) first." };
  if (cfg.protocol !== "SFTP") return { ok: false, detail: `Transport ${cfg.protocol} not testable yet (only SFTP is implemented).` };
  if (!cfg.host) return { ok: false, detail: "No SFTP host set (edi_endpoint)." };
  if (!cfg.credential) return { ok: false, detail: "No SFTP credential configured. Enter the password or private key in the connection form." };

  let sftp;
  try {
    sftp = await openSftp(cfg);
    const dirs = {};
    const outList = await withTimeout(sftp.list(cfg.outboundDir), OP_TIMEOUT_MS, "SFTP list");
    dirs.outbound = { path: cfg.outboundDir, entries: (outList || []).length };
    if (cfg.inboundDir) {
      try {
        const inList = await withTimeout(sftp.list(cfg.inboundDir), OP_TIMEOUT_MS, "SFTP list");
        dirs.inbound = { path: cfg.inboundDir, entries: (inList || []).length };
      } catch (e) {
        dirs.inbound = { path: cfg.inboundDir, error: e?.message || String(e) };
      }
    }
    await sftp.end();
    const inPart = dirs.inbound ? (dirs.inbound.error ? `, inbound ${cfg.inboundDir} ERROR: ${dirs.inbound.error}` : `, inbound ${cfg.inboundDir} (${dirs.inbound.entries} files)`) : "";
    return { ok: true, detail: `Connected to ${cfg.host}:${cfg.port}. Outbound ${cfg.outboundDir} (${dirs.outbound.entries} files)${inPart}.`, dirs };
  } catch (e) {
    try { if (sftp) await sftp.end(); } catch { /* ignore */ }
    return { ok: false, detail: `Connection failed (${cfg.host}:${cfg.port}): ${e?.message || e}` };
  }
}

/**
 * Poll the provider's inbound directory: list EDI files, download the ones the
 * caller hasn't seen, and (optionally) archive each after the caller confirms.
 *
 * Returns downloaded files; archiving is deferred to `archiveInboundFile` so the
 * cron only moves a file AFTER it's durably recorded in edi_messages.
 *
 * @param {object} provider
 * @param {object} [opts]
 * @param {(name:string)=>boolean} [opts.alreadyIngested] - filter by filename
 * @param {number} [opts.maxFiles]
 * @returns {Promise<{ok:boolean, detail:string, files:Array<{name,content,mtime}>}>}
 */
export async function pollInbound(provider, opts = {}) {
  const cfg = providerEdiConfig(provider);
  if ((cfg.protocol || "SFTP") !== "SFTP") return { ok: false, detail: `skip: edi_protocol=${cfg.protocol} (only SFTP poll supported)`, files: [] };
  if (!cfg.inboundDir) return { ok: false, detail: "skip: no edi_inbound_dir set on the provider", files: [] };
  if (!cfg.host) return { ok: false, detail: "skip: no edi_endpoint (SFTP host) set", files: [] };
  if (!cfg.credential) return { ok: false, detail: "skip: no SFTP credential configured", files: [] };

  const maxFiles = Math.max(1, Math.min(50, opts.maxFiles || 25));
  const alreadyIngested = typeof opts.alreadyIngested === "function" ? opts.alreadyIngested : () => false;

  let sftp;
  try {
    sftp = await openSftp(cfg);
    const entries = (await withTimeout(sftp.list(cfg.inboundDir), OP_TIMEOUT_MS, "SFTP list")) || [];
    const candidates = entries
      .filter((e) => e.type === "-")
      .filter((e) => /\.(edi|x12|txt|dat|940|944|945|846|997|out)$/i.test(e.name) || /(edi|944|945|846|997|asn|ship|receipt|ack)/i.test(e.name))
      .filter((e) => !alreadyIngested(e.name))
      .sort((a, b) => (a.modifyTime || 0) - (b.modifyTime || 0))
      .slice(0, maxFiles);

    const files = [];
    for (const f of candidates) {
      try {
        const buf = await withTimeout(sftp.get(`${cfg.inboundDir}/${f.name}`), OP_TIMEOUT_MS, "SFTP get");
        const content = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
        files.push({ name: f.name, content, mtime: f.modifyTime });
      } catch (e) {
        files.push({ name: f.name, content: null, mtime: f.modifyTime, error: e?.message || String(e) });
      }
    }
    await sftp.end();
    return { ok: true, detail: `polled ${cfg.host}:${cfg.port}${cfg.inboundDir}: ${files.length} new file(s)`, files };
  } catch (e) {
    try { if (sftp) await sftp.end(); } catch { /* ignore */ }
    return { ok: false, detail: `SFTP poll failed (${cfg.host}:${cfg.port}${cfg.inboundDir}): ${e?.message || e}`, files: [] };
  }
}

/**
 * Move a processed inbound file into the archive dir (rename). No-op (ok:true)
 * when no archive dir is configured — dedupe still holds via ISA control number.
 */
export async function archiveInboundFile(provider, fileName) {
  const cfg = providerEdiConfig(provider);
  if (!cfg.archiveDir) return { ok: true, detail: "no archive dir configured — left in place" };
  if (!cfg.inboundDir || !cfg.host || !cfg.credential) return { ok: false, detail: "cannot archive: incomplete SFTP config" };
  let sftp;
  try {
    sftp = await openSftp(cfg);
    const from = `${cfg.inboundDir}/${fileName}`;
    const to = `${cfg.archiveDir}/${fileName}`;
    await withTimeout(sftp.rename(from, to), OP_TIMEOUT_MS, "SFTP rename");
    await sftp.end();
    return { ok: true, detail: `archived → ${to}` };
  } catch (e) {
    try { if (sftp) await sftp.end(); } catch { /* ignore */ }
    return { ok: false, detail: `archive failed for ${fileName}: ${e?.message || e}` };
  }
}
