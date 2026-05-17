// All interfaces + the View/DetailTab unions for the TechPack app.
// Lifted out of TechPack.tsx so they can be imported by any
// extracted helper, panel, or future Phase 2 component split
// without circular imports back through the 4k-line monolith.

export interface User {
  name?: string;
  username?: string;
  avatar?: string;
  color?: string;
  initials?: string;
  role?: string;
}

export interface Measurement {
  id: string;
  pointOfMeasure: string;
  tolerance: string;
  sizes: Record<string, string>;
}

export interface ConstructionDetail {
  id: string;
  area: string;
  detail: string;
  notes: string;
  refImages: string[];
}

export interface Colorway { id: string; name: string; }

export interface BOMColorSpec {
  colorwayId: string;
  color: string;
  pantone: string;
  trialSize: string;
}

export interface SketchCallout { id: string; number: number; description: string; }

export interface FlatSketch {
  frontImage: string | null;
  backImage: string | null;
  callouts: SketchCallout[];
  stitchingDetails: string;
  measurementNote: string;
}

export interface BOMItem {
  id: string;
  materialNo: string;
  material: string;
  placement: string;
  content: string;
  weight: string;
  quantity: string;
  uom: string;
  supplier: string;
  unitCost: number;
  totalCost: number;
  notes: string;
  image: string | null;
  colorSpecs: BOMColorSpec[];
}

export interface Costing {
  fob: number;
  duty: number;
  dutyRate: number;
  freight: number;
  insurance: number;
  otherCosts: number;
  landedCost: number;
  wholesalePrice: number;
  retailPrice: number;
  margin: number;
  notes: string;
}

export interface Approval {
  id: string;
  stage: string;
  approver: string;
  status: "Pending" | "Approved" | "Rejected" | "Revision Required";
  date: string | null;
  comments: string;
}

export interface Sample {
  id: string;
  type: "Proto" | "SMS" | "PP" | "TOP" | "Production";
  status: "Requested" | "In Progress" | "Received" | "Approved" | "Rejected";
  requestDate: string;
  receiveDate: string | null;
  vendor: string;
  comments: string;
  images: string[];
}

export interface TPImage { id: string; url: string; name: string; type: string; }

export interface TechPack {
  id: string;
  styleName: string;
  styleNumber: string;
  brand: string;
  season: string;
  category: string;
  subCategory: string;
  description: string;
  designer: string;
  gender: string;
  vendor: string;
  techDesigner: string;
  graphicArtist: string;
  productDeveloper: string;
  division: string;
  owner: string;
  active: boolean;
  version: number;
  status: "Draft" | "In Review" | "Approved" | "Revised";
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  colorways: Colorway[];
  flatSketch: FlatSketch;
  measurements: Measurement[];
  construction: ConstructionDetail[];
  bom: BOMItem[];
  costing: Costing;
  approvals: Approval[];
  samples: Sample[];
  images: TPImage[];
}

export interface Material {
  id: string;
  name: string;
  type: string;
  composition: string;
  weight: string;
  width: string;
  color: string;
  supplier: string;
  unitPrice: number;
  moq: string;
  leadTime: string;
  certifications: string[];
  notes: string;
  createdAt: string;
}

export interface SpecSheetRow {
  id: string;
  pointOfMeasure: string;
  tolerance: string;
  values: Record<string, string>;
  isSection?: boolean;
}

export interface SpecSheet {
  id: string;
  styleName: string;
  styleNumber: string;
  brand: string;
  season: string;
  category: string;
  subCategory?: string;
  gender?: string;
  vendor?: string;
  description: string;
  sizes: string[];
  rows: SpecSheetRow[];
  createdAt: string;
  updatedAt: string;
}

export interface SpecTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  sizes: string[];
  rows: SpecSheetRow[];
  createdAt: string;
  isBuiltin?: boolean;
}

export type View = "dashboard" | "list" | "detail" | "libraries" | "samples" | "teams" | "email" | "notifications";
export type DetailTab = "sketch" | "spec" | "construction" | "bom" | "costing" | "approvals" | "samples" | "images";
