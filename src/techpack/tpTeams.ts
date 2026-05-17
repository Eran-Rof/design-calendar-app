// Pure helpers for the TechPack Teams panel. Extracted from
// TechPack.tsx so the channel-name slug, Graph URL grammar, and
// Graph POST payload shapes (channel create, message create,
// 1:1 chat create) are unit-testable.
//
// Parallels tpEmail.ts — same pattern, just for the Teams side
// of the panel.

const GRAPH_USER_BIND = (userId: string) => `https://graph.microsoft.com/v1.0/users('${userId}')`;

/**
 * Convert a tech pack name into a Teams channel slug. Lowercased,
 * non-alphanumeric runs collapsed to a single `-`, leading/trailing
 * `-` stripped, capped at 48 chars. Always prefixed `tp-`.
 *   "Bartram T-Shirt v2"  →  "tp-bartram-t-shirt-v2"
 *   "  $$$  EDGE  $$$  "  →  "tp-edge"
 */
export function slugifyTPName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `tp-${slug}`;
}

/**
 * Locate the "RING OF FIRE" team out of the operator's joined-teams
 * list. Match is case-insensitive + whitespace-insensitive (so
 * "Ring Of Fire", "RINGOFFIRE", "ring of fire " all match).
 * Returns null when no match — caller throws.
 */
export function findRofTeam<T extends { displayName?: string }>(teams: T[]): T | null {
  return teams.find(t =>
    (t.displayName || "").toLowerCase().replace(/\s+/g, "").includes("ringoffire")
  ) ?? null;
}

/**
 * The Graph filter rejects non-message items (system events,
 * unfurls, etc). Returns only items whose `messageType` is
 * exactly `"message"`.
 */
export function keepRealMessages<T extends { messageType?: string }>(items: T[]): T[] {
  return items.filter(m => m.messageType === "message");
}

// ── URL builders ────────────────────────────────────────────────────────────

/** `/teams/{id}/channels` — list every channel under a team. */
export const buildChannelsListUrl = (teamId: string): string =>
  `/teams/${teamId}/channels`;

/** `/teams/{tid}/channels/{cid}/messages?$top=N` — most-recent N messages. */
export const buildChannelMessagesUrl = (teamId: string, channelId: string, top = 50): string =>
  `/teams/${teamId}/channels/${channelId}/messages?$top=${top}`;

/** `/chats/{id}/messages?$top=N` — most-recent N messages in a chat. */
export const buildChatMessagesUrl = (chatId: string, top = 50): string =>
  `/chats/${chatId}/messages?$top=${top}`;

// ── POST payload builders ───────────────────────────────────────────────────

/**
 * Body for `POST /teams/{id}/channels` — creating a new public
 * (standard) channel. Description shows up in Teams under the
 * channel name.
 */
export function buildChannelCreatePayload(displayName: string, description: string) {
  return { displayName, description, membershipType: "standard" as const };
}

/**
 * Body for `POST /teams/{tid}/channels/{cid}/messages` and
 * `POST /chats/{id}/messages`. Plain-text content (no HTML),
 * trimmed of leading/trailing whitespace.
 */
export function buildChannelMessagePayload(text: string) {
  return { body: { content: text.trim(), contentType: "text" as const } };
}

/**
 * Body for `POST /chats` to create a 1:1 chat between the
 * authenticated operator and a single AAD user. Each member needs
 * a `@odata.type` + a `user@odata.bind` reference; both are owners
 * in a 1:1.
 */
export function buildOneOnOneChatPayload(myUserId: string, recipientId: string) {
  return {
    chatType: "oneOnOne" as const,
    members: [
      {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": GRAPH_USER_BIND(myUserId),
      },
      {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": GRAPH_USER_BIND(recipientId),
      },
    ],
  };
}
