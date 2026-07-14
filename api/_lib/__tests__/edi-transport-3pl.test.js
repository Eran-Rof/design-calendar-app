// Tests for the SFTP transport layer (api/_lib/edi/transport.js).
// The SFTP client is fully mocked — no network. Covers encrypted-credential
// resolution, send, graceful no-creds failure, test-connection, and inbound
// poll dedupe filtering.

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.VENDOR_DATA_ENCRYPTION_KEY = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

const state = vi.hoisted(() => ({
  put: [], list: [], getReturn: "ISA-CONTENT", connectArgs: null, failConnect: false, renamed: [],
}));

vi.mock("ssh2-sftp-client", () => {
  class MockSftp {
    async connect(args) { state.connectArgs = args; if (state.failConnect) throw new Error("connect refused"); }
    async put(buf, path) { state.put.push({ path, content: buf.toString("utf8") }); }
    async list() { return state.list; }
    async get() { return Buffer.from(state.getReturn, "utf8"); }
    async rename(from, to) { state.renamed.push({ from, to }); }
    async end() { /* noop */ }
  }
  return { default: MockSftp };
});

const { transmitEdi, testConnection, pollInbound, providerEdiConfig, archiveInboundFile } = await import("../edi/transport.js");
const { encryptFieldValue } = await import("../crypto.js");

function provider(overrides = {}) {
  return {
    edi_protocol: "SFTP",
    edi_endpoint: "sftp.3pl.example.com",
    edi_port: 2222,
    edi_username: "ringoffire",
    edi_secret_ciphertext: encryptFieldValue("s3cr3t-pw"),
    edi_outbound_dir: "/to_wh",
    edi_inbound_dir: "/from_wh",
    edi_archive_dir: "/archive",
    ...overrides,
  };
}

beforeEach(() => {
  state.put = []; state.list = []; state.getReturn = "ISA-CONTENT"; state.connectArgs = null; state.failConnect = false; state.renamed = [];
});

describe("providerEdiConfig — credential resolution", () => {
  it("decrypts the stored ciphertext secret", () => {
    const cfg = providerEdiConfig(provider());
    expect(cfg.credential).toBe("s3cr3t-pw");
    expect(cfg.host).toBe("sftp.3pl.example.com");
    expect(cfg.port).toBe(2222);
    expect(cfg.outboundDir).toBe("/to_wh");
    expect(cfg.inboundDir).toBe("/from_wh");
  });
  it("falls back to an env-var reference when no ciphertext", () => {
    process.env.MY_SFTP_KEY = "env-pw";
    const cfg = providerEdiConfig(provider({ edi_secret_ciphertext: null, edi_credential_ref: "MY_SFTP_KEY" }));
    expect(cfg.credential).toBe("env-pw");
    delete process.env.MY_SFTP_KEY;
  });
  it("detects a PEM private key vs a password", () => {
    const cfg = providerEdiConfig(provider({ edi_secret_ciphertext: encryptFieldValue("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----") }));
    expect(cfg.isKey).toBe(true);
  });
});

describe("transmitEdi", () => {
  it("uploads to the outbound dir on success", async () => {
    const r = await transmitEdi({ payload: "ISA*...~", provider: provider(), filename: "940_X.edi" });
    expect(r.transmitted).toBe(true);
    expect(state.put[0].path).toBe("/to_wh/940_X.edi");
    expect(state.connectArgs.port).toBe(2222);
    expect(state.connectArgs.password).toBe("s3cr3t-pw");
    expect(state.connectArgs.readyTimeout).toBeGreaterThan(0);
  });
  it("queues gracefully when no credential is configured", async () => {
    const r = await transmitEdi({ payload: "x", provider: provider({ edi_secret_ciphertext: null }) });
    expect(r.transmitted).toBe(false);
    expect(r.detail).toMatch(/queued/i);
    expect(state.put.length).toBe(0);
  });
  it("queues gracefully when no protocol is configured", async () => {
    const r = await transmitEdi({ payload: "x", provider: provider({ edi_protocol: null }) });
    expect(r.transmitted).toBe(false);
    expect(r.detail).toMatch(/no edi_protocol/i);
  });
  it("reports a failed upload without throwing", async () => {
    state.failConnect = true;
    const r = await transmitEdi({ payload: "x", provider: provider() });
    expect(r.transmitted).toBe(false);
    expect(r.detail).toMatch(/failed/i);
  });
});

describe("testConnection", () => {
  it("succeeds and reports directory listings", async () => {
    state.list = [{ type: "-", name: "a.edi", modifyTime: 1 }];
    const r = await testConnection(provider());
    expect(r.ok).toBe(true);
    expect(r.dirs.outbound.path).toBe("/to_wh");
    expect(r.detail).toMatch(/Connected/);
  });
  it("fails cleanly with no credential", async () => {
    const r = await testConnection(provider({ edi_secret_ciphertext: null }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/credential/i);
  });
});

describe("pollInbound", () => {
  it("returns new EDI files, skipping already-ingested ones", async () => {
    state.list = [
      { type: "-", name: "945_new.edi", modifyTime: 20 },
      { type: "-", name: "945_seen.edi", modifyTime: 10 },
      { type: "d", name: "subdir", modifyTime: 5 },
    ];
    const r = await pollInbound(provider(), { alreadyIngested: (n) => n === "945_seen.edi" });
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.name)).toEqual(["945_new.edi"]);
    expect(r.files[0].content).toBe("ISA-CONTENT");
  });
  it("skips when no inbound dir is configured", async () => {
    const r = await pollInbound(provider({ edi_inbound_dir: null }));
    expect(r.ok).toBe(false);
    expect(r.files).toEqual([]);
  });
});

describe("archiveInboundFile", () => {
  it("renames the file into the archive dir", async () => {
    const r = await archiveInboundFile(provider(), "945_new.edi");
    expect(r.ok).toBe(true);
    expect(state.renamed[0]).toEqual({ from: "/from_wh/945_new.edi", to: "/archive/945_new.edi" });
  });
  it("is a no-op when no archive dir is set", async () => {
    const r = await archiveInboundFile(provider({ edi_archive_dir: null }), "x.edi");
    expect(r.ok).toBe(true);
    expect(state.renamed.length).toBe(0);
  });
});
