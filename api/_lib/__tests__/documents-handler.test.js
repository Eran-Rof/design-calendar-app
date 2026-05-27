// Tests for P2-6 documents handler validation.

import { describe, it, expect } from "vitest";
import { validateUploadBody } from "../../_handlers/internal/documents/index.js";

const UUID = "00000000-0000-0000-0000-000000000001";

describe("documents validateUploadBody", () => {
  it("rejects missing context_table", () => {
    expect(validateUploadBody({}).error).toMatch(/context_table/);
  });
  it("rejects non-uuid context_id", () => {
    expect(validateUploadBody({ context_table: "vendors", context_id: "abc" }).error).toMatch(/context_id/);
  });
  it("rejects missing kind", () => {
    expect(validateUploadBody({ context_table: "vendors", context_id: UUID }).error).toMatch(/kind/);
  });
  it("rejects missing title", () => {
    expect(validateUploadBody({ context_table: "vendors", context_id: UUID, kind: "k" }).error).toMatch(/title/);
  });
  it("rejects missing bytes_base64", () => {
    expect(validateUploadBody({
      context_table: "vendors", context_id: UUID, kind: "k", title: "t",
    }).error).toMatch(/bytes_base64/);
  });
  it("rejects missing mime", () => {
    expect(validateUploadBody({
      context_table: "vendors", context_id: UUID, kind: "k", title: "t",
      bytes_base64: "aGVsbG8=",
    }).error).toMatch(/mime/);
  });
  it("accepts valid upload", () => {
    const v = validateUploadBody({
      context_table: "vendors", context_id: UUID, kind: "contract", title: "NDA",
      mime: "application/pdf", bytes_base64: "aGVsbG8=",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.kind).toBe("contract");
    expect(v.data.mime).toBe("application/pdf");
  });
  it("trims context_table + kind + title", () => {
    const v = validateUploadBody({
      context_table: "  vendors  ", context_id: UUID, kind: "  contract  ",
      title: "  NDA  ", mime: "application/pdf", bytes_base64: "aGVsbG8=",
    });
    expect(v.data.context_table).toBe("vendors");
    expect(v.data.kind).toBe("contract");
    expect(v.data.title).toBe("NDA");
  });
  it("notes null when omitted", () => {
    const v = validateUploadBody({
      context_table: "vendors", context_id: UUID, kind: "k", title: "t",
      mime: "application/pdf", bytes_base64: "aGVsbG8=",
    });
    expect(v.data.notes).toBeNull();
  });
});
