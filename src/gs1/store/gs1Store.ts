// ── GS1 module Zustand store ───────────────────────────────────────────────────

import { create } from "zustand";
import * as db from "../services/supabaseGs1";
import { parsePackingListFile } from "../services/parsePackingList";
import { buildSsccFromSettings } from "../services/gtinService";
import {
  buildContentLines,
  explodeBom,
  aggregateExplosionLines,
  applyReceivedQtys,
  runExplosion,
  isAlreadyReceived,
  determineSessionStatus,
  normalizeSsccInput,
  type AggregatedLine,
  type ExplosionResult,
} from "../services/receivingService";
import {
  buildBomLines,
  checkUpcCoverage,
  type BomBuildResult,
  type BomCheckResult,
} from "../services/bomBuilderService";
import type {
  CompanySettings,
  CompanySettingsInput,
  UpcItem,
  UpcItemInput,
  ScaleMaster,
  ScaleSizeRatio,
  ScaleInput,
  PackGtin,
  PackGtinBom,
  PackGtinBomIssue,
  PackingListUpload,
  PackingListBlock,
  ParseIssue,
  ParsedRow,
  LabelBatch,
  LabelBatchLine,
  LabelData,
  LabelMode,
  Carton,
  CartonContent,
  ManualCartonInput,
  ReceivingSession,
  ReceivingSessionLine,
} from "../types";

export type GS1Tab = "company" | "upc" | "scale" | "gtins" | "upload" | "labels" | "cartons" | "receiving";

interface GS1State {
  activeTab: GS1Tab;

  companySettings: CompanySettings | null;
  settingsLoading: boolean;
  settingsError: string | null;

  upcItems: UpcItem[];
  upcLoading: boolean;
  upcError: string | null;

  scales: ScaleMaster[];
  scaleRatios: ScaleSizeRatio[];
  scaleLoading: boolean;
  scaleError: string | null;

  packGtins: PackGtin[];
  gtinLoading: boolean;
  gtinError: string | null;

  uploads: PackingListUpload[];
  currentUpload: PackingListUpload | null;
  uploadBlocks: PackingListBlock[];
  parseIssues: ParseIssue[];
  pendingRows: ParsedRow[];
  uploadLoading: boolean;
  uploadError: string | null;

  // Label generation mode — chosen in the upload panel before batch creation
  labelMode: LabelMode;

  batches: LabelBatch[];
  currentBatch: LabelBatch | null;
  batchLines: LabelBatchLine[];
  cartons: Carton[];
  batchLoading: boolean;
  batchError: string | null;

  // All cartons — for the Carton Labels tab
  allCartons: Carton[];
  cartonLoading: boolean;
  cartonError: string | null;
  lastCreatedSscc: string | null;

  // BOM builder
  bomBuilding: boolean;
  bomBuildError: string | null;

  // Receiving tab
  receivingCarton: Carton | null;
  receivingContents: CartonContent[];
  receivingExplosion: ExplosionResult | null;
  receivingEditedQtys: Record<string, number>;
  receivingSessions: ReceivingSession[];
  receivingSession: ReceivingSession | null;
  receivingLoading: boolean;
  receivingError: string | null;
  receivingAlreadyReceived: boolean;
}

interface GS1Actions {
  setActiveTab: (tab: GS1Tab) => void;
  setLabelMode: (mode: LabelMode) => void;

  loadCompanySettings: () => Promise<void>;
  saveCompanySettings: (data: CompanySettingsInput) => Promise<void>;

  loadUpcItems: () => Promise<void>;
  importUpcItems: (items: UpcItemInput[]) => Promise<{ inserted: number }>;
  deleteUpcItem: (id: string) => Promise<void>;

  loadScales: () => Promise<void>;
  loadScaleRatios: (scaleCode?: string) => Promise<void>;
  saveScale: (data: ScaleInput) => Promise<void>;
  deleteScale: (scaleCode: string) => Promise<void>;

