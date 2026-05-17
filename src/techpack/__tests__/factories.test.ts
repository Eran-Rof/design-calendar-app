// Unit tests for the TechPack empty-state factories + the pure
// helpers they depend on. Covers: every required TechPack field
// is present in the seed, approval blocks match APPROVAL_STAGES
// exactly, currency formatter handles thousands separators + edge
// values, date formatter is null-safe, id generator returns unique
// non-empty strings.

import { describe, it, expect } from "vitest";
import { emptyCosting, emptyApprovals, emptyTechPack, materialFromForm, EMPTY_MATERIAL_FORM } from "../factories";
import type { Material } from "../types";
import { uid, today, fmtDate, fmtCurrency } from "../utils";
import { APPROVAL_STAGES } from "../constants";

// ────────────────────────────────────────────────────────────────────────

describe("uid", () => {
  it("returns a non-empty string", () => {
    expect(uid().length).toBeGreaterThan(0);
  });
  it("produces unique values across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => uid()));
    expect(ids.size).toBe(50);
  });
});

describe("today", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("fmtDate", () => {
  it("returns em-dash for null / empty", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate("")).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
  });
  it("renders MM/DD/YYYY for valid dates", () => {
    expect(fmtDate("2026-05-17")).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});

describe("fmtCurrency", () => {
  it("renders 2 decimal places + $ prefix", () => {
    expect(fmtCurrency(0)).toBe("$0.00");
    expect(fmtCurrency(5.5)).toBe("$5.50");
  });
  it("inserts thousands separators", () => {
    expect(fmtCurrency(1234)).toBe("$1,234.00");
    expect(fmtCurrency(1234567.89)).toBe("$1,234,567.89");
  });
  it("handles negatives", () => {
    expect(fmtCurrency(-99)).toBe("$-99.00");
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("emptyCosting", () => {
  it("returns all numeric fields at 0", () => {
    const c = emptyCosting();
    expect(c.fob).toBe(0);
    expect(c.duty).toBe(0);
    expect(c.landedCost).toBe(0);
    expect(c.wholesalePrice).toBe(0);
    expect(c.margin).toBe(0);
  });
  it("notes is empty string", () => {
    expect(emptyCosting().notes).toBe("");
  });
});

describe("emptyApprovals", () => {
  it("returns one Approval per APPROVAL_STAGES entry in order", () => {
    const ap = emptyApprovals();
    expect(ap.length).toBe(APPROVAL_STAGES.length);
    expect(ap.map(a => a.stage)).toEqual(APPROVAL_STAGES);
  });
  it("every approval starts Pending with no date", () => {
    for (const a of emptyApprovals()) {
      expect(a.status).toBe("Pending");
      expect(a.date).toBe(null);
      expect(a.approver).toBe("");
      expect(a.comments).toBe("");
      expect(a.id.length).toBeGreaterThan(0);
    }
  });
  it("approval ids are unique", () => {
    const ap = emptyApprovals();
    expect(new Set(ap.map(a => a.id)).size).toBe(ap.length);
  });
});

describe("emptyTechPack", () => {
  const user = { name: "Eran", username: "eran" };

  it("seeds designer + updatedBy from user.name (with username fallback)", () => {
    const tp1 = emptyTechPack(user);
    expect(tp1.designer).toBe("Eran");
    expect(tp1.updatedBy).toBe("Eran");
    const tp2 = emptyTechPack({ username: "fallback" });
    expect(tp2.designer).toBe("fallback");
    expect(tp2.updatedBy).toBe("fallback");
    const tp3 = emptyTechPack({});
    expect(tp3.designer).toBe("");
  });

  it("seeds status Draft, version 1, active true", () => {
    const tp = emptyTechPack(user);
    expect(tp.status).toBe("Draft");
    expect(tp.version).toBe(1);
    expect(tp.active).toBe(true);
  });

  it("createdAt and updatedAt match today()", () => {
    const tp = emptyTechPack(user);
    expect(tp.createdAt).toBe(today());
    expect(tp.updatedAt).toBe(today());
  });

  it("returns a fresh costing + approval block (not shared references)", () => {
    const a = emptyTechPack(user);
    const b = emptyTechPack(user);
    expect(a.costing).not.toBe(b.costing);
    expect(a.approvals).not.toBe(b.approvals);
    expect(a.approvals.length).toBe(APPROVAL_STAGES.length);
  });

  it("seeds empty arrays for colorways / measurements / bom / images", () => {
    const tp = emptyTechPack(user);
    expect(tp.colorways).toEqual([]);
    expect(tp.measurements).toEqual([]);
    expect(tp.construction).toEqual([]);
    expect(tp.bom).toEqual([]);
    expect(tp.samples).toEqual([]);
    expect(tp.images).toEqual([]);
  });

  it("seeds flatSketch with null images + empty callouts", () => {
    const tp = emptyTechPack(user);
    expect(tp.flatSketch.frontImage).toBe(null);
    expect(tp.flatSketch.backImage).toBe(null);
    expect(tp.flatSketch.callouts).toEqual([]);
  });

  it("unique id per call", () => {
    const ids = new Set(Array.from({ length: 10 }, () => emptyTechPack(user).id));
    expect(ids.size).toBe(10);
  });
});

// ────────────────────────────────────────────────────────────────────────

const TODAY = () => "2026-05-17";

describe("EMPTY_MATERIAL_FORM", () => {
  it("defaults type to Fabric (matches form's select default)", () => {
    expect(EMPTY_MATERIAL_FORM.type).toBe("Fabric");
  });

  it("zeros unitPrice + empties every text field", () => {
    expect(EMPTY_MATERIAL_FORM.unitPrice).toBe(0);
    expect(EMPTY_MATERIAL_FORM.name).toBe("");
    expect(EMPTY_MATERIAL_FORM.certifications).toBe("");
    expect(EMPTY_MATERIAL_FORM.notes).toBe("");
  });
});

describe("materialFromForm", () => {
  it("mints a new id + createdAt when not editing", () => {
    const out = materialFromForm({ ...EMPTY_MATERIAL_FORM, name: "Cotton" }, null, TODAY);
    expect(out.id).toBeTruthy();
    expect(out.createdAt).toBe("2026-05-17");
    expect(out.name).toBe("Cotton");
  });

  it("preserves id + createdAt when editing", () => {
    const existing: Material = {
      id: "old-id", name: "Old", type: "Trim", composition: "", weight: "",
      width: "", color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "",
      certifications: [], notes: "", createdAt: "2025-01-01",
    };
    const out = materialFromForm({ ...EMPTY_MATERIAL_FORM, name: "New Name" }, existing, TODAY);
    expect(out.id).toBe("old-id");
    expect(out.createdAt).toBe("2025-01-01");
    expect(out.name).toBe("New Name");
  });

  it("splits certifications on comma, trims, drops empties", () => {
    const out = materialFromForm(
      { ...EMPTY_MATERIAL_FORM, name: "x", certifications: "  OEKO-TEX , GOTS,, BCI , " },
      null, TODAY,
    );
    expect(out.certifications).toEqual(["OEKO-TEX", "GOTS", "BCI"]);
  });

  it("returns empty certifications array when input is empty/whitespace", () => {
    const out1 = materialFromForm({ ...EMPTY_MATERIAL_FORM, name: "x" }, null, TODAY);
    const out2 = materialFromForm({ ...EMPTY_MATERIAL_FORM, name: "x", certifications: "  ,  ,  " }, null, TODAY);
    expect(out1.certifications).toEqual([]);
    expect(out2.certifications).toEqual([]);
  });

  it("copies every form field through verbatim", () => {
    const form = {
      ...EMPTY_MATERIAL_FORM,
      name: "Twill",
      type: "Fabric",
      composition: "100% Cotton",
      weight: "8oz",
      width: "60\"",
      color: "Indigo",
      supplier: "MillCo",
      unitPrice: 3.45,
      moq: "500yd",
      leadTime: "30d",
      notes: "Hold for Spring drop",
    };
    const out = materialFromForm(form, null, TODAY);
    expect(out).toMatchObject({
      name: "Twill",
      composition: "100% Cotton",
      weight: "8oz",
      width: "60\"",
      color: "Indigo",
      supplier: "MillCo",
      unitPrice: 3.45,
      moq: "500yd",
      leadTime: "30d",
      notes: "Hold for Spring drop",
    });
  });
});
