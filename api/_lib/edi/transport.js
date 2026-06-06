// api/_lib/edi/transport.js
//
// Outbound EDI transport for warehouse/3PL messages (940 etc).
//
// HONEST STATE: live transmission requires the 3PL's real endpoint +
// credentials (SFTP host/user/key, AS2 cert, or VAN identifiers). Those are
// operator-provided and stored on the tpl_providers row (edi_protocol,
// edi_endpoint, edi_username, edi_credential_ref → an env var NAME holding the
// secret). No SFTP/AS2 library is bundled (deliberately — no heavy native deps),
// so this module:
//
//   • If the provider has a configured protocol + endpoint + a resolvable
//     credential, it ATTEMPTS delivery for protocols we can do without native
//     deps. Today that set is empty (SFTP needs ssh2, AS2 needs crypto envelope
//     tooling), so every protocol currently STORES + QUEUES and returns
//     transmitted=false with a clear reason.
//   • If nothing is configured, it stores + queues (transmitted=false).
//
// When the operator wires a real transport (add ssh2 + an SFTP step here, or an
// AS2 sender), only the `attempt*` branch below changes — callers and the DB
// schema already carry the transmitted flag + transport_detail.

/**
 * Read a provider's EDI connection config into a normalized shape.
 * @param {object} provider - a tpl_providers row
 */
export function providerEdiConfig(provider) {
  if (!provider) return { protocol: null, endpoint: null, username: null, credentialRef: null, credential: null };
  const protocol = provider.edi_protocol ? String(provider.edi_protocol).toUpperCase() : null;
  const credentialRef = provider.edi_credential_ref || null;
  // The credential REF names an env var; we resolve it here (never store the secret).
  const credential = credentialRef && process.env[credentialRef] ? process.env[credentialRef] : null;
  return {
    protocol,
    endpoint: provider.edi_endpoint || null,
    username: provider.edi_username || null,
    credentialRef,
    credential,
  };
}

/**
 * Transmit an EDI payload to a 3PL.
 * @param {object} args
 * @param {string} args.payload   - raw X12 envelope string
 * @param {object} args.provider  - tpl_providers row (carries edi_* config)
 * @param {string} [args.filename]- suggested remote filename
 * @returns {Promise<{transmitted:boolean, detail:string}>}
 */
export async function transmitEdi({ payload, provider, filename }) {
  const cfg = providerEdiConfig(provider);

  if (!cfg.protocol) {
    return { transmitted: false, detail: "queued: no edi_protocol configured on the 3PL provider (set edi_protocol/edi_endpoint/edi_username/edi_credential_ref on the tpl_providers row)" };
  }
  if (!cfg.endpoint) {
    return { transmitted: false, detail: `queued: edi_protocol=${cfg.protocol} but no edi_endpoint set on the 3PL provider` };
  }
  if (!cfg.credential) {
    return { transmitted: false, detail: `queued: edi_protocol=${cfg.protocol} endpoint=${cfg.endpoint} but credential env var ${cfg.credentialRef ? `'${cfg.credentialRef}'` : "(edi_credential_ref unset)"} is not set in the environment` };
  }

  // Fully configured. Attempt the protocol-specific send.
  try {
    if (cfg.protocol === "SFTP") {
      return await attemptSftp({ payload, cfg, filename });
    }
    if (cfg.protocol === "AS2") {
      return { transmitted: false, detail: `queued: AS2 endpoint=${cfg.endpoint} configured but AS2 sending is not yet implemented (no AS2 library bundled). Payload stored for retry.` };
    }
    if (cfg.protocol === "VAN") {
      return { transmitted: false, detail: `queued: VAN endpoint=${cfg.endpoint} configured but VAN delivery is not yet implemented. Payload stored for retry.` };
    }
    return { transmitted: false, detail: `queued: unknown edi_protocol '${cfg.protocol}'` };
  } catch (e) {
    return { transmitted: false, detail: `transmit error (${cfg.protocol} → ${cfg.endpoint}): ${e?.message || e}` };
  }
}

// SFTP upload. Requires the optional 'ssh2-sftp-client' dependency. It is NOT in
// package.json (no heavy native dep added), so this performs a dynamic import and
// gracefully queues if the module is absent — flipping to live transport is then
// just `npm i ssh2-sftp-client` + operator config, no code change here.
async function attemptSftp({ payload, cfg, filename }) {
  let SftpClient;
  try {
    ({ default: SftpClient } = await import("ssh2-sftp-client"));
  } catch {
    return { transmitted: false, detail: `queued: SFTP configured (endpoint=${cfg.endpoint}) but the 'ssh2-sftp-client' dependency is not installed. Run 'npm i ssh2-sftp-client' to enable live SFTP delivery. Payload stored for retry.` };
  }
  // endpoint format: host[:port][/remote/dir]
  const m = String(cfg.endpoint).match(/^([^/:]+)(?::(\d+))?(\/.*)?$/);
  const host = m?.[1];
  const port = m?.[2] ? Number(m[2]) : 22;
  const remoteDir = m?.[3] || "/";
  const remotePath = `${remoteDir.replace(/\/$/, "")}/${filename || `940_${Date.now()}.edi`}`;
  const sftp = new SftpClient();
  try {
    // credential is either an SSH private key (PEM) or a password.
    const isKey = /BEGIN [A-Z ]*PRIVATE KEY/.test(cfg.credential);
    await sftp.connect({
      host, port, username: cfg.username || undefined,
      ...(isKey ? { privateKey: cfg.credential } : { password: cfg.credential }),
    });
    await sftp.put(Buffer.from(payload, "utf8"), remotePath);
    await sftp.end();
    return { transmitted: true, detail: `SFTP upload OK → ${host}:${port}${remotePath}` };
  } catch (e) {
    try { await sftp.end(); } catch { /* ignore */ }
    return { transmitted: false, detail: `SFTP upload failed (${host}:${port}): ${e?.message || e}. Payload stored for retry.` };
  }
}
