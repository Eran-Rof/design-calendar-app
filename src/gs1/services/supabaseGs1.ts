// ── GS1 module — Supabase REST service ────────────────────────────────────────
// Direct fetch to Supabase REST API — same pattern as src/store/supabaseService.ts

import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { buildGtinFromSettings } from "./gtinService";
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
  ParseIssueInput,
  ParsedRow,
  ParseSummary,
  LabelBatch,
  LabelBatchLine,
  LabelData,
  LabelMode,
  LabelTemplate,
  LabelTemplateInput,
  LabelPrintLog,
  Carton,
  CartonInput,
  CartonContent,
  ManualCartonInput,
  ReceivingSession,
  ReceivingSessionLine,
  ReceivingSessionInput,
  XoroSyncLog,
} from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function rpc(path: string): string {
  return `${SB_URL}/rest/v1/${path}`;
}

async function sbFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...SB_HEADERS, ...(init.headers as Record<string, string> ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase request failed [${res.status}]: ${text.slice(0, 300)}`);
  }
  if (!text) return [] as unknown as T;
  return JSON.parse(text) as T;
}

// ── company_settings ──────────────────────────────────────────────────────────

export async function loadCompanySettings(): Promise<CompanySettings | null> {
  const rows = await sbFetch<CompanySettings[]>(`${rpc("company_settings")}?order=created_at.asc&limit=1`);
  return rows[0] ?? null;
}

export async function saveCompanySettings(data: CompanySettingsInput): Promise<CompanySettings> {
  const payload = {
    company_name: data.company_name,
    gs1_prefix: data.gs1_prefix,
    prefix_length: data.prefix_length,
    gtin_indicator_digit: data.gtin_indicator_digit,
    starting_item_reference: data.starting_item_reference,
    next_item_reference_counter: data.next_item_reference_counter,
    default_label_format: data.default_label_format || null,
    xoro_api_base_url: data.xoro_api_base_url || null,
    xoro_api_key_ref: data.xoro_api_key_ref || null,
    xoro_item_endpoint: data.xoro_item_endpoint || null,
    xoro_enabled: data.xoro_enabled ?? false,
    sscc_extension_digit: data.sscc_extension_digit || "0",
    sscc_starting_serial_reference: data.sscc_starting_serial_reference ?? 1,
    sscc_next_serial_reference_counter: data.sscc_next_serial_reference_counter ?? 1,
  };
  const existing = await loadCompanySettings();
  if (existing) {
    const rows = await sbFetch<CompanySettings[]>(
      `${rpc("company_settings")}?id=eq.${existing.id}`,
      { method: "PATCH", body: JSON.stringify(payload), headers: { Prefer: "return=representation" } }
    );
    return rows[0];
  }
  const rows = await sbFetch<CompanySettings[]>(
    rpc("company_settings"),
    { method: "POST", body: JSON.stringify(payload), headers: { Prefer: "return=representation" } }
  );
  return rows[0];
}

// ── upc_item_master ───────────────────────────────────────────────────────────

export async function loadUpcItems(limit = 1000, offset = 0): Promise<UpcItem[]> {
  return sbFetch<UpcItem[]>(
    `${rpc("upc_item_master")}?order=style_no.asc,color.asc,size.asc&limit=${limit}&offset=${offset}`
  );
}

export async function upsertUpcItems(items: UpcItemInput[]): Promise<{ inserted: number }> {
  if (items.length === 0) return { inserted: 0 };
  const rows = await sbFetch<UpcItem[]>(
    rpc("upc_item_master"),
    {
      method: "POST",
      body: JSON.stringify(items),
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    }
  );
  return { inserted: rows.length };
}

export async function deleteUpcItem(id: string): Promise<void> {
  await sbFetch<void>(`${rpc("upc_item_master")}?id=eq.${id}`, { method: "DELETE" });
}

// ── scale_master + scale_size_ratios ──────────────────────────────────────────

export async function loadScales(): Promise<ScaleMaster[]> {
  return sbFetch<ScaleMaster[]>(`${rpc("scale_master")}?order=scale_code.asc`);
}

export async function loadScaleRatios(scaleCode?: string): Promise<ScaleSizeRatio[]> {
  const filter = scaleCode ? `?scale_code=eq.${encodeURIComponent(scaleCode)}&order=size.asc` : "?order=scale_code.asc,size.asc";
  return sbFetch<ScaleSizeRatio[]>(`${rpc("scale_size_ratios")}${filter}`);
}

export async function saveScale(data: ScaleInput): Promise<ScaleMaster> {
  const totalUnits = data.ratios?.reduce((s, r) => s + r.qty, 0) ?? null;
  const [scale] = await sbFetch<ScaleMaster[]>(
    rpc("scale_master"),
    {
      method: "POST",
      body: JSON.stringify({
        scale_code: data.scale_code,
        description: data.description ?? null,
        total_units: totalUnits,
      }),
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    }
  );

  if (data.ratios && data.ratios.length > 0) {
    // Delete existing ratios for this scale then re-insert
    await sbFetch<void>(`${rpc("scale_size_ratios")}?scale_code=eq.${encodeURIComponent(data.scale_code)}`, {
      method: "DELETE",
    });
    await sbFetch<ScaleSizeRatio[]>(
      rpc("scale_size_ratios"),
      {
        method: "POST",
        body: JSON.stringify(data.ratios.map(r => ({ scale_code: data.scale_code, size: r.size, qty: r.qty }))),
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      }
    );
    // Update total_units on scale record
    await sbFetch<void>(
      `${rpc("scale_master")}?scale_code=eq.${encodeURIComponent(data.scale_code)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ total_units: totalUnits }),
        headers: { Prefer: "return=minimal" },
      }
    );
  }
  return scale;
}

