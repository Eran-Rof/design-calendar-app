// Unit tests for the MS Graph helper. Uses a stub fetch so the test
// can assert URL + method + headers without touching the network.
// Covers: token fetched + sent as bearer, JSON body forwarded for POST,
// 401 fires onSessionExpired, other non-2xx surfaces the response text.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { graphGet, graphPost, type GraphSession } from "../msGraph";

function makeSession(over: Partial<GraphSession> = {}): GraphSession {
  return {
    getToken: vi.fn(async () => "TOKEN_123"),
    onSessionExpired: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────

describe("graphGet", () => {
  it("calls the bearer token before fetch + sends Authorization header", async () => {
    const session = makeSession();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await graphGet("/me", session);
    expect(session.getToken).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me");
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer TOKEN_123");
  });

  it("returns the parsed JSON body", async () => {
    const session = makeSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ displayName: "Eran" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const res = await graphGet("/me", session);
    expect(res).toEqual({ displayName: "Eran" });
  });

  it("invokes onSessionExpired + throws on 401", async () => {
    const session = makeSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    await expect(graphGet("/me", session)).rejects.toThrow(/Session expired/);
    expect(session.onSessionExpired).toHaveBeenCalledOnce();
  });

  it("throws on non-2xx with status + response text", async () => {
    const session = makeSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );
    await expect(graphGet("/me", session)).rejects.toThrow(/Graph 500.*Internal Server Error/);
    expect(session.onSessionExpired).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("graphPost", () => {
  it("JSON-stringifies the body + sets POST method", async () => {
    const session = makeSession();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg-1" }), { status: 201, headers: { "Content-Type": "application/json" } }),
    );
    await graphPost("/teams/T1/channels/C1/messages", { body: { content: "hello" } }, session);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/teams/T1/channels/C1/messages");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ body: { content: "hello" } }));
  });

  it("returns the parsed JSON body", async () => {
    const session = makeSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg-1" }), { status: 201, headers: { "Content-Type": "application/json" } }),
    );
    const res = await graphPost("/teams/T1/channels/C1/messages", { hello: "world" }, session);
    expect(res).toEqual({ id: "msg-1" });
  });

  it("401 fires onSessionExpired on POST too", async () => {
    const session = makeSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(graphPost("/x", {}, session)).rejects.toThrow(/Session expired/);
    expect(session.onSessionExpired).toHaveBeenCalledOnce();
  });
});
