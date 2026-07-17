// MessagesView.initialOnlyUnread — the pure reader that seeds the "only POs
// with unread" filter from the URL. Today's "Vendor replies unread" to-do
// deep-links ?view=messages&unread=1, and this decides that arriving that way
// opens the list already filtered to the POs that need a reply.

import { describe, it, expect } from "vitest";
import { initialOnlyUnread } from "../MessagesView";

describe("initialOnlyUnread", () => {
  it("true when ?unread=1", () => {
    expect(initialOnlyUnread("?view=messages&unread=1")).toBe(true);
    expect(initialOnlyUnread("?unread=1")).toBe(true);
  });

  it("false when the param is absent", () => {
    expect(initialOnlyUnread("")).toBe(false);
    expect(initialOnlyUnread("?view=messages")).toBe(false);
  });

  it("false for any value other than exactly '1'", () => {
    expect(initialOnlyUnread("?unread=0")).toBe(false);
    expect(initialOnlyUnread("?unread=true")).toBe(false);
    expect(initialOnlyUnread("?unread=")).toBe(false);
  });
});