export async function deleteScale(scaleCode: string): Promise<void> {
  await sbFetch<void>(`${rpc("scale_master")}?scale_code=eq.${encodeURIComponent(scaleCode)}`, {
    method: "DELETE",
  });
}

// ── pack_gtin_master ──────────────────────────────────────────────────────────

export async function loadPackGtins(filters?: { style_no?: string; color?: string; scale_code?: string }): Promise<PackGtin[]> {
  let qs = "?order=style_no.asc,color.asc,scale_code.asc";
  if (filters?.style_no) qs += `&style_no=eq.${encodeURIComponent(filters.style_no)}`;
  if (filters?.color)    qs += `&color=eq.${encodeURIComponent(filters.color)}`;
  if (filters?.scale_code) qs += `&scale_code=eq.${encodeURIComponent(filters.scale_code)}`;
  return sbFetch<PackGtin[]>(`${rpc("pack_gtin_master")}${qs}`);
}

export async function findPackGtin(styleNo: string, color: string, scaleCode: string): Promise<PackGtin | null> {
  const rows = await sbFetch<PackGtin[]>(
    `${rpc("pack_gtin_master")}?style_no=eq.${encodeURIComponent(styleNo)}&color=eq.${encodeURIComponent(color)}&scale_code=eq.${encodeURIComponent(scaleCode)}&limit=1`
  );
  return rows[0] ?? null;
}

// Atomic: claim a counter value, build GTIN, insert — returns existing GTIN if already exists
export async function getOrCreatePackGtin(
  styleNo: string,
  color: string,
  scaleCode: string,
  settings: CompanySettings
): Promise<PackGtin> {
  // Fast path: already exists
  const existing = await findPackGtin(styleNo, color, scaleCode);
  if (existing) return existing;

  // Claim next item reference atomically via RPC
  // Supabase RPCs can return either [{gs1_claim_next_item_reference: n}] or a bare scalar
  const rpcRes = await sbFetch<{ gs1_claim_next_item_reference: number }[] | number>(
    `${rpc("rpc/gs1_claim_next_item_reference")}`,
    { method: "POST", body: JSON.stringify({}) }
  );
  const itemRef = Array.isArray(rpcRes) ? rpcRes[0]?.gs1_claim_next_item_reference : rpcRes;

  const gtin = buildGtinFromSettings(settings, Number(itemRef));

  try {
    const [row] = await sbFetch<PackGtin[]>(
      rpc("pack_gtin_master"),
      {
        method: "POST",
        body: JSON.stringify({
          style_no: styleNo,
          color,
          scale_code: scaleCode,
          pack_gtin: gtin,
          item_reference: itemRef,
          source_method: "system_generated",
        }),
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      }
    );
    return row;
  } catch {
    // Race condition: another process inserted same style/color/scale — fetch it
    const race = await findPackGtin(styleNo, color, scaleCode);
    if (race) return race;
    throw new Error(`Failed to create pack GTIN for ${styleNo}/${color}/${scaleCode}`);
  }
}

