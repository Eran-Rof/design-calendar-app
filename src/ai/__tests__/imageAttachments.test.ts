// Tests for image attachment validation + extraction (PR 3/4).

import { describe, it, expect } from "vitest";
import {
  validateAttachment,
  imagesFromDataTransferItems,
  SUPPORTED_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
} from "../imageAttachments";

describe("validateAttachment", () => {
  it("accepts a small PNG", () => {
    expect(validateAttachment({ type: "image/png", size: 1024 })).toEqual({ ok: true });
  });
  it("rejects an unsupported type", () => {
    const r = validateAttachment({ type: "application/pdf", size: 1024 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unsupported file type/);
  });
  it("rejects files over the size cap", () => {
    const r = validateAttachment({ type: "image/png", size: MAX_ATTACHMENT_BYTES + 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
  });
  it("rejects empty files", () => {
    const r = validateAttachment({ type: "image/png", size: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/);
  });
  it("rejects missing media type as unsupported", () => {
    expect(validateAttachment({ type: "", size: 100 }).ok).toBe(false);
  });
});

describe("SUPPORTED_IMAGE_TYPES", () => {
  it("covers the Anthropic Vision-supported formats", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(SUPPORTED_IMAGE_TYPES.has(t)).toBe(true);
    }
  });
  it("doesn't accept SVG (not Anthropic-supported)", () => {
    expect(SUPPORTED_IMAGE_TYPES.has("image/svg+xml")).toBe(false);
  });
});

describe("imagesFromDataTransferItems", () => {
  function makeItem(kind: string, type: string, file: File | null) {
    return { kind, type, getAsFile: () => file } as unknown as DataTransferItem;
  }
  function makeItemList(items: DataTransferItem[]) {
    const list = items as unknown as DataTransferItemList & DataTransferItem[];
    Object.defineProperty(list, "length", { value: items.length });
    return list;
  }

  it("returns [] for null / undefined input", () => {
    expect(imagesFromDataTransferItems(null)).toEqual([]);
    expect(imagesFromDataTransferItems(undefined)).toEqual([]);
  });

  it("picks out image files and ignores text items", () => {
    const png = new File(["x"], "shot.png", { type: "image/png" });
    const items = makeItemList([
      makeItem("string", "text/plain", null),
      makeItem("file",   "image/png",  png),
      makeItem("file",   "application/pdf", new File(["y"], "doc.pdf", { type: "application/pdf" })),
    ]);
    const out = imagesFromDataTransferItems(items);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("shot.png");
  });

  it("ignores image items whose getAsFile returns null", () => {
    const items = makeItemList([
      makeItem("file", "image/png", null),
    ]);
    expect(imagesFromDataTransferItems(items)).toEqual([]);
  });
});
