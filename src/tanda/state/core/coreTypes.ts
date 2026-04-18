import type { XoroPO, Milestone, WipTemplate, LocalNote, User, DCVendor, View } from "../../../utils/tandaTypes";

export type DetailMode = "header" | "po" | "milestones" | "notes" | "history" | "matrix" | "email" | "attachments" | "all";

export interface AttachmentEntry {
  id: string;
  name: string;
  url: string;
  type: string;
  size: number;
  uploaded_by: string;
  uploaded_at: string;
  deleted_at?: string;
  dbxPath?: string;
}

export interface CoreState {
  user: User | null;
  view: View;
  pos: XoroPO[];
  notes: LocalNote[];
  selected: XoroPO | null;
  detailMode: DetailMode;
  attachments: Record<string, AttachmentEntry[]>;
  uploadingAttachment: boolean;
  wipTemplates: Record<string, WipTemplate[]>;
  milestones: Record<string, Milestone[]>;
  dcVendors: DCVendor[];
  designTemplates: any[];
}

export type CoreAction =
  | { type: "SET"; field: keyof CoreState; value: any }
  | { type: "SELECT_PO"; po: XoroPO | null; mode?: DetailMode }
  | { type: "SET_MILESTONES_FOR_PO"; poNumber: string; milestones: Milestone[] }
  | { type: "UPDATE_MILESTONE"; poNumber: string; milestoneId: string; milestone: Milestone }
  | { type: "DELETE_MILESTONES_FOR_PO"; poNumber: string }
  | { type: "SET_ATTACHMENTS_FOR_PO"; poNumber: string; attachments: AttachmentEntry[] }
  | { type: "UPDATE_ATTACHMENT"; poNumber: string; attachId: string; entry: any }
  | { type: "REMOVE_PO"; poNumber: string };

function loadView(): View {
  const saved = localStorage.getItem("tanda_view");
  const valid: View[] = ["dashboard", "list", "detail", "templates", "email", "teams", "activity", "vendors", "timeline", "archive", "shipments", "match"];
  return valid.includes(saved as View) ? (saved as View) : "dashboard";
}

export const initialCoreState: CoreState = {
  user: null,
  view: loadView(),
  pos: [],
  notes: [],
  selected: null,
  detailMode: "po",
  attachments: {},
  uploadingAttachment: false,
  wipTemplates: {},
  milestones: {},
  dcVendors: [],
  designTemplates: [],
};