  loadPackGtins: (filters?: { style_no?: string; color?: string; scale_code?: string }) => Promise<void>;
  generateGtin: (styleNo: string, color: string, scaleCode: string) => Promise<PackGtin>;
  generateGtinsForPendingRows: () => Promise<void>;

  loadUploads: () => Promise<void>;
  processUpload: (file: File) => Promise<void>;
  selectUpload: (upload: PackingListUpload) => Promise<void>;

  loadBatches: () => Promise<void>;
  createBatchFromUpload: (batchName: string) => Promise<void>;
  selectBatch: (batch: LabelBatch) => Promise<void>;
  loadCartonsForBatch: (batchId: string) => Promise<void>;
  updateBatchStatus: (batchId: string, status: LabelBatch["status"]) => Promise<void>;
  clearCurrentBatch: () => void;

  // Carton tab actions
  loadAllCartons: () => Promise<void>;
  createManualSscc: (data: ManualCartonInput) => Promise<Carton>;
  clearLastCreatedSscc: () => void;

  // BOM builder actions
  buildBomForGtin: (packGtinRow: PackGtin) => Promise<BomBuildResult>;
  buildBomForAllMissing: () => Promise<{ built: number; complete: number; incomplete: number; errors: number }>;
  buildBomsForUpload: () => Promise<{ built: number; complete: number; incomplete: number; errors: number }>;
  buildBomForReceiving: () => Promise<void>;
  checkUpcCoverageForStyleColor: (styleNo: string, color: string, scaleCode: string) => Promise<BomCheckResult>;

  // Receiving tab actions
  searchBySscc: (sscc: string) => Promise<void>;
  setReceivingEditedQty: (upc: string, qty: number) => void;
  confirmReceive: (notes?: string) => Promise<void>;
  clearReceiving: () => void;
  loadReceivingSessions: () => Promise<void>;
}

type GS1Store = GS1State & GS1Actions;

