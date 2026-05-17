// Tests for the Teams panel URL/payload builders + slug rules.
// The Teams panel pivots on stable channel names (`tp-{slug}`) so
// reopening a tech pack finds the same conversation. The slug
// algorithm + the channel-create payload shape are what this
// suite pins.

import { describe, it, expect } from "vitest";
import {
  slugifyTPName,
  findRofTeam,
  keepRealMessages,
  buildChannelsListUrl,
  buildChannelMessagesUrl,
  buildChatMessagesUrl,
  buildChannelCreatePayload,
  buildChannelMessagePayload,
  buildOneOnOneChatPayload,
} from "../tpTeams";

// ────────────────────────────────────────────────────────────────────────

describe("slugifyTPName", () => {
  it("lowercases + collapses non-alphanumeric runs to '-'", () => {
    expect(slugifyTPName("Bartram T-Shirt v2")).toBe("tp-bartram-t-shirt-v2");
  });

  it("strips leading + trailing '-' produced by the collapse", () => {
    expect(slugifyTPName("  $$$  EDGE  $$$  ")).toBe("tp-edge");
  });

  it("always prefixes `tp-`", () => {
    expect(slugifyTPName("foo").startsWith("tp-")).toBe(true);
    expect(slugifyTPName("")).toBe("tp-"); // pathological — caller protects
  });

  it("caps the body at 48 characters before adding the tp- prefix", () => {
    // 60-char input → first 48 after lowercasing/replacing
    const long = "a".repeat(60);
    const out = slugifyTPName(long);
    // tp- (3) + 48 = 51
    expect(out.length).toBe(51);
    expect(out.startsWith("tp-")).toBe(true);
  });

  it("handles Unicode by treating non-ASCII as separators", () => {
    expect(slugifyTPName("café—résumé")).toBe("tp-caf-r-sum");
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("findRofTeam", () => {
  const teams = [
    { id: "1", displayName: "Marketing" },
    { id: "2", displayName: "Ring Of Fire" },
    { id: "3", displayName: "Other" },
  ];

  it("matches case + whitespace-insensitive", () => {
    expect(findRofTeam(teams)?.id).toBe("2");
    expect(findRofTeam([{ id: "x", displayName: "RingOfFire" }])?.id).toBe("x");
    expect(findRofTeam([{ id: "x", displayName: "RING OF FIRE " }])?.id).toBe("x");
    expect(findRofTeam([{ id: "x", displayName: "  Ring  Of  Fire  " }])?.id).toBe("x");
  });

  it("returns null when no team matches", () => {
    expect(findRofTeam([{ id: "1", displayName: "Marketing" }])).toBeNull();
  });

  it("tolerates undefined displayName", () => {
    expect(findRofTeam([{ id: "x" }])).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("keepRealMessages", () => {
  it("filters out non-message system events", () => {
    const items = [
      { id: "a", messageType: "message" },
      { id: "b", messageType: "systemEventMessage" },
      { id: "c", messageType: "message" },
      { id: "d" /* missing messageType */ },
    ];
    expect(keepRealMessages(items).map(x => x.id)).toEqual(["a", "c"]);
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("URL builders", () => {
  it("buildChannelsListUrl", () => {
    expect(buildChannelsListUrl("T1")).toBe("/teams/T1/channels");
  });

  it("buildChannelMessagesUrl defaults to top=50", () => {
    expect(buildChannelMessagesUrl("T1", "C1")).toBe("/teams/T1/channels/C1/messages?$top=50");
  });

  it("buildChannelMessagesUrl accepts a custom $top", () => {
    expect(buildChannelMessagesUrl("T1", "C1", 10)).toBe("/teams/T1/channels/C1/messages?$top=10");
  });

  it("buildChatMessagesUrl defaults to top=50", () => {
    expect(buildChatMessagesUrl("CH1")).toBe("/chats/CH1/messages?$top=50");
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("buildChannelCreatePayload", () => {
  it("includes displayName, description + standard membership", () => {
    const out = buildChannelCreatePayload("tp-foo", "Tech Pack — Foo");
    expect(out).toEqual({
      displayName: "tp-foo",
      description: "Tech Pack — Foo",
      membershipType: "standard",
    });
  });
});

describe("buildChannelMessagePayload", () => {
  it("trims content + sets contentType=text", () => {
    expect(buildChannelMessagePayload("  hi there  ")).toEqual({
      body: { content: "hi there", contentType: "text" },
    });
  });

  it("preserves interior whitespace + multi-line content", () => {
    expect(buildChannelMessagePayload("line 1\nline 2")).toEqual({
      body: { content: "line 1\nline 2", contentType: "text" },
    });
  });
});

describe("buildOneOnOneChatPayload", () => {
  it("includes both users as owners + uses the v1.0 user@odata.bind url", () => {
    const out = buildOneOnOneChatPayload("MY_ID", "OTHER_ID");
    expect(out.chatType).toBe("oneOnOne");
    expect(out.members).toHaveLength(2);
    expect(out.members[0]["@odata.type"]).toBe("#microsoft.graph.aadUserConversationMember");
    expect(out.members[0].roles).toEqual(["owner"]);
    expect(out.members[0]["user@odata.bind"]).toBe("https://graph.microsoft.com/v1.0/users('MY_ID')");
    expect(out.members[1]["user@odata.bind"]).toBe("https://graph.microsoft.com/v1.0/users('OTHER_ID')");
  });
});
