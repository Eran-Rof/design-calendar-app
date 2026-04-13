import "../../store/__tests__/setup";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { useTandaStore } from "../../store/index";
import { useTemplateOps } from "../useTemplateOps";
import { DEFAULT_WIP_TEMPLATES } from "../../../utils/tandaTypes";

// ── Helpers ─────────────────────────────────────────────────────────────────

const initialState = useTandaStore.getState();

function resetStore() {
  useTandaStore.setState(initialState, true);
}

function jsonOk(body: any): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const sampleTemplate = {
  id: "wip_test",
  phase: "Test Phase",
  category: "Samples",
  daysBeforeDDP: 50,
  status: "Not Started",
  notes: "",
};

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetStore();
  vi.restoreAllMocks();
  global.fetch = vi.fn().mockResolvedValue(jsonOk([]));
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("useTemplateOps", () => {
  // ── loadWipTemplates ────────────────────────────────────────────────────
  describe("loadWipTemplates", () => {
    it("fetches from Supabase, parses JSON, and sets store", async () => {
      const templates = { __default__: [sampleTemplate], VendorA: [sampleTemplate] };
      (global.fetch as Mock).mockResolvedValueOnce(
        jsonOk([{ value: JSON.stringify(templates) }])
      );

      const ops = useTemplateOps();
      const result = await ops.loadWipTemplates();

      expect(result).toEqual(templates);
      expect(useTandaStore.getState().wipTemplates).toEqual(templates);
    });

    it("migrates array format to { __default__: [...] }", async () => {
      (global.fetch as Mock)
        .mockResolvedValueOnce(jsonOk([{ value: JSON.stringify([sampleTemplate]) }]))
        .mockResolvedValueOnce(jsonOk([])); // save call

      const ops = useTemplateOps();
      const result = await ops.loadWipTemplates();

      expect(result).toEqual({ __default__: [sampleTemplate] });
      expect(useTandaStore.getState().wipTemplates).toEqual({ __default__: [sampleTemplate] });
      // Should save migrated format back
      expect((global.fetch as Mock).mock.calls.length).toBe(2);
    });

    it("returns defaults when fetch returns empty", async () => {
      (global.fetch as Mock).mockResolvedValueOnce(jsonOk([]));

      const ops = useTemplateOps();
      const result = await ops.loadWipTemplates();

      expect(result).toEqual({ __default__: DEFAULT_WIP_TEMPLATES });
    });

    it("returns defaults when fetch throws", async () => {
      (global.fetch as Mock).mockRejectedValueOnce(new Error("network"));

      const ops = useTemplateOps();
      const result = await ops.loadWipTemplates();

      expect(result).toEqual({ __default__: DEFAULT_WIP_TEMPLATES });
      expect(useTandaStore.getState().wipTemplates).toEqual({ __default__: DEFAULT_WIP_TEMPLATES });
    });

    it("adds __default__ key when missing from stored object", async () => {
      const stored = { VendorA: [sampleTemplate] };
      (global.fetch as Mock).mockResolvedValueOnce(
        jsonOk([{ value: JSON.stringify(stored) }])
      );

      const ops = useTemplateOps();
      const result = await ops.loadWipTemplates();

      expect(result!.__default__).toEqual(DEFAULT_WIP_TEMPLATES);
      expect(result!.VendorA).toEqual([sampleTemplate]);
    });
  });

  // ── saveVendorTemplates ─────────────────────────────────────────────────
  describe("saveVendorTemplates", () => {
    it("saves vendor templates to Supabase and updates store", async () => {
      // Pre-populate store with defaults
      useTandaStore.getState().setCoreField("wipTemplates", { __default__: DEFAULT_WIP_TEMPLATES });

      const ops = useTemplateOps();
      await ops.saveVendorTemplates("VendorX", [sampleTemplate]);

      // Store should have both __default__ and VendorX
      const wt = useTandaStore.getState().wipTemplates;
      expect(wt.VendorX).toEqual([sampleTemplate]);
      expect(wt.__default__).toEqual(DEFAULT_WIP_TEMPLATES);

      // Should POST to Supabase
      const postCall = (global.fetch as Mock).mock.calls.find(
        (c: any[]) => c[1]?.method === "POST" && c[0]?.includes("app_data")
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1].body);
      expect(body.key).toBe("wip_templates");
      const saved = JSON.parse(body.value);
      expect(saved.VendorX).toEqual([sampleTemplate]);
    });
  });

  // ── getVendorTemplates ──────────────────────────────────────────────────
  describe("getVendorTemplates", () => {
    it("returns vendor-specific templates when they exist", () => {
      const vendorTpls = [sampleTemplate];
      useTandaStore.getState().setCoreField("wipTemplates", {
        __default__: DEFAULT_WIP_TEMPLATES,
        VendorY: vendorTpls,
      });

      const ops = useTemplateOps();
      expect(ops.getVendorTemplates("VendorY")).toEqual(vendorTpls);
    });

    it("falls back to __default__ when vendor has no custom template", () => {
      useTandaStore.getState().setCoreField("wipTemplates", {
        __default__: DEFAULT_WIP_TEMPLATES,
      });

      const ops = useTemplateOps();
      expect(ops.getVendorTemplates("UnknownVendor")).toEqual(DEFAULT_WIP_TEMPLATES);
    });

    it("falls back to __default__ when vendorName is undefined", () => {
      useTandaStore.getState().setCoreField("wipTemplates", {
        __default__: DEFAULT_WIP_TEMPLATES,
      });

      const ops = useTemplateOps();
      expect(ops.getVendorTemplates()).toEqual(DEFAULT_WIP_TEMPLATES);
    });

    it("falls back to DEFAULT_WIP_TEMPLATES when __default__ is missing", () => {
      useTandaStore.getState().setCoreField("wipTemplates", {} as any);

      const ops = useTemplateOps();
      expect(ops.getVendorTemplates("NoVendor")).toEqual(DEFAULT_WIP_TEMPLATES);
    });
  });

  // ── vendorHasTemplate ───────────────────────────────────────────────────
  describe("vendorHasTemplate", () => {
    it("returns true when vendor has a custom template", () => {
      useTandaStore.getState().setCoreField("wipTemplates", {
        __default__: DEFAULT_WIP_TEMPLATES,
        VendorZ: [sampleTemplate],
      });

      const ops = useTemplateOps();
      expect(ops.vendorHasTemplate("VendorZ")).toBe(true);
    });

    it("returns false when vendor has no custom template", () => {
      useTandaStore.getState().setCoreField("wipTemplates", {
        __default__: DEFAULT_WIP_TEMPLATES,
      });

      const ops = useTemplateOps();
      expect(ops.vendorHasTemplate("NonExistent")).toBe(false);
    });

    it("returns false for empty string", () => {
      const ops = useTemplateOps();
      expect(ops.vendorHasTemplate("")).toBe(false);
    });
  });

  // ── templateVendorList ──────────────────────────────────────────────────
  describe("templateVendorList", () => {
    it("returns sorted vendor keys excluding __default__", () => {
      useTandaStore.getState().setCoreField("wipTemplates", {
        __default__: DEFAULT_WIP_TEMPLATES,
        Zara: [sampleTemplate],
        Alpha: [sampleTemplate],
        Middle: [sampleTemplate],
      });

      const ops = useTemplateOps();
      expect(ops.templateVendorList()).toEqual(["Alpha", "Middle", "Zara"]);
    });

    it("returns empty array when only __default__ exists", () => {
      useTandaStore.getState().setCoreField("wipTemplates", {
        __default__: DEFAULT_WIP_TEMPLATES,
      });

      const ops = useTemplateOps();
      expect(ops.templateVendorList()).toEqual([]);
    });
  });
});