// ── packing_list_uploads ──────────────────────────────────────────────────────

export async function loadUploads(): Promise<PackingListUpload[]> {
  return sbFetch<PackingListUpload[]>(`${rpc("packing_list_uploads")}?order=uploaded_at.desc&limit=50`);
}

export async function createUploadRecord(fileName: string): Promise<PackingListUpload> {
  const [row] = await sbFetch<PackingListUpload[]>(
    rpc("packing_list_uploads"),
    {
      method: "POST",
      body: JSON.stringify({ file_name: fileName, parse_status: "parsing" }),
      headers: { Prefer: "return=representation" },
    }
  );
  return row;
}

export async function updateUploadStatus(
  uploadId: string,
  status: PackingListUpload["parse_status"],
  summary?: ParseSummary
): Promise<void> {
  await sbFetch<void>(
    `${rpc("packing_list_uploads")}?id=eq.${uploadId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ parse_status: status, parse_summary: summary ?? null }),
      headers: { Prefer: "return=minimal" },
    }
  );
}

// ── packing_list_blocks ───────────────────────────────────────────────────────

export async function insertParsedBlocks(uploadId: string, rows: ParsedRow[]): Promise<void> {
  if (rows.length === 0) return;
  const payload = rows.map(r => ({
    upload_id: uploadId,
    sheet_name: r.sheetName ?? null,
    block_type: "channel_qty",
    style_no: r.styleNo ?? null,
    color: r.color ?? null,
    channel: r.channel ?? null,
    scale_code: r.scaleCode ?? null,
    pack_qty: r.packQty ?? null,
    confidence_score: r.confidence ?? null,
    parse_status: (r.confidence ?? 0) >= 70 ? "parsed" : (r.confidence ?? 0) >= 40 ? "review" : "failed",
    raw_payload: {},
    parsed_payload: { styleNo: r.styleNo, color: r.color ?? null, channel: r.channel ?? null, scaleCode: r.scaleCode, packQty: r.packQty },
  }));
  await sbFetch<void>(
    rpc("packing_list_blocks"),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { Prefer: "return=minimal" },
    }
  );
}

export async function loadBlocks(uploadId: string): Promise<PackingListBlock[]> {
  return sbFetch<PackingListBlock[]>(
    `${rpc("packing_list_blocks")}?upload_id=eq.${uploadId}&order=created_at.asc`
  );
}

// ── parse_issues ──────────────────────────────────────────────────────────────

export async function insertParseIssues(uploadId: string, issues: ParseIssueInput[]): Promise<void> {
  if (issues.length === 0) return;
  await sbFetch<void>(
    rpc("parse_issues"),
    {
      method: "POST",
      body: JSON.stringify(issues.map(i => ({
        upload_id: uploadId,
        sheet_name: i.sheet_name ?? null,
        issue_type: i.issue_type,
        severity: i.severity,
        message: i.message,
        raw_context: i.raw_context ?? null,
      }))),
      headers: { Prefer: "return=minimal" },
    }
  );
}

export async function loadParseIssues(uploadId: string): Promise<ParseIssue[]> {
  return sbFetch<ParseIssue[]>(
    `${rpc("parse_issues")}?upload_id=eq.${uploadId}&order=created_at.asc`
  );
}

// ── label_batches + lines ─────────────────────────────────────────────────────

export async function loadBatches(): Promise<LabelBatch[]> {
  return sbFetch<LabelBatch[]>(`${rpc("label_batches")}?order=generated_at.desc&limit=50`);
}

export async function createLabelBatch(
  batchName: string,
  uploadId: string | null,
  lines: LabelData[],
  labelMode: LabelMode = "pack_gtin"
): Promise<LabelBatch> {
  const [batch] = await sbFetch<LabelBatch[]>(
    rpc("label_batches"),
    {
      method: "POST",
      body: JSON.stringify({
        batch_name: batchName,
        upload_id: uploadId ?? null,
        status: "generated",
        output_format: "pdf",
        label_mode: labelMode,
      }),
      headers: { Prefer: "return=representation" },
    }
  );

  if (lines.length > 0) {
    await sbFetch<void>(
      rpc("label_batch_lines"),
      {
        method: "POST",
        body: JSON.stringify(lines.map(l => ({
          batch_id: batch.id,
          style_no: l.style_no,
          color: l.color,
          scale_code: l.scale_code,
          pack_gtin: l.pack_gtin,
          label_qty: l.label_qty,
          source_sheet_name: l.source_sheet_name ?? null,
          source_channel: l.source_channel ?? null,
          label_type: labelMode,
          sscc_first: null,
          sscc_last: null,
          carton_count: null,
        }))),
        headers: { Prefer: "return=minimal" },
      }
    );
  }
  return batch;
}

// ── SSCC / carton operations ──────────────────────────────────────────────────

export async function claimSsccSerialRange(count: number): Promise<{ start: number; end: number }> {
  const rows = await sbFetch<{ serial_start: number; serial_end: number }[]>(
    rpc("rpc/sscc_claim_serial_range"),
    { method: "POST", body: JSON.stringify({ p_count: count }) }
  );
  const r = rows[0];
  return { start: Number(r.serial_start), end: Number(r.serial_end) };
}

export async function insertCartons(cartons: CartonInput[]): Promise<Carton[]> {
  if (cartons.length === 0) return [];
  return sbFetch<Carton[]>(
    rpc("cartons"),
    {
      method: "POST",
      body: JSON.stringify(cartons),
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    }
  );
}

export async function updateBatchLinesSscc(
  lines: Array<{ id: string; sscc_first: string; sscc_last: string; carton_count: number }>
): Promise<void> {
  // Update each line individually (PostgREST doesn't support bulk PATCH with different values)
  await Promise.all(lines.map(l =>
    sbFetch<void>(
      `${rpc("label_batch_lines")}?id=eq.${l.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ sscc_first: l.sscc_first, sscc_last: l.sscc_last, carton_count: l.carton_count }),
        headers: { Prefer: "return=minimal" },
      }
    )
  ));
}