export const useGS1Store = create<GS1Store>((set, get) => ({
  activeTab: "company",

  companySettings: null,
  settingsLoading: false,
  settingsError: null,

  upcItems: [],
  upcLoading: false,
  upcError: null,

  scales: [],
  scaleRatios: [],
  scaleLoading: false,
  scaleError: null,

  packGtins: [],
  gtinLoading: false,
  gtinError: null,

  uploads: [],
  currentUpload: null,
  uploadBlocks: [],
  parseIssues: [],
  pendingRows: [],
  uploadLoading: false,
  uploadError: null,

  labelMode: "both",

  batches: [],
  currentBatch: null,
  batchLines: [],
  cartons: [],
  batchLoading: false,
  batchError: null,

  allCartons: [],
  cartonLoading: false,
  cartonError: null,
  lastCreatedSscc: null,

  bomBuilding: false,
  bomBuildError: null,

  receivingCarton: null,
  receivingContents: [],
  receivingExplosion: null,
  receivingEditedQtys: {},
  receivingSessions: [],
  receivingSession: null,
  receivingLoading: false,
  receivingError: null,
  receivingAlreadyReceived: false,

  // ── Tab + mode ────────────────────────────────────────────────────────────────
  setActiveTab: (tab) => set({ activeTab: tab }),
  setLabelMode:  (mode) => set({ labelMode: mode }),

  // ── Company settings ──────────────────────────────────────────────────────────
  loadCompanySettings: async () => {
    set({ settingsLoading: true, settingsError: null });
    try {
      const s = await db.loadCompanySettings();
      set({ companySettings: s, settingsLoading: false });
    } catch (e) {
      set({ settingsError: String(e), settingsLoading: false });
    }
  },

  saveCompanySettings: async (data) => {
    set({ settingsLoading: true, settingsError: null });
    try {
      const s = await db.saveCompanySettings(data);
      set({ companySettings: s, settingsLoading: false });
    } catch (e) {
      set({ settingsError: String(e), settingsLoading: false });
      throw e;
    }
  },

  // ── UPC master ────────────────────────────────────────────────────────────────
  loadUpcItems: async () => {
    set({ upcLoading: true, upcError: null });
    try {
      const items = await db.loadUpcItems();
      set({ upcItems: items, upcLoading: false });
    } catch (e) {
      set({ upcError: String(e), upcLoading: false });
    }
  },

  importUpcItems: async (items) => {
    set({ upcLoading: true, upcError: null });
    try {
      const result = await db.upsertUpcItems(items);
      await get().loadUpcItems();
      return result;
    } catch (e) {
      set({ upcError: String(e), upcLoading: false });
      throw e;
    }
  },

  deleteUpcItem: async (id) => {
    await db.deleteUpcItem(id);
    set(s => ({ upcItems: s.upcItems.filter(u => u.id !== id) }));
  },

  // ── Scale master ──────────────────────────────────────────────────────────────
  loadScales: async () => {
    set({ scaleLoading: true, scaleError: null });
    try {
      const [scales, ratios] = await Promise.all([db.loadScales(), db.loadScaleRatios()]);
      set({ scales, scaleRatios: ratios, scaleLoading: false });
    } catch (e) {
      set({ scaleError: String(e), scaleLoading: false });
    }
  },

  loadScaleRatios: async (scaleCode) => {
    const ratios = await db.loadScaleRatios(scaleCode);
    set({ scaleRatios: ratios });
  },

  saveScale: async (data) => {
    set({ scaleLoading: true, scaleError: null });
    try {
      await db.saveScale(data);
      await get().loadScales();
    } catch (e) {
      set({ scaleError: String(e), scaleLoading: false });
      throw e;
    }
  },

  deleteScale: async (scaleCode) => {
    set({ scaleLoading: true });
    try {
      await db.deleteScale(scaleCode);
      await get().loadScales();
    } catch (e) {
      set({ scaleError: String(e), scaleLoading: false });
      throw e;
    }
  },

  // ── Pack GTIN master ──────────────────────────────────────────────────────────
  loadPackGtins: async (filters) => {
    set({ gtinLoading: true, gtinError: null });
    try {
      const gtins = await db.loadPackGtins(filters);
      set({ packGtins: gtins, gtinLoading: false });
    } catch (e) {
      set({ gtinError: String(e), gtinLoading: false });
    }
  },

  generateGtin: async (styleNo, color, scaleCode) => {
    const settings = get().companySettings;
    if (!settings) throw new Error("Company settings not configured.");
    set({ gtinLoading: true, gtinError: null });
    try {
      const gtin = await db.getOrCreatePackGtin(styleNo, color, scaleCode, settings);
      const gtins = await db.loadPackGtins();
      set({ packGtins: gtins, gtinLoading: false });
      return gtin;
    } catch (e) {
      set({ gtinError: String(e), gtinLoading: false });
      throw e;
    }
  },

  generateGtinsForPendingRows: async () => {
    const { pendingRows, companySettings } = get();
    if (!companySettings) throw new Error("Company settings not configured.");
    if (pendingRows.length === 0) throw new Error("No parsed rows to generate GTINs for.");

    set({ gtinLoading: true, gtinError: null });
    try {
      const seen = new Set<string>();
      const unique = pendingRows.filter(r => {
        const key = `${r.styleNo}|${r.color}|${r.scaleCode}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      for (const row of unique) {
        await db.getOrCreatePackGtin(row.styleNo, row.color, row.scaleCode, companySettings);
      }
      const gtins = await db.loadPackGtins();
      set({ packGtins: gtins, gtinLoading: false });
    } catch (e) {
      set({ gtinError: String(e), gtinLoading: false });
      throw e;
    }
  },

  // ── Packing list uploads ──────────────────────────────────────────────────────
  loadUploads: async () => {
    set({ uploadLoading: true, uploadError: null });
    try {
      const uploads = await db.loadUploads();
      set({ uploads, uploadLoading: false });
    } catch (e) {
      set({ uploadError: String(e), uploadLoading: false });
    }
  },

  processUpload: async (file) => {
    set({ uploadLoading: true, uploadError: null, pendingRows: [], parseIssues: [], uploadBlocks: [], currentUpload: null });
    let uploadRecord: PackingListUpload | null = null;
    try {
      uploadRecord = await db.createUploadRecord(file.name);
      set({ currentUpload: uploadRecord });

      const result = await parsePackingListFile(file);

      await db.insertParsedBlocks(uploadRecord.id, result.allRows);
      await db.insertParseIssues(uploadRecord.id, result.issues);

      const totalLabels = result.allRows.reduce((s, r) => s + r.packQty, 0);
      const summary = {
        sheets_processed: result.sheets.length,
        blocks_found: result.allRows.length,
        blocks_failed: result.issues.filter(i => i.severity === "error").length,
        total_labels: totalLabels,
        issues_count: result.issues.length,
      };
      await db.updateUploadStatus(uploadRecord.id, "parsed", summary);

      const [blocks, issues] = await Promise.all([
        db.loadBlocks(uploadRecord.id),
        db.loadParseIssues(uploadRecord.id),
      ]);
      const uploads = await db.loadUploads();
      const updated = uploads.find(u => u.id === uploadRecord!.id) ?? uploadRecord;

      set({ currentUpload: updated, uploadBlocks: blocks, parseIssues: issues,
            pendingRows: result.allRows, uploads, uploadLoading: false });
    } catch (e) {
      if (uploadRecord) await db.updateUploadStatus(uploadRecord.id, "error").catch(() => {});
      set({ uploadError: String(e), uploadLoading: false });
      throw e;
    }
  },

  selectUpload: async (upload) => {
    set({ uploadLoading: true, currentUpload: upload });
    try {
      const [blocks, issues] = await Promise.all([
        db.loadBlocks(upload.id),
        db.loadParseIssues(upload.id),
      ]);
      set({ uploadBlocks: blocks, parseIssues: issues, uploadLoading: false });
    } catch (e) {
      set({ uploadError: String(e), uploadLoading: false });
    }
  },

  // ── Label batches ─────────────────────────────────────────────────────────────
  loadBatches: async () => {
    set({ batchLoading: true, batchError: null });
    try {
      const batches = await db.loadBatches();
      set({ batches, batchLoading: false });
    } catch (e) {
      set({ batchError: String(e), batchLoading: false });
    }
  },

  createBatchFromUpload: async (batchName) => {
    const { currentUpload, uploadBlocks, companySettings, labelMode } = get();
    if (!currentUpload) throw new Error("No upload selected.");
    if (!companySettings) throw new Error("Company settings not configured.");
    if (uploadBlocks.length === 0) throw new Error("No parsed blocks to create batch from.");

    set({ batchLoading: true, batchError: null });
    try {
      // Ensure GTINs exist for all blocks
      const gtinMap = new Map<string, string>();
      const packGtins = await db.loadPackGtins();
      for (const g of packGtins) {
        gtinMap.set(`${g.style_no}|${g.color}|${g.scale_code}`, g.pack_gtin);
      }

      const lines: LabelData[] = [];
      for (const block of uploadBlocks) {
        if (!block.style_no || !block.color || !block.scale_code || !block.pack_qty) continue;
        const key = `${block.style_no}|${block.color}|${block.scale_code}`;
        let gtin = gtinMap.get(key);
        if (!gtin) {
          const created = await db.getOrCreatePackGtin(block.style_no, block.color, block.scale_code, companySettings);
          gtin = created.pack_gtin;
          gtinMap.set(key, gtin);
        }
        lines.push({
          style_no: block.style_no,
          color: block.color,
          scale_code: block.scale_code,
          pack_gtin: gtin,
          label_qty: block.pack_qty,
          source_sheet_name: block.sheet_name,
          source_channel: block.channel,
        });
      }

      const batch = await db.createLabelBatch(batchName, currentUpload.id, lines, labelMode);
      let batchLines = await db.loadBatchLines(batch.id);

      // ── Generate SSCCs if mode includes sscc ────────────────────────────────
      let allCartons: Carton[] = [];
      if (labelMode === "sscc" || labelMode === "both") {
        const ssccExt  = companySettings.sscc_extension_digit;
        const cartonInputs: Parameters<typeof db.insertCartons>[0] = [];
        const lineUpdates: Array<{ id: string; sscc_first: string; sscc_last: string; carton_count: number }> = [];

        // Claim serial ranges in parallel (DB lock serializes them server-side)
        const ranges = await Promise.all(
          batchLines.map(line => db.claimSsccSerialRange(line.label_qty))
        );

        for (let i = 0; i < batchLines.length; i++) {
          const line  = batchLines[i];
          const range = ranges[i];
          const ssccFirst = buildSsccFromSettings(companySettings, range.start);
          const ssccLast  = buildSsccFromSettings(companySettings, range.end);

          lineUpdates.push({ id: line.id, sscc_first: ssccFirst, sscc_last: ssccLast, carton_count: line.label_qty });

          for (let seq = 1; seq <= line.label_qty; seq++) {
            const serialRef = range.start + seq - 1;
            cartonInputs.push({
              sscc:             buildSsccFromSettings(companySettings, serialRef),
              serial_reference: serialRef,
              batch_id:         batch.id,
              batch_line_id:    line.id,
              pack_gtin:        line.pack_gtin,
              style_no:         line.style_no,
              color:            line.color,
              scale_code:       line.scale_code,
              carton_seq:       seq,
            });
          }
        }

        // Bulk insert cartons + update line SSCC ranges
        const [insertedCartons] = await Promise.all([
          db.insertCartons(cartonInputs),
          db.updateBatchLinesSscc(lineUpdates),
        ]);
        allCartons = insertedCartons;

        // Refresh lines to get updated sscc_first/last fields
        batchLines = await db.loadBatchLines(batch.id);
      }

      const batches  = await db.loadBatches();
      const gtins    = await db.loadPackGtins();
      set({ batches, currentBatch: batch, batchLines, cartons: allCartons,
            packGtins: gtins, batchLoading: false });
    } catch (e) {
      set({ batchError: String(e), batchLoading: false });
      throw e;
    }
  },

  selectBatch: async (batch) => {
    set({ batchLoading: true, currentBatch: batch });
    try {
      const lines = await db.loadBatchLines(batch.id);
      set({ batchLines: lines, batchLoading: false });
    } catch (e) {
      set({ batchError: String(e), batchLoading: false });
    }
  },

  loadCartonsForBatch: async (batchId) => {
    set({ batchLoading: true });
    try {
      const cartons = await db.loadCartonsByBatch(batchId);
      set({ cartons, batchLoading: false });
    } catch (e) {
      set({ batchError: String(e), batchLoading: false });
    }
  },

  updateBatchStatus: async (batchId, status) => {
    await db.updateBatchStatus(batchId, status);
    set(s => ({
      batches:      s.batches.map(b => b.id === batchId ? { ...b, status } : b),
      currentBatch: s.currentBatch?.id === batchId ? { ...s.currentBatch, status } : s.currentBatch,
    }));
  },

  clearCurrentBatch: () => set({ currentBatch: null, batchLines: [], cartons: [] }),

  // ── Carton tab ────────────────────────────────────────────────────────────────
  loadAllCartons: async () => {
    set({ cartonLoading: true, cartonError: null });
    try {
      const allCartons = await db.loadAllCartons(200);
      set({ allCartons, cartonLoading: false });
    } catch (e) {
      set({ cartonError: String(e), cartonLoading: false });
    }
  },

  createManualSscc: async (data) => {
    const { companySettings } = get();
    if (!companySettings) throw new Error("Company settings not configured. Go to Company Setup first.");
    set({ cartonLoading: true, cartonError: null, lastCreatedSscc: null });
    try {
      const serialRef = await db.claimOneSsccSerial();
      const sscc = buildSsccFromSettings(companySettings, serialRef);
      const carton = await db.createSingleCarton(sscc, serialRef, data);
      const allCartons = await db.loadAllCartons(200);
      set({ allCartons, cartonLoading: false, lastCreatedSscc: sscc });
      return carton;
    } catch (e) {
      set({ cartonError: String(e), cartonLoading: false });
      throw e;
    }
  },

  clearLastCreatedSscc: () => set({ lastCreatedSscc: null }),

  // ── BOM builder ───────────────────────────────────────────────────────────────
  buildBomForGtin: async (packGtinRow) => {
    set({ bomBuilding: true, bomBuildError: null });
    try {
      const [ratios, upcItems] = await Promise.all([
        db.loadScaleRatios(packGtinRow.scale_code),
        db.loadUpcItemsByStyleColor(packGtinRow.style_no, packGtinRow.color),
      ]);
      const result = buildBomLines(packGtinRow.pack_gtin, packGtinRow.style_no, packGtinRow.color, ratios, upcItems);

      await Promise.all([
        db.deletePackGtinBomRows(packGtinRow.pack_gtin),
        db.deletePackGtinBomIssues(packGtinRow.pack_gtin),
      ]);
      if (result.lines.length > 0) await db.insertPackGtinBomRows(result.lines);
      if (result.issues.length > 0) await db.insertPackGtinBomIssues(result.issues);
      await db.updatePackGtinBomStatus(packGtinRow.pack_gtin, result.status, result.units_per_pack, {
        missing_upcs: result.issues.filter(i => i.issue_type === "missing_upc_for_size").length,
        total_issues: result.issues.length,
      });

      const gtins = await db.loadPackGtins();
      set({ packGtins: gtins, bomBuilding: false });
      return result;
    } catch (e) {
      set({ bomBuildError: String(e), bomBuilding: false });
      throw e;
    }
  },

  buildBomForAllMissing: async () => {
    const { packGtins } = get();
    const missing = packGtins.filter(g => g.bom_status === "not_built" || g.bom_status === "error");
    set({ bomBuilding: true, bomBuildError: null });
    let complete = 0, incomplete = 0, errors = 0;
    try {
      for (const g of missing) {
        try {
          const [ratios, upcItems] = await Promise.all([
            db.loadScaleRatios(g.scale_code),
            db.loadUpcItemsByStyleColor(g.style_no, g.color),
          ]);
          const result = buildBomLines(g.pack_gtin, g.style_no, g.color, ratios, upcItems);
          await Promise.all([db.deletePackGtinBomRows(g.pack_gtin), db.deletePackGtinBomIssues(g.pack_gtin)]);
          if (result.lines.length > 0) await db.insertPackGtinBomRows(result.lines);
          if (result.issues.length > 0) await db.insertPackGtinBomIssues(result.issues);
          await db.updatePackGtinBomStatus(g.pack_gtin, result.status, result.units_per_pack, {
            missing_upcs: result.issues.filter(i => i.issue_type === "missing_upc_for_size").length,
            total_issues: result.issues.length,
          });
          if (result.status === "complete") complete++;
          else if (result.status === "incomplete") incomplete++;
          else errors++;
        } catch { errors++; }
      }
      const gtins = await db.loadPackGtins();
      set({ packGtins: gtins, bomBuilding: false });
      return { built: missing.length, complete, incomplete, errors };
    } catch (e) {
      set({ bomBuildError: String(e), bomBuilding: false });
      throw e;
    }
  },

  buildBomsForUpload: async () => {
    const { pendingRows, packGtins } = get();
    if (pendingRows.length === 0) return { built: 0, complete: 0, incomplete: 0, errors: 0 };
    set({ bomBuilding: true, bomBuildError: null });
    let complete = 0, incomplete = 0, errors = 0;
    try {
      const seen = new Set<string>();
      const uniqueRows = pendingRows.filter(r => {
        const key = `${r.styleNo}|${r.color}|${r.scaleCode}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      for (const row of uniqueRows) {
        const g = packGtins.find(pg =>
          pg.style_no === row.styleNo && pg.color === row.color && pg.scale_code === row.scaleCode
        );
        if (!g) { errors++; continue; }
        try {
          const [ratios, upcItems] = await Promise.all([
            db.loadScaleRatios(g.scale_code),
            db.loadUpcItemsByStyleColor(g.style_no, g.color),
          ]);
          const result = buildBomLines(g.pack_gtin, g.style_no, g.color, ratios, upcItems);
          await Promise.all([db.deletePackGtinBomRows(g.pack_gtin), db.deletePackGtinBomIssues(g.pack_gtin)]);
          if (result.lines.length > 0) await db.insertPackGtinBomRows(result.lines);
          if (result.issues.length > 0) await db.insertPackGtinBomIssues(result.issues);
          await db.updatePackGtinBomStatus(g.pack_gtin, result.status, result.units_per_pack, {
            missing_upcs: result.issues.filter(i => i.issue_type === "missing_upc_for_size").length,
            total_issues: result.issues.length,
          });
          if (result.status === "complete") complete++;
          else if (result.status === "incomplete") incomplete++;
          else errors++;
        } catch { errors++; }
      }

      const gtins = await db.loadPackGtins();
      set({ packGtins: gtins, bomBuilding: false });
      return { built: uniqueRows.length, complete, incomplete, errors };
    } catch (e) {
      set({ bomBuildError: String(e), bomBuilding: false });
      throw e;
    }
  },

  buildBomForReceiving: async () => {
    const { receivingExplosion } = get();
    if (!receivingExplosion?.missingBomGtins.length) return;
    set({ bomBuilding: true, bomBuildError: null });
    try {
      for (const packGtinStr of receivingExplosion.missingBomGtins) {
        // Try cached list first, then fresh load
        let packGtinRow = get().packGtins.find(g => g.pack_gtin === packGtinStr);
        if (!packGtinRow) {
          const fresh = await db.loadPackGtins();
          set({ packGtins: fresh });
          packGtinRow = fresh.find(g => g.pack_gtin === packGtinStr);
        }
        if (!packGtinRow) continue;

        const [ratios, upcItems] = await Promise.all([
          db.loadScaleRatios(packGtinRow.scale_code),
          db.loadUpcItemsByStyleColor(packGtinRow.style_no, packGtinRow.color),
        ]);
        const result = buildBomLines(packGtinStr, packGtinRow.style_no, packGtinRow.color, ratios, upcItems);
        await Promise.all([db.deletePackGtinBomRows(packGtinStr), db.deletePackGtinBomIssues(packGtinStr)]);
        if (result.lines.length > 0) await db.insertPackGtinBomRows(result.lines);
        if (result.issues.length > 0) await db.insertPackGtinBomIssues(result.issues);
        await db.updatePackGtinBomStatus(packGtinStr, result.status, result.units_per_pack, {
          missing_upcs: result.issues.filter(i => i.issue_type === "missing_upc_for_size").length,
          total_issues: result.issues.length,
        });
      }
      const gtins = await db.loadPackGtins();
      set({ packGtins: gtins, bomBuilding: false });
    } catch (e) {
      set({ bomBuildError: String(e), bomBuilding: false });
      throw e;
    }
  },

  checkUpcCoverageForStyleColor: async (styleNo, color, scaleCode) => {
    const ratios = get().scaleRatios.filter(r => r.scale_code === scaleCode);
    const upcItems = await db.loadUpcItemsByStyleColor(styleNo, color);
    return checkUpcCoverage(styleNo, color, scaleCode, ratios, upcItems);
  },

  // ── Receiving tab ─────────────────────────────────────────────────────────────
  searchBySscc: async (rawSscc) => {
    const sscc = normalizeSsccInput(rawSscc);
    set({ receivingLoading: true, receivingError: null, receivingCarton: null,
          receivingContents: [], receivingExplosion: null, receivingEditedQtys: {},
          receivingSession: null, receivingAlreadyReceived: false });
    try {
      const carton = await db.loadCartonBySscc(sscc);
      if (!carton) {
        set({ receivingError: `No carton found for SSCC: ${sscc}`, receivingLoading: false });
        return;
      }

      const alreadyReceived = isAlreadyReceived(carton);
      const contents = await db.loadCartonContents(carton.id);

      // Build content lines and load BOM + UPC data
      const contentLines = buildContentLines(carton, contents);
      const uniqueGtins = [...new Set(contentLines.map(c => c.pack_gtin))];
      const bomRows     = await db.loadPackGtinBomForGtins(uniqueGtins);
      const uniqueUpcs  = [...new Set(bomRows.map(b => b.child_upc))];
      const upcRows     = await db.loadUpcsByUpcs(uniqueUpcs);

      const bomMap = new Map<string, PackGtinBom[]>();
      for (const b of bomRows) {
        (bomMap.get(b.pack_gtin) ?? bomMap.set(b.pack_gtin, []).get(b.pack_gtin)!).push(b);
      }
      const upcMap = new Map(upcRows.map(u => [u.upc, u]));

      const explosion = runExplosion(carton, contents, bomMap, upcMap, new Map());

      set({
        receivingCarton:         carton,
        receivingContents:       contents,
        receivingExplosion:      explosion,
        receivingEditedQtys:     {},
        receivingAlreadyReceived: alreadyReceived,
        receivingLoading:        false,
      });
    } catch (e) {
      set({ receivingError: String(e), receivingLoading: false });
    }
  },

  setReceivingEditedQty: (upc, qty) => {
    const { receivingCarton, receivingContents, receivingExplosion, receivingEditedQtys } = get();
    if (!receivingCarton || !receivingExplosion) return;
    const newQtys = { ...receivingEditedQtys, [upc]: qty };
    // Recompute only the aggregated lines with new qty map
    const updated = applyReceivedQtys(
      receivingExplosion.aggregated,
      new Map(Object.entries(newQtys))
    );
    set({
      receivingEditedQtys: newQtys,
      receivingExplosion: {
        ...receivingExplosion,
        aggregated: updated,
        totalReceived: updated.reduce((s, l) => s + l.received_qty, 0),
      },
    });
  },

  confirmReceive: async (notes) => {
    const { receivingCarton, receivingExplosion } = get();
    if (!receivingCarton) throw new Error("No carton loaded.");
    if (!receivingExplosion) throw new Error("No explosion data — search an SSCC first.");

    const { aggregated } = receivingExplosion;
    const sessionStatus = determineSessionStatus(aggregated);

    set({ receivingLoading: true, receivingError: null });
    try {
      const session = await db.createReceivingSession({
        sscc:      receivingCarton.sscc,
        carton_id: receivingCarton.id,
        status:    sessionStatus,
        notes,
        lines: aggregated.map(l => ({
          child_upc:    l.child_upc,
          style_no:     l.style_no,
          color:        l.color,
          size:         l.size,
          expected_qty: l.expected_qty,
          received_qty: l.received_qty,
          variance_qty: l.variance_qty,
          status:       l.line_status === "expected" ? "matched" : l.line_status,
        })),
      });

      await db.markCartonReceived(receivingCarton.id);

      const [updatedCarton, sessions] = await Promise.all([
        db.loadCartonBySscc(receivingCarton.sscc),
        db.loadReceivingSessions(),
      ]);

      set({
        receivingSession:         session,
        receivingCarton:          updatedCarton ?? receivingCarton,
        receivingAlreadyReceived: true,
        receivingSessions:        sessions,
        receivingLoading:         false,
      });
    } catch (e) {
      set({ receivingError: String(e), receivingLoading: false });
      throw e;
    }
  },

  clearReceiving: () => set({
    receivingCarton: null, receivingContents: [], receivingExplosion: null,
    receivingEditedQtys: {}, receivingSession: null, receivingError: null,
    receivingAlreadyReceived: false,
  }),

  loadReceivingSessions: async () => {
    set({ receivingLoading: true });
    try {
      const sessions = await db.loadReceivingSessions();
      set({ receivingSessions: sessions, receivingLoading: false });
    } catch (e) {
      set({ receivingError: String(e), receivingLoading: false });
    }
  },
}));
