// ── GS1 Prepack Label Generation — shared types ────────────────────────────

// ── DB row types ──────────────────────────────────────────────────────────────

export interface CompanySettings {
  id: string;
  company_name: string;
  gs1_prefix: string;
  prefix_length: number;
  gtin_indicator_digit: string;
  starting_item_reference: number;
  next_item_reference_counter: number;
  default_label_format: string | null;
  xoro_api_base_url: string | null;
  xoro_api_key_ref: string | null;
  xoro_item_endpoint: string | null;
  xoro_enabled: boolean;
  // SSCC fields
  sscc_extension_digit: string;
  sscc_starting_serial_reference: number;
  sscc_next_serial_reference_counter: number;
  created_at: string;
  updated_at: string;
}

export interface XoroSyncLog {
  id: string;
  sync_type: string;
  status: "running" | "complete" | "error";
  started_at: string;
  completed_at: string | null;
  records_processed: number;
  records_inserted: number;
  records_updated: number;
  error_message: string | null;
  raw_summary: Record<string, unknown> | null;
}

export interface UpcItem {
  id: string;
  upc: string;
  style_no: string;
  color: string;
  size: string;
  description: string | null;
  source_method: string;
  created_at: string;
  updated_at: string;
}

export interface ScaleMaster {
  id: string;
  scale_code: string;
  description: string | null;
  total_units: number | null;
  created_at: string;
  updated_at: string;
}

export interface ScaleSizeRatio {
  id: string;
  scale_code: string;
  size: string;
  qty: number;
  created_at: string;
}

export type BomStatus = "not_built" | "complete" | "incomplete" | "error";