export async function loadCartonsByBatch(batchId: string): Promise<Carton[]> {
  return sbFetch<Carton[]>(
    `${rpc("cartons")}?batch_id=eq.${batchId}&order=batch_line_id.asc,carton_seq.asc`
  );
}

export async function loadCartonsByLine(batchLineId: string): Promise<Carton[]> {
  return sbFetch<Carton[]>(
    `${rpc("cartons")}?batch_line_id=eq.${batchLineId}&order=carton_seq.asc`
  );
}

export async function loadCartonsByUpload(uploadId: string): Promise<Carton[]> {
  return sbFetch<Carton[]>(
    `${rpc("cartons")}?upload_id=eq.${uploadId}&order=created_at.asc`
  );
}

export async function loadAllCartons(limit = 100): Promise<Carton[]> {
  return sbFetch<Carton[]>(
    `${rpc("cartons")}?order=created_at.desc&limit=${limit}`
  );
}

export async function claimOneSsccSerial(): Promise<number> {
  const result = await sbFetch<number | [number]>(
    rpc("rpc/sscc_claim_one_serial"),
    { method: "POST", body: JSON.stringify({}) }
  );
  return Array.isArray(result) ? result[0] : Number(result);
}

export async function createSingleCarton(
  sscc: string,
  serialReference: number,
  data: ManualCartonInput
): Promise<Carton> {
  const [row] = await sbFetch<Carton[]>(
    rpc("cartons"),
    {
      method: "POST",
      body: JSON.stringify({
        sscc,
        serial_reference: serialReference,
        upload_id:    data.upload_id    ?? null,
        po_number:    data.po_number    ?? null,
        carton_no:    data.carton_no    ?? null,
        channel:      data.channel      ?? null,
        style_no:     data.style_no     ?? null,
        color:        data.color        ?? null,
        total_packs:  data.total_packs  ?? null,
        total_units:  data.total_units  ?? null,
        carton_seq:   1,
        status:       "generated",
      }),
      headers: { Prefer: "return=representation" },
    }
  );
  return row;
}

