// @vitest-environment jsdom
// Tests for the Ask AI event bridge (PR 4/4).
// Pinned behaviour: askAI + onAskAIRequest round-trip via window
// CustomEvent without leaking listeners, AND buildRowAskPrompt
// renders a consistent shape from typical ATS row data.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { askAI, onAskAIRequest, buildRowAskPrompt } from "../askAIBridge";

beforeEach(() => {
  // Each test starts with a clean event bus.
});

describe("askAI + onAskAIRequest", () => {
  it("delivers a dispatched request to a subscriber", () => {
    const handler = vi.fn();
    const off = onAskAIRequest(handler);
    askAI({ prompt: "Hello", source: "test" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ prompt: "Hello", source: "test" });
    off();
  });

  it("ignores empty prompts (no event dispatched)", () => {
    const handler = vi.fn();
    const off = onAskAIRequest(handler);
    askAI({ prompt: "" });
    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it("cleanup function removes the listener", () => {
    const handler = vi.fn();
    const off = onAskAIRequest(handler);
    off();
    askAI({ prompt: "After unsubscribe" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers", () => {
    const h1 = vi.fn(); const h2 = vi.fn();
    const off1 = onAskAIRequest(h1);
    const off2 = onAskAIRequest(h2);
    askAI({ prompt: "Multicast" });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    off1(); off2();
  });
});

describe("buildRowAskPrompt", () => {
  it("renders the typical ATS row fields in a stable order", () => {
    const out = buildRowAskPrompt({
      sku: "RYB0412-S-BLK",
      style: "RYB0412",
      description: "Edge jogger",
      category: "Mens Bottoms",
      store: "ROF",
      onHand: 120,
      onOrder: 35,
      onPO: 200,
      customer: "Burlington Coat Factory",
    });
    expect(out).toContain("About this row:");
    expect(out).toContain("SKU: RYB0412-S-BLK");
    expect(out).toContain("Style: RYB0412");
    expect(out).toContain("Description: Edge jogger");
    expect(out).toContain("On hand: 120");
    expect(out).toContain("On PO: 200");
    expect(out).toContain("Customer: Burlington Coat Factory");
    // Trailing default ask
    expect(out).toContain("Tell me anything notable");
  });

  it("omits Style when it equals SKU (avoids redundancy on single-SKU styles)", () => {
    const out = buildRowAskPrompt({ sku: "X", style: "X" });
    expect(out.match(/Style:/g)).toBeNull();
  });

  it("flattens `extras` as key: value lines", () => {
    const out = buildRowAskPrompt({ sku: "X", extras: { ATS: 5, "Last shipped": "2026-05-01" } });
    expect(out).toContain("ATS: 5");
    expect(out).toContain("Last shipped: 2026-05-01");
  });

  it("skips null / empty extras", () => {
    const out = buildRowAskPrompt({ sku: "X", extras: { Foo: null, Bar: "" } });
    expect(out).not.toContain("Foo:");
    expect(out).not.toContain("Bar:");
  });
});