export interface PackGtin {
  id: string;
  style_no: string;
  color: string;
  scale_code: string;
  pack_gtin: string;
  item_reference: number;
  units_per_pack: number | null;
  status: "active" | "inactive";
  source_method: string;
  bom_status: BomStatus;
  bom_last_built_at: string | null;
  bom_issue_summary: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface PackGtinBomIssue {
  id: string;
  pack_gtin: string;
  issue_type: string;
  severity: "info" | "warning" | "error";
  message: string;
  context: Record<string, unknown> | null;
  created_at: string;
}

export interface PackGtinBom {
  id: string;
  pack_gtin: string;
  child_upc: string;
  size: string;
  qty_in_pack: number;
  created_at: string;
}

export interface PackingListUpload {
  id: string;
  file_name: string;
  storage_path: string;
  parse_status: "uploaded" | "parsing" | "parsed" | "error";
  parse_summary: ParseSummary | null;
  uploaded_at: string;
  created_at: string;
}

export interface ParseSummary {
  sheets_processed: number;
  blocks_found: number;
  blocks_failed: number;
  total_labels: number;
  issues_count: number;
}

export interface PackingListBlock {
  id: string;
  upload_id: string;
  sheet_name: string;
  block_type: string;
  style_no: string | null;
  color: string | null;
  channel: string | null;
  scale_code: string | null;
  pack_qty: number | null;
  raw_payload: Record<string, unknown>;
  parsed_payload: Record<string, unknown> | null;
  confidence_score: number | null;
  parse_status: "parsed" | "review" | "failed";
  created_at: string;
}

export interface ParseIssue {
  id: string;
  upload_id: string;
  sheet_name: string | null;
  issue_type: string;
  severity: "info" | "warning" | "error";
  message: string;
  raw_context: Record<string, unknown> | null;
  created_at: string;
}

export type LabelMode = "pack_gtin" | "sscc" | "both";

export interface LabelBatch {
  id: string;
  upload_id: string | null;
  batch_name: string;
  status: "generated" | "printed" | "cancelled";
  output_format: string;
  label_mode: LabelMode;
  generated_at: string;
  created_at: string;
}

export interface LabelBatchLine {
  id: string;
  batch_id: string;
  style_no: string;
  color: string;
  scale_code: string;
  pack_gtin: string;
  label_qty: number;
  source_sheet_name: string | null;
  source_channel: string | null;
  label_type: LabelMode;
  sscc_first: string | null;
  sscc_last: string | null;
  carton_count: number | null;
  created_at: string;
}

// ── Carton types ──────────────────────────────────────────────────────────────

export interface Carton {
  id: string;
  sscc: string;
  serial_reference: number;
  batch_id: string | null;
  batch_line_id: string | null;
  upload_id: string | null;
  po_number: string | null;
  carton_no: string | null;
  channel: string | null;
  pack_gtin: string | null;
  style_no: string | null;
  color: string | null;
  scale_code: string | null;
  carton_seq: number;
  total_packs: number | null;
  total_units: number | null;
  status: "generated" | "shipped" | "received" | "cancelled";
  created_at: string;
  updated_at: string;
}

// ── Receiving types ───────────────────────────────────────────────────────────

export interface ReceivingSession {
  id: string;
  sscc: string;
  carton_id: string | null;
  status: "open" | "received" | "variance" | "override";
  received_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReceivingSessionLine {
  id: string;
  session_id: string;
  child_upc: string;
  style_no: string;
  color: string;
  size: string;
  expected_qty: number;
  received_qty: number | null;
  variance_qty: number | null;
  status: "expected" | "matched" | "variance";
  created_at: string;
}

export interface CartonContent {
  id: string;
  carton_id: string;
  pack_gtin: string;
  style_no: string | null;
  color: string | null;
  scale_code: string | null;
  child_upc: string | null;
  size: string | null;
  qty_per_pack: number;
  pack_qty: number | null;
  exploded_unit_qty: number | null;
  created_at: string;
}

export interface CartonInput {
  sscc: string;
  serial_reference: number;
  batch_id: string;
  batch_line_id: string;
  pack_gtin: string;
  style_no: string;
  color: string;
  scale_code: string;
  carton_seq: number;
  upload_id?: string | null;
  po_number?: string | null;
  carton_no?: string | null;
  total_packs?: number | null;
  total_units?: number | null;
}

export interface ManualCartonInput {
  upload_id?: string;
  po_number?: string;
  carton_no?: string;
  channel?: string;
  style_no?: string;
  color?: string;
  total_packs?: number;
  total_units?: number;
}

export interface ReceivingSessionInput {
  sscc: string;
  carton_id: string | null;
  status: "received" | "variance";
  notes?: string;
  lines: Array<{
    child_upc: string;
    style_no: string;
    color: string;
    size: string;
    expected_qty: number;
    received_qty: number;
    variance_qty: number;
    status: "matched" | "variance";
  }>;
}

// ── Input/form types ──────────────────────────────────────────────────────────

export interface CompanySettingsInput {
  company_name: string;
  gs1_prefix: string;
  prefix_length: number;
  gtin_indicator_digit: string;
  starting_item_reference: number;
  next_item_reference_counter: number;
  default_label_format: string;
  xoro_api_base_url: string;
  xoro_api_key_ref: string;
  xoro_item_endpoint: string;
  xoro_enabled: boolean;
  sscc_extension_digit: string;
  sscc_starting_serial_reference: number;
  sscc_next_serial_reference_counter: number;
}

export interface UpcItemInput {
  upc: string;
  style_no: string;
  color: string;
  size: string;
  description?: string;
  source_method?: string;
}

export interface ScaleInput {
  scale_code: string;
  description?: string;
  ratios?: Array<{ size: string; qty: number }>;
}

// ── Parser domain types ───────────────────────────────────────────────────────

export interface ParsedRow {
  styleNo: string;
  color: string;
  channel: string;
  scaleCode: string;
  packQty: number;
  sheetName: string;
  rowIndex?: number;
  confidence: number;
}

export interface ParsedSheet {
  sheetName: string;
  rows: ParsedRow[];
  issues: ParseIssueInput[];
}

export interface ParseIssueInput {
  sheet_name: string | null;
  issue_type: string;
  severity: "info" | "warning" | "error";
  message: string;
  raw_context?: Record<string, unknown>;
}

export interface PackingListParseResult {
  sheets: ParsedSheet[];
  allRows: ParsedRow[];
  issues: ParseIssueInput[];
}

// ── Label export types ────────────────────────────────────────────────────────

export interface LabelData {
  pack_gtin: string;
  style_no: string;
  color: string;
  scale_code: string;
  label_qty: number;
  source_channel?: string | null;
  source_sheet_name?: string | null;
}

// ── Label template types ──────────────────────────────────────────────────────

export type PrinterType = "pdf" | "zebra_zpl" | "csv";
export type LabelTemplateType = "pack_gtin" | "sscc";

export interface HumanReadableFields {
  show_style:   boolean;
  show_color:   boolean;
  show_scale:   boolean;
  show_channel: boolean;  // GTIN labels
  show_po:      boolean;  // SSCC labels
  show_carton:  boolean;  // SSCC labels
  show_units:   boolean;  // SSCC labels
}

export interface LabelTemplate {
  id: string;
  label_type: LabelTemplateType;
  template_name: string;
  label_width: string | null;
  label_height: string | null;
  printer_type: PrinterType;
  barcode_format: string;
  human_readable_fields: HumanReadableFields | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface LabelTemplateInput {
  label_type: LabelTemplateType;
  template_name: string;
  label_width: string;
  label_height: string;
  printer_type: PrinterType;
  barcode_format: string;
  human_readable_fields: HumanReadableFields;
  is_default: boolean;
}

export interface LabelPrintLog {
  id: string;
  label_batch_id: string | null;
  label_type: string;
  printed_by: string | null;
  print_method: string | null;
  labels_printed: number;
  output_file_path: string | null;
  status: "printed" | "reprint" | "failed";
  reprint_reason: string | null;
  created_at: string;
}

// ── Audit log types ───────────────────────────────────────────────────────────

export interface AuditLog {
  id: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  user_label: string | null;
  source: string | null;
  created_at: string;
}

export interface AuditLogInput {
  entity_type: string;
  entity_id?: string | null;
  action: string;
  old_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  user_label?: string | null;
  source?: string | null;
}

// ── Data quality types ────────────────────────────────────────────────────────

export type DQSeverity = "info" | "warning" | "error";
export type DQStatus   = "open" | "resolved";

export interface DataQualityIssue {
  id: string;
  issue_type: string;
  severity: DQSeverity;
  entity_type: string | null;
  entity_id: string | null;
  message: string;
  status: DQStatus;
  context: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface DataQualityIssueInput {
  issue_type: string;
  severity: DQSeverity;
  entity_type?: string | null;
  entity_id?: string | null;
  message: string;
  context?: Record<string, unknown> | null;
}

export interface ExceptionGroup {
  key: string;
  label: string;
  description: string;
  count: number;
  severity: DQSeverity;
  newest_at: string | null;
  tab?: string;
}

// ── Known scale codes (for parser detection) ──────────────────────────────────
export const KNOWN_SCALE_CODES = new Set([
  "CA","CB","CC","CD","CE","CF","CG","CH","CI",
  "UR","US","UT","UV","UX","UY","UZ",
  "VA","VB","VC",
]);

// ── Style number pattern ──────────────────────────────────────────────────────
export const STYLE_NO_RE = /^\d{6,10}[A-Z]{0,4}$/;