// ── Receiving DB operations ───────────────────────────────────────────────────

export async function loadCartonBySscc(sscc: string): Promise<Carton | null> {
  const rows = await sbFetch<Carton[]>(
    `${rpc("cartons")}?sscc=eq.${encodeURIComponent(sscc)}&limit=1`
  );
  return rows[0] ?? null;
}

export async function loadCartonContents(cartonId: string): Promise<CartonContent[]> {
  return sbFetch<CartonContent[]>(
    `${rpc("carton_contents")}?carton_id=eq.${cartonId}&order=pack_gtin.asc`
  );
}

export async function loadPackGtinBomForGtins(gtins: string[]): Promise<PackGtinBom[]> {
  if (gtins.length === 0) return [];
  const inClause = gtins.map(g => encodeURIComponent(g)).join(",");
  return sbFetch<PackGtinBom[]>(
    `${rpc("pack_gtin_bom")}?pack_gtin=in.(${inClause})&order=pack_gtin.asc,size.asc`
  );
}

export async function loadUpcsByUpcs(upcs: string[]): Promise<UpcItem[]> {
  if (upcs.length === 0) return [];
  const inClause = upcs.map(u => encodeURIComponent(u)).join(",");
  return sbFetch<UpcItem[]>(
    `${rpc("upc_item_master")}?upc=in.(${inClause})`
  );
}

export async function markCartonReceived(cartonId: string): Promise<void> {
  await sbFetch<void>(
    `${rpc("cartons")}?id=eq.${cartonId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: "received" }),
      headers: { Prefer: "return=minimal" },
    }
  );
}

export async function createReceivingSession(
  input: ReceivingSessionInput
): Promise<ReceivingSession> {
  const [session] = await sbFetch<ReceivingSession[]>(
    rpc("receiving_sessions"),
    {
      method: "POST",
      body: JSON.stringify({
        sscc:       input.sscc,
        carton_id:  input.carton_id,
        status:     input.status,
        received_at: new Date().toISOString(),
        notes:      input.notes ?? null,
      }),
      headers: { Prefer: "return=representation" },
    }
  );

  if (input.lines.length > 0) {
    await sbFetch<void>(
      rpc("receiving_session_lines"),
      {
        method: "POST",
        body: JSON.stringify(input.lines.map(l => ({
          session_id:   session.id,
          child_upc:    l.child_upc,
          style_no:     l.style_no,
          color:        l.color,
          size:         l.size,
          expected_qty: l.expected_qty,
          received_qty: l.received_qty,
          variance_qty: l.variance_qty,
          status:       l.status,
        }))),
        headers: { Prefer: "return=minimal" },
      }
    );
  }

  return session;
}

export async function loadReceivingSessions(limit = 50): Promise<ReceivingSession[]> {
  return sbFetch<ReceivingSession[]>(
    `${rpc("receiving_sessions")}?order=created_at.desc&limit=${limit}`
  );
}

export async function loadSessionLines(sessionId: string): Promise<ReceivingSessionLine[]> {
  return sbFetch<ReceivingSessionLine[]>(
    `${rpc("receiving_session_lines")}?session_id=eq.${sessionId}&order=style_no.asc,color.asc,size.asc`
  );
}

// ── BOM builder DB operations ─────────────────────────────────────────────────

export async function loadUpcItemsByStyleColor(styleNo: string, color: string): Promise<UpcItem[]> {
  return sbFetch<UpcItem[]>(
    `${rpc("upc_item_master")}?style_no=eq.${encodeURIComponent(styleNo)}&color=eq.${encodeURIComponent(color)}&order=size.asc`
  );
}

export async function loadPackGtinBomRows(packGtin: string): Promise<PackGtinBom[]> {
  return sbFetch<PackGtinBom[]>(
    `${rpc("pack_gtin_bom")}?pack_gtin=eq.${encodeURIComponent(packGtin)}&order=size.asc`
  );
}

export async function deletePackGtinBomRows(packGtin: string): Promise<void> {
  await sbFetch<void>(
    `${rpc("pack_gtin_bom")}?pack_gtin=eq.${encodeURIComponent(packGtin)}`,
    { method: "DELETE" }
  );
}

export async function insertPackGtinBomRows(
  lines: Array<{ pack_gtin: string; child_upc: string; size: string; qty_in_pack: number }>
): Promise<PackGtinBom[]> {
  if (lines.length === 0) return [];
  return sbFetch<PackGtinBom[]>(
    rpc("pack_gtin_bom"),
    { method: "POST", body: JSON.stringify(lines), headers: { Prefer: "return=representation" } }
  );
}

export async function updatePackGtinBomStatus(
  packGtin: string,
  status: string,
  unitsPerPack: number | null,
  issueSummary: Record<string, unknown> | null
): Promise<void> {
  await sbFetch<void>(
    `${rpc("pack_gtin_master")}?pack_gtin=eq.${encodeURIComponent(packGtin)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        bom_status: status,
        bom_last_built_at: new Date().toISOString(),
        bom_issue_summary: issueSummary,
        units_per_pack: unitsPerPack,
      }),
      headers: { Prefer: "return=minimal" },
    }
  );
}

export async function loadPackGtinBomIssues(packGtin: string): Promise<PackGtinBomIssue[]> {
  return sbFetch<PackGtinBomIssue[]>(
    `${rpc("pack_gtin_bom_issues")}?pack_gtin=eq.${encodeURIComponent(packGtin)}&order=severity.asc,created_at.asc`
  );
}

export async function deletePackGtinBomIssues(packGtin: string): Promise<void> {
  await sbFetch<void>(
    `${rpc("pack_gtin_bom_issues")}?pack_gtin=eq.${encodeURIComponent(packGtin)}`,
    { method: "DELETE" }
  );
}

export async function insertPackGtinBomIssues(
  issues: Array<{ pack_gtin: string; issue_type: string; severity: string; message: string; context?: Record<string, unknown> }>
): Promise<void> {
  if (issues.length === 0) return;
  await sbFetch<void>(
    rpc("pack_gtin_bom_issues"),
    {
      method: "POST",
      body: JSON.stringify(issues.map(i => ({ ...i, context: i.context ?? null }))),
      headers: { Prefer: "return=minimal" },
    }
  );
}

export async function loadBatchLines(batchId: string): Promise<LabelBatchLine[]> {
  return sbFetch<LabelBatchLine[]>(
    `${rpc("label_batch_lines")}?batch_id=eq.${batchId}&order=style_no.asc,color.asc,scale_code.asc`
  );
}

// ── Xoro sync log ─────────────────────────────────────────────────────────────

export async function createSyncLog(syncType: string): Promise<XoroSyncLog> {
  const [row] = await sbFetch<XoroSyncLog[]>(
    rpc("xoro_sync_logs"),
    {
      method: "POST",
      body: JSON.stringify({ sync_type: syncType, status: "running" }),
      headers: { Prefer: "return=representation" },
    }
  );
  return row;
}

export async function updateSyncLog(
  id: string,
  data: {
    status: "complete" | "error";
    records_processed?: number;
    records_inserted?: number;
    records_updated?: number;
    error_message?: string | null;
    raw_summary?: Record<string, unknown> | null;
  }
): Promise<void> {
  await sbFetch<void>(
    `${rpc("xoro_sync_logs")}?id=eq.${id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...data, completed_at: new Date().toISOString() }),
      headers: { Prefer: "return=minimal" },
    }
  );
}

export async function loadSyncLogs(limit = 20): Promise<XoroSyncLog[]> {
  return sbFetch<XoroSyncLog[]>(
    `${rpc("xoro_sync_logs")}?order=started_at.desc&limit=${limit}`
  );
}

export async function updateBatchStatus(batchId: string, status: LabelBatch["status"]): Promise<void> {
  await sbFetch<void>(
    `${rpc("label_batches")}?id=eq.${batchId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status }),
      headers: { Prefer: "return=minimal" },
    }
  );
}

// ── label_templates ───────────────────────────────────────────────────────────

export async function loadLabelTemplates(): Promise<LabelTemplate[]> {
  return sbFetch<LabelTemplate[]>(
    `${rpc("label_templates")}?order=label_type.asc,template_name.asc`
  );
}

export async function saveLabelTemplate(data: LabelTemplateInput): Promise<LabelTemplate> {
  const payload = {
    label_type:            data.label_type,
    template_name:         data.template_name,
    label_width:           data.label_width  || null,
    label_height:          data.label_height || null,
    printer_type:          data.printer_type,
    barcode_format:        data.barcode_format,
    human_readable_fields: data.human_readable_fields ?? null,
    is_default:            data.is_default ?? false,
    updated_at:            new Date().toISOString(),
  };
  const [row] = await sbFetch<LabelTemplate[]>(
    rpc("label_templates"),
    { method: "POST", body: JSON.stringify(payload), headers: { Prefer: "return=representation" } }
  );
  return row;
}

export async function updateLabelTemplate(id: string, data: Partial<LabelTemplateInput>): Promise<LabelTemplate> {
  const payload = { ...data, updated_at: new Date().toISOString() };
  const [row] = await sbFetch<LabelTemplate[]>(
    `${rpc("label_templates")}?id=eq.${id}`,
    { method: "PATCH", body: JSON.stringify(payload), headers: { Prefer: "return=representation" } }
  );
  return row;
}

export async function deleteLabelTemplate(id: string): Promise<void> {
  await sbFetch<void>(`${rpc("label_templates")}?id=eq.${id}`, { method: "DELETE" });
}

export async function setDefaultTemplate(id: string, labelType: string): Promise<void> {
  // Clear existing defaults for this label type, then set the new one
  await sbFetch<void>(
    `${rpc("label_templates")}?label_type=eq.${encodeURIComponent(labelType)}&is_default=eq.true`,
    { method: "PATCH", body: JSON.stringify({ is_default: false }), headers: { Prefer: "return=minimal" } }
  );
  await sbFetch<void>(
    `${rpc("label_templates")}?id=eq.${id}`,
    { method: "PATCH", body: JSON.stringify({ is_default: true, updated_at: new Date().toISOString() }), headers: { Prefer: "return=minimal" } }
  );
}

// ── label_print_logs ──────────────────────────────────────────────────────────

export async function createPrintLog(data: {
  label_batch_id: string | null;
  label_type: string;
  print_method: string;
  labels_printed: number;
  status: "printed" | "reprint" | "failed";
  reprint_reason?: string | null;
}): Promise<LabelPrintLog> {
  const [row] = await sbFetch<LabelPrintLog[]>(
    rpc("label_print_logs"),
    {
      method: "POST",
      body: JSON.stringify({
        label_batch_id:  data.label_batch_id ?? null,
        label_type:      data.label_type,
        print_method:    data.print_method,
        labels_printed:  data.labels_printed,
        status:          data.status,
        reprint_reason:  data.reprint_reason ?? null,
      }),
      headers: { Prefer: "return=representation" },
    }
  );
  return row;
}

export async function loadPrintLogs(batchId?: string, limit = 50): Promise<LabelPrintLog[]> {
  const filter = batchId
    ? `?label_batch_id=eq.${batchId}&order=created_at.desc&limit=${limit}`
    : `?order=created_at.desc&limit=${limit}`;
  return sbFetch<LabelPrintLog[]>(`${rpc("label_print_logs")}${filter}`);
}
