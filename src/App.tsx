import { useState, useRef, useEffect } from "react";

// ─── THEME D: SLATE BLUE & RED ────────────────────────────────────────────────
const TH = {
  bg: "#4A5568",
  surface: "#FFFFFF",
  surfaceHi: "#F7F8FA",
  border: "#CBD5E0",
  header: "#2D3748",
  primary: "#C8210A",
  primaryLt: "#E02B10",
  text: "#1A202C",
  textSub: "#2D3748",
  textSub2: "#4A5568",
  textMuted: "#718096",
  accent: "#FFF5F5",
  accentBdr: "#FEB2B2",
  shadow: "rgba(0,0,0,0.12)",
  shadowMd: "rgba(0,0,0,0.18)",
};

// ─── TEAMS BRAND COLORS
const TEAMS_PURPLE = "#5b5ea6";
const TEAMS_PURPLE_LT = "#7b83eb";

// ─── CUSTOMER → CHANNEL TYPE MAP ─────────────────────────────────────────────
const CUSTOMER_CHANNEL_MAP = {
  "Macy's": "Department Store",
  Nordstrom: "Department Store",
  JCPenney: "Department Store",
  Belk: "Department Store",
  "Kohl's": "Department Store",
  Ross: "Off-Price (Ross, TJX)",
  "TJ Maxx": "Off-Price (Ross, TJX)",
  Burlington: "Off-Price (Ross, TJX)",
  Target: "E-Commerce",
  Amazon: "E-Commerce",
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const BRANDS = [
  {
    id: "ring-of-fire",
    name: "Ring of Fire",
    short: "ROF",
    color: "#C0392B",
    isPrivateLabel: false,
  },
  {
    id: "departed",
    name: "Departed",
    short: "DEP",
    color: "#7F8C8D",
    isPrivateLabel: false,
  },
  {
    id: "fort-knox",
    name: "Fort Knox",
    short: "FKX",
    color: "#92400E",
    isPrivateLabel: false,
  },
  {
    id: "axe-crown",
    name: "Axe Crown",
    short: "AXC",
    color: "#1A5276",
    isPrivateLabel: false,
  },
  {
    id: "blue-rise",
    name: "Blue Rise",
    short: "BLR",
    color: "#0E7490",
    isPrivateLabel: false,
  },
  {
    id: "ross-pl",
    name: "Ross Private Label",
    short: "RSP",
    color: "#8E44AD",
    isPrivateLabel: true,
  },
  {
    id: "macys-pl",
    name: "Macy's Private Label",
    short: "MCP",
    color: "#E74C3C",
    isPrivateLabel: true,
  },
];
const SEASONS = ["Spring", "Summer", "Fall", "Holiday"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const CATEGORIES = [
  "Denim",
  "Twill Pants",
  "Fleece",
  "Woven Tops",
  "Knit Tops",
  "Outerwear",
  "Shorts",
  "Printed T-Shirts",
];
const DEFAULT_CATEGORIES = [
  {
    id: "cat1",
    name: "Denim",
    subCategories: [
      "Slim Fit",
      "Relaxed",
      "Skinny",
      "Boot Cut",
      "Straight Leg",
    ],
  },
  {
    id: "cat2",
    name: "Twill Pants",
    subCategories: ["Slim Chino", "Cargo", "Flat Front", "Jogger"],
  },
  {
    id: "cat3",
    name: "Fleece",
    subCategories: [
      "Full-Zip Hoodie",
      "Pullover",
      "Quarter-Zip",
      "Crew Neck",
      "Sherpa",
    ],
  },
  {
    id: "cat4",
    name: "Woven Tops",
    subCategories: ["Oxford", "Flannel", "Poplin", "Chambray", "Plaid"],
  },
  {
    id: "cat5",
    name: "Knit Tops",
    subCategories: ["Crew Neck Tee", "V-Neck", "Long Sleeve", "Henley", "Polo"],
  },
  {
    id: "cat6",
    name: "Outerwear",
    subCategories: ["Puffer", "Bomber", "Fleece-Lined", "Windbreaker", "Coach"],
  },
  {
    id: "cat7",
    name: "Shorts",
    subCategories: [
      "Cargo",
      '5" Inseam',
      "Hybrid Board",
      "Stretch",
      "Twill Walk",
    ],
  },
  {
    id: "cat8",
    name: "Printed T-Shirts",
    subCategories: [
      "Graphic Crew",
      "All-Over Print",
      "Logo Tee",
      "Vintage Print",
      "Band Tee",
    ],
  },
];
const ROLES = [
  "Product Developer",
  "Designer",
  "Graphic Artist",
  "Merchandiser",
  "Sales Rep",
  "Tech Designer",
  "Account Manager",
];
const DEFAULT_SIZES = [
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "XXL",
  "2XL",
  "3XL",
  "28",
  "30",
  "32",
  "34",
  "36",
  "38",
];
const GENDERS = ["Men's", "Women's", "Boys", "Girls"];
const ORDER_TYPES = [
  "Upfront",
  "Projected",
  "Stock",
  "Custom",
  "At Once",
  "Future",
];
const CHANNEL_TYPES = [
  "Department Store",
  "Off-Price (Ross, TJX)",
  "E-Commerce",
  "Private Label",
  "Specialty Retail",
  "Direct / DTC",
];
const DEFAULT_CUSTOMERS = [
  "Macy's",
  "Ross",
  "TJ Maxx",
  "Burlington",
  "Nordstrom",
  "Target",
  "Amazon",
  "Kohl's",
  "JCPenney",
  "Belk",
];
const PHASE_KEYS = [
  "Concept",
  "Design",
  "Tech Pack",
  "Costing",
  "Sampling",
  "Revision",
  "Purchase Order",
  "Production",
  "QC",
  "Ship Date",
  "DDP",
];

const STATUS_CONFIG = {
  "Not Started": {
    color: "#6B7280",
    bg: "#F3F4F6",
    dot: "#9CA3AF",
    border: "#D1D5DB",
  },
  "In Progress": {
    color: "#B45309",
    bg: "#FFFBEB",
    dot: "#F59E0B",
    border: "#FCD34D",
  },
  Review: {
    color: "#6D28D9",
    bg: "#F5F3FF",
    dot: "#8B5CF6",
    border: "#C4B5FD",
  },
  Approved: {
    color: "#065F46",
    bg: "#ECFDF5",
    dot: "#10B981",
    border: "#6EE7B7",
  },
  Complete: {
    color: "#047857",
    bg: "#D1FAE5",
    dot: "#059669",
    border: "#34D399",
  },
  Delayed: {
    color: "#B91C1C",
    bg: "#FEF2F2",
    dot: "#EF4444",
    border: "#FCA5A5",
  },
};

// ─── USER/AUTH SYSTEM ─────────────────────────────────────────────────────────
const DEFAULT_USERS = [
  {
    id: "u1",
    username: "admin",
    password: "admin123",
    name: "Admin User",
    role: "admin",
    color: "#CC2200",
    initials: "AD",
    teamMemberId: null,
    teamsEmail: "",
  },
  {
    id: "u2",
    username: "alex",
    password: "pass123",
    name: "Alex Rivera",
    role: "user",
    color: "#E74C3C",
    initials: "AR",
    teamMemberId: "t1",
    teamsEmail: "",
  },
  {
    id: "u3",
    username: "jordan",
    password: "pass123",
    name: "Jordan Lee",
    role: "user",
    color: "#3498DB",
    initials: "JL",
    teamMemberId: "t2",
    teamsEmail: "",
  },
  {
    id: "u4",
    username: "sam",
    password: "pass123",
    name: "Sam Chen",
    role: "user",
    color: "#2ECC71",
    initials: "SC",
    teamMemberId: "t3",
    teamsEmail: "",
  },
];

const SAMPLE_VENDORS = [
  {
    id: "v1",
    name: "Blue Star Apparel",
    country: "China",
    transitDays: 21,
    categories: ["Denim", "Twill Pants", "Shorts"],
    contact: "Wei Chen",
    email: "wei@bluestar.cn",
    moq: 500,
    lead: {
      Concept: 168,
      Design: 154,
      "Tech Pack": 140,
      Costing: 126,
      Sampling: 112,
      Revision: 84,
      "Purchase Order": 70,
      Production: 42,
      QC: 14,
      "Ship Date": 0,
      DDP: 0,
    },
  },
  {
    id: "v2",
    name: "Delta Garments",
    country: "Bangladesh",
    transitDays: 21,
    categories: ["Fleece", "Knit Tops", "Printed T-Shirts"],
    contact: "Rahul Islam",
    email: "rahul@deltagarments.com",
    moq: 300,
    lead: {
      Concept: 140,
      Design: 126,
      "Tech Pack": 112,
      Costing: 105,
      Sampling: 84,
      Revision: 56,
      "Purchase Order": 42,
      Production: 35,
      QC: 10,
      "Ship Date": 0,
      DDP: 0,
    },
  },
  {
    id: "v3",
    name: "Pacific Outerwear Co",
    country: "China",
    transitDays: 25,
    categories: ["Outerwear", "Woven Tops"],
    contact: "Lisa Huang",
    email: "lisa@pacificow.cn",
    moq: 200,
    lead: {
      Concept: 182,
      Design: 168,
      "Tech Pack": 154,
      Costing: 140,
      Sampling: 119,
      Revision: 91,
      "Purchase Order": 77,
      Production: 56,
      QC: 14,
      "Ship Date": 0,
      DDP: 0,
    },
  },
  {
    id: "v4",
    name: "VN Textiles",
    country: "Vietnam",
    transitDays: 18,
    categories: ["Knit Tops", "Woven Tops", "Shorts"],
    contact: "Minh Tran",
    email: "minh@vntex.vn",
    moq: 400,
    lead: {
      Concept: 133,
      Design: 119,
      "Tech Pack": 105,
      Costing: 98,
      Sampling: 77,
      Revision: 49,
      "Purchase Order": 42,
      Production: 35,
      QC: 10,
      "Ship Date": 0,
      DDP: 0,
    },
  },
  {
    id: "v5",
    name: "Crown Denim Ltd",
    country: "Bangladesh",
    transitDays: 21,
    categories: ["Denim"],
    contact: "Farhan Ali",
    email: "farhan@crowndenim.com",
    moq: 600,
    lead: {
      Concept: 154,
      Design: 140,
      "Tech Pack": 126,
      Costing: 119,
      Sampling: 98,
      Revision: 63,
      "Purchase Order": 56,
      Production: 45,
      QC: 14,
      "Ship Date": 0,
      DDP: 0,
    },
  },
  {
    id: "v6",
    name: "Apex Fashion",
    country: "Pakistan",
    transitDays: 19,
    categories: ["Fleece", "Printed T-Shirts", "Shorts"],
    contact: "Imran Syed",
    email: "imran@apexfashion.pk",
    moq: 350,
    lead: {
      Concept: 140,
      Design: 126,
      "Tech Pack": 112,
      Costing: 105,
      Sampling: 84,
      Revision: 56,
      "Purchase Order": 42,
      Production: 38,
      QC: 10,
      "Ship Date": 0,
      DDP: 0,
    },
  },
];

const SAMPLE_TEAM = [
  {
    id: "t1",
    name: "Alex Rivera",
    role: "Product Developer",
    initials: "AR",
    color: "#E74C3C",
    avatar: null,
  },
  {
    id: "t2",
    name: "Jordan Lee",
    role: "Designer",
    initials: "JL",
    color: "#3498DB",
    avatar: null,
  },
  {
    id: "t3",
    name: "Sam Chen",
    role: "Graphic Artist",
    initials: "SC",
    color: "#2ECC71",
    avatar: null,
  },
  {
    id: "t4",
    name: "Morgan Davis",
    role: "Merchandiser",
    initials: "MD",
    color: "#9B59B6",
    avatar: null,
  },
  {
    id: "t5",
    name: "Taylor Kim",
    role: "Tech Designer",
    initials: "TK",
    color: "#F39C12",
    avatar: null,
  },
];

// SKU auto-generate descriptors
const SKU_DESC_BY_CAT = {
  Denim: [
    "Slim Fit 5-Pocket Jean",
    "Relaxed Tapered Denim",
    "Straight Leg Jean",
    "Skinny Fit Denim",
    "Classic Boot Cut",
  ],
  "Twill Pants": [
    "Slim Chino Pant",
    "Cargo Twill Pant",
    "Flat Front Slacks",
    "Jogger Twill",
    "Stretch Twill Slim",
  ],
  Fleece: [
    "Full-Zip Hoodie",
    "Pullover Fleece",
    "Quarter-Zip Sweatshirt",
    "Crew Neck Fleece",
    "Sherpa Lined Hoodie",
  ],
  "Woven Tops": [
    "Oxford Button-Down",
    "Flannel Shirt",
    "Poplin Woven Shirt",
    "Chambray Shirt",
    "Plaid Woven",
  ],
  "Knit Tops": [
    "Crew Neck Tee",
    "V-Neck Knit",
    "Long Sleeve Thermal",
    "Henley Knit",
    "Polo Shirt",
  ],
  Outerwear: [
    "Puffer Jacket",
    "Bomber Jacket",
    "Fleece-Lined Jacket",
    "Windbreaker",
    "Coach Jacket",
  ],
  Shorts: [
    "Cargo Short",
    '5" Inseam Short',
    "Hybrid Board Short",
    "Stretch Short",
    "Twill Walk Short",
  ],
  "Printed T-Shirts": [
    "Graphic Crew Tee",
    "All-Over Print Tee",
    "Logo Tee",
    "Vintage Print Tee",
    "Band Tee",
  ],
};
const COLORWAY_SETS = [
  ["Black", "White", "Navy"],
  ["Stone", "Olive", "Khaki"],
  ["Red", "Black", "White"],
  ["Indigo", "Rinse", "Light Wash"],
  ["Charcoal", "Heather Grey", "Black"],
  ["Cobalt", "Forest", "Burgundy"],
  ["Sand", "Desert", "Brown"],
];
const FABRICS = [
  "100% Cotton",
  "98% Cotton / 2% Elastane",
  "80% Cotton / 20% Polyester",
  "100% Polyester",
  "Stretch Denim",
  "Ripstop Nylon",
  "French Terry",
  "Jersey Knit",
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).substr(2, 9);
}
function getBrand(id) {
  return BRANDS.find((b) => b.id === id) || BRANDS[0];
}
// Parse YYYY-MM-DD without timezone shift
function parseLocalDate(ds) {
  if (!ds) return new Date();
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function getDaysUntil(d) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((parseLocalDate(d) - t) / 86400000);
}
function formatDate(d) {
  if (!d) return "";
  const x = parseLocalDate(d);
  return `${MONTHS[x.getMonth()]} ${x.getDate()}, ${x.getFullYear()}`;
}
function formatDT(d) {
  if (!d) return "";
  const x = new Date(d);
  return `${MONTHS[x.getMonth()]} ${x.getDate()} ${x.getHours()}:${String(
    x.getMinutes()
  ).padStart(2, "0")}`;
}
function addDays(ds, n) {
  const d = parseLocalDate(ds);
  d.setDate(d.getDate() + n);
  const mm = String(d.getMonth() + 1).padStart(2, "0"),
    dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function diffDays(a, b) {
  return Math.round((parseLocalDate(a) - parseLocalDate(b)) / 86400000);
}
function fileToDataURL(f) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = (e) => res(e.target.result);
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

// Upload a file directly to Dropbox and return a shared link URL
async function dbxUploadFileGlobal(file, folder = "images") {
  const DBX_TOKEN = "sl.u.AGUcjMEcACemDUZHoLi92xdgZ13WI8iSDzLrDH79Xgcn7fQKuN8tfpn01xSY-JhTMgcNe-tGiNYqsVkrbII3NoWk0KO1MumGTJV1CX1DZb7qCUFR9lOlx9oQoAtuuAiMockw9inV9CuMwsVRIAA7h5qrrjKqAZ65SfmWt0bq73FFlircuF1x7LkEsABbzJGznX7y5q8Qo76unECnZw_QOKIF7JeYlshwpIbb-6i4qktHbqbOZ5lHEe5U2nuCmE1QVj80sMPoFvcRTa-D1WptAgnL_gHlZqnsLppUPlJ17RVpoXfmF5qkxC6q3P_d5Et2x_4MUKPAeeMc9cGp2vHZBITl5Uqs472avmEnAaa8Ob9g7eeJIIVcQOlg7gXwgpeoxeyuTYHGaAeOiyoNCihv8QBP3SPTA0HnK0KnaXLixBddFtUo97JPVxMDeEsdEeiXqooalU2qJ_BAqOHbk6zUEb3EaZa-2LpslUdktWiP6YaGJgUePX-2JBS4BmN_rfIjVlsikaObNC1U9hhX1ea0FHuThyzijnVqVdze9-fcFszuvJIar3eXf7tzXPzW_JahCXJr-eMdNx68Bpu7Bj-485LL_P0F09mhS219DTWoBVoflXSOF9UE8eE8kiybDGL__qfFfRJwB_-8qEFoDRj1f-wcrWxRYx16yZdiEYBXaMM7KR83Fhiru2gFNFSExAERAqZdBC_PWIicVhHl7nRkAMnlZ7Wu9uu3CGA1v_MqXXgXxvqaqpWlMJxjJMyNHZfA5Th3VwA9NNgB3nOK0umNT8BUVx371VRqreNByWsme6Ara66ZRd9EuPwFQAoz3-q64KqgbfRRiPWjv7edgi6e49BEUBE26B7e1XW2muTnJxncZfp8jF3g9g0P5pBiNf9Z_7w5gXRyU2ZhfNuHrb2epYnBQrq_LyEOsZC2aG2cQgyqRr5-6vdsH0giZoXneSUCqEsuaNmIgY7zLb9gd98oRy1DnwcEpwJY7Ja_lzwMKR9-Bc9MPLt9x_zYQKYR7TRTFOPQDLCtce6wJ4o5r5AbYmn0Vo33ceURUtI6_I3fRH1Bv3W7pydx9QAgI2BVF-2OD2Rwzai2MUghm3yUah-wYjbQGao7VYRT9h7Fcr--qW8W0GYMgGZYbO7_J7A5KixWGA375AH3-_4L4n87IlfxNqd8nvEb7e2hABTrznLm1dgMzYBCSF-O7tFEr24TzWfsA9L0awYgw1v2qN-9-eESJphwJ6KyYNa78ar2cCgc6M6Xsnza8fZJa-BcJrBI-gW_Y830PoQMtsCtgglC4KBu6W0sAwzgr98EKjOgGHNB7Le0qzLO-HAFUyepGOZ2q3bVU0_poNEgEfjpXanfvDtAxZ00Jjdn5AhKumbb9gwxnEmKgAIRmf9eOxr99jABC4Y6GdtBMX3PV6MHRB1N0W11-HpFtO6tTZ5Ui-YEWYPfZfuwqyMG2poXqlepeJNpbTPT65bjtOpMTAb6LZ23M5ezFEOf";
  try {
    const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const path = `/${folder}/${safeName}`;
    const uploadRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${DBX_TOKEN}`,
        "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", autorename: false, mute: true }),
        "Content-Type": "application/octet-stream",
      },
      body: file,
    });
    if (!uploadRes.ok) { console.warn("Dropbox file upload failed"); return null; }
    const linkRes = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${DBX_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, settings: { requested_visibility: "public" } }),
    });
    if (linkRes.ok) {
      const linkData = await linkRes.json();
      return (linkData.url || "").replace("?dl=0", "?raw=1").replace("www.dropbox.com", "dl.dropboxusercontent.com");
    }
    const existRes = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
      method: "POST",
      headers: { "Authorization": `Bearer ${DBX_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (existRes.ok) {
      const existData = await existRes.json();
      const existing = existData.links?.[0]?.url;
      if (existing) return existing.replace("?dl=0", "?raw=1").replace("www.dropbox.com", "dl.dropboxusercontent.com");
    }
    return null;
  } catch (e) { console.warn("dbxUploadFileGlobal error", e); return null; }
}
function getChannelForCustomer(customer) {
  return CUSTOMER_CHANNEL_MAP[customer] || "";
}

function genStyleNum(brand, category, index) {
  const bmap = {
    "ring-of-fire": "ROF",
    departed: "DEP",
    "fort-knox": "FKX",
    "axe-crown": "AXC",
    "blue-rise": "BLR",
    "ross-pl": "RSP",
    "macys-pl": "MCP",
  };
  const cmap = {
    Denim: "DN",
    "Twill Pants": "TW",
    Fleece: "FL",
    "Woven Tops": "WV",
    "Knit Tops": "KN",
    Outerwear: "OW",
    Shorts: "SH",
    "Printed T-Shirts": "PT",
  };
  const prefix = (bmap[brand] || "ROF") + "-" + (cmap[category] || "XX");
  const num = String(1000 + Math.floor(Math.random() * 900) + index).slice(-4);
  return `${prefix}-${num}`;
}

function autoGenSkus(brand, category, count) {
  const descs = SKU_DESC_BY_CAT[category] || SKU_DESC_BY_CAT["Knit Tops"];
  return Array.from({ length: count }, (_, i) => ({
    id: uid(),
    styleNum: genStyleNum(brand, category, i),
    description: descs[i % descs.length],
    colorways: COLORWAY_SETS[i % COLORWAY_SETS.length].join(" / "),
    fabric: FABRICS[i % FABRICS.length],
    sizes: ["S", "M", "L", "XL"],
    units: Math.floor(Math.random() * 500 + 200),
    fob: "",
    landed: "",
    wholesale: "",
    retail: "",
    marginPct: "",
    images: [],
  }));
}

function generateTasks({
  brand,
  collection,
  season,
  category,
  vendorId,
  ddpDate,
  customerShipDate,
  cancelDate,
  vendors,
  pdId,
  designerId,
  graphicId,
  customer,
  orderType,
  channelType,
}) {
  const vendor = vendors.find((v) => v.id === vendorId);
  const transit = vendor?.transitDays || 21;
  const lead = vendor?.lead || {
    Concept: 168,
    Design: 154,
    "Tech Pack": 140,
    Costing: 126,
    Sampling: 112,
    Revision: 84,
    "Purchase Order": 70,
    Production: 42,
    QC: 14,
    "Ship Date": 0,
    DDP: 0,
  };
  const isPrivate = getBrand(brand).isPrivateLabel;

  let phases = PHASE_KEYS.map((name) => {
    if (name === "Ship Date") return { name, daysBack: transit };
    if (name === "DDP") return { name, daysBack: 0 };
    if (name === "QC") return { name, daysBack: null }; // resolved below: Production + 3 days
    return { name, daysBack: lead[name] ?? 0 };
  });

  if (isPrivate) {
    const bulkIdx = phases.findIndex((p) => p.name === "Purchase Order");
    const bulkDays = phases[bulkIdx]?.daysBack || 70;
    phases.splice(
      bulkIdx,
      0,
      { name: "Line Review", daysBack: bulkDays + 42 },
      { name: "Compliance/Testing", daysBack: bulkDays + 21 }
    );
  }

  // QC = Production due date + 3 days (always 3 days after production completes)
  const prodPhase = phases.find((p) => p.name === "Production");
  const prodDue = prodPhase ? addDays(ddpDate, -prodPhase.daysBack) : ddpDate;
  const qcDue = addDays(prodDue, 3);
  const qcDaysBack = Math.max(0, diffDays(ddpDate, qcDue));
  phases = phases.map((p) =>
    p.name === "QC" ? { ...p, daysBack: qcDaysBack } : p
  );

  const shipDate = addDays(ddpDate, -transit);
  const base = {
    brand,
    collection,
    season,
    category,
    vendorId: vendorId || null,
    vendorName: vendor?.name || "",
    deliveryDate: ddpDate,
    ddpDate,
    customerShipDate: customerShipDate || addDays(shipDate, 6),
    cancelDate: cancelDate || addDays(addDays(shipDate, 6), 6),
    customer: customer || "",
    orderType: orderType || "",
    channelType: channelType || getChannelForCustomer(customer) || "",
    pdId: pdId || null,
    designerId: designerId || null,
    graphicId: graphicId || null,
  };

  return phases.map((p) => ({
    id: uid(),
    ...base,
    phase: p.name,
    status: "Not Started",
    due: addDays(ddpDate, -p.daysBack),
    originalDue: addDays(ddpDate, -p.daysBack),
    notes: "",
    assigneeId: null,
    history: [],
    images: [],
  }));
}

function cascadeDates(tasks, collectionKey, changedTaskId, newDue) {
  const collTasks = tasks
    .filter((t) => `${t.brand}||${t.collection}` === collectionKey)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  const changedIdx = collTasks.findIndex((t) => t.id === changedTaskId);
  if (changedIdx < 0)
    return {
      updatedTasks: tasks,
      ddpChanged: false,
      newDDP: null,
      oldDDP: null,
    };

  const oldDue = collTasks[changedIdx].due;
  const delta = diffDays(newDue, oldDue);
  if (delta === 0)
    return {
      updatedTasks: tasks,
      ddpChanged: false,
      newDDP: null,
      oldDDP: null,
    };

  const ddpTask = collTasks.find((t) => t.phase === "DDP");
  const oldDDP = ddpTask?.due;

  // Shift ALL tasks in the collection by the same delta — preserves all spacing
  const updatedTasks = tasks.map((t) => {
    if (`${t.brand}||${t.collection}` !== collectionKey) return t;
    if (t.id === changedTaskId) return { ...t, due: newDue };
    return { ...t, due: addDays(t.due, delta) };
  });

  const newDDPTask = updatedTasks.find((t) => t.id === ddpTask?.id);
  const newDDP = newDDPTask?.due;
  // Warn whenever DDP changes (either direction)
  const ddpChanged = !!(oldDDP && newDDP && newDDP !== oldDDP);

  return {
    updatedTasks,
    ddpChanged,
    newDDP,
    oldDDP,
    delta,
    affectedCount: collTasks.length,
  };
}

// ─── BEAR LOGO ────────────────────────────────────────────────────────────────
// Geometric polygonal bear matching the actual ROF brand logo
// Bear faces right, polygon facets separated by thin white lines, two bars below, bold "RING of FIRE" text
function ROFLogoFull({ height = 44 }) {
  return (
    <img
      src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAhsAAAGrCAYAAABpBVVVAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAEAAElEQVR4nOydd7wcV3n+v6fMzNbb1Jst23IvGFMTQq+BJPQSSAgQwIRACC2YQICEDiHwA0wH01sIHWODDRj33otsyV399nt3d8opvz9mtkkyBku22j6fz2iv7p2ZnZlz5pznvOV5hfeeAQbYU3A3Xe/lUceKPX0dAwwwwAAD3H/Qe/oCBjgwseXMM/0PvvktpjduYtHImD/4kNUce+IJrDzmeDjphAH5GGCAAQbYjyAGlo0BHlD86nx/3o9/wvUXXETFQZR5lIeWzYidwYQh0egIy45Yw8HHHs0hJxxLaflSOP6IAQEZYO/HNbf41vrbWX/r7dw6Pc7fvPftg347wAAMyMYADxDMORf6S39xBlee/mui2RYra3VKmcfMt6jX6zgpaNiUTCkSLWkIT1NBFgU0lae2eBFrTjieIx/8IJatXoV68MD6McBegt9d7m+68nJuuuoKJm69i3SuiVeaRiXgrV85FQ4/ZNBXBzjgMSAbA9x/WHeHb952O7//6c+45YJLqDRjFnrNqFCUU09zdgYdlggrJTJraZkUGQRYrYmdIXYOqwRGSnSlii6FzDQazMctFi1ZzKojDmfNiSex8KBV6MMOg2NXDgb1Ae5/3Hi9v/PaG1h70RVsuvBKgsSSuAzpMipWIoHMw3gAT/mXV3H4P7500C8HOOAxIBsD3C9onf4bf9EZZ3LDBRcxIiSq0aJqHAvDEna2iWk2Ga4PMRvHECgAhJRYPKmxBEHA8MgIjTgmThJS6xBSIoTC4ZFS4sKQOSGZdQavNCMrlnDY8cdw5EkPYuiIQ+Ghg8DTAXYDbr7NZ7ffweUXnMd1l1xGc2KSkpdEccYSWYYkoWUTvLOUPQQyAK2ZLUVMLRvmH0//4aAfDnDAY0A2Bti9uPQmf82PfsxVZ51NqRUzrAIa27YxVCpR0gHTkxOUy2XGhseYnpulUinRSmLiOCYMQ6rlCmlqaDabAGihCcMQpRS4bl+11tI0GWpolFiAtY7UWVIcNgygFODCkCNOOpGlhx3M6uOOQa5eAUesHgz8A9wr0rPP99tuu5Nzz/gV8fg20ulZgiSj6mA4CAksxPNzSA9CSwgESglCY/HGYzKY0jCxcIiTP/5BeMyfdfrd5ptv9jPr7uLIpz9x0BcHOGAwIBsD7B5cvtZf+tOfccUZv0JPzbEsChGNJlUhEdbgnENrjVQBiTNkxqGUIk1aVKtlQBLHTYSXKCUQQqClRAqNdw6swzmHlBIlJAAOQctahNIIJfFCYIUkEwIjIVWSpjUkGrJAo2plRpYvY/XRR3DUsccxfMgqeOgg9mMA4Oob/a1XXcM1F1zMXTfdjJmdo+w8dRVg5+apeMGIDpFxgogzylIRBAGptCTSY4RFOIu2Du0lUoS0ooAt1ZBjnvWXPOjd/9bXz97+lOf7Jz/hiTzhlNcM+t8ABwQGZGOAXcPla/21P/wxF5x1NszNsziMCNIEmk1KHkKpEEUX80ickOAFXkhyuuABB8jtPsHfyzAsPAQu/7QSrAAjZfEpOj97IXHI4qji0wsSDWmtxLKjDueEkx7MiuOOheVL4MiDBxPA/o6b1vrxdbey4bIruf2a67hr3W0EXjAcliFLITGUlURYT+Ac2lFsHu3yfucEJAqMcljpkN6hnUd5gXSSWAVsKwW0li/kH87+UV+fOus/T/Xn/erXHLrmEF761jfCcQcN+twA+zUGZGOA+4xz3v1Rf82PfkalmVCRgnoUopKErNGgrAXD9SHiRrPYW4KXgAIvEV6CcHjhcGLHPpgTjZ2TjjYlER60M0h8TltETjo8Obnwgg7JkF4gAOnz/wsnMQpsLWLOpszGMQ3vCEeGWHbEGtY86HiWHHYIC485Fo49dDAR7A/47fn+igsu5pbrbmB8y2bM5BRDrSZV6yiFEZUwQmaQtWK8dUQ6oD0+CvL+phwon//sBRhZ9DlhELiev0tSEbAVT3PRCC99/3uQT+m6UiZ/eYn/0oc/hm7ME5YCXveB98Kjjx/0swH2WwzIxgB/GtZt9rf/7Ay++YUvsiyqsNBaSjZFeQiEQHmDsxlZkpKmCeVypSAZEuklwguUy8lGPljnq8I+CM9O+EcfpAcrHVYavLC5+6WYDIQXBRlpE5y2dYMeQiJwAjLhUIFGKE2GI84MTWNJkWRS4EplhlcuZ/kRh7P6mKNZecTh6IVjUC7DmiWDyWFvxU23ehotNl1+JWsvu4LbrrkRNzNHBUVZKJQH4iaVwFJSApwnixMwubtPqxAvBYk1eNEmrjlZbRMPoMOEJRaEQ/i8L0svyURAKyqxRcFhz3gyj/7oO/r6y6ef+QpfvXsLQZax1ae8/O1vZPTFzxz0qQH2SwzIxgB/NO74f1/x5/zwZ5Rji59rUDKWiARpMmySYtIMLaEUBgRRiJSSxGR9ZEM5kRMDJ3HS5WRju+G1oAf3ej1OOIwyeOE7q818ZSmQrjiPlziRWzu8yF0tHeuHcDiTIhFIqUGKPEZEKdABXoXMpgmJEjSsJZYKWS1TGh5m8aoVLD7sIJadcDgLDlpO6cQHDSaJPY21t/it197ANRdezJ3XryUen2RYBshmTNVJaiJAZhm2lVCWmlJJ00xnkFhMluEtlIKQKIrIrKORtJBhlPcZ0e+Gkz4ntTnJdUg8YHDCdfazQuOiGlulZ2bhECd/5XOwZmmnn5z7gVP9rd/5EWNItqTzzISCJ7/0BZzw1jcM+tIA+x0GZGOAP4x1d/iN55zPGd/6DnqmSbmVYSZmWTE6RmtulrAaIoQnlArlwBqDTRPwHiElXgq6cRL9Lo18dZj3v15XSftnt/3/t9tHeIfyphON0d1f9vxfdo7v/Y62KyYEvDU4BNZ7vBdY4bFe4DzIMEIFIQaB8Y4stbSSBKkUpdEh5rWlJRzV4WEOOfJwjnjQCSw64jBYthSOPmwwadyfWL/e25vWcfPlV3HlJZcxvnEzoYWKUujMoTKDTA2hzWMuAgGh1EjnEd7hpadhGmitCHVAgEJ4j7cO5wAhcFIVbpLu1wrftpqJjqVDOwvC4KQrLGgSh6aVGuzwCBtDwYvf+RZqz3ta90zX3OQ//5JXsjhxUAoxUcCm1jzLjjuS57/rFDjmqEH/GWC/wYBsDLBzXH+zv+mss7nwl7/Cbp0i3bqNlfURgiRDJRkrFi5mYmIbRglaSQzOUy/VqFUqeOuI45jUZOhI72CjyGMnikG7+J3vCRD1Iv/sda7sjHBI71De5eco3DK5FaP47CUZRYxI76fAEQjAebz3OYERAi8EQuTaH9bnv3POoYQkDCK8tRhj8EoSK5+LjwmwStHwhlhAtGCU+pJFHP3wh7LkkNUsOPpIOH4weewyLrzY33LNNVx+4cXccd2NLCEkyAzSWQIhCS1I41DWor1AI6iVy0gPSdICwHuPMbkVIqrXyWyKsIBxuDTDZYYgCAjLJZI07etLkPdb6SHvo7lLJnQWMHmwqPA4IcBrXOZxtSG2lTTDJx3L07/y8b4+cOaL/sHbdXcwOzFNtVon8zCZJUQrlvL37zoFHv/ngz4zwH6BAdkYYAds+tr3/C++8R38xBSVxGKnpjh82XKkyZgeH6deLpGmKc456vVRnAVvLdY4sizDe48MNEEUkrisIA8AecS+9KC8B/JU1bYvfEcysCNkT3d1hXk7t3J0/975uee4nJJ4vMg/HcVBUuC97Wh4CG9zElT8X0kQSpJlGcY5olKIkLK4TwjDEpn1ODw+CMiEJ/YOq0N8FNF0lhiPi0KGFy3i4DWHc8Rxx7Lw8DWwbDEcOVA9/YO46Cq/5aZbuPGSS7jzhptIxqcILJSVzK1SWYoWebyQtLk7LfD5z85meV9TilarRWISomoFHQY4PEIrmonDWotykpJWRErn5NOaPDhUtklsOxajS5YdElNkW0XWIjGk2mIFOAnSKsqyRMtJxiPJ1prmtZ/7H3ho1+U2edoX/dff9X6OWXIwzS3TjAQVvAqZ8JaJsuBZb34dC046Fn3CcYN+MsA+jQHZGKCD27/5bX/OD35CsnEbldhQSgwjKiD0jnR+HuEt1XKJLMvITEqtWmd+PiaQQW4RKDiF0AovILMWoUWecUK+DuwlG64gG+1VY29QaJsoCN+lDL1Eo53uaqSknS8g8EVMiEcWDET4gmQU5KKXdDiRkwSEQOBy7lF8KgRSeLIkpVQp470jyVK8zNVLrXdIFMLl19ixpigNSpPgSa3DBQovFVZIUu/JvMcKcr2RSsjCk05g9LCDOfKYo1l26GFw9AGednvjbX7yprVcf+nl3HXDTUzcdTdl6ylZqFhPZB2Bc0XKsyP1Bh0GCO+wSQqZJdAaLSQ4jxSeIApJswzjHboUkdqEOMlQQYRUIUIopMvdJ8q7ro6Ls0B/ZhS0yYbL21QppJeUjEX5PGC5naGCl+hMYrykUQqZGop48htexdJ/eGG3ja+6zH/rre/ArNvEmuoCzLZppFT40Tp3ZzEbtOVRL3wef/78Z8Gxg2KEA+y7GJCNAZj8xlf9eaf/mi1rb6WSWIYJ0JnDpymB0nQTSNtxEnkgJpDrZrTRyfzo/qobMJej7Rxppw62Azihn0zsDNuPtO0Jvn3m3HJS6HfsxFKCcH3uGnDbuWW2/67tsmS2u7f2fWwf0uoKbY/e62tnv3TO4SWpgrgUkUqBweMDTX3hQg464jDWnHA8Y4ceAo97+P49wdxym+fmW7jhiqu59errmbprI34+JrCWEND4nAB4j3SgfB5/oYqHbQU7WLZgx74Cve3Tbv9ufM/2xxd73uNlC/K010Tllo1aCkFhDTPSkar8ukIdMDE1TXVkjEatTHPFQl708+/0Xd4ZbzjFT/3mEsZmWwzhSdIGbrTKuMmIVYCt1ggXL+Ul7/h3eNQx+3d/GGC/xYBsHMCYPf0M/5PPfga7ZSvZ5CxlIxhTJSqoDpkwwneyOCAf5KXrF9Ma9KD7BiegkWWIQCO1xkhJ4jwtLInSpFqSRgFLDz2Eox56Eoc/+AQqqw+GI/Zx68cNa/36q67h6gvOZ9NV1xA0E0QzpWQddacoIYiQCOf6XHBQZBwVhDfP+JB7rP8ZBS2dZ1hVU4hMTmGsgER7jMqtJM45hAwYt4bm4lFe+smPwCO6rpQ7v/tzf/q7PsyyRouDhqo0mtPMh5AFijjx1EeXctuWCRYdfQRPfeU/UH/Bk/ft9h/ggMSAbByI+N3l/mef/Bzrrr6ChUMhoXdU0dS8QqcWM9/CG4uXAhkGOLlzsgHdgMwB7hu01hjvsD5/jl4pCBRWBlilmDMZIgzJtKKRZaQSFq9YwXEPOoGVxx5J/bjD4fgj9+7J59pbfHPdOq4473yuveRyWlPTlKVGGksYCALvKXtJxStKTqCMwaUGb03hhmufqO3q6res7UmykSiJ8FBNxU7JhvAQBAHWwLYsZWqozGNe+VKO/NdXddts3Z3+Gy/7Z4Y2jbMs0GTNWZJQYJRAiIhMaOZST1KOGI8kf/OPf8ea175s727zAQbYDgOycSDh/Mv8GV/8OrdddDnLdJlaoJlrTWFNQpA6SkhKKLQXKCmRgaZpsz6yka8sc+lm6QdkY1cRBgpbZLc450AonJA4DxkOFZXInCfzIIIwJ39AK0mYcDHxggpJKWD5wat4yCMezvEnPhixdAmsOWTPTUbr7/TzN9zIuutu5IrzzieenEI0YqpCUvaSspBETpBlGQkZ3lu0EShrCS0EQuZ1caTEuCyPfyB3S+T6Ka4Ty7Mn+56VXbJRyQShbVv7PIl2OOk6mU6SAFMusUVLkpWL+cdffr+vfa455X3+ttPPIpqaouwtQb1Es5WQphkjC5axdWYWOTLCxqxFUg1YuHolL/nBtwaEY4B9BgOycQDAn3mu/+3//h/rL72SMQJEo0XZg0sTRkbrmDSB1BB6QeBzNUXrHZl3OF3Ieg/Ixu6HcKRpjBISpRRKqU7KLUhcofshVC44lhpLnKZIqSlVyoS1EuOtOWLhQCsMgrksxYQBy9ccyqpjjmJ4xQoOOfZo9KMedv9OTOdd4NdefiXXXXIZm269A99sEQlFVSp8HFNGUEFBnCHTjAgFUqDKUW5BsyCdA2Nzt4MHpOiIsEHez6TPgzM7cvf36039YeQByvk7ERmZvxO0LRu5C0h4sJnJBe1GhpnUiptbc7zta1+AR57YbZPTz/bfePu7qU1Ms1AHICzCeaTUxKklqg6xaWYKOTaMr0XM25R4qMrJ//1heOiDB6RjgL0eA7KxP+P3l/uzT/sGN19yKctLdez0NCUP1TBAOofNDHFjnlAqQqUJZG7V8N7jVD7QJ9Lv1I2i/IBs7DKEIwgU3ju8cxhjsMblK2GpUUohpcwFpgClNUoFGO9IkoQkSahWywjhsUKQWIeVEhsGxFIwZw1yqE5DApUqiw45iOMe/jCOeciJiIfuYh2Oq672d1x1LbdedBlb169ncvNWQiRlpSDJ0ALq5Qrx/DyBz10lIk2RxlGPypRUQJIkzCUJKEkgA7QUeYaPkgghQApi07VsQFfjolPcT9xzEOf9DSdysiHJyUZbdd8VAaJWOhQehcDGBqtD4lqVzcJywjOeysM/9M5uG6y91X/75NdT3TrJQgRz49tYMDyEaeUp1tXhEVre03SW2SxmLmmglyxkXZrwtk98jPBJjx0QjgH2agzIxv6I08/1V/ziV1xx1tksKteIrGF2y1YWjQxTCUO2bt7EyFAN5UDLgEBIJCI35WcG4x1eS1CSVORkoz2ktzNR2tkAA7KxC2hbNpRC65xcQCE6VeQRZ1mGDiKEkqTWkCYGIQSlSplaKWJq02aq5TKBjjDGgNLIMCJzjvk4wYUhLWsxgUaUIlrW0rQZ1aFhhlYuYuywVRzziIew+NDD4aQ/oOVw40ZvbruFC8/5HTddexXJ9CxirsHB5Rp2cgaXZFTKJSKlSeMEY1K01gjp0VoTSIE1hqwZEwaaSGpMllEu1bDWYq3H2gzvBc7n+idOkMvG9wpquXbdG8hTmPcs2WhbLwInkT4Xp7PSkak860XhCaTCp4ZmahGjw8xqTTwyxN99+r/h+MM7d3fDez7sb/jZmQw1Y9z0DGOVCj7LiIKQbRMT+EChohILly5h28Q4caAQYwu5eW6K45/2RJ70sQ8MCMcAey0GZGN/wuXX+at/+HMuP/0s5MQsK4aHSadnqISKSrlElsTMTk+yZNFCTJqQJRlK6Dxd1PncfF2sKJ0UGOGxSvQN9m2rRjtAb5CNsmsIA4UvXAcWC8gi/zKv3SJVgHFZbt1QEqU13nsSk+HSjNFqFZ8acHl6rxQC70RRrVTiEVgJmcjb1CuNkwLroSkyWpEkq5fZMt+kevBBPPXl/8DRz/7LTotnv7/W//Ib3+amCy5gSAtClVsoylJSsR49HzMUlgkEpK0YZyxhGILMVTplpJhrNlBKUS6X8gJ6xuQF8wCFxLuCWEiRS4QLsA4sHqTqPKvcqiG6Cp7CF9Lge5Jw5Gnh2nZTaa1wGAVOGDQCnKOiQhpJSjA8wob5BnZkiOe+481Ez3t69+266Cr/pX9+I+WpOVZEJWQzpiQhabWoDtUw1uKAmbk5hoaGiJ2jJRSNKCQerRActIwXveudcPThA9IxwF4HvacvYIBdxC23eg4/VFz8zg/43//kFxxcHmI4cxhrkVlCOZDgDc3mLAJHrVYmbjbyctiFIJYFUAKUyjMiilRXJ/rHrPYg31ZRHJCMXYMAfGLzZ4pEiqJgnMt1IIQA7zxSSGTxe58ZACIkLopomDwFQsi80J10IGVejE54j8jlzJCAd+C8wRfaFJGA4Vgw24wJ6jUmJqc5aNnSvmucWL+eOy66mDVBhGjOE0oPJkVZn1vElMKYFOdzpVUtZU50nMtdQMZTiUoAuMwWMT+i4waxeLz0naqqtihplit3ik4VVeFlx31yb3osDyS6VpYcjn5JfeccZR3QbDSQSoPJkHFCkBiu/f0FPPR5T+/u/MgTRbR0qfdG0EwMVR2S2AwVlWilace6WK5WMMahBJC0WL1oEevv3ohrpHz1n97M37/tzV795cCtMsDeBXnvuwyw12LtRn/b//2KD6w6zl/ynf9jTVQl3rSFMElYUKuQtZoILMI7RI9AkSsC65zoVkFtB7sZCVnx/15lz3ZFVUF3cB2MZrsBRUXcfH2cb6K3Sq4H1f50Em3zQERtZbGazgt+eXSxys/b1Yk8ZsALB8IABoRBYhBkCDIClzFsHfXEUDWe0Dmqw7W+y9t82zqGrGE0swzFKdUkpWYsIwhCkyG8y2N6ZH9Nmt6fu/fXKw/XFYCzxWYUnXNZ0XXd9cZp7EA09qBVA7rX1CZw7fuFXII/jROklIRhiPce5QWj1Sqi0eKGiy/d4XwPe/ITaUUhTaWYyyxGKIyQZEJ23tNOcUEvGa3U2bxuPYfURgk3T7OwYfjC29/Duk+fthdRsgEGGFg29k1cfbu/+Dvf48pf/YaR+RYnRKNEUYA2jqAU4U2CKpeRoQJr8lRB152IfFsivGeF2Yvt5cNFjzWjd7AfjGa7Bk9O7rq0TRa1W2Qhsy5z+uH72wKRT2RW5G6FznQr2pNcl0wa2dvuvhNn4AUEttBM8blKZ6VS2sEEv/b6a6jgKDuDSVNklH9HGGpS002Lbs+xwreJRr+arBfgPYj2RNwmH8J1iK3tISmSboG9DtEABL6vKvDe1AddcYXgO+2llKLtqjbGINKYSqmKJWNicoZN3/2ZX/aiv+4886Me82h+/M3vUg0CdBhhvAHfjU0RRbuDzvuBtVSjEjPbxjl8xQru3jrJqIaLv/5dNty41j/25FfACQOZ8wH2PAaWjX0JN93hr3nP//jvvfXfufnXv2MsTonmmiwIApidRcw2qDmPimNkmpI1cneJ67FeeJEb1h25nkObePSvzLr4Q0Rj+30H+NPgitV826Jk2qmeQuT1NYTorPD74ma87KQgK0fXJuJFkSHUloDvf71F8XflCneLz2u8iCDEOFi2YtUO17jl7jspATJLUN6ilMJ6l7tNhOh8x84GknZ/at+DFRJX1LPJ77On//U8k+59disDqx7CBV2Z8j2NbvVX2XEF5SQ+b6NyGJEmCcY7wjDEGEPcalGWkkXVGr//0U/7T3jSkWL0oJWYKECWontQSM1/58kJzKKxBQzVKjRnZ4knJ1goFOWJGTaddwn/+7Z3waXX7U2cbIADFAPLxr6A62/xt/7mt1z4izNx26bRjZSacWhrGVs2ysa772asUiewhtB5lo0sZL7ZpFap0rBp4RrJB8NOYJ6T3fokO8E9kQzo1z0YYNdgBfh7CELobYN2u8mOhaCYyKXvm6C3h3KSToFb37WhCK9wAlo40mpIIuCkY47tOza59hpvWy1CocnSGCUEPlDENsU7h1AR0vmu9YX+2iSWPAaFHmJgi795Saf4nSiuMbfYFNfddt0V0uTt6+51/fU+oz2HXprVJl/tCrH530xmCaOAIIxwSUaSZXgHUgombl4H1673HH9YpxWf9txn8vOPnErFOcL2tzg6zycnn4VV0gm2jG9DlyLipMkhhx6EMYZyJrh7w2ZUK+Wrr349L3vvOzx/9aS9gJ4NcKBiQDb2clz30U/7y886m9ambVTSjDEVorOUBZU6s3MzbNm8gcWLxwispDk5CUIwO50RpwmqUgLdLQDWVl2UTnaqo3rhdjpZ9U4efSvK7Xzzas+6zPd5qLbLY4e/tAvFSSS5fobKBSlzwtFpM9fRO9k5JMIV7hjXDWhUTpDoXOkyUYoUyWHbkY0N62+nIjTSWpyxSOWxwmOExFlPOQjygMed9BVJ1/rVniA7V+TbsT+yyCrJLSXbV/VVvks6eu+xTTgA9B5mvL2F9rqQufAYxX0ohXUOkyY4BOVyhHCKVppSCQR3/Oa3HHz8YZ2jD37Js0X2sVO9y/KeIX3hoGmrp9K1diil0EEJHwg0is2bN+KtZaw+zDGrVjKTpqjM8Yk3v51n3LzOH/6m1wwIxwB7BAM3yl6KdZ8+zZ/6qKf6i771v9TGZ1gtAhZbQTVJCNOYxsRWlE1YWK1h4haT0xMML11AMFpnyseUl4ySFipD2uVFovJNEViRm9ILc29boKu9tQd55Xomhp5rcyIP5GvHAgxw36A8hNZRMo5ysUXWETqHdkW5c+/yAF/v8sBekX/mlUsd2udbUOwve6Z1L/KpyQqBReGEwhIUW4gRAWkpZAaLDwJYcXDf9W1cu56yk0jj8iwTJInN900deFloYBTXAi7/WeQByco7lMsnS13cU2jzWJGw2LTLrS/KS2TbvdOTXt0NDs3P334G3e0BbLB7QfvJd4NZJcKJnGzgSU2W/13mirHlMKLiHBf/5qwdzvWQh52EUAJB3qbaObT3RcXbvAougNeSVpbmBd9Sw9Jli6kNV8mUZf1d65hvTCHjFkvR/P4b3+P7LzzZc8umgVFygAccA7Kxl+Hu7/3If/O5f+d/8dkvsKCVsdh62DZJvHUbw0GASFJKWhFpRTUq4bMUZy21Wo2JqUnmkxZRvca2mWlK1SpAkdUgO66T3hVkp3Q8O5IK6LpK2qvUQazG7kW++nVdd4lvi6YV7gNfSHe3J3N2dF+JYhW9s4yN3rbqZIoUsSJW5IXg0sySlAI4aXVfy87duZnIOoR1CJ2LVRlj0D3aF/c0hLQvoX1PfSS2HYux3Y1I340/6UsnvYd4ItjxHHsCvuffXjhyUTbvBVoHlMtltNa0Wi3mG3MIZykLwZZ16+Cqq/tO8BdPfxot4XM3lJcdd1mvkq92eWqtUoqkmaCEYG56BleUuh8ZGaEUhJQFjHjJcMswd+PNfPW1b4ALr9kLntwABxIGZGMvwebv/8h//Tkv8T/+4Mdwa29lhfEMxzFh3KIWKarVMq2kCTrAeoVHk6V5gSeFxhlPqCKkV3gD5bBC2kqhGKxykuCKjASPE7b4dJ1gs96tN6jUFJ9ddwydFejepHmwr8GTB0kaKYugyXzLK5nKIhOjf+s9Nldv7e7fOa5ATkLaM7vFC4sTGVZmWJkiMMj5hKFqjSUnrNnh+m69+AoiJxBCkAkPWhFKhTaOsg6xWZZP9r77/b330K7I6vuu2WFlvhnlOv2q04287Dtf+9m0n48vUoO1y7c93f+6X+/Ir84Wzzp3UcpA521iwaYOZzyB0pQCjbMGbEbgHJf96Od95xXPfIJgwQJ8EJFax0yWkEaKWHkMnrLQyFaWWx8LS0mgI4RQaK8QRiCtQHmFdlDVCt2cZ7HJKG+8i0+94G/hf38+eHsHeMAwiNnYw2j+4tf+u5/7IpPr7+CIRcsYNgox32JhpUbamsfLbhqjEyBEHmQnRXtScT2T0B/DHf840/MfGoX29AC/PyF/lPeN87f7xR8+vj8apK/thSRSedXZQ489sv+wC67zqpWgC/dFW5ZbOY9rp6Xu5Hr+mGv+Y9G7r+35Qun50070gGHHyJteErV9K0lcrrsRlbjuvIt56HZ/P/JhD2XT6WchtWLB2FImJrdSDctIIUhbKWInzd6JyyqekXWGJEuJyAlHFjc5eMEC9MwsX3nHuzj++mv9w174Ajj6sIG9coD7FQPLxh5C+vPf+C886Zn+4//0FkYnWqwJhmjecidDLcNSXcZMzVByednqdiwF7JhOuFeOuQM84Nh+/u3tM9Alq33HCDAImknMMcf1B4dO3XEbURAAe4erYn+E8CDijOGgxPzmcZJf/K7vST/i6U9hVhhiJTDWg81LChg8RgsI9b0uHLz3RDpAIqhVKrTmG0xNTrJi2XKGVcBF3/8pP//Yp2HtHYNWHuB+xYBsPMAwv73Q/+Tlr/P/8+a3UJmY4cTFKwjG5xBbplgiIxaqiFIGkfMEPa6K9oDfqxI5iJ0YYFfggUxBphXVFSv7/nb7uvUESvbIhee/byd3tmNJBlau+w5RxF3QSllUrXPBr7YLFH3cSaJ60FJagWJiapJapQrWkWQpohRiJEWg8D1DKUUUhjSbTbIkZXR4BJOkzExPUxMBq2SF235zPl957RvxZ184aM0B7jcMyMYDhdPP92e85PX+m2/9D1pX38BBUYmw2UDPzBA1Y1bVhxiSkvE778bGLRaNjpEl8T2ebpAJMgDsaNHYHvdk4WjH5KRSMrJ0CRzRrxx6601rMXHcc6zs1sXp/G6Q97wrkB4qWiPjFNVKuOnCS2Hthr7mfNBTHseMNAgdEDhFoEKstSTekkh/rwsOk6QIIYh0wOz0DKFUjNTqZM2YbGaOMWNZLULCTRP8v7e+nTu++t0B4RjgfsGAbNzfuPgG//OXvN5/8a3vJLtpPdXxGaJtkyy1gkqSYRvzlALB3PwMSRqz7KDlqEizcesmXJArLvZaMdqR+oNV5QC7CiMEsyZj6aGH7PC3yc2bEZntWDLaSpntfKXBwLHrEADGUg9KZNPzhKkhvuaGvn3WPPrhtEoBtfoQjdkGkQxRKiA2GWh1r2Qjz1RpMVSvUwpCmvMNnLGMDQ2zeGSEeNsEqyo1hpOMg2XIN973Ic56638MRpYBdjsGAaL3E8z3T/eXnXk2N1x4GVFmGXIenySMak1JSsLZJlUhsMM1Em8RUpFkKZvnJ1FaIEeqOAEZri84rrcoWv6LQdzGAH88eicnKyFWioOPPbpvH3vpFd40mwxphUi7HU34djirxLaLtAywS7CZIUJSVgqlNJee/Vseffhqz4mFpemkk8QhJ53gWxfeSOjyKrqhDEmVyNXd7B8+f6VSYdu2bWitqZTLKKVotlrEcUqapowM15mZ3IY2BpvE/MXqQ7jp52cxdftd/vn/9iZ42AmDRh5gt2CwQNndOPdif/4/vcV/9/0fZeO5F7PKKZYJxQIBde8pGY9OM3RmkdbRjBs00iaxMIhKBNWALJDEWFrYTiGtjm7BdpoFAwzwx6KvKJrIa5TooTrL1/SnvW678y58HBOSV+Houk3ado72fwcdcFcRhiHzjVmqYUBrYoqbLrsS+nRM4KFPeCwTzQb10TFsahDOUwpDsiS91/M3m03q9Tree+JGE+89JssItKZWq5FhUKFgrFZhTGqyu+5mtYho3XArX3jjKbTO/I1n/fpBQw+wyxiQjd2Fa2/yV779v/xp//JWbjv7dywWnopNUWkDncZUE0M1cYTGIhFkoSQOBV6DCiRIT+xSEhyZBKMETnYrerZFm7pSz3vwXgfYa7B9lonYbmuLPkkpO9VHnXMkWUbqLDPOUTp4dd85716/norSCGvuUY5+EC+0e2DxpFmGNxnDpRIlZ9l2+eV9+6z42xcJWasy3WxiEZSjEq1Gk3IU3Os4IGU+xAshiKIIm2ZUolIu/+4NibSk0pLamADLkINqI2ZJYhiZmuer73o/V//kjPvr9gc4gDAgG7uKG9f5i9/1fv+Jl72K9edewHCSMGIdYdxCtJpE1nSlpH2uV2AUJEqQSdGJSG9bKjoVPHu2tjWjUB9H+kEmygB/HMIwJHOWNE0xxuAF6DAkKpcQQUhpbASO7VcOveOGm4ichzTN5bLvYULLg5QHQaL3FV44vPSUqiXKpQisIZ6c4rwzfrXDvkc/4uGUFy0icR7nPJHSxPONXVp0tDPbrGyPJ/k4FVlLLXUMJ4bq+BwXf+eH/OJf3jJY3gywSxiQjV3At//rA/5Dz3s52866hPpMk8aWzSRpA12SKOGoaIku6kNYCa0AmoGkGUCicioRWkklzbdSlm+RkQQ9m7ayW0SLdsBorsI4wAB/CNZarM1Lw0dRhBAC5xzWWppZwsKDdiwrv2n9bQTWEiK7k5nvqpp25MMf2FvZL5HhMBjSNKaiFGPlKndefyP20iv6Hu/xj/sLxsnItCLNLFEQEgi1Q7ZRrwLwvW1tdWHIVYIzBanK21b7nHCsjqosmEtZf8Y5nPZXL/BcdvWg2Qe4TxiQjfuIGy+8yF936RUsro/QmJhm0fACNJKx4RG8sczMzBCWS1hRaBkUL7ORuUQ1xUAe2O7WLkylHQTFpnYSn5HLXN972uMAA1ibRxBqrVGBJrOWOE2weESgWbnmsP4DLrncE8e4OKYShn2F3Xox6He7DgcgBdZa0jhGCxgulYgyz7qLruzbNzruSOZKCjFcw6jcFVYKwp2e90+B8rn8e1caHozMC95pb7ET0ywVmmNqC2ndeCvve9VrmTr9rEHzD/AnY0A27iOO/rNHig/87AfioX/9dG43KZtm56nVF5DNG9JmSqlWY9ZlNEKYD3OrhhX5ix24NqmQ3YqXxUu//acq9mn/v131s11fYuA7H2BnaK92gyDIa5tkGUmS4JxDSonWmnKlxsGHH9F33OxddxEJAWlaVJwF0UM42haNbuXZAXYFUgrCQBMphUgz5sbHqQrJVb/+ff+ODzpSHP6YRzInLUZLUpNhbLrT4omwY62jnW3Sg7Z51V28xIrcspHodj0kR0lL7Mwsbus4q0tDHF9fyCff8G9c+J4PDQjHAH8SBmRjF3HCO/5JvO2H3+eIxz+GLdYwYQ1qaIRMBRhEx4ohvUS1SYaVhDZPX82zAnKrh5WFDPm9mKjb2QSDuI0B/hDy+hgeLSTGGJxzlMtlZKBptlo0Wk1WHHF43zGb7t6AxlMOAjDZPVo2YNAHdwecc+A8kZJo5xBZxqJKncl1t8Pp5/cNA4/866expTVP0xtEoBFi1x9+e0GT11fKCYcV5EXyhCMsh4zWa8g4oZZk2A3bOCIaYu3PfsOPXniy54p1A9IxwB+FAdn4I/Gxt5zif3rqF3b+Yj1olXj8m17Hi/7z7ehjDmODslCt0ooNkdFUUkk1hXImiEzuMmmvPBMlaWlJXGyJlqQq3zqVLnsqLnXlygdWjQHuHWmaEgQBWueTkwp0Xl/DGIJSBMce3NeLbrlpLcI4SjoA19/d80quA6n83QUJ4Dw2zRDWoRGMVutUUNSd4pJf/65vf/2oh4vFaw4mEQ6vJEjZTYmn38Lxx8ZsSC9QTiGdKIq45W3cXgC1fMqWqW0sXbqEeGqaemxZ6UIWT6fMXH4jX337u5n6ye8GhGOAe8WAbPwRaF56jd966VVc/oOf8j/PfLFff9r3d3y5jlophp71FPGSj3yQhz332axPE7LhIZpaYaTCIwAPwoEwtCtpWumKOI7u5umvf5LX3WxXc8yDRXP3Sv8ltMnHH/rcccAZYH9Dr6S4954wDAmkIo0TklZK5jzlsTFWH3PMDsfeceNagsQiiwkwN6/nPn3o13sRfpCCvUvwkkiXkFIhpCa1Bo9hfPMGhgPN2ssuh/Wb+p7wiU94DGmlTOwsSWb6zuV7ctikb2+9AaT5gLGj7Hx+lCrEAnOLWN7ecWoYGh1hfHIbCxeMMVopkY5PUm6lrI6qcMdG/vcjH+fGj35u0BMG+IMYkI0/Ahd89as8xChW37WVlXdP8Jv//iwXveIUzznX74R0HCpOevfbxMmf+CjRicezoaTZGknSeplZn9LyMaqiiX2DVKWoINc/UAi0kJA5nHEIJ/AOHAIvio0ijsPnWSza5YNJ72rz3j633waEY9+G8nm6Yuf/TiKd7GixSC2Yb82jlaCkArxxhOUhtiYZS47sj9fg5vVeT7eotRylTFBSEVYU1jXAI7Eyt7RpR6ci8QD3FRKbCqQoEwuwARiRUKkJXDaLmZtk/LJL+4448jGPYiqUZEGI1rnsGl7ihQCvwCuEVyin0E7kcWE+7yeSfBO4Is3e4YTHCQt4hHedWDJd9KNQhcRJhgoDGmmTVhoTlhUqdMjGFAc1W6zaOsHFX/8mV77zfYPeMMA9YkA27gX2jLP9unMvwNxxOyuspzo5zch8zKYrruW/T/5nLv34F3f6ggVP+HPxrHefwgve+W9sGYq4OZvHLR1lXisa3hLVh3EWmvMNQinyQds66uUylTAEY4tBwhcy0b3pKHKHuI5edch7+xz42vcTdAI0d+5Sa1vFjM+w1hIEAUEQ5bFE5RJL1hzat//chrspOUHFK5QXeJuf10loDxXtPtcWlxtg1yC9LsgCRSq7R2BRWAJnuPXKa/r2Fw97sFh+9FFMxy0sqt/6uV06axfuHn4GRG5hpdBTkYV1I7dwdM/TCSzt7G9R3lL3joUIao0m5/3gh3zlBS8eEI4BdooB2Sjwmbe+01/3q3N3eFG+9ulTsXOzrFq8kKFaiXoloqwgNBlrhoa56HPf4MtPeJ7n15fu+JIdfrAYecFfiX+55GzxoL9/LuukY6pSZSKVzMw5IlWjFlUhTbFJDCbDpQnKWkpKEEnQ3uWbyzMDbOFLTYq4Dlu0YK9Ze2dbGwPz9/6F7a1UtkcDwwlQgcYjMdYjdEAmYS5pkeKor+ovK7/u+hvBWYT0SAXWd830bevZgGDsbriOFUq5btE7XaTCX/a78+Cia/ve1sc8+ckQRhDqnbhDXZGx1k2R7w08d8hOX7m3QPR7gxXQFHlZhbH6MItVRHDXBO978KP83OlnD0aYAfpwwJON6077jv/ws1/st27cyHFPeXTfazv1s194s3WcVWNjzM1Mcvv6W4gUlDVMbrgTu22cYypDVO7awhf/5a389IWv9lx7y05fskf+xyniZe/5D5Y87GG0xhaQjC5gTkY0jSWIQkZGhigFmqTZwGcpgRTYrNVRHe1u/S6RPxZtctH7Oagcu39gexdZH+FQAqEVRngs+ZZgCYaqsGCs7zzrb1zbRyba8uYD3H9oE4V2rITo0dWJrEPPNRm/cV3fMUuOPxZZq9FwHisE4IoX2xUxYe14MJ+nyG83XuT2k91z7ZWxYTaObyaZm2dJWMHdvpEH1xfzrfd8gCvf+7FBBxqggwOXbFy+1p/5hnf5X3/pmyRbxnn1K17e//frb/a/OO0byJlZxPw8I+UySxePkTXmUVnKQQvHWFYtY7ZuZpG1HFIqIe7axCde8jJu+8xpnnW37/Ci1Z/+RPG0d76dJ/3za7i1FHJXKSBauoTpZpPN49sw3hEECucNHktQCjHKYWReL6VtxVAeAiMIbHeQ+mM2sd3ngGjs++hkJ9GTNt2zcjXG5BOLFKTekkmJLJVZvuYwOGJVH13dcsedeTq2sTjv8TKfyLa3gg2sYrsTuQujHZzZXgRoB5GBharMhb84s/+QE48Sq447ljQI+qTG86J5ucPDiZxouGLcsDKPufGiHUS664TDC9g0Oc6ylSsYq1SYu2sTq0s1xO13s2Biniu+/2N+8tJXD3rLAMABSja2fO1H/itv+ndu+vU5hInh+KOPYfkT+60ad15wMRM3rmNxVEa0EtJWk0hJbNxCmhRpU2a3bmKsEqGzGDexDbN5MwsTx++/+h0+/crX43570Y4v2polYtkrninedMlPxVHPfBrn3nUrpdUHIZcsYmscE46Mokpltk5OYLwnkz5X9VNteXKHKtRFQ/unmbXb5GJAMvYT+PakIXewcvU2sRACpCR1FuMdRgsO2j449MprfTw9S9DOOvE+L2EOtCdEGBCN3Y12uwnfPxi3CYduxNxxzY1wdX/l1Uc89cnMCkcqu20vcEgMAgOY3LohXE9fkLvdmlmvVBHOMz81w1AQsqhcZqFS1FoxK6Vk/Mpr+ewT/tJz7U6C6Qc4oHBgkY0rb/BnveZt/qcf/xR68xYWhwGpNfz1C5+3w64/+sKXWV6qIeOMelTOV3vGUo5KlIIQLRUjo0M0bBMfesolzWgQslxFhBsnOKyl+Pxr3sbv/vEUzzV3edZt2+Fle8z73yzeefr/sWlBjWvnZ5GrlnHX3BzbGk2WHXQI6AAnRMfn6mmbWR2B82j3xw8c4h62AfZ9dGNwuq9zu221kHjncsIhJJmHxDsOOrxfzGv8jg2IZkwkBEqKTtBgP7qpkzCQLN9VtGNsbPFAu0QuDxjXDoZVxJiO2HR5f6Bo+YRj8MM1MpULcQFI7wrCkbtSuinubQXinvGicLfsCoSHeHYe04zRShCEgpnZCbzPKGEYspbFiWVsap6PveTlzP3wZ4MucwDjgCEbG772A/+F17+Fu35/PmOJYTQQZCbmoU94NPopf9E371707g/5xTJCz7UoeYlEIFFIqfHGgnV4Y5mfn8WYDK0V1qQ0pqYI0pSDh4ZxG7ayWpfZdP6lfPEfXsVdP/8lrN2w48v24GPES376PfGsf3sjsyNDNIbruLFR7p6dY846rMij1aWXnTLz+aCRV5Ed4MBGXhW4q6kA3UlLesB5XOYAiVIBItSgA+qHHNR3nsaWcUqZJxCyU5bcFcoNfd83mC52I/K4iq5IWrvUYg7lHYFx6FbCWT/+af+hR68Sxz/6USRKFirF+ZHKe2Sx9ZLDtlJonjq/eyxU0kNZh5RUkH9/oPGBpJnMMzY6RDw5STVNGGtlHCJLnPau93HlBz7uufnWQS86ALHfkw172TX+2y96lf/1R09lyUSDFU5g5yYZXlhnggaPfuWL+w+48iZ/1Rm/Q0zMMyQCpPN443Ki4VRen8SDxROGJSIZIBODclCvlrE2I2k1qQSgW01qWcYS6zjjC1/im//6ZpIzdq62d/hr/kG89IPv49AnPYHxSoVWvUZTaiwBlVKdeC6hqsukSUIQKlJpcyVBKfBSYPEY7/DeI4RASokQYmDB2M8hCpLRbmdZmONVUcQvlAqTZoRKY63FWI/VGk46tq9b3Hj5VZS9oCQlWRKjI00RYorw/eb+9kQ10GjZNfRmEbUzQ3ozibwAbMJQGLBx/Tqmf92fLffQpzwBWykxFTfRUQkpJVmSB5crCc5kncVJb+Bpb+zWriIQGmsMXklinxErC9WA2eYcUSipI6gmKYuMYGkGl37vx/z4Ax+DdXcNCMcBhv2abKz/9g/8p1//Nsz1t7A0tiw04ObnqdYrXHvnLTzlJc+Do4/oGzKv+tHP0TMNFpZqZI0W0hUBVT4fzj0KR6GqiCxEcETnQXrh8NLihUWRMiQ9YmaG5SrA3nkXn3zzv3HJu9/rueHaHV+2hxwtHvU/7xKv+MwncAevZLpWYVJJJpMMXarQbKWMjo0xNTdPWC4RuzQfoIqsASm7q1JjDGma3o9Pd4A9jY6lq/d37cml+NmZvBy5dw6HREURKw89dIdzbV53KyO6RHN6lkgHGGMwbcvZoODa/YY8wHdHl1WevuqxNkM5w4qhIa4677y+ffQTHylmnaU8tpDpVhMVhQgh8C63vIY6KPqGRDmB8CInGz3fsatt285sybOgRFcFufiSUhShMotuNBlOPdFMg+nr1vJfz3guXL9+QDgOIOyfZOP69f67f/ca/4v3f4JFW2Y4xIZU45R4fg5dryBGa4TLF3HsEx/bd5g952J//k9PZ3mlTmPbOLWonP/BSyDXK2hLN7frlbSrsgqfl6wyElLlyJTDCUurOcOykTrplk2MpSnHDQ1x9f/9iM//48ls+9rXd/6yPfwo8aJffEM8/B9eSLJyMRORxo+O0fAwPjvH0NgCZhpNqvVans7oHdY7HEUGgZIIrRBaDcrQ7+foVAjermBJTkIcCkElKuG9x3tP6i2rj1jTf5J1G/3cxq1UvEAZk+tsSAk7KfTVVqEcWDV2D3zPZN8miJALfHlhMD5D+IwoSbn5oktg/W19r/PDn/Jkkiik6Syp6y46oAgM7kiWF+OUE4Xq8O4hkJ1Ml47lK++P7e44OTuDKoVMjI+zdHSMFaUKQ7Mxjz9oDe95yl9xxze+OxieDhDsX2Tjlrv97Z/7pv/gC/6e+atv4LCwwqpyBTE3R1kphJI0vGf95CRP+tsXwcP7YzV+9rVvUzUWNz9POZBoJfJ0tM4eOcloyze3/9/L7ruDcL5qCJSENGbVgjGGhSe+cwNLESyYT/nBRz/Bl5/xtz45ayeCYMAx//oq8fIP/hfH/NVTuTWZo1krw4JRJtIWLQlzWYYIVMdlAuTEw1qEEIRhuNsf8QB7J/oVYrsTiZQS5xzOewgUjSRl5aGH9B1r7ridKhI336JermLSDKTYrqrojpPTQO5+19F+fB2NjZ7xxkqHUFDSkmRiAiZmaKy9re/4hz33OWyYm0XUh8iEwEnZsXR2dVIEvUN9mwhY6f9ATd8/Bb31WHoKuiGpDtVpxTHLVizlrttuZTgMMOPb2Hrd9Tz6sCP45Re+wm/e+S7PzTvXJxpg/8H+QzbOv9r/8m3v4cavfZ8TfMDwzBylNKYxP8X4/CROS6ojC5h3ngWHHs4hf/mMvsMbp//Wb7zuesrOYVsNFiwcoRXPI4tU03bRs7aWQXtAMFIWEeH5C9bOl2/XrKiVImamJmjOziAyw6JqDTnXopZYDpYlxrZM8O1/fye/euUbPTfetuML9/DjxMM/9O/idd/8MnPLxrhhbop0dAS9eCFN4bFCIpREBRqpFQ5PajJSk2Gc7fcH92wD7B9oa2xs7/9vTyjGO5pJjPEeHYUYCQsOXtV3jluuu4HhqAytmFBKwBHHLbzavrcM3Cm7G+3Ymtzy0C2GBj5v08ChlWAIGEosF//0l/0nOOkIUV25ElMKsVGA03mKc+rtjsJ/nVTpnGjY3UQUhQdZ1FLRVhdVZBUexUyjhZGCxBpGxoZpzM1y6IrljEURM+tvI9o8yU0//TWn/9dH4OobB0PTfoz9gmzc/Pkv+//3j68mueFm4pvWscR4lldKZI0ZqrWIkQVjzKQJk1lCFpZ4xkv+Hg49rO9VO/Pr36ZuPbRiSpFmvjmDUh7pDapIKYPcZNi7msskZFL2KQFqB9rmg0ez2SQIAkqVMjbN0F5QVSF1FRI2W5i772SFzdh08cV85eTXcutnT9v5C/eQo8Srzv6ReP4pb+Q21+LG6XHkglHm05g0TXHOoZTKS4mr/aJZB7gXtPMN7kmqvGNtw+c/S0V5uA4jI33nuXXdOkKgGkTYLKNaLhNnKVKpnm8aYHejra0hO8J8bZds/ndX7NBozjAaRZSTlHUXXw5r+4Mrn/q85zDebDIbx1ghUWEASpJZR7f8Wte1ketvtOuc7Mod5LEg3S13JwsvwWtAUqrkrt5mEhNVIhrNGeLmPKGGkTDk0KjKSquYvGYtX3ndG0l/csags+2n2KdnpYnzLvNfe95L/Xmf/zqHyIh6ErN6yRjx3ASzE1sYroTEjXlkpEiUZGvcYskxRzN84kP6zjP3jR/76VtuxU5OsXBsiMQ0ibMYFSiU93nFxMLPmQduOUSRetorH54L8eRBo6pIN4vKFaL6ECmCBE+cZmih8LFFJhnLxiqI1hTVuRlGpme56LTv8K2nv8Qnvzx/py/dylf9nXjTt7/Cg5/zdG6c2gKlCAekxpAV7hOtNUoplFI7rHjbGFg49g/kZEL0EYxe64YDgnIJIzyJNSxduQrq1b5zbNywAZ8aQqnw1iGlRGvdDTzu6SiDujq7F7LHmiF7MkaAzlhjswyVZlSMo9TKmLnk8r5zrH7sY5G1Kk2XK4aiNFIF2GJ86rrYcsLRjrOwuzj6d4TH2lVivUB6UVhQcoIDEq1CpNA0m03q9TqJSyjVS/gsxm2dZFHsGZ6LCSbm+Mx7P8iV//OZQQ/bD7Fvko2b7vSXf+o0/5W3vRNuvoPR2Zi6sZSEYH4+z9RYvmQpjdk5tBC00gQ/FJGN1Xj0854Jx67o4/Nnf/Pb1FLD0qFhGpMTVMsVVOEo8TsNkstfpRxdZcWuNHhX8yBOU2bmZkmylNGxhWTW4i0I59FSY5IUlaQsLdcYSSx6yyT1iRk+f8q7+O1bP+C5YUfZc446XDzuox8Q//aZT+EOXk68cIS5csSs8LQ8OAs4D5lF+JwY+R6i1CYdeX6N62ztyPT2RNW24vRubTGgzjED7FE4AV56lJcETiJ87p830mGUIzMJpTDEWUi8Z+zgVXDY8r5O3dy8kSxt0UxbSK1oNRPCMCJLDCBwQvTVXvGiX/Z+gPuOXksU5O4I0Rf7AJVKBZOkRCjqKuDs7TU3jloulh5+GOHoMJlSzLVaODxaqiL7pJ3tUlgyfBHRuUN12PuGXO+nO3Z0rSWSVqtFEEQEQUASZ4X1NWDDpo1UKhXKWiNTQ9XCiHGsECG//8Z3+Pnr37rTkg8D7LvY98jGhZf7b7/xTaz93Fc5erLJ8jhjFAmJIUktWRASq4j52BAGZaQXWCzjMmbBgw6l9oKn9g20Mx//im/ccjMVmyFaLULyQVuiSFOLFZJM5jEZ0ku0zVcj7TLvXYGt/Hy9qn0eiRaaUEcooWnOt4h0hCfPaEEESBchXQnXcsjUs1BpgslJVqYZd5/5a777r29lw6n3kLXy5MeJZ53xf+KYV/49G0frTFWqzDlBuT4MmYcsRWQppVDTjBsQCIJygFAQJ00irdDOob1FkpMSJxxOulwivWdzsluKWmCRxTYgHHsO+cBuEN4RGUk51UQmRDpVtJsnkJJ4fp4wLJFJxYKjtkt7PetsX5qdojoUkgSWTDosAmkFgQwL87vspHtnBQFVPpfMH8SH3nd4QYcU9rozZOGKUE4RqRLWQBBEtFotlHdsWX8b3NLvSnni8/6GiaSFL5UQOgCXu8W0M4TWosgQZOTURqKcRtugQ2ju2/U7jPQY5TEyr8fi2wXhyC2/odLYNMMbTykoYVOLNzBUHibJLFkUEEuPEjCUwdD4DAc1MpoXXcV33/BWuOCyAeHYT7BPkY0rPvEp/6FXvppo6zgjzQaV2VnKmSH0nlArhFIYIPMe43K/YVipM5MZmuWAZ7zsb/tPeP3d/uwf/ADVaDIShmAyfGZI4wSfOpTQHWLQdkW0tQ06K5HtVnc7C8LsLYbWu1/+g0Z6XQwuEFhP2ViG0pSxOMHefidnfuHL/Pj5r/Sce8VOX7wj/ukV4g1f/iwLH/IgNmvHhPA0NETDw6ggotVoMjY8gm0lzM/NoZWgXK0SZzFe+GJl5TspbB3LR/Ftbb+y2m41u1225QAPONoEMC9JHliJtvlE1Za4V1ogvM/N6lqz5LDD+s6w9fobCJIUYxNSDJk1SCkJZIBE0TaH91k2GFg1dhe2D+j1hd20TQIajRbeWoSU1KtVIiHQacZtZ/yq7zwjRxyKrUQkShJ7TykoEzeaPfFmXctlLvCVL552FZ36K6K7GPnDB7SzVgr9oiDAKYESkpKUDKGoxRnRxBT+rs185s1vo/WLMwc9bT/AvkE2rljrv/tXf+uv/Nr/cpAICZIWqqaJFtexziGcx0uP0AIFCGtzH6jUTDSalBYv4ZCTHkL4uCf0TY13nX8h01u3Mjo8gnMOYwyVSoVSqUQQBH2pow9Iil/hopDeobxFO0tdSepSMHnbrXzk9f/Cue/4gOeatTu+fMesEX/95U+I1536MRqrFjC/cIRb52eJpSKQEWHsqaMZCypMbR0nzWJ8qDBSdDYn8kkKL5EUlSctlDKIrCSwEuUleIUVCovababYAe4bXBHo56TrxBQhXEfYCy8xDjJARBH1xz2iryffcvPNVMIIiSDUAc7lk4X3Hmst0JZE3zFWYzAD7Dr6FyCyL7sIQGtNEAR4Z1BCYJOYwMPFv/1d/4mOP0oc9dATsVFI7BytJCVQIZ0Kr6LbXu03dk+vE2QhOueMJbMpBgtaoLTOM3SaMZX5hM+84784/10f8Ny8k2y9AfYZ7N0zxboN/taPfN5/6K+fj7z5TlalnuFmQgXP+MQWJqcncd7kMswuwwuDFBbt8/WBFQoxNMLGNOHp//iK/nNfvc6f/p1vs6BWI9CamckpvHXoQt7ZGEOWZUCXaLQtFrufeLRXHa5TTEl5R+AdMk7x0zPUjGVFVOKqM87kU//8Bprfu4eiRk98lHjRxz/II1/xQqYXDTNe0jQrEXPW4dCEYYnFY4sYrtWJGwl4jUN3osfbREMW6bu6yK7ppP8W+1uh8UIPdBb2ArQnkraVo9eK5pwDLYmtZXjRwh2O3XD7nURS4zNDoHVeB6iYBFTx8wD3L2SeKtT9RY9OitYSKcGYFJslYA3VQDJ+511w8VV9rfOwJz2eeenxpTJpZglVvljaPoh9bwrybQfGOudInCHBgoJyEDAchIwawcGqzDU/O5P/+88P7enLHWAXsNeSDXfWBf7Lr34dv/niaRwZljmkXKHciFkSlfCzcywfGaYSaEKh8D4nG8YbpHBIYfHW0XSOCQHHPPHxcNKD+qbFy3/0Q9KNG/DNFlkzRiIYHR7GOUeapl0xpHuYTHuzPHbpPnei5CcLsqGdYUgrFlerDGWG0uwcY40Wy43jq//xn/z0OS/z/HYnPs3DDxWr//nV4jXf+CwLnvhnXOeaTNZLNCsRN915F5lxNKfnGQoqaCcJrEIVefIdV0m7emRPeXEvJB6RyxKjsKJfLGiAPYHcR25lbt1ot5egHUck0GGJBFi5Zs0OR09vHce2EtJGC2k9CpHXQvGeICgKbLVTNHu/deBC22X0ysq34US/xSiOY7IsJX/zHFUdUBWSoBVzyemn951v6JgjyWoVRLVGVKmQZTaPLUN2F0l/jKvjAYIAAiUIA4UKA5wUpC4jswZhDWXjqcUppW1zrEgE8vZNfPoxz/DunIv2Eqo0wJ+CvW+muPF2f+br3+4//ca3EW3ZxlIEi8KAbHqS1tQE09u2MRyWqXiFSi2B1qAkPg9hy32U3pMJaCnFVKh4/D/9U/93XHG9P/dHP+agWpXIQ6AU5ShCCUkaJ1SiEpVyubN7r0Wjm6u++255+wGmWzjJkzUatCbGScfHWRREDKUWt2ELR1RHaN18K6e+4W1c+a6Pe9Zv8dyyXfT20UeLJ3/yv8W/fO6TbBursqmsWXrCccwJcGGJICohvCry+0VXI8TlwaK5sJDFFkFsRroirqNdL2bv6z4HIvI+WcTeSAfCd7JFvBc4qcmU5NBjju47Lr7gQq8daASh0kjnUYUarXeuMwnuLavg/RHK9Re2833ji0MHCiFEnsZuDcJZSGLqQnD178/vP9kRh4ujH/EIpk2GU2GR6tqNN/N0a+nsLRarLEkRziO1QqgiJReLtwaZZZQzz1BqqM3HmA1b0Fsn+Mx/vJvbvvGtveQOBvhjsVfNFnP/d4b/9htP4a5f/Y7jK0PUpucYVZJ4fobMG5YetIKh4WGUk5ipmLIL8E7gKCqdilwTA8AEkqwa8RfPfw6sWdqf6nra11hRKmGnJgnJX/YsSZmbmSWOY6SUxHGMc+4B8EvLvq2fzAiG63WGSxWWjY4xfdcGFpfKrCjXkNOzjDRSViaOK7/7Y776stcwefHVO/0G/YRHi5PPPUMc8cK/4orGJLOjw0zrgMnU4ESh/OckoYPQuk6GSnvFnASWRDtSlUeft1Mfldurus8BjXbsRjdjKHclOqCZGUwYsODwfsvG2quupiw1AZKhchVvHVjXlb63tuPX39783qtMO8B9Qyd9uPh/O16j11oahiFKC6Qkt08kCTrJGEZhJ2Zo/er3fU3wiKc+mVYQ0LAedISnm7bcddU+UHd473A2yzdneipWg1Sg8JSkZzSKWFwqU48z1lSHCcdn+PaHP8Y5//4ez5U37UV3M8Afwt4xW6y7w//6Tf/hv/3fHyddfxtLrEdOTLK4FGHmZ1kwNkxqUiZnZ5BaM9eICVWEFCGxsWQeJHlEs/B5FH5aCkmHazzkba/pt0FccLVff9kV2IkJhgONiVsID6EOKJVK1MoVhBDEcUytVusc1onb2K2mY9nDLPLpoVPsrXBktJoJ3nsac3MsX7iQ1tQMrtkkzCwV56nGCUu8pzo1zQ8+9v/4379/refGdTt9AR9+ylvEG794KpXjj2S8FjE3XGU21DQDSFU+0LUtKu1CXm1tjjzFre1WcoUA0d41cB2I6Kl4gZUdG1zXOhaEpN5DpQTLl/Ydu/nWO3DNBJOkhFqTZXmsUlvUq/Md/g+b+gfYNQjfLzvfazHMkjSPHVOSMNRoAYH3BJml6j3XnHNB37mCxzxC1FYsxQUhTWM6Y4nvc9d2+8eefn+DKERpnVcodi4nHYK8CKBweO9pNudpzs4wEoa4ySmWK81yq1h71u/52Sc+iz9757WlBti7sOfJxrmX+I+88MXcfs45LMVRyRJGowDTnM0zMrRifn6eKIpAKZqJRZWqZCokRmC0wElBtVyhOdPI4wpKEZtMi8e/6Lk7fN0vv/INgtl5hkNNpASRCvKJE4E3uQJnlmWUymVacfwAPICu2p5DFZvGF1VmUTovDR5EJKkhDEOklCgJEoP2CUHSYDhLWJ45Zi++ki//479yzYdO3fkL+MgHi7/6+qniKae8ga1Lh7k1SJCrl7Iha2IqIS6QJElCJYwwcYJWgmaziRB5Hr0xKViLj5uUtRqY2Pc0fB7E2Q0CzMlhW3Qu845MwvI1h8Hhi/qo8oYbb85lysMSzfkGpSBEhUFeU8fv2LCDbJTdj+3jYNo5IjkRyF1aQgiszciyLFcIRqCNoWI9l5792x3O+fAnPJZN87Poag0ryV0UuohtM7kFQUrZqQ67J+G9zy3I3iNFvmCUCCyeVHgSaaEUgBZ4LCXvKTUzlhrFwrmUycuu41sf+G/SH5w16I57OfZcb7thvT/z9W/zH3vla1gSGw4rV7BbtlJKE8rCEwWazCR5Oh9gpcCjsUJhpCKVGiM0BihVymzduo2R0QXoWp3bp6eoHbKSlY//876vNL+/2t98wcUskCHKOuJWo0cJ9E/D7p1ku+F3vUGYrqgwawuBsLz+hSxiSPL9S5EiFAYdtxhKM5Z7RbRxGxd943t89jHP8uPf33mtgYNe+Dfi5I+9j8e+8sWcedt1yNWL2Swyxk1CNFwnNpahkTHSxLB0yRLSJMEbSznQlALN0gULmNiy5T4/vwF2D9o+eCg0D2S/kqOTChFF1JYs6j/w+pt9Mj5FaLv6Kb3ojUvam3z8+yPa9Uq66amiqDHSbZe21Hg7HkcWaelRnLHpaz/oa51jHvMX1FcsY9pmGCExznUmdKGL+klC9FSF3XNox8JJiiyq9u8L8pwqSJUjU/kz0g7KxjGUWkZjw0LjiNffxf9+/FPc+t9f8Nxyx56/qQF2ij1CNjZ+4Zv+m//6Njb+9gLWhGVWByHTt95OKUlZuWAB8fw8SdJCRSFWSIwUWDRGSkyh5tkOfIoqZeZbTcqlOq3Msy1O8QtGeMEbXgtH9xdb+/L7Psxhw6MMC4VpJffpZev1Xe8eM2RbRnjHokjdYDHZRzyy9nOQ0EzmkcpTCiTKZVSdZUUQslqErGgafvbRT/HLV7zV87sdBcHkcUeJ4978evGBX3wXfdxh3B1a7NIxJoTn7ulpJmfmCIIyE5smUU5S0REhkrQxz9bNm1i2ZPGu3vwAu4C2OJJwXdEtB4U7Jf8585ZMChYdvLLvWLthE0Grhd4+QJHt5OkLtAlHe9v+7wPcN3SKHmz3LHPXlezUGslTm7vWJOVzIbeFYcQlZ/2m/+CTjhb1FcuYFQYb5H0DaxACpAQvRceisCexvYyAdHkcWK7l0x3rEp0r19oi7kQ7R2QdFeMZMoaDqxXE1nHOPO1rnPPJz8NVNwwIx14Ife+77EasXet/e+qXuOl3FxLNtTh4eAQZN5FpypCQVMKIZK6BSTNqtSGaSYIPdEEuKBLFC5Ehl0/O8zOz1OpVypWA8fk54lqF+qErEEf0KyWmPzvXR5MzzG/ZAmnMosUjZFmCS+777eweoqFo+1DbefA7iwvJf9fmhl17Qtu3boxBeksgI5QzpM0WzTSjPFxn/PIr+eQ1V/PY5/6Nf9ALnrNDbQyOO1E855Q3+Tt/fyG/+8b3CJxjpLIKhaQxN0dtbBHg2Hz3RsaGhlm8aBETm7cSp6189Bpgj0E5CQKcl3mBwDz8B8j7jBWCFMfyw/plyresX0ddKJTP+n7vRLdfb98NBQPXyW5FIcDmoBPMK73KyRz5yJBnfrm8vEF+UP7hJdo7WtsmmIjn4JobPCcc02myRzzl8Zy14W7S+RlCSxFAD/g88Nfgcc6jVPub9w60A2Z7ia/04GS7TES7pD0I4VACstY85SxlZGgBV/78lzSmJnn6P7/a82cnDejwXoQHbKaY/MEP/edf/QZu/vXvWJI51tTquMlJGlNTxHMNRmpDaBStuQZREFEKS1ib1xhxHUuGL9Q1DQqD9oaRahVpPRu2bCHWmvlKxF+/6mVw2KHdjnbzbf6rH/4wY94yqjUlpShHZaamZna4zh0KjxXoXdVtLz2+SxC2s+U1RzyivfkdLSlttAO+ymGVUATgBZm1JCbBkjI8VOawVUtYWomI5mZZ7uGsL5/Gaa99PcmPdyL/e+jh4qCXvVS89HOncvCTHsvVrTk2RprpUok5pZlNLatWH4aKStx+9wbKQzW8loPV7R5EW6NB+S4J7U2ddALQCl2pUDvkkL5jb7/uRsrG9VQY7T9u+yDQgRvl/kUxj/aUQRCdGimQk8Z8K9yqxSQ8VopYNTzGbRde2ne+ZScdz+bWLLEzGO/yeAgE1jsyZ/EelFIP7E3uBL3uulypttD7KSwc7bL1Hdl8JLZj4XbEaQObNllYLSGnZzisXKVxwy184fVvIf7uPQgfDrBHcP+Tjcuu879/w9v9t9/9UfTdmzm8Osywtcxv3kRVCVYtW04Ylmg1E5LMUBtegNIlJqfmqJRrhQZErv2gvENhkT6fmJW3+CShOTfP6MKlqKFhqqsPJnzGU/qmwE0XXoKanCLdso1Fw8OYLGPz5s2MjIzeZ07fs4C872gL7AiDJN8QJidT3hTZHq6P4PS7cCRTUzOYzFOt1hkbW0ipFBI3G0xNbGF620ZmNt7JaCCoNOc5emwMuWkrn3jz2zjn5Dd6zr98x5fx8NXizz/8XnHKD75La8lCNkvPODBrHVtn57BKUa7XaGQJPlCDle4eRte3L3YQmfNAaiz1BaNwdL81a+ttdxDZbqp4L3pJx/aEQ2y33wD3He3sk509xzaRzEleO2ZL4qTM3aqF+JqZm8fPzfGbn/ys/wQPPVo87HF/QSY8DpvHa7TF+bwHKVHBA2vY/mPQHueUa6sY56RDFmn2TnSLQ2YKfCQIIgi8ZTTQlGab1GaaDM0lfPPD/8O17/2EZ+1A5nxvwP1HNq5Y6+Pvn+F/9M4Pctsvz2HRXMqR5VGad2xgWCnGhmpEUcjGjRtRMiAo18hUQCIFiRQYpTAetJWEFkoGSsYR2HwiRmQgDLUwRCGZnW/QBJ735jf2X8dNN/mff/NblDPDWDliZmIby5cvRcmAZiOmrW3xx/qg2yRjd630utVT29aMdtJru0bKjltvldnRscUYFOMTM0xMTCGcYOHYKEtGxxguRSxfNEo2M0VNOczkNqLmPMctXsjGyy7nS2/9d677xGk7v5PjjxCv+Ol3xMve/Q42C0erUmZo+XImG01UtUJpZITx2emBZWMPoh1Q1y4rjxdF4mu3L2fesXzVyh2ObU1Noazdzlo2UAZ94JFXSu0rgMjOLJnFGEUeu9Buo5FqFZ1mzG3ZukOF1Ic99i9QpRCk7Aq0CdGJ2fB7U0MXcRqiXfHW59W3QyMIjUC53NLjya0aiZa0AjDaM92cBm8ws7OMKc2yoMRQI2NhJjn3hz/jR//zKWYvGlSP3dO4X8hGdtb5/ryvfIMvveM9mNvuYjjOWLNgMXZmnnpYImvF4DxzM7MsHl2AMY7Zxjw6inLlzzSlVK6gEH0TbG4FKNQoiq4zPjuLHqoSLBpj+NCD4GHH9L1BV59xFnbTNurGUjaWWqnM5s2bCcMSUVTeydX/cXhgJ9n+1WfXqiKZm5tH6oChoSHCMCRJEubm5mk0GiRxjC/u2TVjQmMZkRI1M08wM099tsG5X/02X/3rl/vWLy/c6cs49Lyni7dc83txzF8/jatmt+KWLGCbzbh9aoLawoWFYmVR/IverbsK7ndNycL/vGMtCHEPW99+228HNCTCicLi5RDYXJugsEgYqVD1IZYc0h+v0br8Cp82WmRJ2vf7PzXDapD2vDsgCrLYRpd8dH5dWK/a+hu9C500TTFxi0Uy4vrf92tuVI87Cl+rQBjhkQinkFKjUDjn8pi1vYhv7AztRVjbqtu+Xlv08ThOWbJwGbaoZ1WOIuYmpqhJRc14FljPjb/9PT/+5OeZ/u35gx67ByF2d/rT1s9+zZ/xpa+zwAvc1CwlKYsJw3dNZN4R2m5QpJHtDAugKP6kne+UR05cglWCsBTgXB6FXZEl5potGqEiGa6zVUpO/swn4JHH970+n3r44/2q2YxFTUPJ2ly8SkAmZRGQuYeFqXYyYXYH8R254I6X2t6nO2FvT07ag1Zutu1WlrRCQVBiPI6JS5rDHvUIHvfaV8FQFdas2mEYSi641P/0c19m01XXsKpUh+kp6hi0Nfg0f471co2ZmRmq9SGc96TOQ6DwSFJr8CYvdqelAuFxLkXiisj7/loR7UmzW8q+e1+9KYEHqmx6vvrL0xhjlZLKBEuGkwJURFNFbNMVTv7Ex+DxJ3bac/1Xv+Mv+9QXGJlpEjqHcjsnz73vRWfeu5/v6UBDtzaS7A/M9bIzNmyftdHe3wvIlCDxIIIS2bJFPPs3/9u352X/8V5/zXd/xvH1UZobtqKEQJcimt7gpUD1LNz2Juxwu74rTNb7LNRO4udc8WyMFKRSwvAQd8xMYseG+NvX/zOjj3wIHH7QXk6z9j/s1lH6q8/9e3/Gl75OZXoWu2kLi7QmsnmpdOgNPNt+ddtfrVLg89z/Ii00jCLCasTU3CyNVovEGFqtBKEC5FCdbc7w0Gc8eQei8YtT3u3rqadsHIHzfT7Q9tJB7umJqjAf9m5tJVEPO2w7or+wUr6f7Nva5+3Ev1gILZSNJWjOsUwLVgrJ+KVX8KWT/4W7zvwdrL17h6+L/vxh4vlf/5z4m38+mYlSwHQY0CpXmDIZemiIqFplenaGpYsX02o0SZMEhMN6Q4bJZeV1rk6phCjG0nsLMu3RyNyZb3svHCgfSKSJIbUGish8LfMn5p3ASI2vVWF4qO+YbbfdQRb3p2HdWwD0Pfe/AXYF7fTl/lLzhe4G3We+Y/vk7731jrIO0Y0Uu3WS9Nfn9jXTkY98BLZSZnI+QQYRYamcx28oiQ72XpK+w9jXsyjrxnVIlFMIn4shWiFJlcSo/NloZ3Fzc5Tm5zm0UiXaOsl3PvZxbvvJz+GmWwfd+QHGbuttJ5/wCJ9OTNHcOs7Cao0F9TpJs9EJSuoSiRxO5JaMtCi+09mnmAw7uf/4fDAtMDIyQq1WQyqFKpeYjlP0SJ2HPPdZfdcz/dtz/aZrbiQyuQumWxVzgDaccLgAMlKaMxNU4pRw0yTnfP5rfPdf3w6/3Hl1xdUn/4N45ec+wYrH/wW3JhnhisO4Y6ZJQ0SU6mNs3jZFEARU6xVQHicsxqd4afO6BwKU9UjTXql0NURsT/aR3W7zRTTL9vVkDlQ4QAQCqQWdB+sE3pJvXjC0cAxOOrSPpt15y3qEdX2S5APsexAepDGEIicfWavFFWf/rm+f+jOeIkYOWslMmmC1JlOQ+Pw9dMbumQvfXRCucDnlWy5oZ8jd7blVfNHoEFljHjM7y9GrVlGKY3745dM442Mfh4t2EiA/wP2G3TZSH7poCW6myUELF9GYnMYmaV6psDB/d3zwRfNakRONPIWpuBhfmMWKc3pAhgGZNbmEeKkCCKamZ2lkGVNJjKtWeOKznw0nHtVvPvzFWTRuvaNI7/O4Ql2xbbY8cKeoLrwArz0Iy4JaBTE3y8FRiYNFQHTHZr7w5n/nrNec4rnqlh1fymPWiKd86sPi9R//H5pLlzIzNMQGY5gPQ0wpJBOCuUaj4zbTgCaPv/EmwxmDc5Y2YejNfugqpebCZa74OXcB6cJSoxm0IgRhCELkEuOFQJf2Iq/eqhSLVy7vP2DdXX787g1oQW5dGgy3+yykz+uk+Cwh0JJyEHLzRZfBujv7WvXoRz0CUwrIpKRlM4ywSC1I0weiHMP9h3yscNhibO8UIhQWyOUE5qYmWTw8jG002bD2ZpaUyywNQ679zW/58nvfx+Qvz/LmppsHb8EDgN02Wi+q1gmTjKqDKoqSVrTiRufvyhXpTL4/fckUHo020WhLJ7cnH+PzFZhCUQkjGo0W83FCNDJEViljhusc/MZX9RGN5tnn+tvOv5B6I6VkDdKbolPurrvdf5DFLUINpVAxHGgWBJrm7Xcw0miyPLVs/N2FfONNp3DbqV/f6Qsp//JR4vk//JJ43jvfTmPpQu6wCUm9hi1HeTxFaggyR8V6Sk4grMHZjEzaPHVWUMRcdLeONLsEj8CJfMtJRpF5gThgYzV6YVxGbPPNek8oAkoyRAuNF5KVR/aL27F5C+nsLBESm+zbk82BDoEj8LmipreGSHjExDzNy67t2+/Yx/0FbniIhoRMKdCqU1l1bxL0ui9oE452TSAnfEE4cot2GGji5hwHL1nE6oULqKQGPT3HSl2ivHmKb73zv5i66PI9fRsHBHbbaL1y8WKUc/hWik8TsiRl6dKlna4scB0yIX0+keSr1v7zdKWTc3KQ2bwKJcYhnUCgGFm8hLQUMqM8D37ak3a4ltO//k2iuSZHLFxAyVgCn8vB9EZ435NM8IEE4aFermBbCeNbtuK9o9GcYWyowrLhOqVGg8UWKuPT/PgTn+Wrf/N3nvN2nkK25MV/Kf7pc5/k+Gc+nbuVY5sSNAJNLCXO5w2tXN7+uc8YZCA7cTRtItpu/64Pu/frxHafHNCEoyvA5RFSonWQC7xZT5pkzKcxhx53dN8xm9bfTtkLSlJiM3MPZx5gn4HzhFKQZi1cHLMwLHHB6b/u20U88iRRO2g5c8IiSgHOOazJCJTa522DbidlHvLfA8IRRQGNmWnmJ6eY3rIZOz3NoihiVW0Iu3ELh7iAb//nhzjzNW8YWDfuZ+y2vrZ06VJKWtGcnWG4VkUFki3jW/HSdSwXwrv+3HH6haoAnPTYwvLhZF76XXtJaAU2NljrsUHAuvFtRAct5/i3vbavq237v5/6u666llpmsDOzhM6gXVvQxnd0CPamFPM9BeWhuW2GRdVRAh3RwiJGKjQix4133szQWBXVnGc0TjlMldC3beDzb/kPznjDv+/8xTxutXjkR94pXv6x9+OPWs2WWolWvU4clrAiQHiFRBVKhh7vLco7Ale4Wtx2miIu97tK75G+CBUTg1DFLhxSS6RWyCDPSnHGYVNwaEQpInzCn/f19PXX30jZSUKhUGKgDLqvQwgwzhAogXKW0DjuvPYGuPKmvpY96lGPpBlpnFR4a3HGovYLH1p3Csv7suj8ziFxzlGv1wmCgJFqnaGwjE4sbnqOQ4fHqI7PclxphK2XXsMnn/wM76+9Zn94KHsldhvZqI+OoMOQqFwiMRk6DBAyz6jo01HoIRaQTzLdYNA8lsOogmwgMZkDY6mGFUIRkHlPFoSkw1We+apX7HAdp3/tmxxUraPTlMCbTgqtct087QHRyCG9ZNHQQuYmZhkaGsZpxcbpSUxJU1s0zGxjilIAdQ/luXkWJ5ax+ZhbzzqHzz3ur/xNn925IFj0pEeLF33kfTz+n17JxMJRpup1pqKIRhBgdIiT7Tz/rBMU3OtG065f0Ex609Xv6Che5l/tD3CtjcxlOGy+WrUeYxxCaaJ6nZFFS3fYf/OttxFkBmktetc1cAfYg8hjriStNKFSqRBpTXN6GpWkbLn2pr59j3rso7C1MgaBRBEqvV/E67QL1rUlzaVvi9vl7tg0s2Qe4jRBak0ax4SAj1Notqg7KCcZ0WyDytQ8n3jzO7jzxwOZ8/sDu41sRCN1Wt7k+duBopHEEKgd64vQVj10xcQCgct/Z4vslFR2VfK0lLjUkczHlKs1YueYxXLQQx9E5Vn9suQz3/qRn19/F1GzRT0KyLI0j0pup0kVLMP1RDHv6z7LXYVLPKGqksQWr0JktULDZSQKbJjntpukyZCEWpww2mqx0nhGx6c574un8Y2/eb7nvJ2I5aw5RBz6mpeJl336Y5Qf9XDuqpfZVq8yF4XYKCKISrg0wxdZEdIWtWBsLtMeCFDO9lk72uqq7WjzA13UywlACpxwaCHBOnRQxnhJw1iWHnrIDsdsvv12ygjSZoNIBwO6sQ/DAU5LgnKJ+flZbJpRr5ephAHn/uz0/p0ffKRYfeIJTM83qNeGyJIM4faHAGHZqSEjvC4CxzUU6bBojZcSGYYk1iHDCIdA6zyw2oWCNGsyIhWLM6jePcHpH/oU1/znJzw33rXPP529CbsvQHT1SmaylNLoEPNpWsjk7nwoaxMN5XuDRl1RpTJ3n7StD0rkOejlWpVNExMEo8PMSMeTX/SC/pPecIf/9idOZbFXtDaPY02KjsJi/St3EIsaTFbQDbRUgCp0OIoXt7NPTsgEBu0MZWOpZ5bhJGNhK0HfeQefes1r+e0b/sWzdielnY87XPz1pz8g/v6//oNtQxW2RYrN3jCLJxodw5ciZuMmhCHGWXQYEoYhLssQ3heaK74oUtdDNA5wktiGMSnee6QoUl4ROK2JlWDlEWv69nWXXuVlK6GiQ0o6xNiUwXPct5EZi8FRKpWoVEokcZPprVtIto3D5Wv73sdHPf2p6GqF6fkGmXUote+nPgufK7BKL3LyBIWVIw+QtkIXqfO6UB3tBqA7IYmdIfMO0pRyYlgcO2qbZ1j3y99w9vv/G9ZuGBCO3YTdRjaCeh01XGOy0SCs1Zibb6KE6viEXZtItF0qHqTrV+/0BeFwoutuMcYQlCvMmwxXKbEliTnqzx9O5amP62Mys5dcTr2RUTeeJfUhhmpVpuani44GHtXJethZFdUDEQ5IC+VW4SWBEZQzSSWVRCaPkwHRzRzqiOUYSsZQy1IWJCkHC8Xm8y/ma697E7d+6as7fapDT3+MeP05PxWPfNkLmVpQY3OkuMM0mQsktlYh1oKWlrS8Ycv0JEIrgiCgTS6kdz2VcNtk40CfKB0Oi8KjhcRbsAgyFTCL46AT+oND1197PdoXbkXhkQO7xj4OidABmXVYa3HO4DGUA4mdnOLWs8/p23v4mKNISgG+XCpW+IXo336Adml65XLS0c5ay4vW7VyzxwqgFCDLIVJKQutZoDQrZEi4cYLN51/Ct171OjjvqgN8ptg92H097eEPFrOtGF2pMB+30FrjbaGv4fLYjXb2iRe5OVz1Eg26U0c7a0F5cM4hooApm2KGq9iRKo9/zrP7v/uaG/1PvvJ1olaCbLUIrWN2cpqxBYuwMpettSIvTdyGaJvlD+Bu5EVOIHKZ+Lw9AguRycmGtrmWhRd58SMj22qfrpCc9+g0Q883iCbn4fZN/PrUL/Gzl7/ec8PtO32yR73hZPHPp36cFY96OI0Fo9xlM1r1CjOBYl5LmkpRXrCQaGiYRpJ0FVCRB3Rb3ROUUgghUD6X+XdS0ZKehgRWrujb9+6bb6EsA0wSkyVpQeYG2JchnEALjXGQmBiFZ9noCGGWccmvz+7fec0KsfJBx8PoMEYHuP0geM33BIwL7zukQ/j82eT7yCITsb/opheQZBbn88J0JkvwSUrZOxYqyVKpERu38T+v+We2fP+ng9FnF7FbaW25PoQVEqUDNJpQBCgnkXQtG1a6jmIouJ70vfxitMultANbxHOEJWZtQlIPuTub41HPegY89hF9b8mlP/gJzU2bqSrBkqFh0sY8GkGr0cQIRSo1iZIYkX9xJ/CQA9uVkgudWazK8EWBO+3y566tLOSAcz/o9quD/MUVVKrDuEywfGghy0WFhVMt3NU389GnPZtb3vdpz9Vrd3xJH3KC+MvPf0I875S3MPLg41jbnGWDsMxWykxrxRyea9ffSml4FCsUXvSWd4M2AdpfVmW7ApFrk6OMQwmFVYqWgGDhCBzZX99my+13oPFgHc45dnddpAEeWEgPWdOgCQlLEVprXJog0pgwTWlu3QLn9KeqP/75z2KTbTHnbc/iYV9GIeSFL8Zyj/C561V2LKHdvbv8Kk8akMbl453WyDDAKEcza5KlDQKbMuo9h1WG+cJ/vp/fffjjgxdmF7BbR+uDVh/C7HyTcrlKFmdoBNr1iHQVgZ+FSDXQJiA9MRrt1bXNLRwWTyIFk6TIJWM86OlP6f/Sq9f5K395NsuHhzFJzNTkOMrB4pExSirECkmmJKkSGCmKGiG5dJQ44FMoHV4YrDS49qds560Xmq8+rz0gvUI4RUEJCxOsZnKqwejIYiY2TqAbKUfUFjA8Pc/KxHLZd7/Pl1/3r9z+2a/s9EEveOZTxQv/69285K1vYr5WJa6XCZYsYgbPQccew3hjvkNudpAoP4D1NXrhvc9N6JlBC4khLz510FFH9u+4/i4/tWkrPjOEUYDWkjRNd37SAfYJCC+pBWWkJc/sUgrtPL7RJLCGmpQ7WDf00x4t5ssRolojsW0F330XrhDz8jKXKZeYoqhBO20ewHXcr6L4f7t0RlWX0F6Bc7mFMJDIEIR2SGFRLiWenmRBucKNl1+5+2/g2us9Z53j+c253p17oXeXX+Vb117rp2+4cb+bnHZrhNBQfZhWrc78zCzDQYhP8+JQ7XmhqLvVSXeEbtaJL+I0tIWwWF1bAS1ryMohDSV43DOeDCf2F1s759QvUppvIcIQIQUjIyOoJGHjrXcSDg/hyyVSmceOeEA72/lZFte037XqnwJhQYBTHudFJ35DuLyqaLt4W1tSHFwReyPwQhKVylijWTC8kKzZIJ2bJ57YylGrVzHlEhpxzE8/81mGzz7L/8Mpp8BDT+hfSx15kFhx5EG89ZGP8P/3kf/mzquvZaRUYuP0FMOlMsYatNt+SOz934FrmQIQoli9OY/WAcY6jJYc8eDj+3fcso20MQ/OonTuo3YmRewHQYIHKiRQkhrjHbPGIEJBWSsECocjsSnXXHIJD7/lbs/hKzvv3fFPeDRTv/w9ZmaeULLPDoA5ychHcOdF7pYXXUuGKsZ5getKMHg6JER4ibcO72xeKFK2UEoQaAVCYoRDlSJacRMrS7zyZS+912v6+tv/wzc3jTOqAhZGNWScEk9PMz2+jdnpKYwxKC0JwpCS1KhWgrcWUa2wLWky4SymXubYR/0Zf/vf77//Ht4ewG6ltavWHEKcJlTLFYwxaN2t7tr2peVpSvn+bT+aF7JITwWJ66iHGglehzSB0oplnPDk7dRCL7nB33nFVQwZRzo9Ra1SYb7RYLbZZNGiRZTL5UKhsqMX2vneAXKInoqT3aq8dDODetxM7XYTPf8XBlySMT83RxSFWJuxfOkSsrkZsslJzOYtrKnUMbfeyQdeeTLnvfejnnU7ifA+drV47rvexr989IPEozXSkSHmSgGNICBWAalSRV8COk4Vt5MQx24hN1fE6VjZ9dXmF949fl+H1hqlRR5UrWReRwjHstUH9e3X3LSVSgYVqcE6jLOIUA/ehX0czWYTHQREUR5/Y51DaUGIRMcpdnyaZN1tfcc86q+eymSa4MMSVoi+96Jvg54Yh+47BR27516J/sGleMc7Wk/bvfNSUK6UqFfKhDpAKoGUEounlRlmk4xoeJQjH3Ii5SMOv9fv/vu/fTEz49uYumMD1/zmt9x16WXM3nATpU0TrEw8a3zIYZlmxWzG6Pg8CxsZQ3Mxo7MxyzPJGl1hqdUEzeRev2tfw24lGyaCzCY0mnOE5RArIZN5Ua3AKqJMdWIB6Kng6TNPyUM1VCQuJlYZE65JVivR8BIX1XjE0/4ajn9QX/8++3NfpNpoUHOWERXikwQvFUQR884Sm1ynIbI+L3Xvc9383DSf52EfyH5/6SXCKaQNkDZvG21lJ/NDYvHCYmXW2ZzIfyfxKG8JXIpyKWFJE7uUWMO0SUmEoFKqMuwj5OYpFs0lHJparv/f/+V7b3w9Gz/7hR0Jx2GrBE/+c/HqL3+GE5//bLZWKszXh5mUihljsUqiI433CTabpxyBxJClKUP1OmlqaLRiSuUKcWZxKsAIkW9S4mSbPLk+U+u+jPn5eYSUOC1JhUVKgXEZQ095dN+7svm6WxhLJWHLYNMMXwpItdzH7/7AhhVAWdMwTYQQ4Aw2gMSmaDxDRrIg8/zu+z/sOy586INFdcUK5qUgQyCUxAlHYhJUKDE+QwYSiy1i6iRG5m5oXyh0bl/Fe08gH7+KMcx3M096K0a3izjmdZVkT+prXuTRK0Fs8jkrClVHwl+KgCiqg6zSIuIpL38VrDm473Y//OKXeXPdur5xTJxwtHjbxz/CdDxHdbRKpSyJG5MsGioRiYy0OUXWnGUkDBCNRsfdVcpS6q2UsdhSmW+hzT5qbvoD2L2WjSMOozoyRFgKMS4jSdNu8KfvqkRC1/idZRmjo6M05udJ0zR3uYSa0SVL2Dg9jRwZZl4HPOhfXt3fr888z99+2eWUjSG0hdR1biXrSW/Kv1O79t8LywbdfOsDHbJwlXS3dlt100vb1RQ7VRWL3+f1brr6F1bm6q+2IJggGSpVGBEhC5xiiVOMtVLmblrLr796Gt9+/nM8116541t1+MHi+Le9Vrz2o++ndORq5KqlNEoRDaWYy1KsEJRrVSYnJ7Heo5Rgw8aNjI6OUq/XGR8fZ2xsDJOmnRVYb90VOnew71u5yuUySIHB5/o0WrJk6Y7KodvuuJswcZSFzmM7nMUU9YIG2FfhOjFvosdqa2XuptbOE8WWTTfdssORj3zKk7DlMpkQpCajVCmjtaY13yDUEikF1ncD+PfWqa89bvWTCfq2naH9t1bSxLqMWq1CmqZEUYTzsGFikjnA1oc48UlPhIcf2/emnPWu93pz2118+PVvgou30xc6/FBxysc/SiMQTKUxS5ct5847bydpzLO4PkRVSbZtuJtlSxYiMChvCJwjspZKli+O5V77xO87dutsW128mDhN87xvL1BK5V/i73lQ11oyPTtFOFTDRRrnPIEMmJuZp1Srsyme59mvftkOx33v1M9TSg7s1NW9Ab3ZRO027m3r+bk5mo0GabOFsp6F5TpLKsOEiaW1fiMf+4fXccm7PrTTVhSPfrB47jdPFY992d9SO3oNW7GY6hCyOsx8y1EfXYTXkpElY5RqIRPT29CBYKRWIZ6epgSUjadsPJHNo87bZLc9KO/rkAiMMbn8u3cYPAdvJ+YFcNu6W8BZtJZI4XHGIgbZKPsV2pkX+So//51JEzCW27/7k77GPuRhJ9IMQFZLpMZgrSVUGmsMSuQ1RYT0XTmCws3d/g5XuFj39R4UaImWCu89SZLgnENFJerLl8DiUTaVPCd9+N/6Z69r1vprfn4WS1LPKmP5xBvfCNfe0v8oHvYg8caPfxw3uoiJzLNw+UGMjiwimW4gU8PYgiHGZ7d1sjPb46frcV/tb9i9w+3xx4i5ZovEGYSSKNWfx++F7zfbCoeWgmbcgLLCBhJEXqxrthlDpUrlkJUs+ccX9D366e//1E/dsp7F1UqfVscADyw8/TEeO5PZGhkZYWx4hHpURiYGO9dENVNKiaPWchzqSqz9ya847fHP9nd+6ds7bc1lf/8c8ZwPvoc/e9FzuRvDRmOYDyIaQuHDkDs3bsDi0YEkaTUQ1oBNGCqHSG86tVW6sTs9GS37eFZLlmV5Rd0gxHhIBBx6TL+Yl732ej85MZGb2gtsXwBxgH0PToCXbY2JvCRDb0wcQKQDKkJy3hm/6j940SiLjzwUW9JYpZidnUd4qEVlXJph0yyvbVV0GeFBFSmldKycD9CN3o9wziFU/h6NjIzirKCRGJpKcd34Jv7qtS/f4ZhffPSTLCNgtJVi77yLw0sl/utFfws3rO9/mx5ynDj5gx9gXCkaUrNpfBIRhIyOjdFMWiglOwTDC9chGE7sbCTd97HbR9ryUA0VRgipSUxW/LY/56OtqSE9OJMyNjbC5OwMjSRF6xBjoTqygElneOor/q7/C9be4X992rdZM7yA1uZteecfYI+hQzh6rBq97onZ2VmSVgyZRRpHmHkqTjLsNGNWMRo7hucShifmOeuzp3HOG/7Dc+lOKi8evVoc+59vESd/7lMc9pQnsDnSTIcRG+fmGFm8GBVG4CWVMEAKT6AkjcZc/hJLhxWuk2LdnmTVPk40CrF5Qh0QhiGpdaRSsGjNYX37TW3ekmehKIEzKVhHIIJBIbb9APmL4nKSQbv8Q5cklAJNY3KSDdffCOvu7L5Xa1aJP/ubv2RLqwHlCGstGE8lLOES2/MN+USYlw3ILRzSd4tm7tMrcOHwGjIsqTUIFN4LEg8TWcbKkx7EIS9+bv8d/uQ3/u7/z955h0lWVWv/t8MJlTpPYoY8RBFBvZgjJlT0KqbrNXvNn1mvAcPFfM2YcxYDZswBFVRAQTIShjgMkzpWOnHv/f1xqrqruhv0wjRDD/0+z6GZqpPqnB3WXutd7zrrXErTTVYjWafAG9/G4aUqX3/tfy+8xr3vIl7x8Y/SLlcorVrDjM3Y0Zgmt4ZKpTJv5z1b92mXj7YDq8ZwSuOk6BMN6o/5z13e04osTdBagxDkSJq5Zco5Djjmnqx64qP7ZcnP/Avx9VtIdu4kFHTSMldwR0I3ldkBfhDgeR5aa0LlUdY+JRQqLrwc8fg4w0JSarRYFef842e/5eSXvoaLT/68Y9MiKqT3O0rc66X/xdNPegsTwxXSsVE2t1pkpRLWD2gnhtAvgbUFB0g4jHCdSsKdGLdglp+ynMdKAE8WCqLGWWJnyAMFa0b79rnuiisoBR5SFSs5ZyyeKrRT5DI3uFZQoPBsiE5Bsu6nliRqMRQEhK2EK37W791YffThRL7CaE15YJA8s0jjwDq0Kiozd42JWU/YPG7IcoYFRKBJXQZSMF1vIGRRmVqNjfDUF71gwTFfe98HOWRkNSNaYxp1hpUknxhHTU2TXLeFrz75eY6rtvWPW/c5XPznm1+H27CaaS2xtSqlgSFu2rptdhcxy5UrRCdXPBv/AkbWrCUFcmPRXTnkHrfQ7Cq40yk8qYibDQbCMp70sFIRa027WuKBT33igvP/5AtfpRQliDRhZHCAPfGlLCcsRr6EzspHQmwy2llCK46IsxSbFzonJeUxEASMjQxi0haDSlCLYvY1ig31jL9+/pt8+cWvZ/y7P1/Uy1F78iPFi844TdzzmU/lapOzzQnUqlVMtGKmG208XaJWrmERGCnIpSNTjlx1PB3S7hExZyUkeZISpzkiCAhGR2BosG+ff/z9fDzhwBqEKITACu/Ocv/1K+hiLixWFCbrhgddljJcLjMiPc744Wn9B208UNzlPvdk2mToShmLm+VuwJzXQsySwe0sb6O7mFjOoRQnoJ1F5Dh830drHxeUaBjDIf92T8INe/Xtf92nv+b8OKU9vpPx7VspBZosiamFIXsNDrNa+IgrNvPjd3xw4cUecz/xmPe8iWTdCJujNnUUI3vt0yHSFyjG0jkP0p6GXW5srFq/HrRHah0GQa8xYOd5NqSDJG4zNjhMXG9iUoMKK6SVEqvvfjjq4ffpa8oXv+ejrtROGAsCBqplJhtTy9uNt4dAMFcIqYuud0MFPqoU4FVKqNAnw5IkCVmWIbDkJsbzwaRNfGsYwDKUpqxNoHTjDr7/zg/zi+e/1nHOJYt2vyP+/bG87QffpXbkXThv602U99sXUxugaS2RcTh0Z+AtbsjSI52/B7QdKWVBEMURDgxQW7cGDtqr75dtvfoaRJbhbI5WxVfdstwr2FPQrR/U/06rlTL17TsYFBLdbMHfLu7rR8c87Fgm05hYQCYlQii01hhjUGruXF1jRjrmFo97gMtfaR/tBWSpAa1pYonLPg987jPgwJ5U139c7U4/9fuoJEVaw7p1a4q5Ryps7khmmripOutVwJaz/sq3n/nqhePVUXcRz//YB8jWjtEMS9w00yIXejYrsvBsiE5tsOX/bOdj14dRxsZIrMVK1fPpYmXBO2JfKNIkQaWOalAm8zQ7bM7xr3rJgnP/+Xs/omoga7eJshhWRIl2K7pejdmc+0XSSzNniG1ObHNSLFZLnKewqkjXNCbF2hSnHalMSUWCFDnlPGUsNezbzMnPuphP/MeLmPr8qY4rrunvxAfuKzjqUHHCNz8tnvq2E7nBE8zUKsQDQzSlIu1YFy42BEjIDVJKMnIyZ5a9sZplGdLTaD9gol7n7g+4b/8O51/odJxR9iRZ0kZKiVIF+z7P891z0yvYdVh0wpez39k8QzvDgBD47ZjLf9EfShl4/GPE4N4bmIhiROBTTxKsEGRZhpayr2/f/PWWL7IopuyHpGlOrhRJOeTBT30S3PWgvpHh/O/9iHjbDgJnCHyPdtIic5ZEKHI02ghWV2vkU9OM5jnq8iv53lOev9DguPuR4oUffj/tkVHiyiCJUlipkMqj3Y6LEKfWeyQ9YAmMjVFSUbDjrZurwGeFwwk3y2IuGq/E8zxM7hgeGqWV5Fw3NcF9H38c3GVj38s+783vcm7HNF6WUw5LOC2xapnPFHsQut4N1WN0uB4PQsGZmPt3IVNvZ71dubRFBVplcCJHuYxSnlONE1anlv2t4icf/DinvOkkGr8/c1Evx97PfaJ44Wc/zt7H3p/L0ybtVYMwNoYtVWi1U4TTjA6MML1zinIQ7hEl1p0AoTUGQe5pquvW9H2/7fJN+FGKj0ArQZLFpHmCtVAK5xPUVrC80a0dNBcCsTZnsFImrzfQUcLFfzoLrt7c7914+MOIfEXTQXV4hByBFIo8zft6SEH+lnPXmpf5stwgHIxUB2lONRBeAOUKEwoOfcJj+ne88jr386+dwn6DI2StFsIZbG5wDjy/hEOTZAYyQ0nCoLX44xPEV17J15/xdMeV80rU/9uR4t9f+hKSkWGa2iPWiggYWr260IjKHVLueWUEdj1nY6+9SJxDKA9rF5pncyvJ4n+EUkRZRmwdmacprV/DPZ/0+P6D/vZ39/df/IY12sdzjjxPSdJ02ccM9zR0V0Dz4429RoeVxdYlmPVuXYMjVY5c5ViZUSlrWhPb2VCtsn9QZvqcC/jx/7yfn77olY5Lr1o41B25vzjm/W8Wr/r+l5nZZxVnjW+hXikxuH5vcgM7Nu9g47p9sY2EAS9c9rFR4wQoSewMIvAY3Ldfpnz8uhuoOoFMU7QApQR+qdBWyLLsZs66guWC7mRvu8qYPQYHWHKTIoXBxzHke0xetxmuuqbvHEce+xDqEiJfMZMnJLnB98MOgbinkGZP1tli/Xy5QTpJUo/wREB1dBX/2LGV41/4HDhs/75Z5Ucf+CAbqgPMbNlCLQhRncQED43MJDhFpgQJllAIBrSkhMFv1okvvIwfvfsDsKW/+vXYCQ8Wj3jBs5gKFTNa0vIkO9ptjPKQfoDvh7frs7g9sMuNDTW2itQ6rBBzpxcOKIh50BNMcYLMOKzWtLVkAsODn/pEOLLfhfWHb55KOcoYK5cQOLIswxnAimVtWe9p6CWLdj0cveimxXb/v1D80z28irnmaKTDSEs7a+GVNFPjW7HTk6yXPqPTbabPOJcvPOdlXPzBLzguu2FhK7jrIeJ5P/iGePnJ/8uNKme7dkwiGNmwgXqc4Jyi3Y6X6lHcLrCAcUXIMjWWoFaDu/X3nW1XXU3ZgcgylBQIAdr3MM5inGO5V/1cQQEje4pa9nzu+x5Rs0nJ05SkYtgL+Nvvft9/8L2PEtW99kIODbK91cAGBVlSuUKJVLheGfBCfVlZibQse1FFJQMikzMjHfvd6+7s/YKn9/WfLd/9gbv+3Auo5ZbhICBQklajSbU6gMsdJjNo6eH7IU5AmiUIZyhrySrPZ3+/wvj5l/D1N7x1wbX3f9ZjxXPf9N/ckEUktQppOaAtIRGOrTvHb7dncHth1480d91fSN8nsw6hek9v53kiisklc2DLZeJamXzNEPs9+ti+07nT/+QuOv2PDCpF2m6TZQm+71PWPp5bMTZ2J7oaG728h/kGR29YpfdddcNo3RL22ir8vFM/p8N4t9KRhxJqmsy3DIwOsLZaxZuYYX3bsk8947JvfZ9vvf6N8Pu/uvnuYYChJxwnXn7Ob8VhTziOG0uSm6Rj3BoiIagNjyx7yfoi8UCQIxhbv37B99ddcjkqTvGhCKPkGVGS4KTAD/e81dOdCb1cisJ7OFe7pPMpfuhhhCFLY+J6nTKCi848e4EA1T0f+iAa0uHCMrpUIsstLnedys+93sni3GoP0KmxQmJ9DUOD3GAijvuvZy7Y5/RTvsc+5SpmZprAOTxXjBhRFBXFD4UgUBJNkeXVshmtPMVlOToxpNN1hnNFdOEmfvui/+e4sv+5V590nPh/73sHm21Mq+wTh5pIQHleRtmegCVpLYMjo+TGIOjKlfdX3uuD0rScYauJeeBTnwAb9+mzLH/1je8QtBICIcAZnHNoIQmdJrBq2VvWyx2z/IuezwRz8sayIxHe9Vt0V0uqs2mj0bmPNhrPaLSVaCtQncyRKE9o5wlOw7YdW5me3EnF8yg5RymNKc9M4a65ls+9+jX8/oMfgUuvXLRFHPXW14pXf/OLbKsq6qNV2sM1trQa5Mt7vEQoVbi3teTAgw/u//KCKxxRSklIhDEIa1Ba4KRFaY8kS5c9QfbOjtkwB2JBqAMgSRLC0MeYHC0kMrNkUw0mL+uvl3LUQx7EjmYDKiWSDnnYU3pWi6a3JIFlrkr3cm4+VkDTGsat4dBj70/w6GP7fs41n/maSzdvJbpxG/uvWk1rYhKTpAwNDRFlOUbIIpXc5LgsQ+DwgwAVeDjnyJIUmRiqRrK/P8im0//Crz78iQXS5rUnHi9e/Pa3cHV9gsjzyH0PWd7zFgJLMtSuW7d+VtBrgf6CKIo/yc7KNnOOREmGDtmXjS97ft/Lnvz+z9xlfzmbVWGItBY/DBBCkGcZMjV4ZvnHDZczuoNPd5CD/uyUrmeja3TMGhmdzz0jCXJVbJlCG4U2GmV1Zz9BJQjxlKZUKlGuVQkHy6SeoyUzjLbIpM6GQDI8U2fHn/7Cl579Yi7+n/cv3iqOPky89E+/FA995fPZPuQzUVGky5hk7ERRVj51BqEkBx7Sb2xsv34ztSAklBqbF6Q2z/MQQuB5HlEU7aY7X8FSYLYv9nyW5klROkILSqFPIAUVqTj/zLPgqi1z/eQeh4t9DzuUTDhaSYoTEi09RKfQmUNghZgV8hLMeTGXK4wEWytTL0ke8uyn9X/514vcn771Q0Zix5AVpBNTrB0ZIYlaWGupDA8T2xyLIc9jsDm+UPhKo6WH8TT4IbXyECq2BJFlMBVs+dtFfPM974dL+6vFlo9/hHjbRz5I7Ckm05hmmt6ej+J2wZIYG9U1gzhZhDi00WjjwWxsXiCwWGFIVc60MKTDA9zviY/rP8ml17gzvv1DNpQGCa0jajfJsmTWiPGUAmuX6iesYBeiN0V2MRGwruHZ+++uEmKWZCgnaM7UwVicFDSjJirwSU1KpeSTNeoMOstYLhhrZZz3ndP49mOe6dwf/rboULjhWU8XL/n4Bzn0+Eews6yZCj0aviLSqihFL/rblO0hs84JHc15cETPv4svi1RvO+/vrkbxDAWpsTQ9idy7PxNl+sabSJttTJbjdVLRs9QQtRO0pwiCYJff0wpuX8z2p8K3seDb0C+RJjk5RXVX5wwiTbj23POg3ujb+6HHH4f1PayWSK1IsrTPeOkNhTrmwqi7FaIrONYN2RY+1G4fLvrlXD+c68eSVCrGleB+Tz4B7nrXfk2nX/wGPTlFLckYxMPlhiRLGR4dZabVJIoifN9HSDebTo6wmDQjiWIy41Dax2Y5ZI54usHqcpVakhNdeTXfeMc7F/wU9dhjxdNe/f+IB2ukpRXPxr+E2t4jWGmQOQxRwUznVMtjGOuTtBMqJR8nYrLQ0hytMLN6kL2e3K9B3/rTBaRXbiVsp6jMEmgPIRxSFnGyzFmsFOz6IXwF/yp6tTWk6+dwzLpd6Q+xdPcpytFbMm1IPEOmDXmHFGo7JLRCUlzhcih5JciBxFLRJUjzTql0cELhKQ8V51QTw6pcIK67ic+95i387tVvWzxr5ai7inu/9yTxzM+ezNQB69lSCZmpVJgyFh0EWAtpkmAwSF/SzmNEoHBKEMcx2ilkBtrSqSZbFHrryIYVKb2y/2//Nncr/8p4LRbZpJOoXNGMUuJVVbj/0X2nuvavFxJKDUJihUAojUJQ9gOSKEYJuaxXpiuY61vKWpS1hSqs6C7CJBhNngn8So1ECDKTMVzy8LbfhP3HZX3nWne3w5jO2hgP2iZBlTxSZcnVHAfL73iTcwmJ3s2l54VFOIvE4pnCUyqdAqdwqMLgMDklT2PyBCctsuIz2W6jwjItNPXBEe7xplf29Rt7zp/d6ad+i4E0pZzmhLZIRTXSYyZJUUGIJ0DmOcJJnFQYHMYWfV9riSfAmozMGoQW+CUfhaEcRQxMTjG4aTM/PeEZCx7fwNOOE08+8b/ZLna3FbfrsSTGhjdUJrJ5EbeKM0peiXYrxSGolKrMTNcx0jKdtdhqYl72Pyf2n+Cym9xPvnIKst4iyMGzblaTv3vDpkuI2vPeybJC12PRhZu3LYbe742ws5vryIfPHue6Bkd36w/TSCs76XkKbSS+gSC3VLKcgSRjOE654cyz+cTLXsP5H/3M4rdz73uI5/z8VHH/Zz6dmYEy4d57cdX4TvyhAbxKBen7xHlGUC6RO4tSisHBgrzl+34n5bAwjubKRHfj5sUlVYe1P5dv06+FcGvQ9RJp6VEZGmL4gH37d7hq3E1ev3lWHKib/dM1bYr7WbE09hTMetZ6PGjCSRQKzwtoxglGgpRQDTxq1vCr73yn/yR3PVwc85AH0MaQCUdssrnsFuEQHZl7oK+t32HguuTYHglwIUiSmNDz8ZRiYmKK4TWr2dFskYRlHv2shaTQn339m6zyfMqAtt0yGxIj5WzGj3IWr0faobcn9S7CvMAvslTyBPKMkhQMWPDGp4iuvJZvPv25CzrhYY9+kHj9B99xR3qyuwRLw9nYex8INLLsEZFhPEuctfA9TSkI0NqnNrqGRPkcfb/74R19974He9VvfotI06IseMcFVqwae7FiaNzZITthuiDX+F1yqXN4zuC5lLJJKEURw0nGL770DT7270939uLFCaSHv+aF4gUf+yDrjrk7/t7ruTGO2RFHJEIipY80gqjeptWo04pbpC6jmbVJNMRaEmlJoootl4XmgXACz8i+rVsG3Iliu7Xoeo3SPAPtsf+8Sq+0IxoTU7NhHse8MNC8UNYKliduzoM4+721+NoDa/GVJoljknbEYG2A66+6Gs7rLwPwbw99IFngYbTqtOE56bvZAovC9suX70Z0CauJLjwtpuM5FB1PY27SYlGQ5WTthLWja5iYrMNAjdFD9ufg5z6+P1X8e6e6f/zpbPwkx5eio/8DmZyrctslx3Z/+y09gl6tKWuLAoilIEBKCa0Ic/VNnPKU5zsuXHxc2pOwNGGUgRHaWcZMGiEHPHLPgjJYl1Kv1zHKZ0ecEIcVHnXCk/oPvvBK94fTTkOkCSVPUfjObUeh0nUa0YqY1wqKlZu2AmkFworOAFgMMr4xBMag2k1otNgwOEh7fJK4eQukyKMPEXd/4bP5z49/AHHg3ph1q2n6AS0hiHPLyMgYa9aswziL9BUy9AtV1M5AlEtZKACKjrhSZ6CWbs7IKLgoPcza29AFrZCk1hJlOftuPKD/yx3b0dZ1wjsOkH0Ewu76byUQuWfDWYvLDUpIgk52SdRq4wvFULnKOb/7Y9/+/gH7UNlrDblSSN+fnViBDuehCAEK7gAVtzv8jKLvQaaKMGxX4kxgUZ5HmmcIC6EX0mq1GVy7hi15zCOe/pT+8226xp3xg58waj1UlGHTvDDoe9SPodN33EKv7mLI8xylFL7vAxSVqF1R+G04KDPQymlcvImfnvwpuOr6PdrgWBJjQ97jKFEeGsIGmpaNcb5D+QJjMoRSqFKZG9sJ937s8YgH9hdb+8upP8ROTpPWp/GcQWCKqoOLVMPb3W19BXcAOIm0uqfktUWS49kcz+SM1QbIoiZxlvL8F72Q8n3udstm6qH7Ce5/tHjyh97FPZ5+AjvLHtNaI2tDTMw0GJ+ewTho5QmpLSrYKiuQi2i+ODFnfDghsbM0vn5Z6X9lhJkfnnJ0bBXtkUvJ+v3279v/uosuxre20Cyhv/hcUS7AIlc60B6L7iQohCDPc4QDk+UMVWuU/YDm9AyunXDZn87uP/CIu4p9734kTeHIXKcwmCvkC9xs+ykMerXA27wb0PES5lIW3gfpcNIgOotUqQTOOZwVgCazku3NJkc96mHoJzyk7/av+MkvmL7kGtY4j0HhY9Ns1rORd5SPYc6j8694BoUQaK1RQoItBCnTNMXmOSLL8adbHFwe5KZz/s63Tzxp1z+fOxCWLJVDhyVaWUI9aSLLGidyjMsoDVRpC4kbHeOuT5ufbnSpO/dXpzMsJMOBh686YZSuEG9PLMxyB4wZruB2hxMF0bQ7IBjZ0zYkTERNTLXE817/Clbd6+gFx3/yJf/t2mdduHDYOHyjOOjVLxIv+twnWHffe1KvBWw1KWp4hNrqNbRSQ1AqI5xAdkiiXpcsamUPt0jO3tvs/e2iNuuA2DlKAwNw9FH9ociLLsUz3fsRc8TcrrHB3AptBXsmpCuEppSUBNqj3WyBdYTaw2Q5vrXE28aJf31WXys45D7HYCsVmqYo1Dc3qRYq0JY7WtprZ5aYLfbZqS4uHLkxKN/DIIgzi6pUmbSGB558Un8vPO9Sd9HvziBsxISRwXcO7URfdehZbRG3UM/k5iCEwBgzW/QwCAI8r9DhMEnKoO/ht1pU6i0al13Fef/zPsfV191hnuyuxJIZG2vWrCMohfihh1CW1MZYYZmJY7ZFLQ576IPgrj0lfK++yf31h6cx7EDVm0TTkyiX93g2elQnV9JdV0AxuGTKkGpDqh2psmRSkklNrDVNz2Om7LH/sfdFn3C84OD+mgefftrLXXrhFXz6NW/k7HedvHgHv9vB4hFf+Ig44e1vYOReR3FN3GJzs8XA6BrarQRtITAQGEeYQymHwFi0KQ630pIqS6QtiXbksihGKJxdNOa9WNZJ7033ZvoYIUiVZM0B+y247Z033kjoQJue+hlC9PFEVjgbewZcT5uY/0p1V/FTSrSQmDglbcdUwxIDfolylPH30/tDKaPHHSdWbdyPzNOziqF95OduqOIOwNmgKzDW9XqLHCcNVjiMKCb7NMmQno+qVrihPs3TXvHS/lNcfZ07+9QfkO6YpJpZSgZEZugtXN57jVlF1X9l4WAdJsuxtiCXe0qjpUIJidaSKGuTJ232qw6wLnVc8/M/cOGXTtnVD+kOgSWbtcNKGQCtNY1GA2Mt/kCNBobSutU88H1v6HtNbvMWzv7lb/GaMRXnGK1VSJOoIIl2eBorTowV9MIKsDInlzlG5hgBqZK0PUXdC5gMfY56/GN56Ic/uKDpfOmpL3Fct5mBqRn2tYK/f/9H/O99HuG2/fgXiw6f6hEPEE9+70mc8JpXsNXlTCtJ6pc6hFCAIoziGYtv5lJiAYy0Ha9GEfN2wiFxKOe4LcFAI0FUKqzZbx5f4x9XuXh6CpnnHc7Grb7ECu7AuLmJzvV8FwQBeZKSJAmVcpmw828PSdZqodsRV/3tvAXnWHPwgbhKqUN2Fp3rzWWM3TEM1YJ1JJ1AW4tn7GyY3crCC5OaHB2WaNqcuhQE69ex5lGP6D/Njkn++uvfEEYZQ9pH5zmhp2e9EZJ+r6VgceXkxSCEmNPhALIsI45jjDForUE6HDkiiijHKXr7JBec9it+/5o33yGe8K7Ekhkba9eswxpIk5xSqUKKZGeriRko89CnPmnB/mf86KcMWMcAAi8r5F8DrXsEnuSs32qFHLqCAhancrTnaLebaD/AaI9pp6gP1ggOO5R7vOMtC1rLOe/5kEuuuJLRZp3hNKYyU2d1I+Jw5/PN1/8P3/mPFzquuN4lm67p7/CHHiBG/usp4tWnfJ2Ro45kIpRMlT0mdE5LO1IsQRBg45QygsA6lDH4UhDFLfzQI88SKuUQmyaIjpv6/xpW6RI9cylpmJwD7np43/cTV19L6CCQnXCOKAiiLKhlsULa2JNhRSFX7vs+0oExhjRNKZdKWGMIhWLY87ATk4zPM7KPedjDqONomJxUOJSnMWmG53nFDlIg7iBaEMJ1vYsWbYskgm4dFy8MyZQm8jzqvuK45/0nHLiq78Z/+oUvMYRGJSlex4Oe5BlCdtLtLXgGgnxuAVEQUv+1viuEAOtwpvBmeqrgcBhj8AJNK2oSBAofGNGa4cRw1W//yAXvvhkl5GWKJTM2hkdHcFJRqdSYmG5SHhnDlEuI0RHW3+vu/TtfdIX7w49+0jE0Ukpagi1YvL3VQIucb9lRZOzGVVYGzDsthMXanEZ9mrWrVjNdr5N5PtNaUTv8UP7jja9fcMjlH/+M+8u3v8twEjGYRqz1NZUkYsw4oiuv5uiBMbLLNvHGhx3P5T//3eLXvefB4tivfEg8691vw+y/hnz9KpqDIe1QsaPZpDwwSBynKCERucUkKdUwoDUzjScV7foMlTAg8PX/yVvXKw/fJesl2kMPDfftt+O661HGIK2ht38UGV39xbtWcOfBfA+XdA7aLSoO/n767/u+E+vXMLxxP0prVzGTxHiBj+xMmlCMw7mzdwjOnHSFMeDZ3swZSS4FO+pNptMUf90aSvusY9ULn9p3x1u+9h2387IrEfUGVS0phz65zUjzDOUXhpVyFPWarJgNoxgxp7lxa1EIkgn8QJPYnHbWQuAY0Aq5fYpzTz2NP7/5JMfV1+wRRseSGRur1q8jEzBVjxhbtzdb6022JQn/+fKXwj2P6HtFH3/dG7jL+g2oKCKankJLy+joCDMzMx0ikgAUOI2RXddVN5d6qX7BCpYDlIOhag1nILMQeRp/73Uc/5IXLCi33vrmT9zfvvo9VjdiRlxG6BKymSlkHLO6WmFNKcRs3cb6XHCoCLn469/nsw95grv2899ePLRy/IPF0z72Hg56wiO50kXsKCnS0UF2pG2s7+OExNcBofAZ9KuEzqPiBYjcIqwjjm++xP0/i4dbCs+GHK6h16/r+27TRRcjrZ0rgEi3Ro2crcLbVTm9I0wWK9h1mK+7MV/RtxfSWQIcZZsVoZR/9Gg9HLifOPphD2J70iQveURJghISlxtwDoNDaO92/W2LwUIhOMac0F3XC26EZs1++5GWS1w1M8ETXv7iBcf/9lvfQ003WVWqkDSa1Ft1wlqJsFqi2W5B57zdmk59176FvrNAgHCxDTDNCF8oMu3ISx6JzvEDxX5Dw4y1DDedfjZnffaru+hp7V4sHdNyr9W0nCUYGmbzzmlsdZANRx6NeOwj+17RxPd+6pIbbsRrNBgLfaqhR5LEpGmK0KqopeLkbIqTEbInxXHFq3FnhnQSmzsQHjuaLdqBJhmq8by3n4g+5vDZdmYvuc5x2l/cjz/6aaoTDdZJn6qEvN1EWkOlHDI9voNauURJCfLpaY4YW42/ZSerts/wh499gd8861WOP52/cPrff6O426tfJd7wja+w9r73ZIcviIYHaZZ9JkxG0+TkRtButJFOkiU5YRhiOimw/2raK/QX2nIdbYGB9evgsL37+tT1l1+B15GttqKTPeDkrMEhe861guWLf2WhdUu7CKASaFyrRTnK2HrW3/q+3/ig+7HTxFRWjRGnGYEOENaBEWTuX+MsLC0KD3eRr9gtcSA6qegSi2LLdIO61hx13MPh4f0yC5d/+svObB/Ha7XxsoySUoS+phW1iZKYoDxXO2h+gTu47eRY4SS+0oX8uzWoskc7idm5czuhhTGhCCfqbP3zeZzxhrct+2X10hkbIzXaWpJIj8wPyWqDPPxpT12w20+/+FUOHV1NY/ONeFnK0ECF1KTUoxalSqW4RacBVegUdAZJ2fFsLEWBqxUsD1gk5fIIjVyQDw3SGqnylNe+DO5/ZN+gInP47H+fiL9zhjGpCUxOY2qaWq1GpVIjSXMSZ2mZGOsJDBn1HVtZHwSsiVJWTdRxl1zJyc96IX950zsdl/5jYcc/4nDxyM+cLP79ja9iS83jhkAQjQ0TVyvkpRDn+Qjt4awgs44MgQy82+RZMALG9tm7/8OLL3fxTB2t+vlNws1V3RVO/ssEtxXc8bEYWXOx+kS9W2cvHDkuiRiRigt+d2b/SQ4+QBx6739jKo/wwxAPWdQEopBZTJ3brZ6xbljRdOq0pKojWOck2mpwGlcus8PmPPgl/9V/8FU3uJ9+/ssMWxjSPr7t6IYIgTFFqQ0hxJw+TY94nxX0FH67bb/B8zzyzBbcGqXxSh5SSpxJiKdnqGQ5+Y3b2HzG3zjnLe9Z1t116YyNuxwoRK3CRBQja8OsOehgRp/w2L6mecmnv+TMzp3MXHc9h25Yz8zOHVibI7VAeZIkTTuGRncVKDFiTvNQckdhRa9gd8AJSWIlsQ7ZqQXPeNPr8R/70P7h74zz3Zde+Vr2rQ0yIAVpu03g+YRhSJobUmuJc0tpcBAV+kRZRKUaMDRYgSzCT2LWlwL05BR3W7WaK3/zBz7xqtex5Yc/XLTlDT/t38VL/vxLcY//eCKbXMR4IBm3KSYIyZD45TKtOCMHUm6dh6G7vxGSdQf2Z6LkW28iFKqz6rJY4QrjvCeMMpu6t+LZuFPglgwCkyZUAw+vnbDjyqvh3H5D+uFPOJ6rt96I9j2yNEVahxIapT2svGPIEHTTyzPVFayTs96NySzj6S9/KRy4oe8pnPbe/2XUCHQ7pqI0vlDkaUyeFvLm5XKZOI5xnUqxszo5nbOoTnbKbfVuZNaAp/CFh0syvNwxVCpRKpXwPEEgJCPKxxuf4YpfncGf3/CuZTvjLWlLKa0eJRgdYcvUNI9/5rP7v7zyKvfb751KEMXsMziMabXwpSB3OcLXtNMEJxUgwGksGivkrHKioCgMtII7LxyCRi7Ynlge+uxnMPDk4/uH1cuudF//wAcot9rMbL+JKI2ojA0wnUVESUaaW9oIguERZqKILLcMDg7SbDbYObEdpyyZlyNCR7MxSWv7NirTddaMt/jj/36K3/7XaxznXb1oIzz6za8Wr/vq5xk7+i6ItavYkaW0ckvkQAUBmRA4pTpqorfy9wvYeJdD+z67/sqrCaXE5GlRf6ED4eZEvHoJoiucjT0LvQTi3m2xasyFZ8NQ8jQyTvGinMvO+HPf+cLjHi7G9t5AFCc40zFYUeQI0N5uD8U5YTtEaUi0Leq5ANoUhlBpZJj9HnS//oP+dK7bevHlVFJLRWmiep242aBWqVIKQ6J2kyxNCMNw1ijvGhvd36v7yKj/9/sWFO8g0RLhaao6QNZT7FSTrNGmGTXJtMBISyXwGcpAbZ3k6j+ezZknLk8Px5IaG3pslJvSmKMf9TB4cL/C4Za/noeemKFqIGk0wDr8UpkkyZBCo6WH11FV6SrDOeYY9TiBu4OkXq3g1sMKWZSC7gwSvVs3RNYnZNV1Z0pJpDQz5ZD7P+OpbHz58xY0hu+8/0OoHRPYHTtZVSkzNjTA9p07CUsVarUBlPSxTtCI2pTLZaIooj4zw+DgEEG5hFOSXDimGnVWrRrFc5a1YZnyTItg805m/nYRH33BK/nre754M4Jgh4vHfvmT4gHPeTrsu5ZszTA7TIIcGiJytqih0lU9FD3Sz65H5rzndL1evK47N7zXXft+9/i1mwlzEHGGlmrWzdyNORfP0HYyurqKiyvYU9BtI71/b877W5TmkYXglIWqEJz364UZWMc88pFM5RYVVhGqIIWmSRvhCknwXY3u5P0vpZW6QtSrm5fY1bSJPWh5gqe89EVwUL9X44ef+RzeVIMha7DtiHKpRKVSIU1Tmq0WvhdSKVdJkqTnnhxO9IeNbuvsYwXk1hKnGRhLyQ8YqQxRK5XBSYJSSJwmNBt1KlKxtlJG7BjnH7/+HWe+7Z3LzuBYUmMjXLuWG33LsS961oLvvvO+k1mfa8Lc4SufFMiFQsgAm0kCfMjpvGCDkxlCZGjr0JZOrQl5m1aGK9i9KAwNgRUFH6eItXZWDa7g5GQ2Iyj5pDYlcQajBNb3yTzFDpczdP+jOfKdr1jQ73/zuje6+sX/oFxvsNrT6HaEabYYLFXIkpw0Mzgn0AJ8wCQZoQ7xVUAaZUincE6C0CjlkcUZvtTk7TZlJMNBwECzzcaZJld/5Zt8/5HPcDu/vnhoZa/nP108/WPv49ATjmOy5nNdaxpvZIhMGHKXkGYtAiWR1pDFGRZIcWRakgGoIiff1xJnigFehT77HLD/gmttOvtCVtuQUgYyt32rslwVK8Cso4zY9XasYPlisSwHMe/vYlvnaHI0iSnIxDqNkNu2wq/P6GvHRzzqMTS8GpOZwPklWnGLgYrEk0nBm7sNmO9x6VMqXeS73qwa6SQmznCxJbSCAIkOPBouYbxsqdztQGpPfVTf2FA/5TS39ay/s7FaxW+38UUh5R+lGU5ppB+C9mm2IwIdIG13TOqKS9rZCspdddVbE0pxneM8JyhJj8w6UorQapwbQJKnphPuTZChxGZtVnuS1c0Wm0/9KZve/t5lZXAs6VhTW7+eh/3Hk+Cofpno37/5rW4NPuXI4nfaapeTgSuqYxYbzOrcM/eypaPITlkZKpc1uuWhu1VI5wbHuRW3ryU7d+6kVqvhBT4uDNjSmKFZDtjvfvfg+E+/b4Gh8fuT3uWuOuMcqq2MSmoJcoe2dpavUKz25gaK/q1oe8zf6EmBsxZtLYEx1LKEcmMad/1mvv/+D/PbV5zoOP+ShYPA4QeJI9/8KvHSL36awSM2cmPaohUo8lJAZWyUepyQWke5Wiueh6dBglBgbUcJ1DhA4pSm5Rxj+84jh15xg1N5DnGCZ8Fm+awbuLcQ22z1ymU1VK3gX0X3vf6z92uRaOWjpIdwoK0jjBMu/PVv+/bzVq2iumEDseeTOMfQ0ABZ2iZNGrucoN8NU/T+vaVQTbVcwZeKsgppNZuM12cwAyETPjzyOU/v3/myG9z3P/MlDl29lmhiHE+42arH3WyW3nmIzhy0WIXXfqLtrYdycyEVR5e0XYw3whWCYL7vk5mULInwrGFUaPS2cc793k+WlYdjSWfrAw4/hIc+9ri+z2Z+f7q75E9no+IUH7dC8LyzozNY9bp7ewuGSalZPTJKNB2RxjmRdSS1Cna/dTzkDa9ecLobvvotd8Xv/kR643bWVWoFiYvF+Qm3dbI10mJqmuqaQQZ9ybocNp/2W775kjdwzfs/67hskZLR97iLeNKPvimOe+WLidaMMS4k26KMpvYRg0PkvldUl5QwMzOBlBZshsKBcwihMF7IhHWsu+sRfadubL4O43JSm4InMPNc3F1Dq9foWsGdG8YYhOhULLYWTyn+/tf+FFh58F7iHg+8L4kuVt25ceTWobW/y++nOw7M3xZ4bwCBpdGoU6mUmZqaYs3aDYhKlbpSHHyf++A9op8sfulvTsfMzHDdpquoDQ4UnKndzTnhlo2WKIpQSiGEwPM8JBD6PqtWrcLPDZf96o/84a3Lg8OxpMbG4Q/8N1E9cH3f6/zzj35G2Erwc0NJqZXV1Z0Y3UFEuSJT3nV0IXoHgCxJsbkjLFcgKGFqg6gNa3jS294Eh2/sa1utH/7K/fTTXybc2eSINRuItu1EdxQP5xep2hXtzgmYbEzQaE5S37mNVUKx0Q9RmzZz3pe/zZee+xJmvn3aolfa8IJniGd/9AMc8ehHMx6EJKMjbM0yJpIEv1ajXp9m3302dApKGaQShXqjU2RC0dCaVQcd3HfOazZtwjmLcw6pNULNrZC6A3TXgySc7Pz/infwzgrpilodwoFCQGZQQpI2Gkz/8jd97faQB96H2BM4TxGlGUpr1BIYGzd3nzeH2kCJOGkipWSy2YahIaJKjWOf/7z+Ha+4wf3qm6dQE4I1w8MYHLHJlvbGdwG01kBhFAZBQBzH7Ny5EyEEVR0w2M644LRf8tf3fewOP5PeriNN/NvT3faLr8CbbrGqVEEYg1ghqN1pIV1Ry0B1soq6QlWm4+1QDnylabVjvKEBtucpO5TleW9/CxzdT4zkz+e6r773A1S211nVtpRmIipOdVT/7AJDY7bezm2AcJbRwRqBgL1GhogmduKmpjhsdIxVScpeUca3/+e9nP6y1zsuXEyb42Bxz/e/Xbz4G19BHraRrcqRlUIm6g3GxlazefNmcmEKj4wo0r8RiiQXyKFhWLum73Q3XHsVzuZYYRFa4KTrSCLPeY+kXfFsrGAOWvtgQEnQSpDHEYGDc+YTRfdeS2Wfvcg9hecHOOGRpvki9Xb+71jMu7DQi7FYFWSLpwRJEhHWasRScUMr4pHPfjbcvX98+PVHPsY6ISglMQNhiS1btlCpVe/ws4/neeR5ThoneEoTBEFHh8MQT88waCx7o/nLV7/NBe/66B26R9+uxsYZPzwNsX2KETShEsQdOdgV3DkhYJZ8hbBks1VROw3TFZkq5bERLt66hXSsxgkvfyk84Jj+4emCC9xHX/06RlPHWqdZhYduxwwFJQqtiWK37t9d5TkVDohTXBQRzdSplDv6HHmMTmP09DRrDOw4+wI+9qKXc/6HP7X4YHDXA8RTvvEp8ay3/jf5qmHickhLgR4aIpaS3PcwQgESIRSJc4ztux8c1O813HH9DQiTo3DkeYqwbs6T0dln1tAq/rWLnsQKlis8zyNJErSQlL0AYQy+gavPuwCuuHauvW5cJY4+9gHU8wyrNXGa4oS6+RP/C/iXsk3+yffTk5OE5RKpc2RhSG3jRvZ+4X/2H3bmX93155xDqdUgm5nBxhEb9z+AneOT3NH7gDEGpRRKKbIswzlHpVKhVCoRaoWXZFTaCWtix9+++2Nu/NQ37rAGx+32pKd/8gt31V/OpdJKWeOXiRr1WTfvCu6ckI5Z4qYRYOUc21zawvOQScmmmUnsvmt45klvYuxpxy8wND7+hhNZpwKqUcqAdfh5hiclM82ZPoJkd6LdFasx6KgIxjn7ju2F1prY5uyM6mxtjuPXfPKszRrfpzpVZ3DHDJf/4Od8/jFPc+On/XrRAWHs6Y8XT/vUhznicY/gskadad+joT2yoKiabJ1EoDFCsuGwjf0HX3yxa23bic5ytBCQZ0hReDa6Soeyx+jYVQS3FSxvCOtw1qKkxBqDLzVeluM1YraedU7fvgc/9P7Ysk/TGoz0UJ6HE7t2DJ/vzbg5gmYXpXJALixZ6LMljnjUs565YJ8ffOJTrNUa1WgwVg1J4iaNmTrDgyO79N6XAt0qsd0QSqvRJGq1iVptJALhclyrxQbfZ21q+e0Xv8bUt35yh+zat9ts//3PfYkRNOvCCul0nSSJKA2UVwa8FXTQ9UDIWY9GoiVT0sG6UQ595IMIjzt2wULnmx86mYFWQr59J3Z6mqEwpN1s4Jd8VOiTycKI6aJX8/C2k8MkgVdix7YdSKFwUqJCn+rwIDPNOgPVEq3JHYz6HmuExNs5jb9lB6ec9H5+88oTHeddvLD5H7aPOOJ9J4pXf/zD1O56OOOBTzMMaEmfRPlkWpFrwdDe/SEUZlq46QbaGEIpOoOU6BgaCwsW9os7reDOCuccnuehhCRqNtA4RJYxIBRn/+I3/TsffYgI160mC0O8ao12Ym7Xe13ME+KUpJ4mNKXgoHv9G6uf9PB+3Znv/MRNb7oaOz3DSLlE0m5TCgLyNMOZO34hT2sLKXNrLUEQMDAwQLlcBiAMQzRQ8RWBMQxahzdZ50ef+hw3fecHd7hfdrsYG9npZ7rGNZupJgbXbONLQVgOmGnXO6JGK7gzwgrQJY/p1gye5+ELRdyM8bwSMYKoFLDdFxx9wmO4/1vftGCo+fZ/vty1L72W0nSTMekzFJZptZr41ZCZPCbxBJmay2yZFYTbRXBAagQ6qGGdQlEUZ8jTjEB75CbFD32StIWPpWZyRtspG1opU7/9M1/4r1dw3ae/5LjyyoV39egHi8d/8wviMS9/GTvCkNZAhRlPMuVSbMXj0Hse3rf79edeyAg+Ks6p6AByg83Noloa3RS7FbnyFVgLSinSNCUMQ5QrVDV1lLBj0zVwyaa+tvnQEx7PtElJnSxqVS3hFCIdSClJkoTcWYaGhsiyjDQrCKo5jlQK2hLiSsBxz3jagnP86LNfYMg4yjhsGhGWNHmeoxG49I4/93SzUGxucMbijCVPC1JvniZoHHmaQKCYmJ5gSErGIsPX3vxOsp8u7kHdXbhdjI33vPYNjAgfP0oZqdWwtpAk96vl2+PyK7iDwgFTUZNwoIq1lizJGRkZIxeKdinghrTNmnvelSNPePyCY//yhg+6iQsuZSjOGUgcgXFFOEZaUlUUZerWMpi/IhJuV0l1SxwKh0I4hbAaZTXKijnDRhSZNtLl+DajkmcMxymrWynrmhmnf+JznPLmt9E+84xFB4aNz/4P8arPf5LKkYcS7zXMRAA7TROv3J8JsPXKaxlUASUUrWaTarmCp/TNEkFdT9hqBSsojHGLoKshYylnjqtO/2PffsNH3YV22SOWAqFuWzbKzXkVRM93nufhl0K01kxMTmKsJSiXyLAYpWgCYniYjcfcEx5x777W/NcPf87pehs/yvBskYxgnMXi0EITam+X8bd2ByRg8xztKaYaU1RqFTznGDKO/WWJT77mzUyfesfxcCy5sbH1lB84v52woTKATA3NegPte1gp2Lp9+27Pc17B7oORkHsSVS3RakVooXEotrdaTGjJ3g+4N0888fVw4IF9reTv7/6ou/Dnv+CAco2B1FLOLJ4txN9SNVcBsle8qnfCLYo17Zr0127oRzqNcgJtioqT3UJQYlYYyKGcxTc5oTGUTMZQmrCfk+QXXM6nXvpafvv6Ex3nXbbwrg7ZXxz/1ZPF8Se+Eu/wfdj7qCMQ+x7S90y2XnM96VQDT0g8qWjHERbXN3D3YqXfrWA+Zgv2OYtnCoPjrJ/9qn+nexwu9r/nUbhSiTg3u8RY7dXRmH+6dhIXWiBSkpocrxyClkRZWoRZBfh7b+A+z5+nUn3RNe6M7/6AoBnhZXlRfJAibOQ6ejVC7Dr+1q7GzSm/zleKFQKU1jglqQxWiaIW9R07OXhoFXtbzQ/f/3G2f/2bdwiDY8mf9Bk//yX7Da+msW2cmh+itSQ1Kc451qxZ889PsII9GBYZatp5Sqlao5XlNKzDDg8wXfJ4zGtfBQcf3Df+ZD/5lfvzt09ljRREWzZTzgyeLTqeFf2VGWFhGehdPcn2nd9JXEf+uKNogXQCNbsVq0dJjnDFCtKbbrDGwEF+lU2/PoMPvPDlbPrk1xcdHKoPf6D4r/e8naf9vxf3f3HVdS5pxYQ6oFSqIL2ikGGUxD33UqB3QF/xaqwA5sjCtig6hXQWzzoCY2lvHYczzutrj8c8+hEkgrlCmUsEK4psjNwYMmsIyyWUp2nGEVIrcl+RDA5ywH3vDUf2G98/+9QXGEksFWPwOuXiu3wwSVEPJs/zJbv32wNOgO/7JEmCszlxFDE4UMOXgonNN7DOLzMW5Xz7PR8iO/13u93gWHJjY6/BYVwrYrhaIYnbJDanncZEzRZxs7WS638nh5SSZqtFIh2lvdYwrh3T5ZBXff7TcJce0a5N17roR790nz/xHewfhFSiJqOh7giCdWsVzBkTnpH4RuIZie5IcjokRthCx0PY26zxIjrZNLojr16EcByJlqRSYtDgdFFfwUhk5z5SKYm9wvtSKpWoWoW5aSfrUtg7dfzus1/mu49/rnO/OXth79h4oPDuduSCEf6GzVtIc0PmLDump6mNjuJXa536MyuGxQpuGUbOadHIjlGsrWUsKHHeL/rly0cf+whhPI9SpbZkBONuey2VSgRBQJpnIAXtNCG1Br9comlzxF5rOPINr5pr3Vff6Pjj390Nf/0rpVabkpAoCcYJDAIlPDxZZNGk1ix7D1+UZSilKauQeKqOUorqQJV2FpM0GgwljgNUic/999uYPm33ZqksubFx1T8upz1dRxpHlmUYHMOjqxgdGu4ILq3gzozWTJ2xsTHqecqN7TrTZZ8Xv+OtcNRB/cPA9mm+/ZFPMpxZ9Eydqs1QWYzoCHbNps5SNGptITDgG/A6NkW3Ymw3DXYxt+3/BXOlAA0IQ64cmYJUQi4lRnb30IBmzuApDI5cFnLEtXKFseoAQWaoGYc/MY2/dQeffd0bOfM1JzouuPAWe8ppPz2N0b3WUa5VGa/XWb//vsxELbZPT3RqLcxhfpGuFaygt8BZYYC7jiENOkq4+E9nLzjmsLvd7XYRxEqzDOlpLI4cN+vhiE1GJOFxz3tO/wEHbhCnfOjDeFMzrA18PFdkzDjncFagrERJD7TCLXfpBVcsXrTWlDyfgbBM2m7RaDRYs24tlUpI0mjiNxPWpZIvvPEdJL/87W7r9Uv+tBszdUaHR2i324yOjRGUKsw06kyNT6DsHV1SZQVLCeVgwC/RbjTxh2vEtZDjX/Z8eOR9+mwA++dL3Nff/SHKrZSac+Qz01Q8CHTB08hlj6HhCi9CYCDIC2NDzhb76/d+3FavWjFA51iRY2Te8ZoU95JJQSoFeXcTAovCCNXRJig2YwQz9SZBpcx0fQotcw7cazVy23Y2NCJ2nHY6P3r5iVx38qdv9m6Pf/XLxfCaVYxPz1AaGuLG7dtJgXV777Ng5dYlrq54FFcAcx6E3nYiOuURlbPYRkQyVacxz8t230c9Emvgto7g83U15iNJEjKTI5QqjCEp8UshzXaLo/7tGFY//ri+w278/CluetM1rPYDaLdxJu/UWFIFV9sUP9opBVrvdo/frfU6dp9XKQhJ44w0Sgk9n1pQwmYpcdxm29QO/FpIJfCpNhIOpcIXXvM2Jr75o93S+5d2rt90jQu1R96KCEs+MzMzRHELX3sM1oYI/dIdlqCzgn8NyvVzAHo7T+8AMv875Sjip7pMGoRcHbV4yHP+g72f89T+rnfVDvetD5xM+9rNBFGCNjmjwwO06jPFamVeZ93V6a23jMLYsdLOrvIEdlaxU3azXlg4qHS9CpWBGkjB5M5x9t6wnna9zvS2bYwEAYMG1hjwt+7kj188hS/++9Pczr/9fdFf98QffkE86oXP4cYswa4aI69V2DI11ZOaWNSd6Zabt7Iwdnql2wX975POfXc9Ql2v0Ar2PIiOGI0RhefNAso5RoKAIQcXnPGH/gOOf4AQw0PkUnZCdbctXLdQZK4ITfolH7AoITC5I0UQK49J3+eeT3ty/0muvsH98lvfZnVQwotjRJp26r5opNBFEUNjCq6GNYg9wOJO2hFaSEqlEtPT02RxQtkPsDZnZGQEJyytRhMvNYw4xVqr+PEnPs32H9z+IZUlnemTbePoxFCWijxPUYHE6wxwSZaS2uX/su/MEHTlxot/d9Mpu2l00llcnqG0wGKw0oJ0ZGlMKCV57piSARODI9ztaU9i40v+q3+ouuJG99P/PpHy5psYjmK8uI3vF0qdRilS6zrejMJ7oW0hYFV4OyyJLrZcFfdS1GKZI5MaedtErbohEUtRll7bwpMSGEtgHNo5pCuKVjtRbIWLurgX4SDKUpyGku+RTs8w6PlUfQ+bpSAszhmqnk9ppoXaOsEvTznlZu9n7MQXihd87ENsr1XZaiSiNkLbWKTUOJPhhx6RckzkCapSxaAAVWTR2G4mjUTZwvCwAqwsnmU3lbibLrsrasus4I6Abh0iiXSKXBabE6BtjpiZYrV0XPjbX8KmK/q6yxGPfSQNIdF+hShN0X5AkqUYDF7okdmsxwApjNs+o6RHY6lrzDpRGBmyY2yIznghjMOTmthIrmsnHPWsZ8AjHtQ3Xlz8/R+TbR9HtJp4QlAOQjwrIXe43OGEQnoaIR3SZKg8Q7rdq7Vxc8qo/wyzxpnSoDTtJCaslIu+KYpwUR7nCCOQUlIZqrJ9fBthlrAuTfnuq98IP/jF7ToBL+lo0a438OxcVU+gQ8yjw9xfyquv4PbAfBXK3pLQUKjcNRoNKrUqrSgB7aHLZVpZhhoa4IYkZv/734+HvvUNC1rDr//3gzQ3XY2cnKLmHCWpcCYjyQxGSFQQ0m3C8yWNu6JVvZyF3n0WrqRuHVyHh9E9v7LdzaKs7Qxm/VvvfVhhO6vI4jjZ2URn3yxPEM6wqlLFzDS4+2GH3+y9AIhH3Vu85FMfZ90xd2erMuS1Km0FOiwRRRGZNYyNjTE1MUmemqIfUhiIXS8M86LxXS/NYuGXlS68/DGXSjnHKYKCk1T1FSJuYaYmmPjHZX3HHXifY0jDkHqeEZQqWOfwtYe1ljSL0V7v9LJ4oKT3kwXzgXDkeYYfBoAkNZY1++5HPlDjmCef0L/vWee7333vh4z6PmuHhtFC0pipd1LP58KWRfMtQkTK5Xts++322TzPUZ5muj5DtVrGwzJgYX8Z8PnXvoHGt358uxkcS2psTI7v7HMrd1GkWS3llVdwe8ABSUdAy4pistS20Lzoot5qMjA0hDMgpaaVpOS+z5a4xYSCQx58Hx78rKcvOPfpr3+bu/HCS6EV4wNh4KGUKM4D4DR29y5KbheUSoWRkCQJ5XKZNE3/+UGHbxBP/PJHxKGPfShbSrBdCWKhsVYy7Fdpbx1njR8yHATkyhJ5EOtCnyTRhQcDunoLBfclzAvdBW0Lwu2KT2PPQO+qui8bpRPmzGwGWCpewJm/6s9K4UF3FWsPOYBpkyE8nzzNCT0fJQR5nnfSTRdfufdq3wjmDG1gtp6REQKkJM8sBkis45ptW3nMk58Ih+zTn+r6rW/hWYPLcqbHJ9BCEgQB3fCh7RrTnb9dA3u5w83bej+HwsuhtUZKycDAAFEUMTExwdo1a6j6IV/8yMk0fvw7x9U7ltzoWNIxY2L7zgUroV5DYw8Imd2pYTrx/6xT/HF+zN8KGBkZIWpG7NgxTqVaw2qPtFxC77OB9qohHvGql8AR+/Z1+3P/96Pumj+fw4iTjAY+FU8jrcUkKdJB4AUopckzs6RyybcXbukXSFl8m2UZWmsai1RK/sp7PuK4evuC3nTsSW8R//m2NzBZCxmXAjUwRKudMFipQpqStOuAwwiHkQ7T4Z8UlXeLkb8QeZoLl3XDUCvYM9D1N8xmo8zzXlkcxhiGwwr/+Nv5uMsu6Xv79zj2wbQ9aOYJWZYhhUAJWVQpNfkCQ6PrQeuuvHsJot3sREvBHbFCgtMMja2hZQymWmHNoRvZ/2EP6T/pORe6i878EypO8a3DE4Ko3aRcLi9uUHTDf3eCMKDv+6RxUVsliSIGawN4UrFty02MlMqE7ZTPvet9xBdeDJtuWtKevaRPe2bHOMoxW+YaVjwaexq6nIVupy5WDHOl4nfu3EmtNsja0dWApoVihzVMDtd4xgfeCXfb2Ncimt/+ifvLN05lVWyxO8bxkgSRJJg4xSYZwggUPlqFILzb/wcvIRbrGtP1OtVqlUqlwszMzKJCeGef9mu+dNJ74PfnLRgsho5/lHjllz+Dd+hGtmtFQ0kyJUGBp+Rs5kFBdi0G+rm/thNXn7eJ3r8rWK4oJvwOt6rzmezZALxSWBQta0WUE8P1f7+o7xzD9z4KtXaEtrMoz8dmFpcblKexHdfjv0LaLsIac+2paINFWGf75DRqcJC6dhz/oufBkQf0dZXvf/hkhtDUkHjGoJxlqFal1W4U56LXi7FnGRi9xPtuSLv3UadpilKKwPNpzNTxlGKgWiONE7J6i/V+mb2Ex0ff9FbYvGVJ73VJn/zU9u1I1yXEFZ91LdsV7Bnor6JqZ8W1bGfCGhkZI4piZhoR03FKEvhMBT4v+tiH4Oi79LUE8/PT3Skf/Ch7qxA9VWdQSIgTpDWEWhEGQScOacms6ygY7tmQsjAF0jxDeZpWa55n44ptbo0fsO38S/jMW/6HmW98z3HZpf1D+xEHiye983+4y/GPpjk6wJWNCaKSh6iGFPFrejbbU9Olu8rsEENlP0dnRadj+WM+Z0J0yNZd4yC3hiAIEEnOqPS44Hd/7D/BUYeKDUcejg0DdBiQ5jk2d0WmmepdDLie/8oF154Nqcz+7Yws2mc6zdiStNn3mHvAYx7YN2bc9Nmvu+2XXk4YJ1SMYaxcJpqZIU0iSqWgL0NmTzY6bglaa3zfp1IqE7cjWo0G69esZahUJmgnqMk660plvveFLy/pfSzpE5/eMV64yeg2Ijs7eMHKYLXcoSx4Zs61bkQRVulyOJyALDVYA7pcxhscZEZLXvaut9MK5jW9sy9wnznpvZTrCUE9YkAphsIAX4GS4ElBIDW+VGAsWW46KfPLe9D4Z3ff5Wykabo4Z+OQtUJMznC31WsIt+7k1He/n/O+9PWFJzpiH3HkM5/KU056E+aQfblBG7aaGCckXi5nuRl+533KTsZOroowWdLZsk7WwJynYwXLHd0wSm/NoO7YnHTCd0N+gGql3HTxlZjT/9I3ch957ANxlZDIOZwQeIGPyXI8pefV5pkzOGSHEzK7Iu9LC+/WFFLkKFYfsD/1SsBDnv+M/hu/+Ep35qk/ZI32GUUzGpTZeu11VMOAVatWMTMzU1xPdMP3xUX2NEXd7gK+y0np3cIwJEkS4jjG933KYQmT5SRRzNTOcVQUUTGGqoOKXtrF25KO1NHMTGelVLhqu7oDK56NPQOCgiyoC5E+nJCd7I8i3uqEJDI5JvSZEZYtSYv/d9Jb8Y69t6hs3H+uFZx7kfvqO9/HUOoYFR7lPCewjqhdR2uJMRlpFGPTDOEkSmmc0li55zSkmzO8syzDOUetVqPVanGXI47o3+HPF7q9RwbYfMnF7Fsps0FoLvnxL/j2CU9x7uy/9Z/14HUifOxDxAs/+n7KdzuU8UDS8BSZ6sbIixWltqCsnM3aMbIwMrIe8bQV7BnoehL6Rb3m4IcBzWaTivbx4pTBXHDVeef3nWPNEx8n4kAzlSU4zyMoVTDGLQid3NwEv1hmmHRFGKVtLZfetIX7PPnxcMzd5s5w9WZ37W/PIN02QRhn+GlGXm+wemiQkYEhNl9/A5XqwKwnpWto9F5nuRsc/8r9R1GElHM6HEmSEPoB1lpWDQ0ROEtJOEwUUfL0kt7v0hkbF1/pfNuNxRXFfRC2T4RpJU9/+SOLIyqBD8Zic4Mz4AxgisEiUoJGoJiqae73n09E/vuD+7vIFde5H578acS2SSpRSqXTXuKkjfI0mTMIVUjyCgfOWJxzIEXHoNk9v3up0TXKlacRQtBoNCiXy3jePJ6KtNSndrB+1QDpzDhDecbeQqOvupFPvez13PjlRVLbjj5SPOWUb4q7/PtjmaoF7FAWO1Al933S3KAKVgwuMWg0wkniuNBRiNIEiytWTneGdKA7GWSnSnG3W6UmZ2hoiObENGOlGqoZceEZf15w3F3ud28YrNLGUE/ahOUSUavVFz7voq/LCkFqcpTvYVyOyw2B7+OMw+LIPI9g3Soe8JbX9vf07ZP88ZRTGcgNQWYIrUPbIgTY6pBDjTG79NksB8xfzEspkVKSRjHVUrkgfCOQDrI0RQmJtQalBcYtbWG6pZvtp2ewcYyy/fUY5mK+K4bGnoDhkRG2bNmCFIKRoWHKfglf+Sjpo8oV2oFmqiTZ/8H35i5vfeUC0+DUd7yPLX87n7ARodsJptWmHAZ4pZBMdDIlujHXnqOX+6rkX4VzDqkVUilMZ5LvQ9zEEznaEyjpIE3x2inD7ZwNqeTHH/g4f33LJxxXTC4wOu73zneIp73xNTRWDXB11GBKCWy5jFUexjg8NEm9DUlOqD20E5TL5T7jZwXLH4s61bohDmuLzA7fQ6QZg55P66btNH5zet9h9zruEWyNGuSVkLbNsdYyWBvoP+W8tusEGBza98itIc1ztNY0m00yZ8mUou0rHvrkJy64vT9/49t4M03C3OIbN8s56vXUFKGEQmVw1ojag1Ynt4WGMBve6pDAbafUwlJiyWb8dKZBWegF2Sjd1NdZLsdS3cAKlhwOmGnXGVo1TLlcZnzrTpJ6m7Sd4ZTP9ZOTTAUK9l3Lgz/07v5XffVWd9ab3utaV2xiLIPV2md1uYRyRcG+ZhyBr8ml6JPK7o4VssMB2tNhrUUIgRCCLMsW7mBytJbkGDLtyGUxeISZYaidchevzPnfOJWvveoN8PfrFwxP4QmPFy/4xPsZvc/dmKmFXJe0MAM1UqnwvRKrR1YzHNaoioBkpk3WjKiVypRKJZpRe8mqfq7g9kGfx2Ex0bYezQzpCh0dM9PksjPP6t/xgccIxgZJSppEOJIkwSTpbGXl7iKzm5kyyytAkFuDBbTvIbRAhwHByABRqAk2rOGglz+7b+yY+NVv3I0XXEQtzfFNv4hgwc8Qt5gSvydxBXvF9nq3m6MrdFOdYe6ddMspmCVe/y/Z6W/afCMuy2ZlmWcrNKxwNvYopHmG1IqJiQlqtRqDQyOUBoeJPI/qfnszesRhPO/7pyx44+d+4WtccNovGM1gVElEq4GNE4TJEdJhrS2qPXby7XuVQIXrhuf2fM0HY0wRNgIyk8MiPJVQeyS5wSDB91GBX4jpRS3M1pvYK88ZHB/n0//vFfzj899a+MTufg/xxK9+Xuz3wHshNqxmU3OaSWlpSMf41BQzMw184TFUqmCSnEajQVgukds7n5t6T0Nvn5rrS3PTglIK3/fJsgzfU2RRmwGtuPbvF8Flm/ra0oOedDytQGFDD09ptOsSMu08AujctbVXKI5KQEtFs90iE44dcYsdLuZxL3rOgnv+1VdOYeb66xkJS5102Tk+huuk4dsOd6x74eL3yT1yvLi1kudd9IqdLSWWzNhoTdcZLFU68b855rqbN2msYHnDCwKQkkq1SuYcN01NsnlmikbJY7NNeNL/nLjgmMmvnuou/dVvWZVZzNQEPjnkCVnURAhHpVQm9H3iVlyQTZHksticKESHtXX4xu322gZLja6h4aTAOddRRZxDPtPEyxQudUgXkDpFLiWpcjiZMzYYsE8tYGB6HHXtdfz5y1/jj68/yXHVjQt630M++G7xH295A631I0wOhtSrIYwMIMslGo0GLjeM1AbJU4NxDhX4d5pw1p6Irpd5sXc4P+6PgtxmCBwVT9PevI32xf/oO+aej34E29MmkSy8cZ7Sc6ts+kXDuv+Os5TAL5GnhdcuCAJMqNluIw5/+AOoPP5hfXd3/ns/5rJrt7B+aJBWc6ZHF6an7kpPCQHoKTS4B843omdbzOCYn6WyGBn39sLSeTZuuB4Tp318DYFbkSrfkyAswhnSOCZJEqSvKa8eo7xhHTeahFd/5fOwsV9WOP3Zr93X3v9h5MQUq/yAWqhR0uH5klI5oBSERM0WZA7lVGewKuo1dDU8oJtya/f4MJxSRTpaV3ZYVSp930/cNIFMBSUTEuCTp452mpNKh6x4NKJJbrrhCsK0wTEb1hJs387mM//Cl170crh4kbDKYx4qnv0/byJZP8o23zIuDeHYCDIMmJqu4/s+pXKZOE9J3YpnY1lDdBeA9mZXx8IK0jQlKIVESUIYhojM4LcTLvnDvFDKwYeKgb1WYwONc44sime/6o75ffLoArIsp1QqYbMcrKVUrRC5nGCvMR789Hn1T668yW36/V/Q43VC5yhXg460ucQIMVuxdo570KsC1B+63xMWKV0Do1eF9dZ5OGQn3XjX3t/CqywR6tMzfeqEK9jzINycEFS1WmWy3abtKy7ZeROv+8pn4JB+GXLOPtd94q3vZL/qIF6aQBaBMMy0p4nSCINFCUe73kAhqAYVpJOz2iy5LFyywhX1V3yzZ8VfF4MQYjbrQykFhx/Wb7w1EkKjKWUeFRPi5x7SalIliAKHP1ZicHWZqm9pbdvMeqWoTTfQN43zkf98Lju/e/qCJ1h56APES37+A7HhAfdgm8i4YnwbpdUjBLUKjbiNwRHnGQixEhJd5vhn76/b/nJnkR0dBpU7qlJx9YWXwiX9HrKHP/5xyDDE933oqerdvU43pN5125dKJawxKClxxjLTqNNIY+76kPvCvx3Td3cXffP7tDdtYcxphMmZqE92KsX2CM6JYnHS9XIUE/Fchs2e6N24tegW35vjeiwtaWPJzt6eniKPEqBTQ0MVxB3Pgm+KhtAbh1/BbkJXknoR6enFPVCy02kLV2VqDaJUooUlLflszxPe9NEPQGlezvYFF7uPvuYNbJABcnKaDYPDJI0WzlhKpQrV2iC5sWQO/LBMuVym0WjM1kzoJRkX91YwqJc7uh191sUpuuJKctaYc8ZircWJhS8kUApfKGyezbqufe0jrSRPciYmp1BByEyzgbSGmlL47ZhhY9kgPL7y9ndx2Ye+6rh8YVjlMR/9kPiv953EZm25OmoRVUPqNkeHPpUgJFDFO+51xYtFtoU/2hackpVFyO7F7OTSPw3MvZWixomvNFG7KASYtCNCrahJTToxwU1nn9N37EHPfq64YbpO3VlyLXDCznKsiolfIDrZIcKBEpadO7eilU9QHWTKCkr77ccxJ72rv+mc+Xf3t1/8kmEpqEpFa6bO6PBYD1H8ZmaSjrT+XCi/2K9XVXRPQ1+Ru1vgtfXyNIQrRBqX9L6W6sSN7dupBD5GOlIpiZQkF5pyKqmkhTmaKbHsFSCXNYSdnbT7t25DlBgE0vMxxpFlhsALMKnBk5okNyS+z5SEZhjQKoU84lnPQD3+oYKD5+oX2IvOd99+57sZnKozWG8yGBu8JGcwLOMbhUwVSZJjpSIFrK9oZQnaVwhn0XZuk64jMtWp8bGcQ3K9blAjCoM8l3NuYG0lofCROZT8Enm+cDSolDVTja1kpZy2TnC+w1lDzfmEsaaihkgThQgGsV6ZKM4ItaJkc2qtBvtHCRd8+Rv8/KT3wrmXLhiWKscfJ0789lfJNu7DjZ4gr5YRSuGlFtdokaYxfrWM9j2yLMMmBhcbyiqEzM15nnqM2lmRvxWDY/fDyb6CZE4URfi6xm+WGoRQ+MonbieEnsalKTKJqUnLX3992oJTHvbAB7NNOJKBEkY6JAZtQFuBcBqcRllRKNWaiGqpEOmbsoqZ4VUc9ZSn9p/w+k3urB+eCpPbKHkQRS0GgkFoO6TrbnY2GaEI3dtOqMSBMDhhcMIVv48OkXSZyy/0cm7svIW7nH0O/VvvsQ5IhcFKgUYgl5jwvTRP+x+XO22ZHUisLAZRKwqvhm+YLSO8gt2InoFGOjkvwglgEUoW1RtlsRJpNxsEQYCzlsHhIVS5zI40ZjrQ3PVRx7Lva57X91btZZe4n33+K2w9/wLWeT5la/FFIcwVx2lHlri4D4fslJbur78hO1Z3L4t9/n7LFb0PqxsuckLO/m5nLQpRGHv5wsEgbrcolXx0SZOQkpkMhSBAEjqNshqch8HDoLHQMeByQpOxztOMJjHb/noun3nFazGnn7XgkYp73k08+8PvYd8H35tk9TCXT2xHDg+gKhWqA4Ncd801YB2VSoUgCBgeHWHzlhupDQ7MGoP9wVTZs+Ja3gP+noq+RjA7RnT7okVZi28NO669Gs46t2/3Bxz/eKKyz5RNyCWzXqzelMwub8KXAt/3SYRjCou3995sfOEz+meGrTv54/e/z9pyCQ+LEoVwoKf8zrhgb3ZSXVBEcA+D69nm45+FmOdLCaglHkyXpqdPTuGcm2XS97u/VwiidxQUjU2D8xG2mJiUlT2NziK1wNoca3Oq5ZDVY6PE7RZOOG7aupXIWGy5zKEPeyB3f9+JC97sbz/5RW78w9nsFQwwGJaZmJminifknsSvVZa9sbCr0ev2tAKMtaAkmTGzMfNebN26tTAEhSBPM/K8UAHM83yBguJi/S41MXncYkO1hrppB5951Ru54B0fcWyaF1Y5cF/xyI99QNzzGU9i56ohrispdviaRpJy2AEHEbfazMzMYJVjul1n7T57MdmamS3KN0vW6xTYcmgcSyuPvIKlhXLg2hEXnfGnvs9XP/ZBIvc1xvdmiZvdhUQmwQiL6TTyOEpxyiMu+Yy7lCe/8DkLrvPFd/8vh67bQHt8AtKU0A8QCqKkvcIZ2kXohsaXEkty9vHtO5C4m40XzcaJVqaa3QzZEcBRSKeQViCtLFYLnRLicdQgTVpUKwFSwqZNm6gOD5JpR2ntGFEpZPiQgznmPW9d0O3PeP3b3Y1nnsd66zFsFa2JaYJKmYHVo6TYQvp6ZbC4RTgByIKIWRmoLfh+fHwcY8yskaG1nhViMv+Ece+ExZIxOjJINjHO/uUaa9oZF3//NL7x8tfB+f9Y0EEPfMFzxRu+9GnifTdwnbC0PMW2mWkqw8PoUoDzFFGa0Gi3KJVKfUWiihQ82UlnVp0UxRUsVwgHI2GFS846B67e0vcqDzr6buRBUKSrI4qFjXTkKidXcyE1LygzGSXclMXc63HHUX7cg/pGhH+c/Fnndtbxo5ySkwRCIZwhyVPMHuqtuL0xy9xZjp6N8W3b0QhUj6Uhe3Q2VprHHQidGGo3nKFcx+3ZiXeGYUAQ+NSnp4iTNmv3Xsdk3GLa5Ux7oPbbwJPf944Fp73kg5921/3xLMaaGeush5mYxiUJA7UaubO004TELq0W/3LD/DCWo9DXEFKCkoyMji44RgiBpzUmz/E8D8/zkFLiOu7pW4SwGAyNmQnGqmWYmmKNcextJP7m7XzxFa9h4ns/WTgE3eNo8ez3nMSRJzyOrdKRDFbYaWL8kSG2T4yzevVqfC1pNWY67cj2GRxGiI74kmAljLJ8oRzoOKW1ZSv5DTf0ffeQJz6BydySSg8jdOfdFx4NIw1O5FggtlBdu46pUHHPJz2u/wIXbXJ/+t5PWCN8Wlt3snpgEBNFpElEpVICuYh8/wr+j5C323y8JD19Yts2FGIBI1bSn0Gwp6ctLgf0dtbuxFBo5ruCc+MMWsLw4BBOKLY36siRIdKRAbZ5kie96bVwUH+K6/SvTne/+PLXqMWWcmrQccZwWGKkUqM+Nc3M5BRBEBTcj5XBYgH6+oUQWFWsDMuDCz0boR+gtcYYgxACk+ezXg6l1ALi2HxorchNRp4mBEIw5PvYyUnCeoNgvM7X3vtBznzH+xacQh24n3j4O94sXvjed3Bpc5KpkseWuEV5eIQbt26jVhnAQ/ZlEd1CzsAKliGUs3iZwYsSLjqzvzib//AHCDk0SCY1RsyZ0W42i8zhhKSeWbalGcc+/alw76P6RoOLf/BTqu2M8auuZ981a8haLbQEsAjhEGrFUL2tKIxA0UcSXiosyRUaE1MFG9bOsdF7a6M4sZLvfEdBES7JQeQ4WbC1rTR0jQ4Tp4gcpqamQXtkpTL10OO8ye288q9/FNzjrn0DROu037mvv+W97OdV0I0mpcCjETeLic9kkOaM1gYJlCaNkzt9O5j/83ufhxOQOwtSFgJai3A2kiTBGQvGIqUsalIYg5TyFqteSkBYSZ4bRletJrE5icuYbExRKnsMhQHrAp/1RnDut37A9579EscFC8Mq/uMfIU782Q+I169hp5K0g5Dq6Bhbt+2gVhnohOToZKB0yYIOgUE4x4qfc/lCWig7QTnLufSss+Af1/S1j3s89CGkUmNET7udTUUtyNBqdISZ0Oceb3p1/7LjrH+4M7/3E7xWwiF7baA1XSe3Br+j4TExMUGwxCXR7wzoLgDcLK9q6bAkZ0+bbaRx4BbOJF13WrFyhpXBZnfCFoM+RWqYFTlWmuL9dBB6Ic5BZXCEWGqSSolLJyd4369/TmvT5f0v+OxL3Y8++GkGp1qUmgmlDh+wlUXgFQNOWftoCzM7d1IJwtv11y5HGGdxSpAZU9RGmYd2o4nN8kIPQReDr5QSX+k+Y+Pm3M1aaOpTdXLjqI6MIENNvdlA2Ix8corSTIu7VEeon38pn33569ny1e8t7NSHHyJe9OH3s//97s1OZZkQDjE4wETcJpPFECMcSNtNe817Ul9XsFwhHZCm1JRHe8cE9U1X931/zKMeRaIUuSh4G8LZWaPTAYnSjDvLE1/8wgXn/vXnvsAq5VE10JiYQCooVcqMT46jfY9qtUoURbfL79xT0StlDkvvAFgSY+O6K65C2g5BlG5OfX+1vxXsfkgHlZJP3J4mdymVwTJGORpJhPI0JnekaYbQIanQxEGJcQQvfuf/wIH7icrGQ+fe5IVXu0/+v9dQ2TnDmlwyJCXSWlKbEgxWiUxGmhl87ZG3Y0YqtSJf/07u2YC5Ksiz0v493ylP00piVOBhFglC3Lh5M0pKtFSkcYKvC85GnhfpyrcE6STSeCgCtFeiGSckUuBVShhjKCnFmPKwN21j7wz2igw/+tDH+fvbPrDwRg4+QDz2Mx8Wj3vly7hBGSaqPq1KQOpr6nFcSFEriWdylMkRLkWKwoO2guULXyqyVsSw1lzwpzP7v7zXESIcHUOWKzgpiFptSp6Pcw4jFFngozasZc2zn9A3I8z87Hdu84UXEyQpymYEvoeVgrbJCAdqREmC6gjYrYwftw1CK6wtRAMHBqpLeq1db2xsusEp42YV47rocw/3fLbSWHYjhGVyfDur14zipOGazVeTuoxV69bSTjOE72H9kNwP2dxqsz2Ledzzns3qJz+231y85Cr3/fd9kLXSo2YMQZ6hshTt5tT6umWMZy9Np2rr7fhz72joivLcHKyAvCMV7aSgUl04GPTyohY7/p9BOYmyGuEUoOY0FShE1Eyzxb6jq8jHJ2lddz37hWX+eMp3+M4Tnrloz1333KeIV3/sg9THqkxUfaZ9SWn1GFGWo7UmzzLKvkeSRLg9oD7FnRkC8JWmpBTt8QnO/8MZsOnqvnbxsBMez3gaEZmMSq1KmqYgNZFSTDrLs9703wvO+93Pfh47NU1VCrSdIxjnshD065ZCX2Fs3HZkWYYfeEjh2Ll9+5Jea9e/r6kZtAXtRBGb7SGHStc/wK4YGrsbllq1TNSu44WKdftsACWZmqlTb7fR1QES7dMqBXj7rOOo4x7Ofsc9ov8Ul1zvTv/Ul7npvIuQrTYmi5DSIWUhSCUtKNvVVihqFsylPq9MNvNdmbC44SCEYHSRbJRZISP+eX+aT8adzUCyEm0kfi7RVnbSn4uhwQ80Ezu2s9fYGGsGamQ7xzlsdBXmuhv58JH3dZxx3sKrPuhe4mWn/1xU734XtmrBDVGbcHSUnZN1tOfjpCAsl1DeynSx3NFstgm1x1i5gmpF1C/f1Pf92DH3IC55pFrhV6uk1jETp7SCgI33vTc8oJ8Ueu7/ftSZ7TvYe2SIrN1AUHi/umXqZ5U/O5VcV3DbEHqarOMR9ZeYcLvLz27GJ/EcaCERdt441JXBFSuGxh0BwkHgKZIkIYoS4iglTS1IRW1oNTdNTNMMPK6NG8h913LPj7xNcOiGvsHh8lN/xMU//gUHjY6SNqZAZKAMxmR4UhSF2jrGhhVzCqHFamUlT74XosfT0zU4pJRFOEQIBgcHFx5zM+fprf2wmIejWxCre01Jp6ienackKCVOOtpRE+0cZSC6aStifJyDykN8/BWv55L3fXLR3vzUz35SPO5lL6I1UGGHAEaHSH2fGycn8Wo1ptorokzLHVprTGbxc8uQVPz8m6f07/Bvh4hwnzWEa0bY2a5jlIcaGqRVqXC/Zz+zf9+LLncX/Oo3jFpH3pjGZdGs3k+3aFgB+U+zrFbwzyEc2DSjEgZE09Osqg3BJZuW7LHucmNjanyi0NhA9BFEZ7NR/skKbgW3JyStZkQlqIHTRFFKKRwgyyVeWEUNjjATeKy/zz140rc/3z8tXHyNO//NH3LnfueHHDI4iKxPEQhDUPZIRUacxYXmg5MIJ8CpIgehU/vDSIcV7k4/2dySuSVd4dHoVt7Ueh77ftM2B/396P9mxHevni+4k6JQoqSdxqRYEpOjtMATsHpwiIPWrqd9w42sTw1/+do3+f5Tnu340zkLrr7/fz1T/L+PfZj6cJUbcUSDg8SlCk0hMTropEWuYLmiXK5isxzTihkUiu3/2ATnXNjXDh71zKdx5c4tNIXDHx5kexJz7yc/Ae7f49W4erO74NQf4o1Pw9QMMk8JQg0YlHN4hqLKc9dLKiTmn3CSVnDLkA5MkkGSMTYwxDlnnAnN1tJdb1efcHLnONI4ZEdnY+HgZ+/0E8wdCZ4XkqYGT4eMDK9GC58shXo7oWkt9cDjiV/+5II31vzrBVz+s99QabYZFhLbqhNICzZDCIf2NVmWdfaWs1s3zWpPqGuyVOjtM7P6GT0qobNotv5l42KxPleoOhqMtFhhMNJhpJ31PhkBXqlMbXAI6HhBckt9+w7i6QargpDhPKMyOYm48SZO/dDJTP/sVwvv6L53Fy9477vZeOyDuDZpkw4PMW4MolJZ9sWw7sxwSOIowVMeA56PTnPWl2psv/jSvv1WnfA4EQcSU/JoYVHDQxz6uhf1t8jrb+Kcn/ycAWOpSUGtEmJMVnC7LPgWPNMJ7znRUT5eKeR5myAsgZIEQtCenkZbOO1r31iyy+16z8bEJM7YBSfu9WzMJwuuYHdBoqRHmkOeWFr1hMmdDdat3htjNcHAEK/+2IcWHLXlW99zP/jIJxiYbrJ+oMrUjpsYCgJ8ZzBxC09LhHQkNu+pjUBnYhFzSpJyJYQCt+zts7bQzxBAPmu8FTCt1iwnqjcE86/DYmSOkRmZzkl0TqItibZkqiig2IoikihFobCJIVA+A9VBhHX4QuAlLQ5aPYrcsYPpS/7Bl9/2bs56z4cXMTjuJh788pfwhFf8P8YlRNonEWqW7LeC5QnbKRRIbmhunyCvN/jDz36xYL9HPOmJ1POUmSzlhOc+t/8cV17jzv7Jz6illkE0Ik6YmprAYgqisrOzng3lBMIV+Y0rXrHbBuGgEoTk7ZiKF1DRmovPPZcLv/btJVkH7vK3ldbr6LxT9UAKjOxyNAoS2txguuLh2BUQi2ywcOLpLUXc3YyAKE8JywGe51MuDYBfYjK3bMPwtA+/H+5xWN+p6uec6U75yMns5QeU85S4XmewVsHkOeWgjDQCLRXNRhvf97t1fzv31C0B3RN7XaLnslzQ5U0UBtj87mgRzuFJhZWKzPZ/n6fJLZJsb27EmH8VJ+3NGv9hWMYYg+d5GGMwxqClJGq1UbII80zvGGeVX2GDKrEudlz4/Z/xtae9wHFJf2YCh+wj9nrhf4hXffxjtAaHmNYeifTIZeESN53K0NBty50S9MJiJOSK2X2tmPOW3RLm9wvo7wO7C32XFgvfYW8/vuVtrs7IfFghb3brPjvl5rbimrJz7OLPacG1PUmGQSvB2MAANaGYuO4GuLw/9r/mkMNo1QYpbTyQ0WMf0nef9Ws28/ffn4GfOVw7oSw9BitVSmE4Ww0ain6inJvlcSCWtiT6ng4noN6OKJXL+FKi45RVTvLLL38Drrhulxscu9zYsBMzjIUheZZgNSSqiP1qK/GMxDdF/Y2Vle1th6BbXrl/E53MHwFIqUFpLI7U5mTC4TyF8BRWWlwJWnkbmxtmGk1kbZDr04ynvfPtcN+D+4fjC/7mvn3iu9grSnHtOkYa0ILcgrGCLAUpAvLYUakMYPIud9wgRNYREOtkKFmFsKooL38nRZH+2xU5UhgUjkL8zMkchEU5RxIlRDkccNgRfcd7siMv3xXI6sjNLzbxzGGu8mr3/0UnG0Xbon/6Zi4rBWORSpFZg/A1TjpSk+KHHomxxChkUMM0DQOJZF0b9q5n+Fdcyxde8Wrqv/r9wkHrAUeJF598Mvs96CHMKA8TlJiMYsJaDe0HJHFMIAQ+IJzBCz1yaWlagwk8cs8nygEZIDor3e7v6Z1Iu9k2xVb0hyKrwWJlZ7uNBsfNTcpd3JyR0L2fbh2i2TLsdPvv3N/+rbeU+tx7F27uvRf3ImdDDYttFoFwAm0EXl78VbbgVxUZY8WzzJzB4nDSIaQrrmkNnnNoaUl1jjfo0WjV0Qhq2sNMTXP+j3/W9xzWP/XJYmpkNU98wxth47q5J3Xpte5Hn/4iayuDZK2IkvKQOXipgKT4HbkUZFKSS4sVOcplKBKUS1khmN96WCSUS7SsIWo3GZOSfds5Q9t28qtPfnKXX2+Xj/TbrruO1uQ0SkkMbtZlLjopdt2BoevVWAmn3Hp0Mw1sJ8un+yxVZzBSFrAOIQTK0wilsLhZERfhII1iSpUKVAL8davZEUiefuLrGP7Ph/a/meuudl9600moG3ewTpfJ4za1wWqHFd6ZwJycLew2p7Xfrbcyf8CUd2pDo4tuCKRLyOyiCDU6fC1RSoH2kGG/4qr09P/ZN9TleMyWEYDZyVjZ/q2XD+LmbZ2zIP0QIVVRmiDPKeU5A2nKYLNNZWqGL5z4Nn530jsXGhxH7SMe8vG3ins/40lc7zJK++zNVdu2UW/FrBpbgzEO5wS5tUw36jSjNr6vkaqo/1IopPaHlez/aUzZPZNU11Doheukg/d6ersp4oUnotdL0WvczL39/vF0bnydX3V3NtVadng5srvw647Vnb8U44pQqiig5iy5tcWYDhiXk1tLksVs2bKFwdoAZIaJm7Zx4LoNnPXb3y347f/56tfi37PfU3rjn/9Ktmkz2c4JBkOfUhBinCVOU4RUs2HYXn0NRG+VnRVj49bCCcgROKXxPA9lMqpxwkCzzdQVV3PRJz+3S70bu54gOjGOMznlMMTa/oYwv0Ot4LbBCsgUJFqSqUL0xopi8urGOHWeI21BMhRKIhFgLdpA6CRlEbJj5zQ3xC0uT2c44HEPofKseYbGBZe63773ZNJrt7GhPETSaOH7PuOTE7vpl9954JzDucJgxPP6vovqjd10V11YFCAEpNISK0uiHbkqDI+w2WZf5zF5xt/47n88z3HZNc5e0i9xf+CJLxPP/Oi72WRiSuvWURtezc4d06S5Ay9EVaoMjowyVK1RcmCm6shWk1qo0dLhREFwNbLwWHS37memU/hrVtsHZkN5dwRRQSNk35bLhVumJJns3xLV7fNFobOuf6tvjBVz5qEV3c0Um8zIdUbsGdq+meXq5KqTki6KM2pZpF8LIUA5rAcmEOSBwmhBrVJldGAEMkegNAEKnTumbtpO8/d/7nu6RzzsXv3jyhXXurNOOZXqZJ0RCxUlaWctMt9hypqGyEg645pjzkuF0zhUjxdrBbcGRViq0weUJBcOa3NKUhFv2co5p/0SLr1ml/WQXfumrrza+b5PpVIp/m1sXwG2fyZctIL/O7rcCyMWGnOCgsDlcjNbJ0MIgXICbYsVbRgMMLr3vri1Yxzx74/gQe95Xf+AcOUN7szPf43r/nAOI4mjisJECTY3lEql2/GX7vlYrDOmJi+qW0pRbD3Ytm3b7XNjNwPpwGYpzqY4ZchVTqpzrDJoYanlFr19EnXdNtKLruR/T3gqstFecJ7gUQ8Wr/jCpykdfCBXN+v4e62DgRF2tiImphukicXEOZ4TDJZ8QgVkbWzWAmEXXbnDnFharzemqy+i3Dw9kd0GuejmoMNXKP7OD9cURPuucTE36RYe5DnvlLagre1sOcpZFHlH4bkgCKfKdkIUnSJpziKtRVtQxhV/hUSgsE6QWldsDtpRhhOSqVZEYmFk9WomZqapVquc+cc/3OIv/8s3TyW9fgsbgjIVZxFZQhQ3cRpUqIuQb+d3wpxBVYT/er2nK7h1kCgrsMZgcOQUC5sBP2DICMyN2znza9/chVfbhUi27aDkBwC0Wq3C/dvBrGuuZ/87wspiT4B0PQMRHQOks6oTWmAojA1nLEoINAKZW/LMMt5oc+X4JP7G/bj/O964wO900VdO4bJf/J71BKxVIY2tOxmuVLCpoRxWVt7fEsIBSIH0dOE+mOcpbDV2t2cDyDM0DqUEQkGOwbnC2KgIWK9DVqWOvTLBUYOr+Nxr38Cf3vXuRcIqB4nHvustHPvyF3BJ0uCGNCYcXcXgwCo8POJGRNaOKQUBUlji1jSBlvSLw3W9GHOfzZY0n92nCOd2Q7q7ytG6WHgE5oedFvI7lAVtxOymbLHJztbleKieVWg35NUVuupVgvU6BoZnii0wlsBAKbeUjCU0hjA3BMbg2bnKu13+kLYW3xbHBDmYeoyLcmTmOs9MI/BQOkSHFfxylXpiqO61jqYv2ZknREpQb7c499xzb/6B/fkC99ef/4r1g0OUNMSNOsoVqZguz8jThMCbmz8sRSl0J3op0SvGxm2BdKARiNyRIzACLA7POUZQrLGSf/z69zS+/8tdMsrv0hq9E1u3I4wjSRKEzRioVojydDYm3ds0VjwbuwbKFoZc7yqtN51Q+BqX5zjnkKLQPnHOkQtHLBRy9Sr2PnBvjjvpjQvO/df3ftRd9OOfsW9YRU7XGRwexEVtyA1VL6Q9VUf7C8uer+DWY0G/EAJH4eGYn1/S5XvsLgjAExIpBbmSWJsjnMXNcnLARC2qfkgUpzS3biOs+Vz5+zO57rrnuWe89c2w78a5+f7gDWLv1zybFxy60X3xHf/Ljiij7AzrSlVGxtbQnBlnuj6D50kQEqEoOEm9ombde5ufQkzhGOqtJSPZ/ZwxCX1uF+sEUPRVcAsoCcX92s6RtsP3sFhk/7mYCxlJB3QWIgU5X4KzOClRHTeQdJJOMe5Zj4oRkupIBSslmRAkztA2htQZjLVYW+zTDCWxNpixComSHHjPozjm4I0Mbdz/Zn/3V7/yZXQYsOWmHazKHarkI0MNJkUaIC/KHeDUXEIBxW9xoqt6u8LXuC0QHaPVILBK4KTDZBkqyfEyR1VJEuf43qc+w3NPeNRtvt4uNTbq4+M4k4EzhL6HdfmstT8r5NTTuVdWxbcN/RK+c6SuXEKqin8rKTBCFKshJxBIjHDkviQqhdwgc17636+Cjfv2Dbvx7/7ozj71BxwUlPGm6tSqZW644TpWr15NFEWUvBKeH5KQrYhz3QYsxmES3clBgKHQK3FawzyCqL4D6AwoURgVLndI63DCoWXR+HJnkZ4kcYbcZQxXyyghaEzUaU7X+dizX8oL3/pWFx77gL6n4D/6fuIlB37CfeONJ7HtwiuIJ8fZb3iUIKsRx3XCao08djSiNn5Qmc2+AmYn2z4jQrCIy72XwHzr8S+Lqt3M5xZ6LCBb3KewRb9eJKuoWFQUnxthO2OqnTOebNcDInGOor/LwjjpJX6CwgmJMhJV5LQU56RIL3YCMiFJjSU2GRGOVAtsyUMEIdIPMJ5k/yMP598OP5iBtatYe9fDwaWw8S7/1IT79xc/h4++6a3odYO4Zosh4WGSBD+HwGlkrorQb3eGcgV5tZtKr5ztuI12fx9YznDW4klFIhyZs8hOqFbkCYHRVAE30+KMN7/bPfA9J94m03yXGhvpTBNhLL7vUwp96tOTeEER1zeiv2bDiqFx2yEoLNNuC3B0tAgEZF2yaJ4hnUMj0aKIgyZKkIc+jaEqL/3YR+Do/hTXzT/8sfvWSf/LBqMx9UmUKQahDRs2sGNinNWjYzSnm3iet+LJ3IVYLKzoBFjnkFrD0OCC/Xc3hFA4Z3GZAWtQnkIJBQqMM8jQo9mKGBoZZqrRREpJ1VcEzjEiDF9767t5wCUnuMNe+YL+geyQfcQzfvhFNn3gC+70r3+HG5IWo5UqaRbTyiy5k/iVGta4IuuK/qaoXNf13pOlwpw3447SbF2vQdH9/56/xWJizpPRhXQFV0WRd6pCdPeVc+FqUbgAnFDFs+iUCugKK4LoZIR1Cap0SKqQKUGqIFOK3PfwhgdZt+8G9j/sEPY99CAq6zfAXTfe6sln8B5Hi7f/+qf8/eOfdOf98ldM3LCVmsnYKwzx2gmeMQS6yEyZC78Xg103JbjzyYoK7W2AMxblexhyMmsIPIVGooRDWAiNIY8SLvzVr7n3sQ92/rH3u9XvfJcaGzddfx2e0uRJG1UKZqu9CjfHkp5PYLwDjJfLGk4U7k/VGXychaJkQNEBgyDAtuJC/8YXtK2lGWgaAz5PfNULFxgaXHCZ++kHP8kBMiCst6lKiQfkLqcR5QSVMo2ojfIlhhVRnV2BbmHC+etYJ0D7Pk5LYpOB35+NMr5z52432o21HV6BwlcK68DlnRW3lIV3o1yiHsdorfGchAyUFSRTLYzW/OlL3+DGSy51D3/9K+DgA/ra48bX/5fY++6Huc+98R20GxHVIKRSKhE1DFKFyCzBOUuoPaYnpxgbGUIIwUyjQVAKyZ3rm6at2D0LnZsN10hHZnICz0cqRRylSAm+1mR5VhhwSqCUwjlZcK+cAyFRAkSSEwQBzjmMsQgpsUJjcAjlYRBkWFJryIXCSoHTEiElTipyY7GyUHKNXE4kIBwZZt/DDmH9oRvZ/4jDKa8ZhSMOWZKA091f/jJx95e/jPNP/oQ787s/5MapGfYarEGUQWrxlVeE5ZWgXC6RRA2SKKIa+MXiqmMkreDWQaiiTSGLono5ltganHAoISDNqJmQ0VTyrQ9+lGcfe79bfa1damzIJCdutBgOQ6IowvO8zurLzjGnO/sK5oiNKwbHrUMRVy1y5qWdWxlrW3g2hIOo3WQgqOB7GlUu02hP0xwo8aDnPZ2REx7f303POt99+lWvYz0+7c03MFgdQnWyWHqZdF2C2+6e6JY73Dxre1YDg7mQY5wm5EriujmmPZjYsfP2utWbhRPdjAmBxfV08GKKt52pXnZSTbtVZf8/e+cdJslVnf3fDRU6TtoorbSSdrWKSEhIZEwOEogoRAYTTcZgkwwmB4PxB8bGGAMGYwwYsAGTcw4CBEI5582TO1W6935/VFeHmVWclWZHmvd56pmZ7p6uW1U3nHvOe96jHKjUYV3KmpEqe373Jz76rBfyko980HHKCUMXGjz0fuIV//5h971/+gTbf/sH4mbESGmEJEsoBSEuTeikGQcffDCze6fITIKnNYHnY9O4ZxK7Ae/qYJbc8sEicLgsJcpSPM8jDDyklKRpShRFlEolMgOpSYCuSJ8AYx1ZllHyfLI0JU5SpPKQJUVqHREOoQWt1OBCDxGUMUoQO0dkM4xzWCkYPXgjBx22maOPP46NRx8J69dCOYAtBy9tCT/7j2771ddy1bXbaTjL6W94xU1+30mverk46X73c1/7l49x9e/OZWOlRNqeZk11hDhqE2rN1Nws0qZMjNWhE9HstFGlkZv62lXcFLphu2IuN90NqhGWTOYLc71aJnGWsJ3Q2b6bS//hY+6o0x8Gx2y51f1jvxobN1x1FWtqFaKZWerlgEy4XiyxcGf2Fqnu5HPTaoeruClYkeegy+7krV1ezt0BAfk9r1frtFsxTiv2zs4wN+Lx0Gc9ha3Pf95wZ7n0avejT/0n5bk2WXOSEw/byuzu3b23lc13EBLbFdjJn5s2ctXo2I9YOIKdlkjfQ/k+bFk/9Ha6oFbKHQ2HxPQMINnlApCTN61ACIl0oktd7BdmLIxkJxwl52hs307Z86mvmeDjz385D3nu092WMx4BWwa8HHc7Sjzi3/6eC//+X91vvvR1okZCYBVgsNZSVh67pmZZOzIK1jDfmIWucF1B2Si8qoU8/O2JmyOeFqRubSHwglwKPsnA5lkXSijGqqNd3oLqfZ/rGnVSCaT0SU0KfoAuV7Dao20NU52ITCuCkRIt52jZlEQaqmsmOHTrVo494Xg2b9sGG9bCUZuXdieunHRMTdHecR3XXno5V/7xj+y87Cp07KjWR5nOUvZiOP1JZzqO3HjT5zrlJPG4f/9XWt/5ofvef/wXaSlg12yTQw47lObUFIFfoyxhZm6GmqcolUokS2r8KvIwnuyF5ItKukZYUOABnbk5Rmt1pBN8/VP/wVH3PuU2nWv/GRvnXe5ElJJ0ItZUKrRb81TDAGPylWihnO9qlG3pGCTdZrLP4VAuF/TKpKTTjtDlCtNpRjRS4Z6PeShbX7YgPn75te6zb3kHXLuDcpQwpj0md96AjVPCsJzvTrtx7nyXaHuxZrdP8t0q9gdyAVhHlCZkOlj0vpaK5TU3+ryIQStJONHNjCgMjP6bCxfhLO0wXi5hrKQxOcOoFJz9uf/lsosv4bRXvcRx7LD7/rjXvlgcc+TR7isf/Ddau/cyMhLQnNqbq+AqwSXXXMNxW7ZQq44wPTdFUCnfbte+X2AdpSAnWlubu10ik2GdIax5RKYrxCUFQmqElnl5AGNIsjQvOeBJUmHIcGS+xo2MU1m7hpFDDuaEbds4aMthjBx9FGw9dOkm1vnXuM4113H5RZew8+qruf6SK2hM7oUoYl21wlpd4tCOwzRj0sZuRqtVmi5h7qLLGDly4y06ReVRDxVPOHyzm/7D+XzxI//GH3fvZCwIoNGi5AzrRkZozs9TDkLsaiT3NiMnCwPYvJqulF1jt3jf0mo3CcMAkyUEqWBMCr7/mc/z8PXrHFsPuVX9af8ZG7PzmCRFC4knFZHpUpDcgESu6Lsylztt704DYbHk6a69PWYv/x6MUjSUY0rB1vvdg5Pe+zeLOsgvP/kfzF14KRuUYm29gt9J6ERtxsZHaXeK5Sx3qwkkwtkeKW/1Ge4/7OteKqUw1uIvyESBPK4f3QHtujHkehZdQ9P1x/tgymWPvNzNJBicB8AS+HnItVytEc/NcPjmw7l+7wx7fvo7/vuG3Tzxr17qvIcMZ6vIxz9IPGnNGvfND/0zl5x/LhsnRpmOEjwpOfz4Y7jm6uvYuGaMMCgPiXnt6+cdpWi8r/NYJO1OhyyzZMYgtKJUrSIQzMcRDWvRo3XaaUo7STFK4AUewvNIs4ym0yRVn9FNG9i4eTOHbD2CLccei/+A+y79qi65wjE3z9SV17D3mhu46oIL2X7ZVUSz84Qoyl6AlBLXbrFppEa5FpLMzpB0pqj7ASUvpI2jKSxjgccvf/h9Tn/cA2/5+Y/aKsaP2sqLn/YEzn//R9yvv/cDqmsnaO6dJI4ijtx0KLuuupqRSm3Vs7oEFJtG0fWKCwROqG4YNEN5PtpTxHGMNJIRFXL5r37Dcd87kYO2PutWnWv/GRutFkmrQ61cJ5qfyyt+ZgbpZG+S2deAk45Vgs9tRBED75VsF7mWQDH2jBBkpYAplzJ292N40Ktftug7fve373cXfvuHrJMa3WrT7kRo30NrRZwmGFk8uD7NTjlQ5o6bqO/MuLkgotAKrTXjayYWvddqtW6fRt0q9PIaukZuYWzkhBSHwBZKkMWOSRTZFTDXbjJSqxOnKWtGxpjbtYf1tRHc/BzRFdfz0Vf9DY996fPdYS/58+Hedv/jxaMnXus2fukrfPO/Pseh9XFkxxBGHTZs3sTU9h2MjdaJ08XmmHTDia/LtVY5AaU14wCkmSEyGU2T5KnrvsYFPo0sxngKV6miymXCtRMcesQWjjzmaCY2HwIPudfSR+GVVzuzazc7rrmGHVdew86rr2bP1dczv3eSMb9MYCxeZlhrBYEXEgiBs4Y0jglxlNOMUKSgJH6oKUkJNoI0QwpDWYVc+Ydz4eJrHMccdqvbe7fXvUzc7VEPdz/4/Be48Ce/JJSKS/dOcfCGg7DNVi8zZRW3El3Bu6JWFU7kadCiP0a1J+lEHZSvCcOA6bk51o6v4bv//p88d8sWxyNvuWG734yN7ddcx8TICDN7JzmoWmF+ukVYLuGyVbPz9oLshktslyRqc6J/z9KPtWTGZVS3HMKTPveJRZ1i+6e/7n79pf9jPbC2EjLb2tOtaZNRrlbyKrB+ZSDWLbsqgxLlcv9lKleNxf2JQW8AQBzHWCmpFyUABrBz+w7W3XFNuwnY3AC1A8RvJFZaUpn/LJaD3BDJPWNWWLxyhWaa5iXOZa7bkbZaHDI2QUdA3Tl+/tH/4MKf/NI9+k2vhRMGsqeO2SJOfstfc/K9T3UffvPbWD8xxg1XX4caGcVoTWbMPhWLBQNepGXqu07kY2cm6ZBpAb4mdpJOZpDlkNLEGlStwtHbtnLwli0ccfxxcJ977J/W/vqP7roLL2bHFVdy/cWXks436DSapFGETi0hMC4lB6sQ22jjCZHXibUOIRxW5rLWZJZ1pRHajXniNKLsa4SAZqeFcBI/LGGcwU9TvLmMxrnnUzvmsNvW5hO2iYed8BYe9oeL3Q8/+Rmu+PEvmIkTRoTYv8TDuxy6oj50jXCbm+H5euKIoghdCuikCSaN2LhmnOt27mZkbB0/+ex/86DDD3Fsu2XhlP33nJIE04mpeQHtZotSEOSVRRG4rrUE3QmpN9CXXuJ5paNHqqMgWsqh+3Njplo/ZJKnHlryHHkrZV6kCElLa9KxCs944+sX/f/2T37d/d+//BuHBGX85jzpXIPRchWbxpRLZeZbTbQf5JyQfmvBue7feQuEk92i6AMEQfr/09/N9s89SNTrhw4W6gnI7vXdeOZL/3yL/6/43xtDLxGkG4Za/N9FY2VfbOlGv8wOf27BT7HoDN2fhRBTT18jG1j7JEZYnPSQfomwttjY6LTaNxmOHEx2WaSo2YvLLhVF/aPc0pC2uzPC9nZIPV4HgCtIm7YvQuUH2E4MEsIwpN1skjabZGlCSQcIJXBX3MDn//J1PO2db3Lc79ThWeMRDxSvXPvP7svv/QChsczOtxkdGaEdR13hs1yuPNcs6canuxoWRf8avBe9/jbQn/d1jwu9Cifk0PtFhk5+H0ROqBaFxkVf6yJWknnpcJWQDYdu4sitW9i4eTMbtmyBzQfDliWSN4H5n/7aTW3fwQ0XX8Z1l1zK9A3bMa2IUAgqyifMMnQnYsRBoD1CqbBphopTlMzQUiJtzh1KbQoShJDd4oCQdZoEAqTv5YkAzhIEAVIIDODjkFGLsBxy3q9+xf2edsbSLujkY8RDT34vf/Y/P3Tf+tR/MH3NNfk1WNvjqkmbq40sTEBw+3iehfHZf/Zy0dw1jPw7erPBiuerDV6kW9TntdZIqbDWIo2hOT3LwWPjOOu46re/55g/nc/6bYfcojPtN2NjdtceSii0BV94+J7CmDRPzRxYXLQtJHNvfCG9q8AKi5X9mJlF53URBhbgojjS4ALdN0wsnahJeaRCisALykzPNCmPjjKfOuYCxQvf936477Cin/3p2e77H/sY61sdSlkH3zmEy+MxUvl04gylg/5CKbrUUJFnobhumpR0Em1znY/cXd7XUyl4JH0Sq+0Xxer2ibxQlMxVEZ3IzzP4k5yZb6zBUWgNONI0xTmH8hXKgyhN0UIjJTiTV7iVUmK7vKGipoiWCsjzyiUCP/RIXArOkmWmS3SUvSqXzjmiTkS1ViZLLVEU4XkeWuue3kF+GLTyyUyKQuF7miwx+cIqQDiTk3d1fmPyoni50qZ0Mi+WV0hoZBlOCoTycEKQCUnHSTK1WBbepHFeI4PhxbC/V+l7GhZif4y9woMxlGEihxdv0c2SGvSOFZ/HgXYSm1iUUmTWYJzBCz1wCSUtiaM2mzauZ+dcg+buHXzydX/L6S98ttv4508fXgpOOk6c+cVPcc47P+x+9cWvIZ3CjzLqniZLWziZq5kKB0m7TUWVUc7hpMbiMNaSCUdmLRaHEhKlBFpIWo0mWgrCMMQ50+sfrSTCBWH/fvdEtURX30Jg/QDCgDmT0jAWb7TOyEHrOGTLFjZtO5JNxx6DvPexS99yXXy1Y+9edl59NVddegnXXnoZ0zt3IVODbyy+yQurrXN9t7mO2wTGolx3YU6Tbr0M8iqvzuKyghQu0EJjHZB1+xV5+CyXQlc4LMopMmvxLCAMQjrKoaZBxjm//TX3u/hyxzFHLvl6vSc9VDzuSQ/l+o9/zv3kf7/C7suuZPPIBONGk8w1CDKLxlAqlenEbYzLcnl7SS4FbzKyOKGkwq6x0TUKGTYMiw1JDktRmcU6V1z9yjU4nOyHEwVY1VfizUXh8s1SFhtKMsQZ0FJClOcATfiK7/zLx3jO5k2Oe55ws890vxkbM3smUcbhCw9sRJZlPfOvmGiKFE3RFaCywq6qv9FdeG9i9i/IdPnvOUEzL6FjWTMxxq7JvQS1Op1Oh3B8jB3tNnZ8jKe86mVw/2FDY/5HP3NfeNcHqM3MoVttglCjhgp8yd5CAEWacv/9flZR191GzhMZNB2Fs0ghca67sx+ozDm4yy1KHPf+GPgput+XZQbPy7UHsm6NF9/3kTIXErEuxZcKpSQSQWpSnHU4p3HG5FoEpRKe0kRRRJalhGGIQjA/P4/UAqFVr2igtZYsyxAohBCUKmXiJENKSVgukWT51KuDgCzLUF2/knMCpX2shU6a5emfXWEZIWS+O3AWEAjPyytoSsl8J0IoSeYywOJ7EiSkSpL4IUZ7tKwh2oe/v1quIDuzN0u2XrB36T3H3vNdAgb/vzA49vn+jZxH20HCaH8T4rrVR0uBYmb3Lnw/4NiNh3D55DRf+dC/cuJ5F7n7PffpcLfhhfoeT3gsJ979FD7xjnexsbKG+eYMvvJxaQcbRQRKU6vVaE23GBsZY3a+gdIa4Wu08pC43PhzBlzudapW6/h+bmDONxvEWUJYLuGPjDBjDJmUGFcY1hIrPZznkSnJxsO3cMhR2zj0mG3UNh8G69fBlnVLXmzbP/21u/7Sy9l18WVMXX8D26+7lrTZouIFVH2NihNG222qXoC2rithbruKobkBLHuv3cKTDixOBeyAZL50Mn9uSGx3RshMApkj8Hx8YO/5F7L2mCOXevk9HPLCp4tnPfj+7k//83/8+EtfYWp+loPLFXRqKCvNrl07GR+r4yufOGuDzbN7JFCuVjCx6SUxDM2CXa5hX+q+YMTvt6YfGOj2hz7PbzH/pegz/TGcfyYwArF3ip//5+d4wD1PuNlT7TdjY/fOXShr80UAyLLsJot09SaYu7h7Q1AYYIsn/oK81uv00Nu2OkA5SdpOCKVPPawxMztLQ2qSiTpnvu6l1J/0yOGhceHl7n/f/2Fqs22qwMEb1jM/s3co/FFMHQsXr6JtC42idMEjznfSuatcU2St9Gs39D7XHeCJsgsWqOHpTEiHcBlYhTMZxhiyxCGlREkQ1iCdQXt5QTCyXN9BqXx3Uq9VmJyZplqtU63WmZ6eJs0yqqOjubqlBOcc1oo87OcEQkmUUkid77bn2x2CoIQfBrSzBGkdJe2R5KnoaO0TRQmlUoiz0IpaVCoVrLCYzKG0ILOCJIsx1nUNFIhMihgbgdCjnUVkaUwo80UtMhbhwUwS0Qw0WTCsHsoVO5y3wqPVhdel6As9T1j3fSuhVirTmWvkoRVfM6IUvpFc+cvfce211/L0N/2VY7QKR3Sls48/TOjjD+PFW//Fffz1byDu7GXMOsa8kPHyCI2pGebbEQcffATbd+6gNjFOlMTEcQypxfM8lFSYDNI4IQxD4iRlttXBC3zCNQfhYWhEbXZFKZ1KiZYW+NUKazdv4sgTjufw445m7NBNcNzxS1+arrjBsWMXU5deyeV/Oo+rL7iE9vQ0QVHozqQoKdggwFMldAYyipCZQVqJb0x/k4ftZpTlcHTv+ZIa2A0ruH4oqfe9AlS3t+vU4KUZ5/7q1zz8rMcv6YyLsPVQceLrX86JT3qs+9FHPsaFP/w540Iy3W6wbsM6kk6brNkhCD3C0Ge+OUcnS9ETZdrdIdQPq8je38NznezOu3Io1LBivRr7Aco5aHW4+o9/4vBP/pfb9Pxn3GR/F87tn9X+U/d9jBvbM88oFp1lpFmM9hXO9mOW0kFg8gdpZFer4S78sAo2MBSDVZJLRQK4ofLYbpDR1v2scuBlBq01IeIYvQABAABJREFU01GMPngjV9mY4x//KO791tcPP/gLLndfe+ffsefsP7HGwMaROlN79lCulnqFnHrNKgbe4O8LuklhJ6YqD48IBgh4XTetoM/RKb5r0OiwQKotQwX6uv1hMF6amtzTEAQBQghSm7uyQ1+TtSOcyY1cR668KJQEJUnSnCHvBLl3wtOEYUij1SRNUybGxnFxiu1qwciuh8PiaMcRnTRhdGyCJMu/B61IsjyEI6UmsQanNMoPmJ+fp1qtkpiM6dkZRsbGMM5ijCEohf32ADrwEULQMRmV9Wspj48jQkW1XOLwjQcxWqnjlcrU1qyDsQmMtbBhDHX0AJP/3Kvch571fA5PY+pJuug53dio39+ejaVAkIvCAWQqLyBYiMUVO27XDbH4XhkZBszECdNRh0gJGK0yG0ie+cqXsvYZT9rnJf/hA//P/eLzX+KgVFFPHKKTkMYZ+D5SaxLTIQh8lPYwxpCmBivA80N0EDI1PU1tYgIjBJOtedpZQlivc8TR2zjy5LtTP3QT9YM2IB6wf8ib6S/OdldeeAmXn38+k9dcx8wNuwhTQ136lJxAx4YQCKXOvcdakJqELE0hS9FAIDWhVvhKksVJ18iQ3SqpfY+k69ZBWQrBu+C3iJ7Xoxtm6M5rnqeIrGXaZLTKJbJDDuK5738XnHjM7eYjaH7r++5nX/wqey+6nEono5SkhJklcC4PGYk8/BljSbubklzV1vYy/PqGcH99KuaoIQ7SXbjybKIkpuSz26SYjWt57of+H5xw4yGy/bY1snGKEoIszfBlV3u/G9fqLTYL/+mubGh00VscbuWk7wQ4J0EqMqHIfMfuxiwPfu7T2XLGQ4c/fMWV7lt/9w+4y65nQ9uwrhRSMhmRzjkhqRxedIqBZukbCMOckYK4mfteenaC6HthTLcSZyb7PJPB6x081xAFdUAszIqcoKScxhqIXAIOUmvIkozZpqESVPJS1NZihcRK8DwNniKSLl/wBZTXjSGkZKrTwhuvEWjNzqk51pRGcEkeOslSizMG5Xuo6ghlrbhheobR8TEik9KOYiq1KsY5Op0IE3pMO4tX96G+hsrmzUyMjjCuJIdsPhQd+BgB1XqN2kidoFSiNFKHe9x8fHMQ+/QPJhm+VCta56TYcUMerhBdLoft8nyUA6nBDwJsnDC1fQqvVOKIiQkSBDumZ6iO1Pmvt72fh154tbvb6Q+F+580dG9PfvJj2XbsMXzxvf9INNkgVD5jG9fTTBK0lrgORFhsZkiw2NAj05oOlnbaRG4cIzh6K4ceezT3PfZo1hx5BBx9xNIXyvPOc9H0HHOXXs11l1zKRRdcyPSevYRSUfYDdJqho4itpQpxu4HOEkIpCaQmUBqyhDTuYDoZntZUtYcX+AhrcNbi0pgkzbknBfHPiNxP2pMiYDgMshQMBFMwg8R/k6GkJsjApTA9PcvO8y5m44nH7Jfz7gvV0x8uTj/94Vz72f92P//K19l1+dVUbcYaHeDmm/iZoRaWEdaB7I4ul0vrqyHjoUjrph/u73HKuh8ZCHHf1aCcRSUp5SxhfsdeLvzSVznuhNfe6Of3j7FxwcUOZ/JovzUILXK2t1DsJ8fJnRPd3X8O2Y+fDUxlOQGp353770kyKYjIy8k3yyGjRx/Blic/BrYOT4Z//N//Y/e5F3KY86lUy5hWg+k4xXo3HeaSA0aGHRhckmI3JHFiWMLPDdTvyES+M8gva/Gk1ndV5juuwWt0IjeEmp0YvxSChiRNUZ5PWK/iOUG73Sb2cp6EE6JLMLRI3wPt0VIOrxQyPTdLSIbyfaZbGcpaqn5Apx7SchY/0EjpkwmHcTlPY2RinNr4KEf6HpsO25wXsFKaw444HGpVMBmMjMB9TlyWKK6bm4UsvVMwngpvWIFC+M8JCMslZqem8dCM12t4XsD0zp1oP+CIsXGmGx3Gxtfyu//9BhddcD5PKb3ecY8BHsfmraK6eSvPG9/o/ud9HyKbmufSHXtz3kxGTv41KamzhKM1Dt12JNtOOpGNR26F8VG4x92W/nwvudIl1+/g8osv4qJzz2XXjhvIohg/MfhzbUakZtTzGZUeSauDm20RakU1KJHONSgBQeAjnKPTapFkKUEQUC55OJOToRWOLO2QJbnnTSuJ5+femvzWFlonrmtk5NbG/vJsDYqk5WUU8nBD1O5QL9WoqwCNpBUZLvjNb9n4rCfunxPfBDY/8yli8zOfwjkf/LC74Ae/YM+uKaqyTj2s4KUwvXMHoReiemFe289gKX7SJbUDFBoUSAryvrwLF6NUzpK2YybKZUZLVb73uS9w7IPu78RD77PPMbNfwijzP/qZ++Kr3sKmyOHHHUJPEqcRyldg6BZhy2N6Xtetnkm7WswL+vG/LpN9MKKaM5+7x8AkkXd2TaQUrdBnWkN922E89S2vg+OGCXM/fdu73B++8m0m5iPGLYTWUq+GTLdmqI+OE7VihtJt99XEG3mvL1k+TDAtflq6RCtB/7qGDCo74NkQ/XTB7oC2wiK1l4dZnCOzhtQ4LAYhFKkWdAQ430f5Hpk1dJIYqRRoTSdLOGzrFtZuXM/k9DRBtczJ9ziVThaRJBnH3+feNObmKI+Ook45aVmMhtuK7Bs/c59/63sZa85RSVdmGEU58IowirQkKg+nFDV4hAObpITKo6x9Wo02YRgCEik0zXYb3wtpW5jH4NaPsjdUPP7lL2LjM56wz1vw7b96m7vygkvxtcfGgzew7W5HsWnrZipbt8CRhy+9D1y003HNdVx37nnccNnlXH3hxWTtJp6QeFqSZWm3KjPE7XkOHh2nNTtL1GoTeD6j1RpaCpJ2h7gTEYZ+zn/TGj/oZ844lxdiC3yfTqdDGid4nqZWruB5HkmS0Ol0UL4/4MUYJGnLfjbYEjbmBbm9CIdZmfOwEgVgEXFMRQQEwqODYk/JY3bdCM//0LvhpP3AabmFMOdf4H72pa9y3nd/jJxqsk6VqTtJkBq0teQpNpY8Ydd2Z698XiruF052s240RQq7EOldVlRMYPElxMYQK59GrUrjoLU8591vg5MXh8n2i2ejNT2NSxIUGqUlzuXFkbTQuHzZ6FWUW8lu39sLPfWFggghXDelcdCNVyRdSZzQWCGIlWaPhPZImRe9522wZVidb/p/vuYu+PoPOJQSvjJUQ02nPU/TpaS+ZK7TInR+rjuwsE0D39TXyl/4nhxicbuuUZETxGRvkDq6LP3iewZ1CLpGh6VvhBS7IyNAKk2r06Zcr7LpkEMoVSsYZxkfH2fDYYcx7xIqo2OMr11DUKmC1jA6AsdtvUUTWe2WfOgAhHAWYZIVPZ6KZwz5M5cLdtrSge8HZJ2Y1AmEAqEk7XY739mXA7IoYaxSwU+gMddgLPb56j/8E0ec8zv3yP/3nkV94LR/eJvg0mvdkguQAZx/rWtcdQW7rruBKy+4kO2XX0Vn7zRBbKlJQVUq1mQOk2QESiKEI4raSK3wSz6ZCMjm5qhIxcjIKMI5slaTJE3xlGa8Usm9A1mKzVJSZ0hctxy48nIZ6SQhCHwqpTLWWtpxjO100FoTlMukmR3Q/Bh2+O+vEMpCDKrFVstlXCtfkIU1lHzN7slpGtt3UTvp+Nvl/PuCutvx4sF3O54HP/YM973P/Dd/+vEvOVgF1FuWcpZ7YAvtl8HQrnAuz7ZzA5mTA1mUK2qHcjsgTSIkEs8Z/Cgi3r6TP333h5x48uIw2X4xNvZu30lJeTlL3w9oNmYIwqCb6pdjX9kWq+iTjYZSQgfeF9ahlCROE7xSmcyCU4rIOFpSkNar/PWHP7jI0Ii/+l33P+/+MGvnDXUB2ilajSZG5ZO255XJWjEig0D6AD3yo/I9lBAkJgMputoYAmROzsxMTtDUvkc7jVFekCsiOosRkgRLJiUi8GilCUZLrNb5uX1NqVZndGyMcq0OgWbToYdSLudGxNj4OGvWr8tJlVrdLL/hwFDQvOOhpMPYPF12JaOwc3uelq5uCD3ioSXwvFz7wtNENoGSJsaAcwjPomxClnWoBxVUFKMTyd4f/4b/PO3J7lnveDOcuiDUdVsMjXP+5NKde5m88jouOvsP7LjiagLryOJ2j1g4amGNBYVFGZBZroPiSYuwuRle1d3QZSdBdL05KRmZyXKSopJ4MkC5vKqvAJT0UORPOpAqlwywAucsGo0zFtNNyfaklydOFOTagrY5YNQN4o4wVpMkoer5SGMpS4nqdLjs93/gHo952O1/8oU45UTxiFNO5O7f/pH7zqf+iz0XXMH6MCCan2esVkaajNbsNGvqVZJOG4XAGihXqzRbHfzAR3geO/ZMMVqv3vHtP8DghwHtdhulfQLnGMvgB//xWU589GmOE4bL0O+XMMrZ73i/u+a/v8XadoYvDFnaQfuK1Bp0N7vCoXuiXnmV0rxU+V3ZCCkq7rku/yGH7DGilbP4nmJycpK1G9Zz/eReamvXkXo+83FKs1bmef/4Prj/3YenkPMucR952WsJ98yz2S+TzM6DyAjrIbF2zDRncdIxUh1Dpoq0nYDUhOWAzDoa7QZCasojFVrtCLxCZMqSWUfmMhwSJwX1sTEOOvQQDAIV+Gw56khUEJJg2bB5M/gaWS5BrQJhANv2g6t6Fez+xGfdDz/ySUZaHcqZWZFhlG4Luj8LL17hv1tsRBlBN7Otz+sIlCaJYspBHl5ptyL8ao2mlOwRjp1lj6e/6a849Amn3/J+d8Flbv7a67jigvPYe+11XHbeBUTTc4wqj0omGPVKlKxkbnIv9bI/lAq5L9NvMBNLDWRsGQmxtj1RsFwuOv98kRFRoO+dkAMF8Pop5YMkbBjQRliAhe0bDoHeehShcG8ojAKxyrMNQ+vwYkNdhESppV3y2e0rJkcCXvafn4Rt+6ES7RIw96kvua9/4lOIJMU05ikbw7pyhclrr2Hzug205uYpBSFeEDA5O4fwfMJ6nThz1OoVWjOzd+kwinBZXixWavBD9jTasH4dzfUTPPtbnxt6tvvFszG9a08uC2wdaZbgB14utXwThsxdXaZ8IRZmexTIMsvI+ASRc4xv2sSuRpNESdTYKE992QsXGxoXXene+/o3UzYGW/LY2WkTljVSejSsIc4MabkEQtCQlmZJEIeKSr3OQZs2UqrUKElLtT7K2oPWIZVHeaRCfWSMUr1MZWQUTrh12RSr2P/Ys2dXT9NmpWLQ2B5KN2RxyqHpev9M8bsApMVhyaRFK0cStfC0RDqDbCeUtaYK/OALX+F5Tzj9Rttx/le+71o7drP7iiu5+vd/QDVaqE6bihCUteRQKVAqQBmHNAbbmSE1hjUVD2FiIM+EMgKE6BtFXUf8gJEhe6u97F5rkMkhY0MsMBYd/bBEEZ7MPaH5/VHk5O1urld//hhwYQwO1oISLpzrq/vessd1kyiMv/y7+6nwxhg8KXC58h9KQN3zueK6G7CXXIHcduh+OPttx8hznyye+Wf3dL//whc59yc/o7N7L0nc4vBtRzOzcxdjtVHIUpJOSr1UAd+nHSe0O23iTpOS793sOe6scAKMA09pjHO4JKYMuHbE9RddwsV//1F3zGtf0ut++8fY2LObsnEomacu6m4RJNntYEUa5SqGIbtpaEWdhoUuTick0lO0jWG+08YqSEaqzEk47UlnUH72Yxct+q9/y98ibcaWk45lTPqE1nHohg3UajWSLCasVxndfEieURF34MEPWDUcViAUCmdvhfrjAYpetpMohKcWG9zFgjs4PgR56ndqM3Tg0446mDSjXBsh6nQwRjEyMUFHSZ581tNusg2jlRqf/I/348+1OHZsLWEmCY1HXUvmdu5ibHwMazOSJCL0g1wfRzoq5YB2I+55NiRdQTLRJ0ZLV5gSi6+rMDAG37uxwShdVw/C5gZHYVwUxprtmxv5/ez/Z2/nPchFYMGnbgvswLMbyqDremYRoJUiNRkxlgSLUBLT6XD0xkP4+Te+zQMf+5AltWG/YMtmccqbXsspj3uM+8V/fo4/fucHmOY8tbBE1IkoK43AECofYw3GGEZHRvA8j06rudytXz44iUWSOoHD4jJDzfdpdloctX493/ncFzjsfqe60n1Pydl8+yOM8tEHPtqt3T7HBgPWRvi+pJMlKCURmegaGzrPobC5NZ0oi5Vdt+EKnzBvM0RfAMd17b5iR1cwxGObIcsBLSXZbVLSNWPc/REP4z5v/etVI+EujJ3/9Gn3o499ivE4JjQrM4zSL2XN0O5/YRpsf1c/8BpQFCr0fEXUbOYy9FLTTFNsqcY0gg0nn8TDP/Ohmx0rO7/zM/f5D/wj1ZkWlfkma4VGdTqsqVdpNmdB5ZL8OTnVJwgCZhvzeWXrfXglRffF4eKKctH9tsIOG1FuWI9GLAqH9E0GKxxZN1zRC6H0FDAHPBtF3ygoogMifkspF1F4pkCibNcAcgIrXE+0UXsyL0WvfOI0QwZlptsdxg7exCWdJi/+n8/Bto0H1lz2uz+57//bp7jmnD9Rt5KKcxBFeMaiEWghwDnmZ+cYqS4ukHhXgRWQGov2FZJcEl+YDBcE7Gi3aU+MIo/ZxrM//4khosCSELXbue6Ac7mQU5ZhrbnJMMrCXfxdFaKrlCicXTTJGgmdJCYYqdNUkNVKHH7qPVYNjVXkdSjMyrbSi7DBQin7woth5EAWRddNryxokysR+5mk7DxcM6GEx0hYpdloIMOQrOKzM2vz8Bc+Gy7bfrM3auOj/ky86JUvYao5hV8JiZIOXqDZtXcXcZYipcTzNKVqGel5GGMJwxI4Bc5D2P6hjIeyGs9otNFokxctLAyPor5QwT0ZSHDvhTWKcJEZ+NxCz84gF2QR0XPgRScdTrq88GOvsGPXSFkiZyPH8HfknJPcwMprZAkyLXCeInOWaliisXuSqvDYc/6F++H8+xmnnige/vEPiSe87jWkh21ih6/YIwXzvk/LWZpRhLNw8IaNy93SZYZEKo2SPlhBGkcYk+Fshucs41rTuupafvuef1rAKLqt+N2fHFleU6CAtV13mRt05i0eEHf10EoxySq3+EFYBA5BaXSEXbMztHGsOfJwHvXi5y9HU1dxgGFy15687sQKV+HtyiP1/u4vxLJ/yPxTykqUk3hGEmSSMJN4scOLBNXUw+9YbCdDasVkFnPUg+4LDzhZsO3gW2ScVx/7MPHG972LPZ1ZTNWjJTP88TrBeJ2ZpM2exhzS83BI5pttpFH4mUeQ5oef5Yc2ucEhrAcoXJ6fghGSVAgyKfPibbK4B91Fv2sIGJkfmeofqYRUQiZd98jnT+Us2i4+VPcQuO5GJkOS5folvbq0+89YHUyBH5zXrLVkODJhMRoyYQhDHxHFjIYhv/jpz/ZbG/Y31jz1DPHMr/6HOPGJj0EdcQgzniAOAsKxUZIkYWpqarmbuOyQ2sc5gctMV31Z0em02bhhHe2paWqR4ddf/Qacf83SZ6p4doaSIK+KOCBTG0iv1/uskD13YTdw0M22uPOFUMTAkb+wcPeQT5zCKXAFZcbl0q/O9uKreZEySSo1DSEY37aFM9/8xv0jlbyKFY9dO3aihNwnx2HFQOScpRtLy9zXa4XSo+yOF2NSyoGPdNBqxnilKony2RF3eOSzn37r23S3oznrNS9jjzI0Q4+GdEw2GqggZGR0nFYUE6cJtVoNpXJjT9q8VtFCw68vTtdrfU9gyyzwVEjXVxAevG4nho/C22OFG9AmkX0vEcNHUWOm+OZ+X1m6kSqHvsv2TjBYpTrwfBQSax3GGGyakXY61MolOlNTXHXOH5bcjtsb93rjq8Rz/uH9nPK409kbKG7IUuYqJezoaF4fRA4+F4YKWy5aD5Dd9TA/Fj6vQfS/b3Gb9vX52wRhh47Bdu776J9fOrBJjE0SBBCWq0g/hCBk18wcslylnWU8/LTTIPCXThBtXHcdQaeNlT6ZcvhoyBzaeVhjcEr2CETCWZTIrXHPgnb5DmalzpXQT/0q4rILixG53u9FOppAWJ3/LizKF7Q7DXyhu6Q3h5WCRIINfNpSQnWcJ7zhtXDctlVDYxUAZFkK1txoifCbG1MHgpFvgaybHjGY9pkLLAmU6++Yi1nCCdsrg22FxQTQNDGlIKAVp7jKCHMq4Lg/ezDhfe9168fLls1i7Zbncu/5pvvBZz7HQTqgGiqEMWRRinYCqRTWZeBASAFuQDhrH8ZRXyAqz1bp0zlzMbuc69Av327ZlwE54CUeeG9QmOsmH6mTsI/2LbU+lRwykOyQt9ohcanNycxZTmpGyp6npawUa+KIPZ/9X7fumU88sOe2ow8VJ7/j9Zz00Ie67/3vVzn/7N/jz82zpeJjpqaYmJggiWNcZrAmBSPwhEQJiSnCnVLnZQ+QIAVaCmQSI53dh8rrcMJAX/ZwWC7CLmX9HFBMBQmuz690QuQEUJF7p5RSBJ4iijpYk1ItlTFZghZ5qKxUqjDTbqJkhcSv0pTQKIU84zWvoH7Pk2HrQWLJxoZpNAm76vGJNfgosLlbRQlNxrBlLq3FdclguLyvL6Xq4HKjT8jrTRsMWfr0iVR2gCAmXN5JOlFCtVYn7URkiWHthk3snJnCaI+d7QZu7Rgv/PD74NT9UKNhFXca1GsVptNkuZuxRAyPk/5r3V2TGHylv5hJV1SNdsx3mkysWUd7LsaUQ9JyyI5mk5c+5awltezIh/wZSnn88N8/g9QaXyqcdSjAlzInjLoMTK55UYjyFaER0W28FK63CcnbXhRCG+BoLVjwb40heKsWmjsg5LaoPYURtQ/jSVsI2m0u/c2vWffMJ97ubdsfEA88RTzygadw7Fe+787+5jfZ+Yc/UKqGZFlC3JxnolKnFoQIYwmkzqvxaonFkVkw1pKZBCEUCPChZ2j00L1ni5kwFpwcMuqWumfISwP0Q1/Cya5iave7hSIxGUo4MI5SqYSJBa2ZGYLQIzWGSn2EycY83tgoTSeZxFDafAgvecvfwL3769aSjY3pPZN4QuYV9KxFSJ2XHk9TPN9n4S2zdHPDu01Y8XobvUljeCDb7l6sKJldvGqE7NU8ccIitOb63TvZuHYjziZcdMXljB60kWaWojeu4fF/86p9GhpX/OCnbuvDHrjS794qbiNKftAtGrXcLbntkC4nezJgpvcW5qFdHUPXmXtJ88m3Xq7TabXB84mcYzqNufv970P5gacu6c6U73GiOP4eJzI7Neku++HPiHfPcFi1Du02caeDH3r5jlUw5L3s+WBkbmRQeGcGsoSkg0I69UDwMC0XJKAzx6V/OI8HXHG1Y+vKEfw75AkPF4c84eHs/sKX3Xf++wvsunYXE/56stiwd3KWmtA47dFJOnmtJk+BECgp0Ton3FhrSTx6dcMKj4XoGhtqoG/0lKZF7vEo7MalZHNaJJkE6RTaQVEYVHTTlo20dEyMXyuhlKQxO0MiBHXfpxL4jNVHmUtiGklGVgqZExlRrcq647Zxxr9/ZNGzXLKpu2fHzl6sEOvQUiGEwBiDEPvuO71iWyuma90IhM2zSehzLXAip2AJ0XVxyV7VwH4s0+JEhhU5sXZ8fA3C80i1ZmTjBppK0qr4nPmKFzP6mGHlQ3fJpe5dTzjLff8zn72DL3YVBxKmpqZQ6sar9q4UKJcXZ1SWfvpkF4My/kUlYOi/BuB7HkmSkkhJx1OYWsjDnv7k/da++7/7zeJuj3gIZqTK3ijCKg8hNUmcoaTXc30P1vkZav+NxNsX1oG5K0I4CJ3EzjWZufDi5W7ObcL6p54pnvPe9/CQP382s7UKU0rhr9+AGhun46AyOkZYq+TpoQqUBF8KPGmRZH1htV7/kX1Pg82Pfnhe9nhARuxLY/fWIf8ujREai84DNUXqdHfV8jyJdSlR3ERqgeerPLvIGa7bvYO5NEPUa8z5ikalzKlnnrFPQyNv/RKxd8cupHV5DQ8EQoibnAR7E8dST3wAIO8EhSmRoycpjMR1E9T6cdWuoSENVhoQhqjRwhm4Yc8kqaehXGFn1OaEJ55G9WmLK1d+7v0fRl69E3PVdua+9M07w21cxW3AlVdchqfESnZsIMh1d7Tt62sIVxgTLidBSofrVjzuG+z9In/zM3PU6uPMZxlxLeT4B98fHrw0r8ZCnPrsZ3DyGY9mLvSZzFJEqYzQ3kAGnh06xIK/rRhINe0SQfdFKL2rITc0LSN4/OlHB25Wys3i6G3i6Fe+SPzFB/+erac9jGtkxm5P0BmtsrfTZq7TIY5SbJySRR3iqIXAUCoH3S/o94lBDG3IXU4JzcNzAuHEjUrS31IIJxFWIWyeMeWEyLOcZFf/RmR40mLiNjaJGalXQcJcq4Ffr6DGRpj3FZe1GoRbDuPZf/s6jn3tK2907C2dIDozy0SX2CWlxDmHlLL3+43hzlhevufqYrCT9C3VnJBjYWBXE4QVEmEplavIWp0L9uzk9Bc+m6P+9jWLHtq/PeP5rnnh5WwSPq1de/nKv36MP7/b0Y6jt6zkNWcVtwEzk1Mc5K/UmrU5ZM9t3A+d3Jgq5Y11cE+XiI0lDTyyasipZzxq/zd06yHixGc82XlScfaXv0La7HBwpcp8Yw5f9zdWfVLngMjWjWBfbJW7GoSDwAnKCK78/bk8aLkbtFSccpy4zynHcfc/u58757s/4Nwf/ph1Y1UqxlJSirLM1VM7rQbtTgffOTQaObAWFsZ2L57RNShct3NJ8gVGdj+z1DVUdcMnCNuT23fOduueWEyUUvN9hCfJ4oROmkI5oBl6TMaWuD7C+i2H87jXvAJOPf4m16GlmUaXXu1skuKJ7oJKztVwgpyxfSP+i3786c7g4RjevfQMDZenCkkrkN00X236BdYEGQJoN5sEuoTSITub8xzy0Hvv09C44t0fcerCa9isS4TtNpu9ALljkou+8/07+HpXcSAg9IOb/9CKQFdpo8fGtz31yUFPQZ7BYHtx7SJVtFSrMx8nmGqJbfc5Fe57j9vH8D56szj27a8Wx57+MOz6cealoG1d12tZiHbJvHJrkZ47cAyGWgY1Ke7KkA48AYGxuLkm7f/51spfDoDSGQ8R9//n94gnv/W1pEdsZEcAl85Nc/X8DE3AeSEqKOHrgMBISlnu4dE2Tz91oquvIi2pzg8j8zVGOIfnHIFx+GZplC1lwTfg23xsOeHIVEamMpwwKOeoSoUfGbzU0Z5r4VXr6HXrOH9+iusCycEPuz+Pe9ff3qyhAUs1NpqtfPEUsqfJn2UZzjmEGsjJdcOpXIt2/ysUhcHUS1dauBtz/Zi07hochYBXcXcqYxNcPzODHa2y7m7bOPNT/7rorvzxzR9wv/jPLzPeygjmO9StQzfbrFGSX37jm3DlNXeKQbqKW46RWgWTJaxkc31oAWa4ouugC7kwMIrxI3r/L5lttxD1KvMS7vvEx97ubb7X85/J5vvfi+02Ro6PkSjR5ZLILhdD9mqDKLsPIcNu4+8UnLUlQmARxqAzw5j0uPi3v1/uJu1XrH/qE8UzvvYF8cC/eA7hcVuZrZaY8TRt36eNpBWZfoVvO9ivc4MjNzAyrMigZ7hmSJcN6DItoYHCop1BOoPCIMjPU3RagSVUAVE7wtMlMqFpCMl1UUy2cQMv/Yf38qD3vEWwZdMt6slLMjYaUzNoIRHGgrEoIVGeJrO5JW8WTIT7MjhWOobEdmT/b4HNDQ0hSaMYXyiqYYlOq40SGqQmFYLpLMY7eB2za0o8+tV/sfgEX/mx++Wnv8RBQYUwM9jpGdZ4JXxjUZkh3jPNDT/91R1/4atYVighwaz8QmxWQCb7h5X9Cq8AcSdivD5CFsVknZhKWMqvWwgMjtjzaSjJPR76EDj1pNt/+T76CHH/5z2Twx90fy5tTJMFIc04RgUBmXEopXBZzl/ztB56Pm5gU2JXNNtm/yFJIkqexrbaXPy7c5a7ObcLtr34BeJZ3/5fseWxj2J6rMZeTyPH1tERGqMkqDw11lhLGPpEUYRWItekEjnXQVqDMxk4gxIOKUHsBzU/pRyeNpi0QyXwSdptsiih5PlkcUaaZHilKi0hUGvWsUcISluO4OXvfx/hwx5yqzrxkoyNuanJfVrvi07i9v2ZO4Vl3618V2CQfS6dxRlD2QvotNpkqaVUqSKDkEacIkdHmPQE2z3LM/7urXDfew/dkWu+/FX3D69/M+vCkDIQWMdouUxrZgZPA0nCxkqFT3/oH+HiK1b4srOKW4yLLnRpEucGxwpGkcnRK8kuhpU1hQNfadqNJqHn5xVE4wQpJUmaYj2NGK9zQ6fJvc58wh3X8OO3iUe8+Hkcd9pD2Z50UONjNJwh1ZIoM2jPo1Sq0GrsuyLoYKXbuzrCMCSKO1Q9j3hyhuZ3f3ynncce8u63iBd96O9Zf+o9uLTVZK4S0ioF7I5bJOUAWw7ZMzvL+JoJ0jgh1D7aWqTNQxpaCqQUGOGIbUIni4bUSm89LIlLmG3NEoYeWRpxyPqNhNqjMdcgrNZpS01ULrHTZExpyeH3uTdP/7t3493/nre69y5pttq7Y1dPclwwHEoYztHoGxz7LBq0gmFFzg4uiDxFUbWiBoGnBGDxfR8jYarVIfN9snKJy+emmRoNef773gJ3P2H44Z1znvv6P/4rlUAzcdAapqZ3E3Ua1EYqWA+Ep5HC0bhhO4fXRjnnc1+84y9+FcuDZgubpOiVbWsA3cytboq4Ef0iZUWdkLLvEbWaBNpDKUUUJUg/wEhJ5ntsj1o89ClPhnscd8cu3SccJU5/+Ys5+JQTaZUCJp0hCUNkpcSe2Vk6UUSlkhN4hzy6xS93pknwNsIBKEjTGA+JjFL++KNfLHezbl+ccpw47dMfFK/49MdIt27ignie4OjD2eESGr5A1qvsmZ5BCIGLEpRxqNR2C50akAKrJVkgMb5a0obdCVC1AF32yVyGrzR7d+zCRCleqUxHKhpln2tdRrb5YO7/nKfxiH/7e8HWW1ZraCGWNF3NTk71NTYGLuDG9NwHNfrvFOiSwgoyaP4zt6aEc4BFCEdmDc5XRIAp+eyKOjS0h9iwjrP+6pWED3rA8N36w7nuIy9/DWtTWFMK2L39OpR21EZrtKIW1ma00xjf12zZcBDJnr2c/Z3vwW/PW53B7gIwaYYWLBp7KxULJ8zBLBVPaxSiJ5mcWIPzFNbXzGNwa0e5x9uXqQrycUeKx7ztzUQTFeKRCjuiJh3PY+2hm4isJUoTFs54gw1d6SGwJUNY4jRCSpAmY9QLuOL3f1zuVt0xuN8x4lnf+E/x/Pe9kz0Vn12BYoewZCNVXL1KpjyizKKkj5Q6Vxx1ksxZEmdxUqIDf0lUBAvsntxLZbQOUnHtDdupjY2hq3Ui5THnafb4ivjgtZz1+ldx2Kuft6RxtqS1f3rP5D5DJIvqAwwcdzoUBgcD1+kAkYHISEyC8CXzScR0ElE/9BCuj1rMV0Ie/fzncvCZjx2+Lede6L70zr9nLDKIyRnUzAyi3aRWK+M8R3N+nsDzkVqRxQnZ/BzlJGO99vnOR/8VLr/urj6F3ekhXV7gytk7A+spl/Yuxk3uJbU9cnWWpPi+T5rGSE9jfUUHQ0fBNAl/9uRllrnedqh41rf/R0yceCxiwxp2xi2unZnBBh5BpdrT3RnS4Vgqse9OhMyZXOzKOULrsHtnSL/2o7vM3amd9Wjx9Pe/m0e/8qV01o5xg82Y9Tzavo8aGSVWGqs8pOchtcY6SFJDnBlS61jq9j0ISsw2OkSZ5YhjjmUySojCkElPcYMwVE44mhf97OtCPuoBS16+l9TSyT17hv52g0fXu1G0cGFO/Z3Fi5hPknn5636IqKjcmgsSZRJEyaeJYWenSXjwBk54yAPZ+PyzFj3AH37wX5n6w4X4sw3Weh4bvJAt42uI5+ZI2y0qpRDf99E6L9xGJ2JjuUa8Z4qr/ng+zDXuyMtfxTIgy7Kb1bFZKRAuL7hWVHMdzDyRDtIoRmtNag1Og/M1DZvQkob6poM49iXPPSD2MI9/3V/iH7wOf90aIi1xvs9UY75raPQh3HBI+a4MC3iBjzEZnpJkzQ6jzuNPP/nlcjftjsXx28SRL3q2eOU/fYjjHvFQpn3BrJbsiFrMpikNY4mdBBUgdYgSupdqvVSM1SdoNjuMrFnPzrl5ZkzGXOBzvUl4+Av+nDPf9ub9cIE5lkYQnZm9Rd6KGyOIrnT0U90KRbciVFTsYsAqQYqBko+ql5lMI+736NO5z1MXFIq64gb3oxe9zu35w4Vs1CWOXLMeMdugs2MPutGm3EqY0CVC36cTRySdlIofEqIQccy66ggVofnaRz9+h9+HVdyxaLdaZGmKPiCW2duOfPwMHN30cNHlPQksSoLDILUidZZUOhIFruRzv0c9dLkvoY+jtojnfPmzQozWCMZGEeVSj/hahJQHq3UW6e8r/BEuGUrlITIyQwiUjOPqcy+Ay66/E64YN4PjjhR/9t63iFd96EMcdNLdMOMjxNUyba1oOUfiHEIoAukTOo/QeUvykEkniRodQlVi99QMk1HC6Nat7NaC133sI2w943TYesh+66JLM43aEcr1Xbk31ap9EVkOBANkIb9ELDj2hd57LqeB5qRYlzODRYZwFuXyQkypc2S+z64owoyNMXb0No4/4zQ4+cihr//df36eHX+6AN3uUEUyecMOKp7HmvFRnLGEfkASxUzPzhKUS2gpSdodkiQh9ANaeyappo7t51+A+9nZB8CdXcXthU6rjUlSpFzhDKii8BODC7HtVlDuZqOEAcY5pFKkxpI6h/MDzMQohz3iADI2unjaB/+e+lFHcOnuXVTWrsOg6JsWsmd8WGF7mQS3djYv5qyVns0i6XIeEbTiiEqtDHFCe3KK7Prrl7t5y4f7nyQe8dY38cy/fQPu0I1Ea0eYL/vMCEebfE1xDpwxed/p9qXBQ9A/iveN7B/532CDgDQsw/gEbu0E05WAl330H2HTethy0H7tYbd9tvrxOW6dk3lqjusr/ElX/J1PHkV6W0/Ap0uk3F9uoKVgSNFP7GOn5RYbHcVnVNfGkmFIw2TE0qACgSNBuoSScLnORlhh3nl0RsZQRxzBs9/+t3Ditv5XXnap2/Xp/3C/+ebXiGf3UisHtJtzjIyMEGWGpsmItaTjKyItCSpVkk6CErk8vPUVrThiJAzwGvOsz+CLH/rwHXgXV3FHY25qGi2LRWyFwxXzQT4k+mJXuYtjtjGHVwqIjQXpIYxHK5Pc98lnwbHHHnjL7dZN4uEvfyHe4YexK0oIKqPMTjYYG12DE5Jm3CJTGbIkSbJOd74cFiorjsJAEU4OvN9VKu6qrK5og8NJRCZQ0scFmg4ZQqb4wvCnn9/Js1JuDls2Cc54uDjrW18Up/7505nfOM610tCphWSVkHaWkBqD5ymkhIwM64FTDisMvpYIk5ElERJHYhMyZUm1w/m5eEcsBDusIdq4lnMbM2w9/WE88xufE5x8tGDb5v3es277bDXXwEuynmdj4SI9JGYzcKxEDBpMxe+FpyaKImq1GqnJaHZaaC1RSmGFJDaOmSil5XlM+x5P/au/hGO3Dj/Ea6/nn970ZqpZyua1a+jMTDM+Nsbknl34vo9DkgnZEz0qzlsYajrwQVg8CzXlIZtNWtdt5/JP/cdKvd2ruDmYboguMweEd3B/YHinXlyUxQsDUuPQpRLznQRVqRKsXcuR97//MrX05uHf71Txgne9hWDzJq6dn2Vk0yauuvYGjDFsXLcRrTXbd26nUq/2FUVZXA375gyJO4NOkRAKzwtwzpGahE6nRUkJfvP91TIMBY588XPFX3zkH3nMy17ATmm4qtNAH7yWuOzRzFLaSUqlUiONYtI0pV6tsXtyD37oMzo6gsVSrVYxxuCcI0oSWnGCLQd0KmUuaczyqve+g/u96423a4+6zcbG/PQUztoVPdkNErUK42jQC2MGBIdsoW4o+687ATLLIElQQlIqlRFO024lRFaSlcvYapVkpMwbPvUvcMK24Yf501+7v3v1a3ng3U+hZiW7Lr+KsbACcUa9Ul2QbdDf6dhuO3ESaVzuZbEOLRUSgWvHXPC9n8OlV6/gp7OKm4Kvl1xD8YCA69WCcFg5TJy0QiKExFiI4gQXBkyKjJMf+ZDFRvuBhgecJB79iueTHrGeyRBK69YQBiVmdkySzrY5eOPBtKOo61UdHOcDFWKLKtED4RbZqxh7YIShlwrjMoQzKGPwrcCTilBqZq7fCb84505whfsJR28RW175F+LF//YvnHTmYzi3PctOT9IplXBeQJo4RqvjuI4lbkas2bCByFn2zs9hgPZsk4os4yKLr8qsPehQ9rTbpNWQt3z+M9ROPP52v4TbbGxM751E3QnoTQvrLUC3TsOAkVHIJ9vu64XRAZZS4BM35igpD194RHGGC8pEns+0VFznUs76q1fCUQsqs/7wl+6Tb30nB+mAPZddTTo5x7ZNmwmcpD07z0i5ik2zG2l1v7qKTQyeyBeeJEkItceYV6Jx2TVc8+0f7Nd7tYoDA8YYtNYrn7PRRW7YW4zI48vSib6nQ2o6WUYiJZGnqB65mWPOeORyN/kWIXzMg8Vz3/1mdpeg6Uum2xG1kRHWTawjbmeYLF9LnRj2YgwaETemV7Rwk7RSYcmLd/pISkJQD0LSVosjNxzMr/7vG8vdvAMPJx8r7vX+d4iXfOA91E8+ju3OEI+MsjdOmG5FTKzbSBSntJodHJJafRTtBYTlKtoLUaUaU2nGOdddy90f+XBe/ImPQqhg6y2rb7IU3ObZamr3HiRiRXf2QY5GgUF35qAHY2HhpGKCkMLgK0kZwfzkLImTeOMTzDpFMj7KM9/+N4w88bThB/nH89yXP/hharMNxo1iJIVDR8dp75kknptj/egoUas99C8F16UwNFz3p4cEmxe+S7IUzzm8dkww2+Hs//sOXHrVCn5Cq9gX2s0WWZblLP6VDJHXOnDC9HlT3UXUITBCgPaIjcGr15gm5YFPfSIcu2Xl7HLuew/x8o98gEbVw1s/QSM1TM7OY42gWq33lIcHNTiKY6iiNPncVHDIDgTO21JhBQiVp3D7gEotwhrSRoMRoTn3Z3exFNhbgcppDxNP+MzHxDPf+RYmx8rMj1TYKwUNAbpcQUqfQPo051t0OilGafbGMfNhwGytxNPf+kbu/pIXwNGHCrbsv4yTm8JtNzb27EXfCTwbg1hoaCwSJxtQQC10AZIkIvQ1LjMIFLpaY1ecMFMvceLjHsPYkxYYGlde6b72Lx9l+x/PRc81kfMtxoIQHRsCoQikptVqIYSgXC4D+97d5JOyRGufNE1xKueKBFYgGxFjyqO9Yzfnf+Pb+/9GrWJZMTc3RxzHGGOWuylLQj7eiqyMYaGrgkyeZAavXGE6Tdlw7DbWn/XYlTfpnHSCeObf/DXxmjo70xhTqRDURpianO2NbXkjx43hprLlVhIya3BCoITApQkiSah4Po3deyhZx+z3f7q6WboJVM88TTzvnz7IY171UuINY2wnoxn6mDBkJooIanVEucKkyWiPVdlVkrzofe9i5GEPgrvdsaHI287ZmJpCFKk3dxIMGhqDKNQMVVcLQNqBOi84DJbYOUprxoiFR6sUcsQZj+S4N7x4+Jsuu9x9/T0fZO/Z57Jt7Xo21GtUlEYmCS5L6czPUyoHrFu/hsiktJN4saHhBLJ7FMiMw3Xd6n7mqEpFSSlqyuO87/0Efr8qY35nQqfVxmYGT6nlbsqS4bqhk6Jkdv4aPS+eySz4Pk3leOCTnrCsbV0KvMc8TDz+fe+AwzeySxim4pja2Dh5tkm/zLjuHqrI7iOfpAujrEe075VJWNnInAXZncuMRVjHiF9CZRlVz+f3P/nZ8jZwJeC4I8Ta558lXvjJf+a4J57O9Z5jj3IklTK74ojpQDE1UoKjD+Nln/0E4vQHCrbctvomS8Ft7q1JowXZCnfjDqBQPR0MmwwaGdoUk8CA4eHA932sEHQEtH2P69M24yccy0Pesbhew9lf/gbX/Op3bPJLxNNTtOdmESZDCYkxJq/25yzX7dgOWiG16rVrUI+gqIkhXK5IILVCaY3NDC5NqQUBaaeNTCKSXXv47de+fgffzVXcnjDG5F6sIFjupiwNAx4Nrzu+AIyQOCFxKGRYZjZJKW06iPGnrkCvxiDufrR49gfeSbphnHbZYzbLyKTohUSL8a0sSCvzeWbBFNvLXtmH53WlwQlQWufFxWTO01EWhMkYrVWZn5zkkt//YbmbuXJw7FZx0ttfJ1780Q+x4T4nsbuimR2vMFnzOPrRD+Op//VxwZH7P6X1luI2Gxut+Tl8ubI5G4s0QBYMYAmQWZRxhFITSo1IDSI1eEg8rcmcI1WKloZJ6Ri994k87tMfHHqgyaXXuMv+4ZPu/P/+Omsz8DspoQORGYQQZNaAkrTSmASLXy1jJKTOLiKO9arsurytsTM43yfqdAg9H6wjzRKEcARCUIoyLvjxL+CCC1bwk1rFILTWSATmRgnEKwdOCqzJ8C1UlI/JHFYqOlGK9AMyrZl1KWf+xfOXu6n7B/e6u3jaG17DbDWgUwkxgY8MAppRjLMCLTRxJ6LsBZgo69aJ6Xt8bqrQ5UqEITc0YmdAK3wpsGlCmiaUfQ87NUf7u6uhlFuFe91dPOz1r+K5H3oPzSM28IhXvZg/e/vfLHuPuW3Gxtl/dIHSdxoZ8sJ7MLiJKDwInpCI1ODiFGWhpPO6JNZaOmlG7KCpJMlYndZ4lae+5bWLvn/ugsv4/r9/honEsdbzEZ02I6UKYRD0iaiyf6Sy/1rhYSmY54MCQA7IFL0dgXLkCnEiL2/vG8uY9on3TvLTL/zPHXAnV3FHYG5uDgAhln3+WDLSNGVidIx4voWLMoRQSO0xsX4DO2fmmLeGI04+ifCYrcvd1P2G8mkPFk961UvYIQ3bOy3aQiArJUS5BFJTLldpN9rUqzWEk4v4G7dUh2OlwArZ9WblfxcbWG0tpdRw7o/v4gJftwVHHSm8+99HvOaLnxdHnvWkA6Kn3CZjI2m2iFvNfCe9wrFQpKuAJF/AfaHwhUJYh8sMFkfmLLEzJNIxnxk6oc/1geM573wjbBtmysdf/oH733e8j42ej4saiE5M6HKpcYHspv3J3pFJiZUSu+DJ9Aw70ZdIs8KRiZy1X/BJMgmZyuPfnjWILGZEai796a+Z/eZ37wSm4Sqm9u5Fi5Ufr4fcSzM3N0e1WkVrnQsPKcVks4kerTPrwX0eexocfcQBMWHuL6x/2uPEWa99BWLDGnZnCYyO0BaCPfOzZAjqY6M0Go184V3AzbgzhFAKyC73xAl6BocV9Hg89Uxw0a/OXu5mrmI/4DbNWNdcfSVj1TpZEiFWrC7ojWOQF2G7mgZKKWKbEdmMVAtsycNWy2Tjo8yVQ17+nncS3vc+w1PAj892n3/v+9kWVkn37GZdtYoSMDM/R+CXiKKkO9DkjU4gg1UiF+5uFubn09UqsNA1Niw2ihkPS1QaET//0tduh7u1ijsac3NzKKVwzq3oMKYll9xvdSK8wEcohRAKhGCm0yarhmy576mU73XScjf1dsGmZzxJnPnKlzJf8diRREy7FD0+SqwEuyanKFdrQ5WzCy/yncGbnEN2C1gKRNegyr25eckL3zjKFtz0aijlzoDbZGyYKKHTaBIqb3+35w5HobUxOJCLIlCQl/NGCqwSZBJsycOUPOaVYY9M2enDI17w5wQPvP+wqfCTs93n3vZeyvNNWtuv47DRUUQcMT0/zeiGtQgVIJ1GOt1VBFx4LMiCoZ93P1hQp0BPVRRA9OvUBErimm2qsWH3ny7G/vg3q4N2hcOkGUqpFZ/6Cvn4GpsYZ2+zQTNJUFKTWoc/McaUyHjwM5+c14m4k6L2tMeJv3jPW9khUpqVkLjs5zWQRqpEWZpvKgY+39sIdcf3Ska+kZIoJ1G2m30kJEbkZOHAgJdmjGqf3373R8vd3FUsEbfJ2Lj6iiup16okUby/23OHomdo0DcyFt6QvM4JJFgyT5L5inmXMmNjGp7gjJe9gENf8MxFk+EX3/9B/N1TTDjL2sDHthtM7dnJoYcfSqsTMz0/T7laA0TOwHbDR8HBkAtez0M+uQfDiaIkt8QIgRH98E/xD55zqDjFTyyV1PGzL656N1Y6lFI5X8OufLtRSY8oTRB+gOmm8sZRSsMmbLnnycgH3vtOa2gU0I9+uHjjv3yISRuzo9nEhD7G13SM6WaqDGMhd2slQ1iZZ97YPNmgqP+kLQSZxTOGCopLz/79cjd1FUvEbTI22q0WrUYTT+sV7caFBcTLfbgppVJY50iswShBi4wGKSObNnDKaQ/h0D9fYGhccb37zFnPc9ENu6kD5SxDmZjG/DSbNx/M9ORerLWoIKCd2q5hIXqHHDA0lB2sPGt7qYIWepyO4rOZyo8iV7/X/jijpnSemZLBFb/+A3v+82sr/KndteF5Hrg7xyNUStFot9C1MjbQCKFwTuB8j4evYF2NW40H3Eu84m1vJlg3TkfArpkZyiO1vDzCkPBXXjZc3QkMjqL9yspezZeCGK8teBYCFCQZdq6F+/6v7hyd/i6K22RszE7uRWqBEeZWMKKHT9VXDlxeONH3ZxTuSURGUQDJWktqLBmSTAd0UETlMgefejL3fMHidLzvf/TjxFdfSzmO8U2CMCkuM0xMTDA5OY2WmkAHBEFe6bA4cW60uUXx2OLPwp26kNuRf972PpkbJa57fwGVD2rPOUQ7opoZvv/FL++nu7eKOxxXXO1KiFyqXLplzUgQdMWnuobwYBp5/l5fm6Zopl2weCZRm/GxMRqtJlGW4Uohplri0BNPQD/0fit5Lb3VKD3+dPGEl7+Q3TJDr59gJonIpFzk3VhYvG2hmuhwn1gJRGI7sNnri5XlxojFdJqM+h5XXXTxsrZyFUvDre+Jl13jWlPTGF/QVgZHn9wDfSOi3+ELDkL/c1ZYnMyP5TQ4HBJjNXECWnpoCZ40eD5YlSIDhfJ84sjie3VasSQrjTFx3Inc8+lPhcOGM09+89a/c1f//GdMmAQ/buBjsVKQSU2UCHyvhjI+MnPI2KFdbiTk98v1qj267v0rUmEzmTO1rcgHonC561E4sMrgpEG5DG0znMg/n6juIR1GOcgyykow5il2/ek8+O5PVncJKxDR1dcj5jt4ypG43CheLkhn0c6ibT6OM5UfTliUzYW6AgNB1henGjSWhYNAKdqzc1T9EJRmUlj2BopHvPB5y3Zdy4nRZ5wpHvDnT2e+FjKrBLGEFOjEKdr3Eb4ktgkq1EQm7imPFp4B2xVEs8V80Z2fi6PnH+m9v3zIQ8IZTmbddUCgbN7OTEImLdiUasknbs3x65+sFpZcybj1vS1Kca2ILOosokUPGhF5AaHinUHxrwPL0pZSEwQBUkriuMNsY5ZOq4nAEnciYmMIRkZQ1RHmraNy6CGc+cY3IE84acjQ2P6Jz7sffu4LjBlHZ+duRvyALE0AkQ9sNA7VM7qU69eCyD0Ww4uGu5EDFoZ98nutepwON6yG2pUCTjttPGMwjSZb1q7j39/+Hrjy2lWDY4UhdIpQSKy1eRGrZd77F1OA63GJ+sZEj2808Hm34H0tFaHn02i0sJ5HWimx9phtcJ8T7lJejUHc7S9fIu7+6Ecw6Qk6gY+uV1F+wPz8PFEnyVOEncULvaF5Y6hQJALXz2PpvX5gZbIUXljXa3sRHjJC5pkpzmCTiIrv0Z6cxv769wfUFaziluPWr/zNNqM6oIakYvPaIEUKZtFhisWuwGCK5mC2x8J0zuWAExmpSYiSDn4ppFyrU6pUGfXr6EyRCsGcybh6dpL64Yfw+Nf/JRw9IPl65Q7HD37j/uufP8Kho+OMaJ/1I+OQZJgoHThPN9hRTMpdr85SF4vcy7H4XhZiQMI6FILA9/GQyCyDKGV2+26u+db3lnbyVdzxkPnzTONk2UW9CjEmK3JXvx3oga7rmbNdT1vhpYPCALEIII4inJDU1k6wuzHPZNTmiS958fJc0AGEkx73KB7w1Mezk4RdUQu/XKZWHsmJk3gYY+jEUdcD2k15H/CMuu4Emy/kw+vzIE/tQMHCNaNAanOVZc85zHyD836zqrmxUnGr1/rZa68mbbfQsSEUOUG0qNrI4O58IBywEAdOZ7cID1KXkFqD53kop4jmY6J2QpRZ5lOHGxtFHbaBM1//Crjn0cNXtHs3H3jN6xhHYabnSGbmiGfnGKuOEngh/RwX0T1jYXQUk8Btd4P39Ddcn2A1WKBNOHDOkWUZgfZQUhBKjW21OWbzYXz3i/8Dl696N1YUrEMrgTEGLdWy71TtgFGx6HUBqeoKzXVVcYveXvRdpT2c57GrMYsaq3Pv0x4B9z3+LuvV6OG448RJb369uM9Zj6dRLrGr08Z5GmcVWZygrKRSKg/p7QzxuYqibQs2ggWKzd6BgF4bGe4f+VzpCDwPEaWUjeSiX69mpaxU3GpjY3p6mtAP8JFk7WQfHdYtEvoq3GQLiY3L3dmtgCTrIH1QZS/X1GgleIkAFeKNjTN6yCbO3XkdT3/HG+G0YdGu7Le/c//y129gvRWUWxEbgxLjXsBYWGFyxy60kAirwakBrwY46foG2hKhugWbevfSFXHa/NBSYbKMNE66KqOGiWqV2RtuQMw1uOJ7q3HQlYQsjpFSooRcdhVRB6SyKzXdNapllxfg6ErvK0uick9eUeFVdEOI0oEfVGilBlupYEYr3POsu1AGyi3AyW99ozj6tAeTTIwwZQ26WkZ5JaJ2B+0U/e3LPg4x+HcfgyXsl9uqK8LDRjrMvnafUiIRee0c42hetwN+sRpKWYm41bPVZHOOVEoyqRGet08DIi8e5HKW+nDFkd5pi0lpecskW2KbYIXBk4Ksk1Lxq6xdcxCJUMwayyXNGf7yw++DB528aFx+9M3vpN6JKXXaHDYyip2fp7F3El9pxkZG8f0QJ0SXiNWdhLtE0JzTsjRjQ1A8wGKCl71zFQx2IQS+r5FakGUJLk0RUUyQZIwpjx98/svwh4tWB+8KQWN2DpcZJCy7qJcVeQq2KeLtRebJABepV/dnYQpnN/MgygyRlIiREQ4/6QQ45djlXv8OONz/+c/h5Mc/htmKz7SziFIAwqPdbjM4hS/U6hEDol8LvRvLvdEbRJGhVNSCGoTWmjSOqOsA1YmppY7zV+XLVyRu9UqvxkeYV4IZCa5Ww4ic/FmISSmXs9AHdSL6LrF+CueBUETICfArIZlN8TOLi1MyqZizlu1TszSCgHs97ylUz3zEcGsvvcJ9/Tkvd+6KG6i2Y9b4Hq09uyhLxcFr19KYnUMoza49k7juwu8YJPN1dx3FsZ+upXBFFpO/Q5JZg9QK6eXF4zwl6TQaHLJuParZIbphJxd84zv7pQ2ruP0xNzuLzUxe9TU7AKq+djcNuYct5w/lonJ9TtLgujYoUmcFpEJCtcZk2uFBz3nWMl3EAY6th4tjn3gahz30fjRGyuwyEcFonSCsdj8gu4yZPDNI27yuiHJFxdh9eTgOgAkY+tpBC/pJASdz+QEvc1SNpJrBhT//9R3dylXsB9xqY+MeL3yeOOkRD4YNa7i6OUei+imZkE80ovszd9MVLr28K9mBhXC5mfSQhxVMnKC1hx+USKRk2hrSDROccuYZnPzqFy1q5efe9QGmzrmQo0pjVK0jacxR9X0klqmpKfyST2oNo+Pj+ywHLbqaGnJ/CDN1YzOWAQb3QAVF5wRRktBst7DKEYYh1UqJub1TlBEcMbaW733+v1e5GysESZIghSD0NErIA4D3lKs8FGO+kNdfuHOW+3jdCkmkFdNpwkkPfhCctOrVuFEce5R44AfeJY477UFMeoI5AfNZkhN0oVfiQDL8DAYn+MK70VflYZk9y30sXAuKthpr8ZQi7bSpez6i1WHyqmvg4kuXveev4tbhNvW0B77jTaJ09BFE4zXSMCR2lk6SIqXOF23hkbQ7+FIPl0SX/cyVA8GzoRz4BsYqNRqdNg2Xx45nS5rg1GM47m2vWNTKc971QTf/2/NZH0Gpk6Izg+97ZCYFJdChB1qSmIzUmTwVsPu/RRpgQZBdKgoP0SBJz4jCs9ENoygFUqFKAWhFK2ljbUagJL5x1AR4rQ4/+eePLr1Bq7jdEWgP6SCJY3x1YCwUhdZD4c3sEcAhl1TPDGU/wCUZ2il8P2Su3SbzNVmlzLQ03Pcuqqtxa3HyO98s7v64R7FTO1rlgMz3SbJc1lyhiNoxvg4gs/hS5fyYgmo5MFcY2fc0Hwi4sbCO1pokiaiVQqJGg4lKBR2n/P47379jG7iKJeM2z1ZnfuIfRfWoI5iyGVkQUlu/lo6zTM/OEFbKjI6OkkTRPp11eQe3yyhHlEM4yFoJWWJIpEaMj7JDZthDN/DUz3xkUdN/8vb3ud9/4ascX19H2E4pZbmrEgaITgULX9pFMcjBdF/B/nJk9sm3i1nnXRG1bruKjAAnuhoHFma37+SEI7Zy9ne/j/vRL1Z3Cwc4TJohESghD4gwSpF2nZOPB6T1B1AOS6SdGF94tFotrBPU165lzmZcPruHRzz1KXDkIQfIsnfg457Pfhqb7n0y12URnUCTaE2qFVYqNh96OM1mEwwkUTxUVLJQRR5Mw19OUbhB7Et6vZjLPM+j0+lQDgOi+XnqnubKc869o5u4iiViSVujp7/uNaw97mgavmYyS2kJQTg6zvU7djDXaFKpVPKTDCxhRWc/UCzqSqWOQ0EQcnWryc6xgGd947OLW/fdn7ur/+fbVKeamKkZbKuJ1gXpU2BkcfSJTm4gJVh0Y6o9Ma79ehPcUJobDBg2RXZAoYkg+3oIylnWjIwwde01HBRW+cEX/3c/tWcVtxca87Ng810rxi5r5L3H1VoQHul7Ly2e0pg4IRQeJk4ol6tkUrA36pBUy4SHHswJj33Usl3DisRR28Tpr3ox2x7xQKa0oKkVaeDTBs675BIm1qzDWkslrCwuf9A1MNwyS90XKDwvAouytuf9LaZGYwzWGhKXInWefVPzfPZceBn8+g+rm6MVhFtsbPz+K19zV3zv+8MP9+5Hi9Pf8zbSdaPsMglppUy4fg3jmw6mVK3RSTNwcqhTHwgprwUckshYTKnCte0W9aOO4K8+/IFFn9v1xa+4f37ZqzkkExxeriDaLdZsWEMjaudZH06DkwO1S9yAoeH6A2ofk/KSsYBgWsTGe5kB3deLncyg61Q4cEnCaFimjuL8H/4MfrqaVnYgY2ZyCpMmaJGnvy43hMvpz8LR09bJUxnzfmmzDBunBNpDSw8/LDHT6ZCUAyZdyoOf+iQ44agDYNlbYTjuGPGYj/w/UT9qK61qwJ4shZEqowdtYM/sLBPr1jM5M70Psb8DZ6NXoKhy3c+uK2ChqxOkw4BG3CIIfWSWETRjrv7NqubGSsItnq3O+crX+fzffZDZr39veDE68iDxrL9/N+naUZLRGhfccB3XTE2ReZp2kvZUAxfiQFAPNVIyLxy7bIrasomnv/41cMICkto557vvfOhjbAlrlJOUsnOEWjIfNch81dVBzL0HwvXjJgLX1xTAIVw30NI1DvbvgO/rFxTubN09lM0zBejy1Rc6VKSCpN3Czs5zWH2CL7z/H/dnw1axn9HpdA4og30QRRgxVf2ibGmaUi6VsHFKtVyh0enQsBl6zRjZRI1jX/LcA2zpW1l40jvewroTj2Wu7HHF7DRNBa4UcMOeXWw69JC+NPzA/xxo/UcMbJAWQkuF1ho8SURKZBNMHLFGeJzznR/e8Y1dxW3GLVvv/3SJ23PO+YS7Z/jCP/wznH3+cFc9+Vjx0ne+lUmZUd6wjpGN65mNImToD9X0GMz/7rMJlg+ZBL1uLdfELZ7yypfBA+81PPFdfIX77OvfSmlyFqZmCK1lau9OMpHSIaE8VsMJibCqV+SoIIBCsesrQij9m11IO9sl6owI8mJYous1KeKzBRvdM7nB0dc1WEzMNSal5GnGwxLJ3mka19xA+r8/OoCmolUMQkuF5+Vy1QfCKl2M40ImO5fh7xOWgyAAK8jijDhOQHtUJia4aPt1PPysJy5z6+8E2HqoOONVL2PzKSfirRunCYhyCaMUe6ZnhirG9uel/OfyZzL1N52D2UqDzTLGoHyPdpagyyGtOCLQHmv8EtNXXk969gUHwFWs4pbgFq10v/rs59gS1jgyqOPtnubf/+atuN+eO/SQxZ/dS7zyXW+jpQXzWUosbL9S6YLTDNZGWU4kUnDh5A5e+6G/o/KE0xbN3R9/zZvIrt/FQWGZg8fGmJnew7rNB6FHSrRNzNTMTF5UzeYy4UOCOl1+Rl5wrch3p2dcuF51xqVdg4BePr1wtp8ZYHPhNGVzT0cPrjBwurwNpVASdGqpollXrvPZf/v40hq1itsNQgg8pTBphlJquZtDsWEYrIVipMN0VYM9zyPuqp7GcYoKQvB9ahvXcdRLXngg2EsrHyfdTTz2VS9j5LBNRJ6ilWWEtRpK69zDhGTQ+5mXdN8/Csb7C0UW08I1QViHtZYMB77GeoBwVJ1gRCjO/vkvl6W9q7j1uHlj46LL3fk//yV6vknQaLBeaeTUNB/8q9fBBRcPd40H3Ee84G/fwB4MSblM6nlksii5BIWwzKBU983PNgMhioHm9tNnB8V3+98nBoWzKApCSRIl6WhF21PMB5oHPusZ+E94zKJm/OfTXuT03hnWSE179ySdmSnWjI2xZ3IPc50W1ZE6TrkBCWbw7MBhchlxy0C62UDhtX5p6Ju9ATcLh1zAOu8LfBVhkyLYM8jjcALi1JAZR9zpUFLg5mZJduzk0k98dnXHcABCGAvWYWyWu5eXsy0U+g6yu6gtfM8RRe3coFWKUrXCbLvNVVO7eerLX7pMrb6T4vijxVlvfgMbTz6OXSRMm4RUK3K15oF0+yIbRfQVjG+1xbefBAnlgKelV8phiN8n0VqTZQbfD0jTlJL2ieabRM0GFeVx0a9WBb5WCm7W2Lj+Z7/ATc0wpjVV4Yj27mGDc6zZO8OnX/W6RZ8Xpz1cPOttb2Zv6DOrNfMGnOfhnKNaDomziLAa0EpbvbMLN2hEDMp4y16ND+ny8uwgh4sOOYXoHd2BRUHItDhnyFyGCAIiCU3Po1Ups8f3OfYxZ3DyW/560Vj71mvf5BpXXEapPU/VGmpK4klFHEXUKjUUgmanTVAuYWSKEynKGbS1BJkkyBRelrfJCUmqIFaQqfzaBJbAWDybcyxuK/IYeV9UTXbvY1GTItb5YWR+Lwp1QeHydhghETpEeCVE6IHLqGQRG6zhV//5ObjiylWD4wDDdZdehjIOoSAxybK2JfecKZRVOBRWdtVEu/o12oKvPZIsBq2JgUhCaeMGJp72hFWvxv7G3Y4Rp/3NX1M5fivxSJWOgjSzeFIRai9PhdWKlJRIJOhQg7BDaafFJq7nce3OV8XRV/zsztNLNjhydeVesb6uGzb3ckisBYVCJI7QKHTiqIchBouwEe3Lr4aLVwUJVwJu1tj4xXe+R8mBh0UZw4inKSUxE4kh2DvLfz3tRYse9MjjTxdPf/1rmK8FBOvX0MaRGEOr2SGQmvmZWdaunSA28dD/DdYKsQM54EX6Zl7ZdJiznO/guxVCumbxUKqtsazfuIHrd+6kg8DVa8woqB+7jROf++xF1/v7z3zWnf2bX+Gcwfc1WZbQ7LTxfR+JxBmLMIJqUKHTbPVkmYcG3UDdl1zhTw6lpRbt21/CXgu/piDq9XQ1uucalI8vBMHi1KCkh7WWUClKzuB32qipaa755neX3sBV7FckcYynBEiBwexT4vmORq+0fNfYFU4M1Elx1Op1GnGHhjO0fcWTX/yCZWztnRzbtohnvPOt7NWWXVmCq5dpZxlJklH2AwLPx9eaKIpotJuL/n3Qw2AFA5yy4tnePs0u9ImKr+9VBXf9jZSyEm3yecyJPBRUywyXfXO13MJKwE0aG43v/dTtvOpaxkdGsUlKlkSUPE3WifGExE8yZi+8nP9+xksWdcHxJz9G3O9ZZ3Jd2mQqi6lOTNBqtBkPaqwvjbH7hl14OuhVhxz0Vjg5XJ5+Ia9hsL6C69Vg6EuiD368VKpw3XU3sG79RvxKlWum9jB65BE8/t1vhW0bF+2uTnn2M8VxD7wf09ox40lmpaO6YQNTzTadKKGkQ3ynmLxhBxvG1/S4EUZIMimJlSTW+c9E9Y2koayQruaF2Q+cjaVCOINwBlKDpzXCOpSzuDjiF9/53uJQ2SqWFUmSoJRCCLHsKYyW3KC1stgU2N5iVITx4k5EnBlctUwnkNS2bGLNqSctW5vvEjjqSPGqf/8o6ohN7PUEndCnXBsjiQyNPVOo1HLIxoMItJ9LE9Cdj+RAHScKTlm3qGMvjC27HuSuJ3UZ5c4FUPY8fvnD1ayUlYCb7Ck/+PJXWRNWCIC400Y4CDwPshTlLGUEh3gB03+6mG+94C8XLUrHv/SF4uTHn85cSdMAahNr2LlzLzZ1jJRH8JXX/WS//HSRp1+465xwLKyQ2lMsdPkfucHhMIXhAb0BkaQGKzXliXH2xG2qh2ziSW/5G9h244qFZ73rXeIFb3g9Vzbn6IzWuaY9T/mgDVCu0IozfO1x3NajmN6xu5cf7oBUQqIkiYJU9SfcPGuEXpgndxvmrsPlXskDzyftxHgChMnI0piyF1BXAc3te/jdV7+5zC1cxSBU15S21iLE8lobRuZKuanMqzwPi3vlWqLV2ggzrRYN6ZjzBfd9wqPh6MNXQyi3N447Rvz5O99MY7zKHl8xZVJUWGK0PkHZC9l+1XU9z+q+6pJAn/Nli1pLhXHhNMpqhF1mzpCDUGoau/fA2X9c7ql0FTeDGzc2zr/W7fjTRYSpoTU1i5QS3/fBGELtIYzDSw16Zp7DVMC1P/4Vf3zjuxY98Hu95XXi3s8+iz3WEOuA8sQapudb1EsjZO1kETlJ4HKNChZLcFvRVy0suBnC2Z7BsbCUtXAS5ySl+gjXzM5gJ0Z44XvfBscdcbOT3cbHnyHe8/nPIg49iJlqiaviFmaszmwSMd9sMb1jL1URoK3shXmsyA2IROaGR6ExkpOzBMrmE7BFYITAyOX1bEhnCXyPJGoR+BphMkya4QlJKCQjKM751g/gN+etDuQDBJ7n4UxeCVPK5VWqccKSKUemXE8CvyAqFyXkjVPIcommLxk79kgOedD9lrXNdync61Txwo98kJmRsFu8zTHbahM1YsbLNUaDapcvN0iCE91wtFj0enHIHo9ODPHt7mgoByKKqQnFH3/082VrxypuGW60p5z731+iGhu82CCto16tYZyl0WggAU8JpDWoToeg0+awSpVzv/0Dfvamty9amE59w6vFcY9+KJd15jDjI1CtMDXXwGV9N5zoxndFz4hw/YqxFIqcwyGVIrVUuJxhbQRYmZMmc76EAt/nhsY8rZLPC9/6JrjPSbd8eb/73cQz3/cejj/9EUxWfK42HdyaMeobNlCt19FS3kwMc9AbM8yuWFh6e7ngnEFg0VLgnEMIQZZliCilaqHUiPjdl7623M1cRRee0lh74KQsmm7Is8g0K9KuRXcX3IgjYs9j3pPc63GnwdZVr8YdimOPEn/56Y8zP1GjPVIh3LCOWAhGa+M0pme7C4Dr1mty3fo2xTw8sOnrfarPR1vuBymdQyYpFSu48Je/WubWrOLmsG9j45Lr3Xk//hnV1BFYR61UwglIuoWfikVJ4qiECm0SdBJTi1P++MVv8Md3fGDROnqP5z+VTY9+ABfMTdEplVHVUXS5AoieCJXqpo8W5LIeSaiLnsHR/VuQM949WxgcNs9DkWCEIpOSllLYkRrP+9s3wCPuf+vHx9ZDxQP//u3iyW9+LburPrs9+NP2a5mOOnjd+5K3JScsKWfxuofqCm4Nih7lKqK54bHcgxUgjjuEoU+WZRhj8MM8xcxzDt3J2KADzv3+j+DXq96N5YY993znrAVje8Jey418fA6nUebqtV2+UqXMLIbq4Zs4+OS7L19D78rYdoR40Yfex/ZQcl3aoe0pMgRK6FyfhyIMZlHOoWz+s/Aa94++UQnLv1kSQFlKZDsi3rUXfvyb5W7SKm4C+zQ2oosuQTba+ElC1mrhjKXRamKVYHRsHK11XiDHZShPgk2w7RYjCI4o1fnNF7/KNZ/83PCD33qEeOxfvoRNDziFqbLihrhF4vk9L0SeLSF61Uj7tT26qVYM1/WwA56BQkFTFamfQhJpScPX7HIpZ7zkBXhPePiS1vZ1T3i0eMPnPk1zvMKaux3DjCeZzGJiJbol3fP2akMvxVRbiyADkfVSxazIgKwn9LWsKn7CkmYxpUqZThyRGoMKfJxzVPyQwFiSyRnGheYbH//3ZWzoKgA6801cZsA6tF5+D0fPC0k/5JnXuchDixbFVBSjJsZ42FPPgqO2Hgj29V0Tdz9OvPqz/84u36E3beCa2WlkudQL9cpis0SGdhblsq7XOJ+vcoPS4YTrhraX37uWczYkrtmmaiWTl1+13E1axU1gn8bGz7/5LYIso+Sg7Ht5hoLvgZK04ojYGJwUCCWJyYhMwkStRmdyGtnqsCms8T/v/CB8bYHs9ZFbxeM//RGhjj2CxniVhq9ItEJqjbVQDvN0Ul94+FKRtKMFng1yIqjsp24mWUqlUsGzIBJDOSjjlcvsTNrMVjT3fuYTmXjofooTH3m4eMXHPsLB970HO0LYE0iikiKWjtTlcfSSlPipwzOWUCqk6w5QabHS4mROhFWuX55+OREEAc1OCy/wkb4mygxCKZIkQSOoaw/RanPVuefifrVapG05YTODMzlXw5gDI/E1kBqFI8lijLOEnk9rvoEWmsyBG62iNq5h/ZlnrBoay40jN4vXfOSD7AxguqRplXwiDMqTpGlMGHikcYQvBQrXm6NEzzObdTP/HLZ7LKfRIbuemJqnyGbm+N2Pf7psbVnFzWOxsfHHC9zFv/0tJWfxnEHbLnfC9VM2B9nLWZahPM3c3Ay1ShnfGUaNY7MK+ce/ehOT//1/i2bEZ77x1TQnqmwXGR1Ps3tujshCsxMxMjKKMYa4E7FmfLxHSyrIEYM54E5AWK8yOTtHEqUEXsje6Wlmk5RkYoQN9z6JYx5/Ghx984TQW4wjDxOnvvvN4qlv+msaa6rMhJq44tPEYrWm3Ylzz0+cEEdR3zPTG5x5CEUyGGZZfuR57kWhtqIEvUOmKWOBj2y0+NbnPr/Mrbxrw1OKQOeaKM65ZVcQlViyKMamGZVKBak1c80W42vX4TyPWEl2Zx0e+KQnLGs7VzGA+54qnvr6V2M3b+DS1ixipMZM1EKWAqIkplwuo7UCa3DWIAslH9EPBfekBg4A2CRGWctYEDJz7fXwh9VaKQcqFhkb53zt/whNisoS6NX16L7purnXAwIvyomctKYl1dE6ptmmtXsvh65Zw1qp+cYHPgLf/sVwBzjuaPGaD7+f6KBx5kJNaeMGqJaJpCC2Du37lMsV9u7eM0zAFG64SI+A6U6T0tgo9dExlOfhVevsSRPGTzqWR/zLPwiOP+Z22VFteMaZ4qUf+juS9ePsxuAdtI4o1JjQJ7GONRvW0+l0ep93AwNUuoIweuCgyOQZNiYtSgpcErO+FHDl787hyv/6woHV8LsQXJIhhcDZAyMbBUA7QckPSOOMJEsplavEOHa3GsxrWH/8URz89CeuejUOIJQe+RBxn2c+Bf+Yw7myOYu/ZpyOEswnCUY4WlEH5xxh6ENXjZkeWbQ/jx0IBocxKb5WhELQ3D3JDX84f7mbtIobwaLZ6lff+g4Hj9TR0uHSqKcRUaR3FmIvBc8i9AKSKCFz0Op0qI5U0Qr23nAd64OAeivh0295J/xmuHAbxx8lnvem1zIpDe1KwF6b0fYEqa+ZabaIkpj1Gw6i0PYfRkG6BKc0Rmm2z0zREIJ2KWD0mK088Y1/fTvdsgGccrL4829/RWx50P35097dxKMjTGKYcYYbpmdYv+nQPCOmK4STHwACt8waCQVk0Z6usE/BNO9BZNgkoq4UtSTjp1/+yjK1dBXNRgObmW6KaZ41tNzQWiMRpHGSS0uXQqbjDmm1QrOseeTTnrrcTVzFPnDcC54tHvLsZ6A2bWBaOSazBDk2Sur5dLIMVC4Vvmg+OJDQ9bL4vsYmMVXpcd7PVmulHKgY6kXxl7/hSp2Izu69BIAQRdyOHoGzWJhkd/FM4wxPepRVSHN+HucpSiMVTNTGzs/hJwkjacZ/v+Gt8JPfDZkN9QfcS7zmUx/nitYcc6FkTkuo14i1BM9nx+5dPW5GgcGwg3CSwC/RTFKykRrXpG2ig0Y5611vgm1b7rDV/EH/9PfiWW95E1dkHeJ1E6RrxkkrFa7cvRsrNDiFcgLVzU/v0rFyL8ItK7x7u2FQE2Gh7WmFJbMpZV+RzsxQbkUk1+6i9eVvrno3lgFzM7OYJEVrjed5pGm63E0ixebu9zCkHFaYnJ8nrZaw60Y4+NQTGHnsIw4Mq3oVi3DE084Uj33JC7khS3HrJ9gVd9Cjo6hKFev5NNrtLv1XdGtUDRfEXE6NjQJCCdIswpiMehCw/aJL4feXrM5PByCGesvXP/1ZDqmO4meGpNMi8LqpUa5fAjhHvmDmkrUaT4aEnk+lVKYdtWg059iwYQ21ckjWmqMOuJ2TfOGt74Yf/Xa4I5ywRfz1+9/NvJaklZCdzXlcEGA9j02bD92nJLMYEA9KWglBpcq8VkRrazzzXW+Bux93h09wBz/7yeJlf/cusnUTXNtpMCMcowcdhEEhnEYZjTYaaXWvZooRy21o9I3GPEQGxcTS6xpKYE1G1QnGhKIeW77/hS/DxdesDug7GFEUAfSqqC43LJLEGqT2IXVoISHwSAOPK1tTPOypZy53E1dxM1j31DPFX77nXexOErJalct37yZRGuGXEDpkUFdjUK5cuOXvfwBOOdpRi8BTiDRFd1KuP/uc5W7WKvaB/mr3iz+6a8+7CNtss7ZWw5mUIiSsutwMORAKKKryhUGJOE6IOwkl7VMPAmwW00xb7JrZRb0cIKMI3YnxmxHf+Pin4ewLhxYqte0wXv3OtzJjUxouRdZKzLQaXLt9x7BXY0AOuZAsHy3X2bVzkqxe4imvfyWcevdl20mVHnI/8dyvf16cfNqjmHKG2cxghEZahbYqr4/iCqXR/Fju2iiFlomAriqgHLrPSilsmlDRHqNSU2on3HDBxVz+y18ua7vvilAIlFJkWYa1dtkJogBOS1TgkcUJcSfGr1SZsSkbjz8a/6F/turVWAFQpz9MvPLtb2UWoFol1R57pmep1sdw6GFDwypkd55YbgVRCxhrUZ7OS9FHHSpKc87PfrFsbVrFjaPXU879zvfYsvEg2lOzRO0OYRiSWtPN/MgJQqrr5ejxDhB0Oh2klJRKJeZmZ0mjlNAPsdayZmycsvZpT8+wJizjd2J2nHcB3/jYx+Hiq/oGx5bNwn/Mw8QL3/gGxMRa9iaG8rr16Fo1rwQoLJIMSTbU9FQqdmUp8doxznrNq1j7hMcdEJPbAz74dvGcv3k9u4Vl3vdoeZpYaoxQ2K7cr+5WYLVCdgvR9V2TvQycLqzoF6vLI1kDJZ/3AwoDUjqQ1g65u4y1BOUKzWaT+dk5QuHYPDrONz/xqf1y7lXccmiZezTSNCXLstyTcDtgUJy6wGDp8aENgBBE7Q5+EJA6y2TUphlInv7ql90ubVvF7QPvqK08702vJxurMWUywvExJmengcHaTvlnLcP9YGFfKSC4+b60ZDhHpVLLKyA7R4hjx6VXwIWXr3peDzDks9U5F7vzfvxzsmYHLTXVSp1WJ8YpTSYdmTIgMgQGz+YcDocklRKUQEpBJ24TVMoYIREotFG4TkbWjFlfG0XFMaU0Zh2WG379M370gffDucPFc+pPPkOc8MgzmPFKzOCRKB8jHFoLnO3gaYMzMZVKjTgTNIMKl9V8jv7zp1A/5eRluYE3hvqznyBe8umPYY7YxK6yZre0tFReqbPi+ahmh5JxZMKR+R6JMWSZpRyU8J0mbScIl3s+MgmZtGQqZ4ILNygatjSDoyiyJJ1F27zeo3CFWqBESo/ZRpvS6BgiCKiUQrKpvaybnWfmnz+5OqDvQMStNtZalO+hhEQilqxC2xebs10jtuBn9UNsViz0xsmecVzxNJ3GHF45JC35THmw6R4nI0+5xwFh+K/iFuLIw8TYmY8Wj/qL59AZDZmzCWGljOccoYNQK5RyZCIllRnGc6QYJMN9ZfAYrHZdeE+LFNpCd2gpBocEPKMw7YQ4yQirAdqkVGzCNb9cJYoeaJAAjQsvYNf11xEozVh9jOZcE0/q/8/eeYdLclRn/1dVHSbdvFkBCQUkRJIEAgkQIHI2yYhgsDHZBhuTDMZgTDDZYGP4jAk2YHIUGJNMjkIR5bDKu9p094aJHarO90d1z8zdIO3e3VVg592nt+709HRXVzh16kQMyu+qFdgd0rgvGSRFOvh+zp6htOqB0mAdkqWoNKFqMxpJyraLL+YXn/nMThU65RlP5cHP/GOuWVygqRUpik6nQ25THEIzT9g4v51gaoZtwMNf8Ccc/bAHw1Hr7njE7aTj1LPe/Y8c84jTcYesYC6CpoG5dpMgCgmMQdIcIzA+1iCOY+YX5uilCWNjdaq1GCjsU4ZuK0viYSx/d1sa3zpV7j4K5qV0bQNEGaJKFTEBrV6XdrvJilqNSrPNdz7xKbj66hHDcRth000bcAqyPMdlObK/wpXvxoXxlvP+eDPnbrPFzKqVLCYJvdDQiQyPedYz9k+9RrjNse45z1CP+JM/ZjM92rEiDQ3Nbo92q0VghdgYjBIsFh3pJVGdYXgNWIqBIXo5rvZdKqtEEwUxoYmwWU6sA7LWIibpccVvz97n+4+wf6E5/1L5yjfPYmLFSrpZCk5QmVB1ATqzmGKA5AafOl07rBZK/+syA+swhoNuOeVzqWitvc5ZaRqVKt2FJhf9+Bf86i3vENYPGRvefZ066e9eoh79gufQqYS4IGR8coYoGkPCmIlDDsHNjLM+W2TVfY7jvo9/NCvvc7c7HqNR4oQj1YM+8A/qYX/2LGYbAZt1TrhuFWpqgg1btrKy3kAttukuLOBshgoEUzOkKufmzRvRFFIMqwlssdNEk+qIVAf7HENSdjiGz4MXkydJQp7njI2N+e9EmJ6awvVSfvKpz+5jDUbYU2zbto0gCHxeIq33W4r5XXlE9eMpFPkwVDHfTRF7p4y/Y3RAN83JKiGzecIpD30I9YeedsedjyPcKo7+i5eo45/4SDbXA2ZDxfi6tTSqE7hmQt0FVFVElnSxWKx2WFUceiAlk6Fzfiz5e5fG/drpJQzIcqF0gORChMZYb6Qcobnh0ivhvEtHG6E7ELTLU66+eQM2MoT1Os12h1qlStXESDslsD5fiVWQm4EovxS3q6GQ22V2wBJOgRPBIoRhiFIKm6TEyjAZ12jkimt++AvO+cTndqrYvZ76BA65772YU8K2JGXeOhYdXLc4z1xsWHvKvXnCa14BR625UxC2tS94lvrLj/wzteOP4pqsw/rWAmuPO5pO0sNlKcpZwlARRIYk75FLxvT05MAbqDh8rBNDrgxOqb44+0DBGANOyLKMerWKWMfWTZuxacZ4pcLZ3/0hXHjJaFLfBgi08XY1WmOM2WdmY1ci7GFpV5l/qNTX66GcRaaIvRPGFVpZRq8aYlZO8eCnPGmf6jTCHQOPfO+71fFPeBQbQ+HaTpNWnhIEES7J0ElOJYhQbiDltnog1ZAhG7Ph8VSiZDjMfqAazjlPm4II1UtoVCoEziGLbbZeOArwdUeC1ve7j3roEx7HxsV5bDWibS0mDKmYmMBpn3NEVD+Fu1U+rbRi97k9StGaFGWW54gIiJD3Emy7R5QLU85gr72BC7/xP1z8rn9ZOvSOv4t61Gv/mhUn3pP5RpWkMc5CGNGt11msRzzu1X8JJx93p2A0+jjlJHXmWV9Uq+9/Eu2Vk1y5OE9PK8anJqnUK+TOogKNYHF5SiUOijBqfieJ+BktBAgBjn33RtjR8G9HCUen06FaraIEkm6PahxTr9bACel8kzVhje/+x3/tcz1GuHWM1WukWQIFA79/sr4uTRvO8K50yJajzJMxnC8DoJs5aitWcFOnzb0fdQacfr8715wcYbc47U1vVCc+40nM1SM25SnRzCTGhLgko6IMpCllRuvhzNbDxyC0uf9bD9lylMbwy4UAuXivLJ07IlG4XkqEppY7zv7hj/ZLO4ywf6ABHvnHT+f0Jz+e6xa20wk1zdzRy3PiuIp22mdflZJr9QNH30pej1KFgtFYcT59uQmox1UqymB6OUEv5fDxSY5oNPj+f36GuS9+aynDcbe7qMe8+W+J73Y0zYk6+Ypp2rUKf/2ed8G9736nJWqP+9iH1OP/6mXMjkVscAnNULHoHPNJD7SiFleQLKU5t72f/hnoG22WGW51wXwcSFhr+2GxbZYTBSGNWo1KEDJZqRO3eqz/7e9ofuf/RtKNAwwlRTI28UyGFdl3NVoxfIbF2f3Nglr6fRncr/RIcwpypWij6NViTnrMw/exNiPc0fDAv3+Detif/wncZR2XzW6hEyp0LabX7lAJwiUKuCXZ6HcxnmDIg2U/qFAAUmcJ4ois06MWxqTtLhNRTE0UN1x2BVx6xYgu3UHgx8rRR6hH/dNb1JGnnIhZM82ccbRwiA6BwqK4EKN6EZj0dbglwzHsGlWqU0QBSqECgyvIYi2KqZmIWDSRKJRNmb3xRg7TMV/6pw8w/4VvLx0cd7+retoXP666h63md1s28up//SDc78Q7LaNR4pDnPl399Sf/H9EJxzA/OcZCJSCPK/RyR5bkVMMqU2PjKFm6Qyj15qH1h94PmT+HF5YdJR31ep08z1FKoZSi02qzOL9Au9kisA7ZvsgaU+UXX//2fmiVEW4J27ZsJTJBvy/2j83GUETIobNS6NuHbTZKqYamlH6AiyM297qc8vhHwf3ve6eflyPsjGP+8oXqqMc+jO0zdTaSk0QBJoio6tireRkcw5KvvrG5cjsZkpbBwfYFToEyAbkVRCtsmlELAwIRIgWhEy795W/26Rkj7D8s6e2nveZV1I86gmYtolur0BSLUwZViL3CQl/rmYpbX+REgWiFCQJEhLSXkHcTJMvRmSUUQVzOivEGY0nG4arCf73ln9j22Z0zxT7/za/nTR/5EJx420cHPWC4993Vs979TtY88H7MVis0axWyqEJuIpzS3v24tMlQ3ihXYTHiCCQnGE6StwzsiduZiJAkPpNtaScwNTFJo9HAJimrxxroxSbrf/Vb+NFvR7uIA4itN28iMAZsIbbuuyjvP/RjKRRjQ4bOD+9GrYLEaBZEkIkxTv/jkQfKHzJOecvr1ENf+BzmJ2M22oR4epK51iJl7iotS+15jBuMlb5Ug4ENx/5CGEV085SoXqXZbDJWqdFbaJElKZXA8PtfjZiNOwqWspbH3VU99c2vpzlVZ6Ee0apGpHFIL3fUoxrSzQkc1MIKaZp6Me5wYJehMOIlrPgMlcaYfsRDLRAojbaC1spHfnOKuNnmrlGdz7zjfTtVtH7C3dWqhzzwD4fRKHHCMeq0975dPf4Vf8GWKGA2jOhEMb0gomfFrysiSG4JlZcEVSJFlrSIAikyMu4/7Oi6luc5lUrFu1rmXhWW9RLyJCVSCpNboiRhlQ75+r9+BK64ccRwHCDkSUqgDXEc45wDve/Toc9MsGuvsjzP/bx1Dpfl6CDCKk3b5qSRoVsJOOmMh8A9D0x25RHuOLjHq/5S3ePJj6Y9XePG7iJmfIJca+K4SmgiWgstqnGF2ITkvYRQ6b7Ee1hyWtry7Q8NcJJnKK1JxBLVY/K0R2w0URQgWcqGiy+HS0bu+XcE7CzHOu6u6i/+5f10Z8bZ4BK25Rn16Wk23LyF8fo4kQqZ3z5HVKkQVys7/bzv2jR0rm98ODS4yiAvYh2h1oRY6gpkYZG7Tk3zysNPOKgGyGHPf4Z69Wc/gzlsHdurEYtRiJqaxkUxVgfEcUy32/UePTYjijWZy/YtKM4+tHAZFTDttRiLYuqpY8vFV2Avv2r5Nx3hFhEojXKCsz6y7/5MMa+HJBfDd61UKv1xF4YxictpW0s4PU23EjAfKO73pMfvt3qMcMfGqW/+O7X21JPZ3ojYTE7XKG7cvJlMYGJ6im67R6fVolap+qBzQzRmiaqWgaRj36D6DIwtB24RDypwjjFR3PSrUcyNOwJ2Ta3ufTf1vPe+HbtuJc1GzKYsYd1dj6TZTQBNEEQoY2gnPa+33cFFbldGQrsSnymByCpiNJ1ul07WIwygmmc8+Ohj+YeTHyz8/iDylT7+cPXs//mcOvT0B3KDcmyUnKRapW2FxApxXEEZTTfr0ckTJFSFwe7ysas+G96J7IiSyfBwVKsxaadJkPQ4cmoln/mXj+5TfUbYPQLPneOcV6HIfpBsLM2ovENY6eL7LMuIwoqXamCwYUBLCxt6LU5+7CPg/vceSTUOIjzuX/5ZjZ94ApuqmmZkmD78cBozK2h2UzInVOtjhMbQ63R3GYdpf6JU4QzcbEt66G1HGhmc/38/PXAVGGGPsfut0YnHqae+8qXMxobeeI3LN27ERRG9zDE+MUU3SdFBuFNAoB0XrxLD3Oew33WkDVk3pTExDtoClua2LcxdsZ5jogYff91b4eoNBw/DATz8Q29Xz//7N7I4PsaNWUq3XiOrVsmjmERgYtVKorE6raSzX55XTtjlIM8zKnHAeKVKa8tmmF/g5k985aDqr9sEF18rOPHzq7SnkP3TzMJAqrHjvLXWEsdVlDJ0k5QUCCcm2NrrUTlkLaf/yTP3Sx1GuHPhmX/3t6x9wMksVkKuX5jnurlt5JWQysQE7V7CQrPN2MT4bn+/f5zoiqSRxadBFGvPaERWCHsps9deDxdeNqJJtzNuUQ4784zHq+e/6XVc1V2ketg6kkpMx1k6aU5tfIJOLwUKYjV0DIL+7Ibh6EtDvG9/HFdZ7LQxlYBma46ZeoXjV66kNrtAetnVnPXGfzhAr3/HxeSZT1Qve/+7iI87ho2h5mYF2xBaWnHtxo0sttuEcbzPFhvD/bYrhmNHL5XhOByiICfHSU6e9yBNWRFVOOtTn4GrNo0m9/5EswWu8PwqoofuL2ajhBoy7CvVKSKKSq1GL81pJwk9FEkY0Y1CHv6MP4K7HTOSahyMOPoo9YyP/Ztada97kE6OkTRqdMOQLa1FiGPGZqaYm1/cLX3aF8P2En3m2Kn+epNrv74EDmILQZpRyR03/Pb8fX/gCPuEW1X6TjztMepv3vN2NruMuTwlGh+nl1sWm22CKFwihu0TqZLRYKlF8nBkOVv8nVhHq9ujWq/hnOPQlStJ5rfjts8zlQsnrz6M+d9fyZef/sKDb/E67UT13G98Rt3tkWfQXTHJjXmP6ro11GZWMDG1Epv6IDnLRdk/u+qvPYOjXq+y0JwnyxMOW7uGm6++jqCdcO0Pfrzseo2wC/R6A4lh4fbq9lHjPawq648FlqpSsiyDwgy5OjYOYcRct8PkYes49mEP26fnj3Dnx5Nf/zccderJzEpGO1DUV6+k4zK2zS8wNjmx5NphBqO069tXTrWMRGqcz+1klWC1t9eIrSMSoU7AeT/62T4+aYR9xR6tVNFxR/Kwp/8RvVDTFQehwUQRWu8cwXJYhbIjo7FjOFurgGqF6vQUzWaTtNOlt7BITTRVcdRyy/yNNzKeC831N/Dfz3zRwcdw4JPNPfmVL2PtfU/kohtvYMvCIi4TVH5gQ5XvCZKkS6NRI65V2bxlE2smp1gVN/jO578C547SPO8vSO6Dq4lI32Zjf+VGKVF6lA2LpkWkH2elWmsgQUCuFKc94uFwzNEjqcbBjuOOVo94xlO4+wPvz9Zeh7mkR3VqkqhaI3d2J3XJ7tR1y8VwKgclPoeXKAgdxDlUdYDrJWxbfwP84vcjenQ7Ys9Wq6OPVMc/7Ymc9rQnMx8oWmFAEoR0pUiwMxSatoyRD0MDwbEkgMvwAOx0OrjcUqvViIKQeqPhCanR2CylEQRMCkz0MrrX3MhP3viOg27A6BOOUaue9nj1zFe9ksMfcD8qdzmcG7td9OQUYJboLK1emhCpH1SnrwrxewolXoXl0DvlLtD9Pit854dE67B0N9Ltdqk16swtzhPVquggYHZ+lnarxa9+/vPbpoEOAlijyENNzygScYjSmDJc/VA/D8fdWKra1EsMQAf9PRgfttgIGAeB9aLoShjhELo2Y9EmNG1KMDPJUX/90hGjMYLHGaerM170Au7xiIewTeVsybpILWKh3aG/xBTJ2MpgceUhxXfluFW7OXYFhevTJKfAaQZ0r4AOIjrdFEXAdVdfcwBefoQ9xZ5vjY87Qt39H1+jjnvcw9laCbgx7WKrMUKGsz1SSUlUTqJyUiXU63Ukc4RWE1qNcarIWOqt3JU4jEBDhZjU4nIh15rFPCephbS1I48NcWTQvS4rHDRmF7nkrO9ywdvef9AxHACcepJ62tvfyuGPeBg3T49zc2RInMLkhVhdO6gGpMaR6Ryncpyy/eijPl+NAjFoMYAhM4rEaHKtsUOMiBFN6DSB83/3g/VI2YPecc0Y4+umFS6E2bQJ41Vqq6Y57aFn3G5N9YeGXghuoko7VDSdoHSFPHEgOVGsyG2XbtrBRAZtIEtTIhP0swUHVhHYIsQ9Gqc0VlFEAHZk2pEZh0Oj8fruOAflLISKrGKYcwnZeJXTRsnWRtgR9zlBPebfP6hqxx9NOj3B9jxDVyo+43fBLujY0My7uKrBVQ2pzrAmL5iDIrNwEYE0cEs3On2mYwem2lpLJg4zVqFN5je9ztFOeuhKjQSDqo+xNUkZX7v29mqdEdgbZqPA/V/8Z6y+191RM5N0w5B4rE4YR0SVmKhaYWJ6Codw/fXXMzY25he3IX/rHWNwDAcBE3ShXtHk2nPB7XYTXEa+uMCKIGSNjvj1187iV697y8HJcBxzmLr/W1+jnv36V9OZHqc1ViUbq7AojgRYXGwRFxl2daAKJkOKHCvDossiRPUOniilRfewYdeuRJ5eOqUIdcj89gXGJiZZTFPCFRN0KpqXvv5v4D5HjHa/+wmNB99fHXLCcSSNCnZynDSKyAJNYi1p2qNSqTBWqyO5RUSIooAsy5aoLYf7VVHouwtdtyjItDewcxTJssTLzXJrSZSQ1ULUikmOPOPBt2NLjHBHxvO++GmlVk3TrUXktZgsDOhmOVprOq0W9UaNJOlxw8YbierVnX5fOg4Mk5t+/BcZSMh9+HNHXImIopCbt2wErQmDmPrEJEkcc21nkZtsQqte4W//378y/ej7j+jR7Yi9V/ofdah6yuv+hsNPvDebkjbXbJklQ9NtJXQXO2zbsIWJWoPp1StZzDqkRsi1+AVPHNr5HCsUA8oW4i/Ytb1HEARMjo0TmQAjjsm4QrZtnot/9itu/PhnD06GA1j7rMerP3/z31I9+Vgusk2a1YhobJxV4yvpblukFsS41CduA7+ohA5CEYw4rM79ZLVCNXdE1u8qRDly48gMpGZg3V2qvqzSBTPoS+VCJhozzC22ybRhNk94+oueT3DGKPvn/sbTPvhu9eQXPI/eWJWtgSMfa2BqDXRQJc+EpJtAJmgr3lMlMCSBKw4hCYp8JzgC5wjtQNddMpOpgSSAxECuNEYFtNtdokaD+TzllEc/DO651APlv1/5Gln4ya8O2rk4wlI897WvJp+e4IasSyvQRFMTRGEFkzpUJ2OmOsYha9fQ63R93i3nt6C51mRGkxhNEvjPUkhbtdODdUH8eas03W6byAiHzqxipjZO2k65edt29NoVNGfGOPRRp/HCf30HnDbymrq9sTwLwxPuqh7zur+mfpdDGTvsEHo6pNKYYHJ8hqnGJHPbt2OCgMTm5MYvXhT6NTPESJSi3DJJT9+yeNiISCnyPEUh5J0O+WKTwyemqXVzvvefn2X2S986eIncQ++rHvOm1/CA55/J/HiFzVnO1Rs3MjGzCu0CbOowTmGcKsTnDiUOpwSnBCXSX3SGjXnt0C63vyPewa4DQAhQYY0NWxcwU9PkE2O84G//hlV/8oydJvYnn/dKuf6TXxcuH4Uz3xesfcGz1J9/4F2MH38UG0nY5hwLudC2CoKYKKrgXOFFYrwNT64dqXFealHMeLODmFpTuDJrz2ikxhNzIUBUQE8rpo86gmOf+Ngl9Wl97luSXnAVH/rLV/OlP/tL4Tfnjfr3YMcDTlYveMvfUT/2SBarFdZv2Uqrl9GIx5iujjO/eRsBakhSoXEEXrKtNJkeeCsudZ3deblSgUJr2LZllg03byWemCGpNdgUalY/8CQe/dH3KO63cyj9+W//ZDROb2OoffLV/9nZ8rFXv4HVVtO7eSsNFBNxBY1gA+hJCkqh8AZnnonQhTGaRtSQCmUo8psPee76mWazzGKCCIKQrljyICDRiq1ZD1kzw3Nf+yqqT33sQc25bvnqWfKt//cpVnYsZtsclV5GmGWEgWcyloSML0SRRiC0vt1zA6nGSyz0IHZKP7mSG6hdBsyHYqGbE61awULD8LDnP5O1L37eTv3w30//c5m96noqYUht7Qqe+9bXwUn3PKj7a3/g9//4XvnN177Fah1Dp4s026yIq9SiiF6vQyfroisRmXb9hH5BYfwZWa9JF+X6wfY8ozG4zjiNdopOFHJ9aHn237+WiTOfsqTfvvbwZ0hy3QZcNaSlBZlscOR978Ojn3smnHSvUR8fxOj+5Ofymbe/jxXdjHjTdsJmh+laDadyOionzXOqugqisUqRm8JDEQDBCH3bjSXpLyglrY4oVGzZsoW1aw/DVirclKVcnbU46ZlP5lFve/PO4+/Xl8gn3/4e3GyTY+9xd07/m5fD3deNxultgH1jNgB+f6185DnP57DKGNVuSjW1dFvzSCCoSCPKMw+B1UuZDUzhyVI+f8BkQGmICEZp75mSC6INSge00x5OIJiaYGOvQ7Me8/KPfgAecPJBPWjyX54tX/vnj7J48ZWstpo1lSrpwiIK8ZbfRapnGOjrtQykGVZRiC49M9HPlwFop4dsO3wzJyYgaUyywSU86VUvZO0LnrlT+3/5zD+VbRddxaqghljH1rxD2oh40FMfz8lvfN1B3V/7Bd/9mXz2fR9k7pobOH7VIXQ23oxdWGDtqhnA0bNJXxUG3islsBD2+9P1JRqpGWI2rMaIwolhITS44w7jmd/87yX9deNnvyq/eucHqW5vMnP4Om7YtpVuZMgbVbZJymOe9QxOes1fj/r4YMa5l8gHXvRy7l2bIbnuBqrWUquGEGlSm/tBh+qr0/2GyBMa70SgvfpddJ8WwcBmI5EeY9MzzLcTtotmaxjwV//yXnjEKTuPuwsuln97xRtY5SJ6m+eI6zUWIuFF//SWXV8/wn7FvjMbV28Qti/y9qc/lxNWroFts6ys10i7LYIAcpf1d8hKdJ/ZEIy3gy9WMC2usDou3JkKSUea58TVCkmSkKY5tUoVEYXLHLoa01LQm6wxWwt50fveCaecdNAPmnPe/F656Kzv0mj2mEQR2rxg6nIvTcJhXMlk6CWuyEsNQfWglCEj30Iy0owirgsD/uwdf0/tKQ/Zqd0/98xnS3zDNoLZNjUVkGQpthbR1Y7KxBjteoWnvPoV1B75sIO+z/YJl98g53z28/zya2dxiImZAZLt25mqxOQ2xQFWC6JUX6qlCgPQwHlmI9WQGc9sKtEETiEE9LRhez3kUa96EWufP8RMrr9ePvemf2TismuY6CYstpqE9Qa5VizmGfHMDNuyHnmjxiOe8VSOfsULR318sOKS6+QTf/YSJto99PZ5Vo7VcHmGy3MCVQF0X7LtlFAqT/y5Uv2rlwQeVKJJjSOth8zmCb2gwnxY4VUf/Qg84G5Lx9oN62X7+Rfx2Xd+gLFmzrgNiawhTVOCsQqzrsfdH/1QHvAXL4Jj7jIapwcI+85sAFx2g6RXXcPH3vpOJjs9pgWqzmK7HaJCjO8fVviiiI8d563k/fONc0U8gMFAc0CuhFwcQRBgtIZMCEQRoenlFlersLHXxM5Mks1M8afvfBucMhLfJl/+rnzxX/6NcK5JLc+JbU7gLEZcn9mwpdpEDexktBv2ENKFMVbhIKlLGxvvOjlXCXn0a17FzJ8+Yaf2/s/n/onI5deyciGjlvogVPXxMTbObaMxPka72cZNTnBdZDn1qU/ktCc+Ee59wkHfb/uCmz7+Bfnepz6N2badu9THWNiwkelaBdWfU77v/N+6bzQsynmDUA1912dnSEzAQmzgrofwzG99dknf3Pzlb8ln3/ZODmt2OCSK6HQ6BCokjqvMN1tMr1rDxuYCweQkG3pNpo+9K2c886msfvbTRn18sOHya4V2xsdf/hccYmKaN97AymoN0pxAgn4iNZB+zCaPgcWGG9r4lJudbqCYqylmDUze9Vie87rXw/3vvtP4uuk//0u++qEPM9HNOaQ+SXvLHFONaZIkwRhFVgnYJAnJqin+9E1/S3zG6aMxegCwf5iNAq2zfiT/8aa3sioX1imDaraYqMVs27aN2viY92oQRZ7kNOIaeZ6TmYLZELfEDU+UIytDmxeGQpqBzjlwnmCmGszYODfObad++KFsdDkve++74EEnjgbMBZfJF971PhauuobpzBI229RFGItjrM3oZSnWGER8vIxIGYyAyy2B0wRKE0UV5ppNVBQjtQrbswQaNZo246QnP4F7vuO1O7Xzj975Drn0i2dxRB4w3s4JnTdS9KJSLw6Nc01iFLONiLlQk080eOHrX034mJGUY5/w41/Lt//jE9x47oWsjSqMWcG12ujcUa/EJLn1mdxMgHKWwEGaZ8STdVpJF9vJMBimp1ayMUu5KVY85x9ez/jTh2yirr5WPv7K15PfcCOrJKWeWUKHj+Ux7F2gFDaM6VYCbk47dBsRxz/kQTzoSY8hOOPBo34+2PDz38on3vw2qnOLxM02K02FqjM0FxepNWpgvCQ8yxI/RLWGzKKUIoxjOmkGQQhRRCbCrLbMTdfRh67lpV/8753H0xWb5PLPf4FffvWLzNicmnOoLKdeqbF9+zxjY2PkeQpxSNM6kmrMVhHu9YgzOP0D7xiNz/2M/RrvuvGkM9TDnv102tWITd0Oul5ly9Y5Dj3kcFrtLmhDkuXUxhq0Wi0Co3eKTlmiNAIqw5oP2xXYwqpelJd4tOe2syqqsnjldazJDb/9/FfIf3L2yNr4PserM7/wCXX0ox/K/FgVtXoFrdDQtI5mklGJa4ROUTMRkWjSXuIjumY5zjls5pjdMsvE2CQmrtBBSMdrXNma5QHPeTr3fN4zdnrkD9/ydrnh/37D5GLKRK4InUOTU0aq1M67XQbOUcmFiU6KuWkLaxPHR17zd5z1or8a9du+4GGnqid87uPqCX/5Em5SjptsymKoCScnUZUa2oQEOkQ58ZJGbVCBodluUTEhNROybtVq1l9/A2aszsSxRy5lNICrvvt/5Ju2MKEUxoHTA1sg47xqJs4d1VwIWl2CuRarXcDaTHPZd/+Pj772TZz7xrcLl47C2R9UePD91Z+/4x9ojleRiXE6QDdPqdWqdJOE2YXtmEpAY2qcXt5DOUslDmlUqvQ6XZ8QENia9JgLNa1GneMe+bBdMxoXbJTvvOVdXPCls6hsnGO1GOqZRbptyLpUIoVWOXnegbTDpFZMdBPuUZ/g8rO+x/vv+UDpfeOHo/G5H7FfJRsAXHq1nPelb3Lx175NPN9iTVwhFGF2cY7Va9bQarXI0pRDZ1ax8aYNVBp1vwiVvv5D1vFWDdwvS3hi5sX+AM1uh3p9jEZcZ6HdZRHYFsLhD38gj37Zn8F97jHiUIGt3/qOfPVfPkqweTszOYw7RT63yFgU+Qyi2htpKaUwutidOsGgcUHEdsnZ6BLc4as49mGn8eB/eMPSdl1/o1zylbP41ee+RDS7yNGTk2Tb54hC40MUq1Ifq4pw6F5cn6Y5K9at5brZrUQzMywEis1kPPuvX8n0s5806rt9QOd/fiD/+Z73U2tnjPUy8u3zNFTIVL1Ot9lCa4UODCYydHptqnEF1bMQhLSikOsDx5nv+gcmnvTIJf3w8Yc8TvSGzaxr1LG9JsYJgVMEznu5eM8z378qMEgU0hOhTU4vNHSwtG3OYmQ4/QXP5aRX/8Wonw8i2O//VD76t29mspkw07Osm5xk09w2okZEq9tCcNSMoW4i6OaEJiDXhjlrUTOTXN9uItPj/NFfvIg1f3LmzmPnpxfLF9/+fty1NzCTZUxoS71maHXn6dmEuFIhS1OyPKc+Oc6WbVsZr42TpUIvcUytO4ymVlw2u5X7PuGxnP6sp48k5fsB+5/ZKLD+Hf8qP/3sF5lxmiBNWLlimmuuupoj7nI45JatN93MYWvX0O52+p4PHq7vollKMYQh7wgGtgUAYhRxWGFx8zZWzKxme7eDzExxVd5i7akn8rTXvgruNkoYBdD71a/lf//9v1i47Gri2RaH1hsE7S5Zp00ujrBaIQgC8jxHLBgTkFuhFxo2pQnRketYc+rJPOzdO7uUXfHuD8sPP/EZjqtOUun0cJ0OQaDIlS3y5gxdPOR6Ox7WmJ2dQ4UhaWCw9Sqb8y7JZIPD73sij3vlS+Aex436bx/wlee/TLZdfDlrgiqVXoI024S5EGhFJpZqtULa7RBphXKKbUmX8Mi7kBy+hqd88RNL2n7Dhz4pP/j4JzkkCklmZwlDM/BscprQ0WcmtUAvy0ErMnFIGBSuuKB0QD5R53qb0KyEPPYpT+GEV4/yrRwUuPpamT/nYr7xoY/S2DrPhIYcCzhELDbrsXZ6Bds2bKIWxBCE5FHMooatAcSHHcIzX/ky4sc9fKfxsvCtn8hX//mjBNffzGqrmNaa0KYsdOaR0BLXK1jJIbc4Bb08Y2xiku5ih3pUI45qbNo2Sx7ENA5ZxzWLc4wddQT3ffyjOfIvdnbrH2HPccCYDS64XL7zLx/lml/9lpU6ZHWlTnv7dkyeU4tjJM+oxCF5kvYXojIGxJLPt4LM5gTaUMWglGGx08HWKmxVOfnKCY46/TQe8ufPg7uNIsiV+Pkb3yZX/PCnxPMt1gYxQZqCCErw6hNrUdqg4pCeNswrS6dR54RHns6p73zTTu34uzf9o1z4zR+wTiLyjZtZNzaBCjStXguJPGOx1E9e47R3baObMjM5hdYBi80mudaYyTE29lo0KyGsnuGRzzmTw563ix3MCHuMzZ/7uvzbm9/KEfUJGqmjmmWo3KG1JlQQpCmVwJAbw2It4DJJ+OsPf4DgIUO2FVdtlk8+9/msTHpE7SYVBMnVoG+lzIIx2Dzkec74+DiZs7RbXcI4olqt0uq22LK4QGXdGppa0cIxdsg6Hv3MP2b6eU8d9fVBgG2f+6Z8470fZBrIOx0CmzMRxUQKXDf12Y2NIY9CFgLFnDHI6pW85O3/APfbIU7PZeulddlVfOQt/8B4O+WeM+to3bSBIHfUq1W6WZegGhLHIc3WPEYc1WoVKwbrhCAIaDabiAgTE1OkuSO1jlQb2oHBrJimcuRhPO6vX8GugoSNcOs4cMwGwHkXy3c+/B9sPO9C4u1NVkZVZqoVts9uoV6vkqcpRpXW8aWdxiDYVz8d8Q63LSUdoiCOY+Zmt1ONYsIgwIkQ1GosSs7WvEe7XuF+T3gM933HLgK8HMTY9OmvyPc+81l6193A6iCioQNUkhNk3g7GGk1TCwuhYb6iOe6hD+KMl74IjlrqGnbRu/5ZLvvf79O84jruOrGSWmpJ2m2cFuJGjcR6ew0jgzgdfYmVgjAASXPSTpdqtYpWATbQtK0jq0bMaVi/OMeJjzyDJ7/qr+GEkZRqX/DB0x4pKzDUuglRbnG5xSQpK1RAniW0AsWWhmHs9PvxRx/+tyVtvemjX5D//dd/Y0We4ha2ceiKlfRaGUqCJXlXBm6MYIx3MZTcEldCADqtNkEQsGLVSjZt3040Ps5CltGrxDSN4rD73IvHvOD58KCRG/sfOjpf+ra899Wv5ZRjjqe7YSNmscNUXEU7i6pEbM0S0okaW4xi4uij+JN3vA2OPnSncfGrN7xNLv/pT4nmF5jWAdnsHCvHp+h0eoyPT5JmOVmWERiwWYLCEmqDIqKXeulbtVFlcXEe6zKmJyZpNtvEURUbhWx3jmYYYA5dzYOf8RTucsZD4Kid6zHC7nFgmQ2Ai6+UT7ziNazpOMK5RcIspR6HtJI2uU2pak+AyngPVpUidt2PXlm6Y/rrBioWKMMya2qNKjowbN82SxRFfnderzMnOdtCxQOf/Qzu/cZXjwbHMC69VL72nveQX7+RfMMs9Z5jiohAaVpK2B5aZhsRY3c/muf993/t1HazX/+hfOuf3kW4dQtrxqegm1I3Ee2FeRpjY94d0phC7aUpnaDL/suNw0Y+b45kOUb52A/tZouZyRX0ckuiNGPr1nHhhptIpyZ58kv/nCNeuHPwsBH2HD95xWvlil/8mlou1JUmbHY5xNTo9tpsDhK2rm7wgn//Z8L7nDpo5/OvkU++4rVMLM4zkXSpm4Tu/CLVYBLtzBLVpygpPjvSPPMbizyn3W4SxzFjjQZZltFrtqjpiDzPqa1Yybakx6LR9KoxzTjiyPudxOOe/xw4eeQS/QeNn/1W/u5pz+Zhdz2e2rYWtcwxv7AdPTPOtnrIwlSFVaecyONf9mI46q5Lx8L518o33vlPzK+/gmqvw4wGSbtoFLkVcgKMjnEJ5N2EahTSqMVYlyBOIakiiGo02/NMTU+Q5D2StM3qFSvYvHkz1lrGpqfY2upRW7OaK7dsJl69ksPveQ8e9aI/hfvfezQ29xAHntkAuPQ6+fjzX0xtscMMoLMUEUs1DpEkQUlpmzEIMFVGrAzcwE4DBjk6fGAwCIwhsym6ErFtbjuTY+P9RSvJLGqszk1Jm7lGzCP+9Lnc/a9ePhocw7jqMjn3c1/i/G/9kOpiyrqwQZakLJLRnqpRO+EonvHm18Fdl6qhNn7m2/K1f/0wKxbnWBMFpO0uWilcllONfRC20AQopwZB3fB9VvZxahyuHrB1fpaVMytoL8wzWR0n7XRphFU6nR5KBzStJVq5gpuTHoux4cj7ncwTnvts9ENHyd6WC/e/P5aPvO0dTGQOvXWB1S4grkbcpHtMnnYvHvuJpbYa13z4M/LDj3yC1XlG3G1RryuklxFIBeUCRCnPZFCGs/cu7GjBuRwRIQxDTKDpdru43DJWqREkKQZFK8+RWkxLa5oK1Pg4c0pI4ogznvpk7vWEx8IxR476+w8U7mvfk//6+39iupkxJobqxBg3defZPKY4/U/P5F5//Zc79/3ZV8nn//Ft6C2bUQvbmQg00lmgXo1p9bqYuAZBhE0Usan4GE3OYZTQSbx0zUiEiCKuxczObqU2ViGKNZs2buTQw9ZhE0ur2yFqjDHf7VKZnmbTwjzVqRlajRqP+quXcdhTHzcal3uA24bZAPjNBfL//vZNxNsWGE9ypsMY12kTkEGRUNipQZ+VzMVwanoYFtUW3yN97xVB9VUuxnmGpJtmxKum2Jj22B4aXvjmv6N+r3vC0SPCNYzu1/5HPvcvHyGY7yIizOYJ606+J8/69L/v1E6tL35DPvv297MKTdhrEYv1YeWL/lNOcM5BEb8Ddk5RD75/Ei2oKCBQGrGWPPXGW4HSGOPtcHp5Rliv085zbKhp25ygUuXkJzyOY57/3JE4c7m4+ib54fs+xJX/9zNWhXVUaJjVGS9+11vg0UPxTi67SD72ktdR2bCVdTpApwl5kBGGIbongwBwRYycEgOj4F3TGF1knwVXhEvXg1IZch2QakMWxaS1Ko95zpkc8ZI/G/X1Hyhan/u2fOafPkgjiGnalHyywtNf8zLWPWnnxVy+/DP59Ac+QNCcpepSQhECfEZrxOFEEAGtg0H0UdE+qKEMqfqKFcNB3ytycNbfQylVqO51v3QKmoFmS63C8aefxsPP/GM4ZeSxcku47ZgNgAsvlw+86OXMZAJb5zmkMYbKe/18KHuPwaCwyi9qw54O4NCBYUtzHhkbQ1ZMcm23y+ve927UGQ8aDYxhrL9O2DTLWZ/6LNeuX8/KI+/Cs9/4ajj6iKUSjbO+LZ97+3s5ghg9t8B4NcZlPfLckecpIgqlhECHmED5/lBup1KJn7jdPEUphdYag0IptYQxydIUbQzVapXFVpMoijBRyPz8PNG6tTQPOZRnvuqVxA+576g/l4kr3v/v8r0vfI12t8OJD30Qj/nwPy1py59+4L1y4Se/xmGpYo0KSbstXC0glYxgSc6cvYOPZCs+TodaastTRhnOncYGId0wZk4LY0fdlUc+90xW/9GjR/39h4b1GyW5aD3vf/e7MPU6r3//2+Hex+7Uz4vf+L588q3vZ20QYjoLGJvgrMU5z0gYY4iDEK01ztpBWAV23vQ4vfPa078WvDpeFRlqladPpRl0Ghq2iqMbB2T1Kk978QtZ8/yRind3uG2ZDWDxm/8rn3jX+5lxhqDVoZY7IrtvzIYX3w6YDc0g10oURaQ4Okax3VnajRo393r87Xvfw/hjTh0NjB1x1fXyq+9/n1Mf8lDUPZaqTm74zW/lA699AysSxToV4rbPUzWaAAiCCGMUBgPK4SwIljxzfeZiEAd2UMZBiDiHcw6N8tIMJ+R5Tp7nNGp1rDiiKGK+uUgURYxPTjA/P89CbpmvVGF6hgc/6THc5wmPhrsdMurTZaD3u9/Lu9/2Dl7/pr+ncsogNs3CRRfJv77m75i6cZ4jiRnvZmTdFuFkjW3tRaK4uuxnKgFjBQ1Y5ZYk4TKF+g3RWKcJJsbY0unQDAOy8RqHnHAcT/2LF8F9R27Rf2i46Ws/kEPvcXc4due5/MX3fUC+8+nPceLao7GbtzLtLFURQmPQWiMiWOsNn13ujUCBnbykSvTVfUMY5ICCMAwREcT5lAsiAs5fIGgqjTFunpslXrOaTWmHYx98Kk980Z/CPUaG7DviNmc2ADZ/6Sz5t396N6viGpVCj1amLt+bEkCXKphiOJXZAX0OEMi6XZxWuDBAT02yJc9JqhVkbJzXvedtxMcdNhoUe4ivfezjMplrDm2MwdwCNVGYnL5HkbWWbqfD4uIiCwsLdDodqlW/GO169+sZDLEZLrcAGKVwzpGmKXmec9MNN9LqtKlWq2TWkheJ+QBsEDHXy6itWsGGhe3U1q7gea94Kcc+cuekcCMsD//z/z4h3/3U5zkhHGOqm8NCC60s8fQYWxfmCCqVvZ63ZalFo6x3nXVFMD+KLNGhE7TAWKXOtu2z1MenWcxSOkYTr5phS7fN9lg4/Iz78fA//iOOP26UD+kPHVddeL5svPIaahm0N27lkLEJTLNJtdikOOf69Gd+fp5uu0Mt9rRiR4lGP2PXLpiN4euvuepq74JrfUiAkuEo80f1Wm3Gp2fYmnQJV01xU6fNYqB41ktfxEPOHLlwD+N2YTYAuPAySebmMSbEx5Vkr0svvSjrr5AiiRQ4cM5faAyMj+M2bkRPTpBqw2wvoa0NRz90pGMbYYRbwvb1GyTZvI0ZZ4iSFLIMYgXVgNTlPjlzEV9jb+cvotHid55OScGEODQ+rD0OP3+bbahVoVqDLKXlLF0sSWyIV02y8qjRLnKEEe7ouP2YjRFGGGGEEUYY4aDAfk3ENsIII4wwwggjjLAjRszGCCOMMMIII4xwQDFiNkYYYYQRRhhhhAOKEbMxwggjjDDCCCMcUAR8/3fyna9/A3oJsYJaEJK0W0RRgGghcflQiGmNdj59tBlKqlUGayo5FyV7xsOUrm7Lh0MVAcHE27BT8k+iXHFvB8r2f6GkjBqk+wGmRC3P9fbOXuZa0wsCrIJAcozYfoQ9D42gcGhEeS8fJT7yo0IwDgKnMLfQhbfkJuCU9oGclB46d8s9PuxC6xRkZhC1w/fvIHlf/+8lES53iPdRjJHbqx9uT/j+8/Uoo3eWOYd8P/v5ogR2NCQ3qP41y4dDYUHlhQN7eTc91Dilh1np1j4I+iZKsDpHtF3Snk75fh8uYTdeMaJu93l4Zy73Db5fVbGeLHWP11jtCtoz6EPj/HVGyh68ZZpxi+4PapjW7T38vBnk6+rfVso10vVL/7Xr/24Q1p/bdf3ZN+j+W0mZ08yVbeD7LVHgqiGPffaZBGxbZPPZ52OSlCDPmQgimvPzjNWrJHmCCkw/uh+Ug0KjnUIjfeI0jEEMDHbuzOINB4RB2FWEyT0tdX9xLBbE4sblfX1Y2nxJA3niVTIl+UHLbFgVkOkAp1TBaOR95g2KSURQJMkbBIwvGY7AOeJ8wHjuCrc0mUV5RqMcW76vBsyAUw69QzCw0rVZiV8ce6GvpxI/HpUotPhSIUuiBw4zJOW7cBD3vxJNZP1cyDXkGrKhdV7JgHHTosFZQKN3ZCGXOX9F51idUy4JWlQxPwe95TcHfiOjnMIU9fbjx2JNit0hCuTuhtwtEdk7Qn8cfKVGuQCg6NdinDHI6u0Apz1bOryJGN7gyK2EsN05lOCOTPLurrjl0ipIAj9vXJ999VeUjLyRIr+XLM3vJaoMKHbnpT9+UxAUdNx/9uf9PLVK0xaHq0XwxKcQEGnIelSVIrCOmhECFBNG00k9UbdFAyG+kTUOU3aXgBTR/wYzd7Cj1EOEyw+MsnsHuRScKrJ0sXelFodRPhwt4rPD9rmt4jrRggzlXEFUQWh9va0WrJJlDLU7f6mcxWRBf1FGKUDhlMNpP1hc0ZZ9pnKoKRWaQC/dkeyCjgO7C+oFSlx/dRikJnf9caWEYnHyZT93gYB1kOU+xLVyugh7P2BG+r8ffl757sX9BMFxkPY/QlD0jXMOB1gZEEMlnlgaV+woi+B7SnlpQFYwKHaZ89cpSI1C1GBOmoIT0FJStUEfKl3SFdvfUzlVTP4h7G7pGX7/HXFH6I+Dr7Ro5QebUgXl7ku6yx4GEXDFZz9uy693HZBrR+xK0rWUHrk9Lst1pUTd+mXRoZEhpte4oflT1rmoa8lESf//Oyf9AYtCIaLIi/lc9pIWTa4U9Xqdzb0mZD0CsCjJCVSAkRydCpHkBGmKSXpIrlHaodRATSECzqnixj4YTxmJrWxuwTe2kx07lqLDygyvu5r6ewaHQ3D9JDsiAWpo9PlU13l/EYPiuqIxfLvkoB0igOKgKrXTBLnFOI3TtmAa84JBA4VCEWAY7GZ98w46VICBkmr3zIbbxQrgdypuJ1H3MOMqQ9cOf/aLno9eqtWudw6KghEu71HcQGSI2SgWytuj/VXxPrdbKRrrgv5cLQm+6JIpAEGBFZSDkpY65SUhTquBZHIZEOUZCKddf3PimcbiOeV1w7/B9enKMIaJYPnVTjsxtQtqU9T9jjAf72zlfhmHpZSKHfumWLaK5yg1uE6gz2TIbsbejpuM3bEPw9iTHf2Ozwhcsezqknb5O6vi+zK6eflTQffpk6+F83ToTth/5bqLAtG6mF9e1SmicUqDETQCGgJCgwoUYNHGgRVC7XBZlwhBBRqrNblWxSRWKNEYp1FFY4kCq8vMeGXn+KsH4rGikxVoBeLJGMr1ZSR7DacUeaGzN6IRp9BucDelHChDqQIYiI8V2hkUoDEY5Q4I53dHL5VoTJE7gGLx8Imw/ITRookk8H1d6u6HJrlVkCtZMgl3kiSUmWB3OD+43voa9e87mJhuh/uWE9jXzb9DpSBWw3SgHIdW4SNTMtjNKAa7Do3BqvB23BnczhC9pF36u75iXvUXbecP6wSrwWlDYgDliHOFKaKALgcOT6X7fVN+UYyvgbgZREm//1VRf+1CQO9yUdid7caONSj3zbf3fLyzlfsOB8iSvh6+s3agpbQNKuQAhdrVjwswBLukLX1J+g62RjvW2w0xK8thNqJC5GvLzXYh9Su/H2QvL5mlYWbDeMkud87+85IbhyhBG0WufSP6LLsarRTbuy30WBUiQ4DkZDYly6EiAi5Ha0+kg2pMnufFePCNKADiObE+MSo4Mym2D6JksGAUzEZ58aChQVAYV3B1y4DT0s+pIAJapOCUvUjdCX6XJsWCKANmA8np63Rgt5zvbVXKMst9ea7CYYtJZMXhJMeJ4HCFMZ5DXI6I7jNxCl1MUIeXgKqlk3DHviyYjfL0UuLvUGL97lj8uBkunRKvx1eCE2+D4ZldodThOmTJ+OrXRflDkMG4pLivCEZUSeoAfbv1+y7Xv9sIghcLO/ymwAFIca4gnkpAnHhJgvI70VwcufNMiROHtrf8nN3DG8+VzMIwM+mUK7R6nhGVQoLiv/aldgFSqOF2mh8lw8HS0t+bIWmr2+V1o3LPyn0ev4V0sVxbhhfqcu1QAn0Ty/6i7q8TpXamOQxtbnZYXHZaazzXSn/dklsudUGXPB2in2lWKb8elffRxYJT1rtkKkRpvy71N76ert4Z+0+Jw+H67aO1Z7qUaHAa0ZpqGCDaQLNJ4JcPQ0WE0BYcvoHUWm8MWuhTjWi/uPQXm8HCoUpPlIJwuL5ufbhivvTXlWf1YFAsA1ocgTVDn0vmwQ3sRVzJyy35ZfHcHc/fftiVTnFPyn1FOXFVwWBo63DKDNQWxeLs+h49wjCB1sOUfpcP2PmzGir92Cl4bVnKe+/KQHS4VOJVOEvGWrlYFX97nfCOv/NW7iXUHWgc3Jbwkr2doYHA6iWfl3zvICza2eyh59nuUOrANQOJ1JLvi37WOOhLUIpMnuUc3sU8uKWpUUpRyieMcDtCFEpM37Zv5+/LHio2O4VE81ZsQvt0QN3KcjpYBzwdKunRrZV9aRpDGxxxqKH7DOjV0ufpUg/BnZv2OFVs7AsJhxKHVyI4QufX40yDsg70kAZjIPLxu4bcUKgo/A1L0cjSh5XcWtlpBWGQgcfHwPPDezQsPU//98spwatzdKHWKd9jGIN67b/n7q9yf2Ff6uH6HjseZT8Pe+xY7RcBX7r+50G/73m5a+gl42fpONr99+V7LK2fL8v32/Xv9D632x9KOdwvw+PSFETd7KIfNQNL+6WqteWXO/bfzv24lJ54A+CyH72kbU9Llny+Y/TDwVvual3Yed0Y/h3sGZ3Z83qUa8Kel+W4Hx6vO95nd3Rm+fW8g5VAGXJCy7BXYmEiwZCBvuzCi82hcUPeG6JYsjktF5nhwzEql1MuacNllneE9xiVo3JUjspReZCVxSGKvoRHhj8PXY8qtRpq8OMSbvgY+t5fe/vpuP+QyvJv8O26nPKO8B6jclSOylE5Kg++clcYZkT6NpoKglv4zS7ustT+YThi5wjLwy112ggjjDDCCCPc0dGXeOxwri/EUHvAKezeTGyE/YnS4GlvyxFGGGGEEUa4XSBqyUe1q0uK0scaFc3S0ExL0Q/5rEpDrSFb/tGit1+gGFjJ7005wggjjDDCCLcXSvfkMrjijucV4ON69V0Q6QdK0gJaVD+gSj8REgPGowzyVHIyo3Lvy+FjX+5xe7/HqByVo3JUjsqDsCx4BlX83T83JIHv/z04UWZUHAqww2AXXXIpwyhvNHzdqNzzcn8dt/d7jMpROSpH5ag8SEtZWg5/hyuj/qrdGWLonf7Wu/1+hBFGGGGEEUY4qHArAf1UeVmRIGaPvFGE0mtCMWyk4ZQG0f3vR+XelfsLt/d7jMpROSpH5ag8yErlSz38ueQwCiilfH4spQhQPmGV1f7Q4i+yAAq06gcH7l9Xfq8F+nnP1KhcTlm293Lh7iDvMSpH5agclaPyICvxzEcZUbUfB6o40AWzoRUBWmOVwirBKjDFxVb8DbWmnybe4RmT4h5LkrGNsDzsj/wmI4wwwggjjHBbww0JKJwe8Ae2+Nsi5EWmzAAFefFFrovsj8ozGEoPzonzXEuZ3teIZ25ktFiOMMIII4wwwkGHUn1S8gJWAQqs839n4rDOgQgBhfrEaY1VGotP4VuqUUpxidKFrkYpn0rXsUSUMsIII4wwwggjHDzwPEHxQQ3MKkrJhtPgjAINQR4FLEYByigqoUIrAzgyF2CMQTnVz6jqOReNqCKdLDDIzLkPFVauyOK4czkwP1maenzYEna5vjHD/sBlg+2ppGY422VZu919v6vflu8zbGSzq/uWddpdG+/Luw/fYZD51Q0Gj+gl9SrrUl659A5uF3VcmmHXDZ1V4obaXi+5Zsf33fEdh59f3qv8tGPb7Vib4T73z97FhXuIXbVF+ZwR7lzY1fwanr+31M/7Sv9uDTuOM70DxVlKP4q5BKBcfz7R/768x+C3t4Zdjeelc3lQz11hd8/Y3+23/6XsxXrDXsxp0UM05ZZbd+n777zO7Vm5b9CFJmPnMTbcL25JPjT/u4LqK38PIw5wWO2vChxYFZAYTaca0a1GKJGR1cUII4wwwggjjHDgMNqEjTDCCCOMMMIIBxQjZmOEEUYYYYQRRjigGDEbI4wwwggjjDDCAcWI2RhhhBFGGGGEEQ4oRszGCCOMMMIII4xwQDFiNkYYYYQRRhhhhAOKEbMxwggjjDDCCCMcUIyYjREOPK6/ehTMZYQRRhjhIMYuU8x/523vE9dsEwHdZhMYRCYvoy8qAZRDiwNliytkL0uwuwj7VkYzcxpUYOjlGYcfcRemVq7AIRx17DFUHvig2yxY+sdf8XqpLfY4dGKCvNejm3fIKwGJy6lRHYr66ZPvqqGYcwL0nKMbGNYecxSPeNXL96jen/v7t0q42CFKLUZ8VM/y0AKhK/vCP6eMolnGp7dKkxo46bQHcNSzn77f2uoLr3ur6PlFImeJtKC04IBcBwiawKmiPQSrc4gVeZZQzRDJhYwANz3BU9/79ts82L2cd6FsuPZ6WvMLJM02nfl5ZjdvxMjejltfOjQZBvDvrIfSEjoFuVKYapWudjzrfe8YBfe/E6B93kXytU9/Gt1LqSmNQTBLWGU9NO981MTl0j+HRggwAqH1URgFSANHqjW5cWinUUDNVEiyjB6OrBZzxtP/iNWnnXKLY+oH//GfsumSS6jlQmxzTBEC0ipNrj3diHILQGoGSTV9REh/XVYJSRoVnvP2f9ij8XvJp78sl559DmNBwNz2bdTrVZ8NtE+n/PsYp4r5ku/T+iHO9PsFnG/TIvK0VUBoGJuaZPW6daxct5qZlasIZqbg2Lse0Pl482/Olf/7+teJOj0qeU7ofI8Lumh/X+/A2SL65jIjiKoy6fvet59VQBSx4m7H8ICXv2Sv28NddLWcc+5vOP/888mTlMMPP4Kjjz2WY46/G8EJx+50v52ZjfUb5NzvfJ+g2WU6qmCsbwxdJF4rwz37UOXiQ4erfFmNpQWMlaUhdhmET7UKlNGYOOL8H/yKuFphxZrV/Gp2G2meyz1PvT/3e9JjidesQJ900gEbPFf+9lzWJYIJKiQLc1gc1VUTLMzN41SdwJZhrx0oWTLYrdEkoWHWWapuzwVJF//o5zSaPVapiMg5REk/DK4uiJMWsEotCbktSsg1pEaRGM22a67jhWvWSXjGafulfa75+dlMdVOqkmNcjpEcUZDqAMQQWE88ReVYbUlMRhwa2s0eBkOiQppjjf1RlVvGORfLpgt+z4arrubKiy/mxvXXE1hLo1qjFsaQW5Jul2q03DDB2hMO8aWfD56auyKpYWY0HaOYEwvnXCrc9+4jhuMOjroorv7teUyJIkoyKg4C53ziSSnTMxQLnRIfEnyZ9A/RCAYjesBsKCE1jl6gybTDYEg7XWomJskt1KrM2pS5I45i9Wmn3OK7XH/OhWz9/SWMpzljqSVyfnxa5TN9A0SZFM/0+SzA0xXtPP2YlYyFsXiP2+8nn/sqs1dfw5HTM6gkYcFavyAWNN6IT3/hU2A48iBbdvtpAZObIqy2X0RFKVyx+3MaennGXGi4MYzIlSXJLbVGg2NPOF6OuNc9OOSRD4ZQwTFH79e5aZodrvz5b5nOLfXMUsuKkN5SZlkPQOUYEhR2kKNhb0pgoJxYDv2ClnX0NmyDl79kj9+t891fymc+9Z9svOlGEpdSrVZRTrjp/Es5v/FTOkmP0x/5SHncc86Eow/rt+sumI3rGE+FmaBCJcmpCARO+rHS/Q6ujMEvWO0QtRyuVFACgR3ObeEhxQ7eKtAo5jZu5siJMbQK2HzxZdQrMYdMTXH9L3/DL378I6JVM5x46gPk4S98ARy7fwcNwGQUslaFVLYvMpYI9UaFtNVjTDS13BJYPZBsqDLficNq6CQZbqwBGiaMubVH9TGWO+5aG6fWTKjkyjMbDDLuxrm/LjWqn9bXQ7AaMqvoBorO7AIffsvbeNUZ/7tf2qKR5qwRRdUp6GUExvdVqn3lIitop0ApcgMdKwR5SmwhMCFdFZF20/1Sl51w/gVy4Q9+wgU/+TmtGzZRtWCSFGMt9xyfZmKyRrfZorl9jjAMGRsbI0nbLG9X5aVY4vzfxgHKM85lBuVeoOhpQ9WEXPWrX3PMfe9+YN57hP2HXs6YhWllqOQZNefnmil2+35H5LdFTrFP9I9ip6udFM/w9DQTRxfIjSMOQlwYI62U+tg4HYFIG64751yOu/IRwrF32S29mzYR1mqmcsV4BrEd7P9z7XNahbl/lyQo6a2HEkXiFBOTE6y33T1ru/OvlN6mLRwaVRlrJVTFod3QWwtoUSiEwHomJxewernrh0Jb59cjpz3tLTM1KUEcxNUxFjstep02QSWGMCSZa3Ldz3/NFb87h02f/BinP+nxPOjRjxIedP/9tnasGp9gWgdMW8d4DvXMERVCCKcUuRJECwrZJ8mOX3j0stpPUNQSR+e6jXDJVcIJx9zq+2/4/Fny3x/9dzqtNkcfczRPefpTaUxNwerVcNNGfnfO7/jhT37KL3/4YzbeeBMv/PiH+r/didk496e/YNw6ZlQEnTaxdYWYZyAmLjlJUYIzbtnJrAoh2k4YTh6UpJYVM5NkNqfdXmR6YgxlNN3FeWKlOWnVGm7YvIXNvzqH9373R/zRnz5Pjnn84+BuR+y3gaPznGyxzVTmGFdQsbBhdjNxvYqyOa7PaA6YJgUorTEaep0mNgpI7Z4vslUrxFlGtdWlkruCqElfjRJ46Sd5oBANxg0YQQeEWqMDjcoMNCp8/tkvlGd97uP73CY1LLLQIkIIycmyDKcVYizaGXQeoB1exWZy4oqj22pT1zEuTZBqgAp3qb1bNvJvfF/O/enPueJ355JsmmVFVOFwUyXrtqiGMWGgyNsdFrdtRURYOT6O1pr5bZsx8fLrogFjTX8hUiJoUYVkw7c/uaEbaS782S855uEPFU44aiTduAMjnZsjzHKk22NMBYTdLrEVdD9xoB7QJ8W+0T8FDq+/cLkfPyiHGIcTjVhHt9NmIq7hbI7udbE2I6qFXHP5Zf5HtwBjLTrpEnYsUZJSsYISh1WaQoviF0CAbLBp1qJQ4sevjQy1aM/e5/Kzf0010kzoALYv+DbDMxdelaIQ8enDrRRsj7FDSSD3Dk5BVkp70SCuLyUv0Wp20IGhUQnIVUbS66BFaEQh42FAlDmu/J8fcv63f8C9T3+gnP6Kv4S0C3ffx01rmpIuLmJyRZikRKkQOVBOYbVGK43VOc4kOG295KeUAO1pCYCFHd55z6EZ1xGtxUXmL72EyROOucWrN3/3R/KVj3+KOob7PvR0znjxCyHrQRzDsXdRBIHc7+i7cr/TH8x/ffrTXHLllXz0Za+Wl330/Qp2wWxccd7v0d0E5XLCJKMWGAwgyvXVGx6CAIFWmH3olh1NNoYzAIqCUBmyZpNcHPUwxChNlmQoJ1SigPa1Gzi0UkXmO4hS/M/H/4tDzjmXZ7z1LcIxh+8Xwm6MUAkCGpGDhS5hCJO1CrkGioGiVKlqEl+KwiohMBEWqAeGWO15dSLrSOYXWEVIXEh5cu2lFkogxE82Eyi0Aq2G7ThABCInxM7Q277InF3P91/9d/Ko9++b7UA1joiVUFOKEEWCkOlC/6oUFRQBnrDkeJ032lALIhIRUiuoINyXKgxw4bXym3//D244/0JaW2ZZUavRqDSwzRaStZiIY5JWi1x7dVzNKERrIi1oLVRDjVJqn7JFqkLSFDiHcRT2HxqL/zvLciKtuenqqyG75cVhhNsfUbXKZK1G2JonMpYYTaRyFAq08/vBQvLqdxTLp3+lqtgIROLHjyt2DLn2ktEsTwiCkFALvWaTer1CLg6XdGDTBjjuqN3e32YpkdZExo/BSHJAYZRFFdxGuQBIIaE04u0pAuulyrPzC8Qr6nv0Pj/7/nepikCzyZiCsSDGZWlftesYzDXlvC4+RBWSoeW1X6ZdIe31uy8ltqC/hYTDOVxuydIuSikacYUwDEnSlNbmzaybmGGh1WFyrM71v/wdH7voZbz4/e9ZVn2W1C1LibQiNEJY9gH0x4vSgtYap0JEmb6gYq9L0YO/9xqKIDRUtOLKiy/mlGf80S1e/e3PfB7bbHPSSSfy4Je9kHP/99vMbtjEr372c0ITyGGHHcbRRx7Nae98o3p+EMk/vf0fueL3v+ecT35B7vuCM9VSZuPsi2Rx2zYmtSZ0QjUMwGZYlWMRcuX1esNp0bU1++TSUnK1w4anO6YeDsOQIAhoddr0FppMjI8ThlXmt27nmKkVLDRbWAxBoLFoZq+4hve96KW85v3vFk6+5z4zHE6BCTWdhSaxS2h1UsxETM8lWAcoz6Ubho03NQqHyyxRNSa0hepj/U3CUYfeap2iMKQS57huTi6WTOVkCrKicVLlxWBJQTTC4o6ho1j0NOLAWsthM1NsTBPW/+Zctn7xW7LymU9cdpv0JEMCyF1Gr71IFAcYp7HKoMQSZJrA+X4V53CSUA0CXC8lVCFYR5Iky318H/Pf+YV89v0fZHJ2gWo3ZUUQYTo9umlKJdBE9YieTanO1Gm2WyhlieOYLMuYa82hlCJQGuXUsueqVZAaz0BESggURLYwkBWNE00trmKrEduSDu2rr6Z+n7vt87uPcAARRtg0I9bQajUJTEhGXthiQaYtuWZg82B13/Byb+EUiHY4cYgTlAWlnedhjEMJ1KOQGMHYnNAYXBiQKqGm4Zxf/JL7PvT03d7fVAJScn8oi1I5UNp0uWIz54lsrv37BA4iQEmAc0KlGhJHeyDauHK9pFu3M+0UVSsEvQxxPQKj/AbJeIP/XBU2TkqjcWjnlr1+iHJ9aZAS3VfzGwEt1n8G4jhGmypJktBttlBa04giZupjdLctsDKMUFaxKemSWsvH3/D3vPDdbxfufbflrx1a05gaJ9s2S6osKXnR34XxvtaAJnAabfdlBS2NRPceVkEz7WIbFS6++GJuyQIo+enZsm39DVSznAef+XQ45nD1i/ecIzeccxGnHHdPJsenuO6aa/n1+p9w5NrDZO3pD+U5T3gKn/7yl/jN937EfU87fan8ZfvlV2Fbi1QElBJSm+GM4LTCaY0zCqcVufFbaYXGKEUgBo1BKbXXRyCGQBQBxd/4e5ninhpDluR02z2qYZUVY9Pk7ZTu9harJqboNltEOsDkjoYyzChNtdllqpfz4de/Cc67RHbXgHsKrTVJ0qVne6w8dDUdl9FutwGNaINohVLF+2MQPWiLMDQE2mC7XVyasCeMBkCeJAS6ENMab/iEVsVO3PeDaDAoDP68M4I1gg0EZwSlhCC3qGaTGQLM1gU+/6F/g5+fs+w26XRaWLHoOMSEQfF0gx6qB1qhlWCUoJUiDiO63S5aaypxTCXcQ7nsrnDFDfLrt75PPvbWtxHMNQmTjCDNqFhhPAipmwBjBclylAidXhcBxGi6NiOxOUElolKrYqIQpRSaweHH485HORZ1v8UNfZFSeRT94ooxYVBk3S6u1WZlXOO3P/zR8t97hNsGacLCwjxTY+NU4xjRnv5Z4+meFLRPzICGeVXBYP4PxtLg8OcGY6gcV6Y4j9KIVqD896EzxM5gOxlaNL1uQn2sQbfVxvVSxiVgw6VX3OKrWKX7dNnTBv8ezqjSPhVrNNaUYxjQeBofCKIhUJo8uXX1b+uiywkXe/Q2b2M8ivyuPgz7bSTKv1tJ65WS4rulc0v3288saVdRpn+U889gCFCEojDiy2iovZVSOOfotTukCy2CzDEeVakFEeSWbrPNWBgxFoS0t22n4oQJB+1rruffX/MGOHf5a0eWJHRa7T5dLNdOKdtCD9ZQTYAe+qdUcfhVEUVQXBMQSHloAhRaqV20354dSinyPCcymvmbboZzf7/b9/39z8+mKpqTT7kfPPR+CmBqxQxr6mM888zn8ug/+VPuf897EQaaS666HO59mDr8gfcnTnPmrrgGts4vVaP835e/zmH1Sez2bfQUVKqGNHfokicpqmKsFxuHTg88SQqRYF9MJkvLEsPfe2mGK6QAeHVE8RhhYCgqxe6957yqQkcxRqCVWfJKhFVF/ZKUMVHEWtOa77DYTfnq297N0979duHY5atUXJphAiGqGjYvbkdXY0JdIc8cSheSGYcnGqUuksIrwWh6WUpcif1CvIcIjAFJyU1eiMk0xvrDq7NylECt4IrTYufQC13B3TuM08RGYzDk8/PMRAFZ5vjIG97Iyz/yIeFex+91m1RNjMaSpRZlosLRVwEBDkUSeMv9oDB2M0bTSxMq4w161pJlGUR7bii7I9Z//otc9KWvszaIaAQBSnKiALS1kGXeKFQMWMFqTe4caEMuDhHQQYATyHOLcrrYVRX/F+LXcsyW9i+i6NtiDI9zhyawDo0jsIMxPBjyjtgpQgyml3HFL37LGct+8xFuGwj1ep1eq804OxrBg7Z+zAQFzTGuMPUsaZDSfdfRYdo3PM6g2IEDrvBQs3gphxJ/v9ImKwxj0kRQYxNs6yW4OCJEUelaNl92zS2+iTYBkVXEeeE5VdxfCcR54Xpb1FuJK61RvATHQK4GTgG3hmt/93smuzBVGyfvpagooutytASFsb9/TmQBHFaVbvzD82UAJbqg/xqnB78v27wvCXde3RM43+b+nbzBuihQ2ni306I9bS7kBtLAQGBopQ6X96AeozVUk5S76Ai7ZZHPvOoN/MnPzrr1l98FojAmdpo41wROPF1QXnKkxbe7eB+2gYSGYXMFjVBKbLz0TFP0H95+D3HooteWAyXQqNXYsrDIyukZetfeROXke+3y2hsvXU9FRdzlngMjd9XqsJoYLr6K8y/4Cr+57PeYtdM84pV/6i+4z9HK9HI5hCpsWxwa/RdfK/nW7aRz26kqTbUSkaYlR+tZXiUaLdrrGK3ud/AwCs/zPlOhhaHmcLscvE6BMBhconThnlUcujiKz6J0P+ZEpjW5Vn3DyTiHWu4YTx0TSU56481c9JnPLaMrlkKJ16c67a2JveuVQbsA7TTGBSgX+ElCQN81Uum+ncXePk+L19taLTjKQWcIrTfg8rYCXhRnhP6k9mJecMqRJSmu12HMhKwII+JuD7PQ4n8/8CFYf8OyOffS4MthivctFmLtLfSXesgstfdRy5ke11wl573pH+W3X/0ma0RRWWyiFuYJXY4WN3DP7o8vVZQlI6H7E1eL7jMajoJ5oHS5dv16LjX3XXrOGwWqIc8s+gTFKvrEVOEwLiewltha+OGv9lnSNsIBxNBmqK8WL0zjBa+eDJ0msP7Y0SBxeNSU4u1h7zqrBvRxeBZYTZ++edoyOByazNsa+3mlhNAKsXX0fvCT3Y4na72XVOB2YHwK99Nys6iKdzKFrVm/rnowb24N68+/kDHRSCch0Jpmr+PtzJTuMwBKik1ZsWAuXSbVkr/0kjM7tWzxHrrP9PdFNZRxLAZHpgumqvhehq5RcYgNNDkCzhLnjkaWU2/3iBfa/ODlr17efBVVtL1eQoc8/SnijLihtbEIIaGKFdQzHeLHi3ZDTIhnNETl/hwDurq3JYBLE6raEHYTrjr/ot2+TlytkLjcex1efa0A1IKIzZs387WvfYVzLziPtYesZdXqFXD0wKtlolJBt7tgogGzIZddgWu1ML2UqiiqKIy1hM4VfuYlQS8N4RxKHE65wu7CN5opdtV66DdGHKFzhGVZHApXxCPwOsTUODLtD6tLD4zh+w+OcgRoAS2eR/SBxgQl3uo6cA46XX75vR/AORf/wRH54YVNYMliq4tDKSGKIrIkZWHrLCtqdaqZ5dpzLuDs//zM3j+TgT/+bYlt51zI9z7/ZWLrmIxiaijGwgqRhdB5FzKnhCwQkvIw3salz/jiCKwnvmExLlEOV443NRh3uRkcVvl7ixo0sBHpx5mxQ+N1eOzmxT0zchwWZeDC3/zitm+8EQ4clKdjppAM6ELW59QO42loTGWBp3W5GdA3v5gMyv7v1VI6OHydxvH7s8/ebdVcbvt0MShtudyACXfopSvPMpH8+jey+fobCMVitAMsQUARg8kVNhVlAMjBWuGlv/3t6aAdZXB9uZYEzhE5R2hdIVV3KHyMn9y4wg4FMuP6xrWlBLJk9nb0GlICSnk1h3YW5SyBiDeOzR10e1zwy1+T/uyXB3DtEBS2iNHjDz+GclA+4JlTxdjRjsxYUpOTGUdmnPdo2cX42ZMSHMpa6kGMssLvzzt399WcbtAi56ZNm+DoIxXA/EITVk7wsD87k4c8+6n8+oqLufHaG1n86ln99pJeymKvA6EaMBsX/va3hApq1RjJM7K0RyUK+txUye1KsWN2ynnjJjUQiXk67IZicXgOdrjUMhC8lxje9e6K+9qlJGRYcrILaYlCMOKoiSFop/z2q9+49X6/k8HhRYxe2gKg+26YZZvkuTdgHGvUqIYh3bl56rkw5TSXfv+nbPh/X9iriWSV6ksB2KUA9ADgd+fJJ9/5fg5vTDJhQmyrQ12HBGlObKUQTZbW6T5mQGIgC1x/V6AKn39TEN7A+V2WR0HIC4lMn8gXxzDD65ltf7+BhGbHcsjw2XgjXXGWyGguPv/826bNRjjwGNoElQukGVo0vKSvZBaGF9ZbOIbHW3ns5jojjisuvPgWKlhuDAeHhkItvivZwfJw+W9+y3gQQZ4RhQFp1qM+XsPid9/9jVBRJ6A/38q1xbdhIfEo1wsoGA6WbFqDghEZvn7wxrvmn0q1/GDj4WHzHHHeRdcUDFkAxE6oOGFlpcH3vvyN/dJOO0EJw/3pPfr8xkmJ9BlYio2U1YLTJU0rNz/+924ZpcZRUYYYTegc2zdtgSuu3SVRP/XRZ7AoGeeefx5c7NNPzEzOoKcaVA5fwzFPfRzPfvELiNH831e+DUDna98XqzSHnXA8HLp6wGxccslFWCwmDsi0JckzXKjIjesT7ySAJHBkZoigF2LzwUQYMBr0Pw0shQff+Zc1Qn+32ZeKMJCIqKGjP1BhCYNTSlr0EGeoxflgZL2EmbDCuT/4MZx36R+cdKOUbMCgLcrFVyM0Gg2arQWSpMuq6Sm6s3PcZXIGs32BxkKXb33wI/D93+1xu5T6RNhfpOrW8em3v5s1YhhLMmyzTegc9BJvD2F9NNVyN5lr15eSpcYzC+DbJiykXaWbqie8xeQuH1YSwaFjyQ6t2LmGS6R9Swn64HBEymByIXCOugqYv+Fm+NWet/cId3QUOopisVBSKl08RJVhlAa79mFJcTmeBmqFpTSvtKUorxmWFmsR5jZshMt3vUDoInBXuYjqvo2dv+OeCDVEbn2oXvrz31BTmkD79kht6mm0KzeihQqAIZXSEsnDgKnaSd2slq4HeqhNtHhbqXBIpW8KVc2gnZZuRIclHBqwNvPSX60IFWhnMVaIFFS1xnRTfv+zX8J5uzee3Ff003MoCiaqYKqc9DUEfalZwbT1+1Tof7e3h5f+g+skmMxRdZqtF126yzpOP+JUFU1OsLjY4sof/QzOvUJ6821unp2lunYV3Pse6t6PfxySCenWeTjnavnPf/t3NrUXOPSUe0K1ZPAuvFTmt82S9RKstd5LxBhc7vq7WKsHthVW09d7ZcZHS3SlXqx4lVL/mBflsC2GK8uCCem7a+7iCN1SrtztMFjLJxZDiZJrKydmbB31XIjbCRvP/sPaVfZtJAobkoHbl+7b0jiEqFal1WnS7baZGmsg7TZTQcxYkrFWDB9//Rvh6hv3aDKVjIa+jZbL6z78SUmv30StlXBobQK6PbQ4GtUK5Blh4TpXSjZsP0bBQNVWMhqlZGO47koUSpTX5xahx2Vo/AoDAzVXfDfMQLODLUhpTO2Za11Y20PkDJEF3Um58YLd60ZHuPOgv1suPqky0heqT+uEgvbh7YTKUN1BUepi3FHYZsCAji45yuuGPhuncL2UxavW77J+Sqlip1zYQQh9ZkMY2FLsEy67RrZeeyNZt0NYibHiCOKIVtLFhcavG1oPmIzChq3cJPnNarFFVIP5V64RdmitoDSsHLLdC5w3Og0KF+RyrSg3sOWcV9BneIahtcYY7zHoBQ2CEosRIbIO3ekxrgMu+PHP9rGhdkZfvcMOkvxCWhO4wdqoltCsoYi2DGxW9rYEjYgg1mKUYiyqcOXvLthtfZ/87D8mTVO++NkvkK2/gTP/8q9473v+Ge7nvVOo1fnLN7yBZz77efzyk/9Jq9Pl8PvcgxMffwYcvc6vHDf+8myCxBauQwaTKyLR6MwtmRTa+SOwAUq8EWSuNanRZEOMhFOaTBsSY+gGhp4xJCYk0SGJCfpHpgO0BH0jx8DpvlqkFHWXRz83QSnyHlLplCiZkFIMacRRNwFhkrEyrHLZb3+3r+PjDo1SdTLw+1fMtRYIqhFj0xOkNiU0wuabbmRFrc6EKFYpw1g34bOvfd0eP6f02DjgDMdFV8rPvnYW4fYFDqk02Hrt9UyPjyFY2t0W0g/kMzBAHY7bosWLXAPnCiNeT7B8kjrPCEOALgx7GZqMfWZ6yDDZqR0MlQmGDoPDeOGvmMF5UShCjDKoVKipgEt+fd4BbrgRbiv4ceGX85LpLBmH4fFTjq2SlppCylB6hJSH22H8DRvFl9/3GV7RhARceuGumVeL3emcF9yr/sI+7CGzO9ySdGP7hZcQpAJBSM/6MOjEMRkKFwRkeunakGsfYyLTAZkJvBHn0Aa0XE8So+kFmm5/vfDn0+L3STF/jSslG8VhNZHVRAUTUkog+++yA8OhTBHYTwScQ7CeAXEOnVumgojV1QYX/OrXcMU1+5fiiSq8bQYMGFA4Avh8OYO1r2Q2S3plUGJAgsG42NsSTQpIGEIQIrnl+osvh6u37PI9T/qzZ6knPOmPwCk++IEP8bPPfRGVCVx5nb8+dxCEfO7z/83Pzz2HTjXkwc/6I4L730sBBFy1Sc7+7blYY1DVOkEc0+l0CMWAdlgVkGufwdKpMuOhQyuwyngDPMAoEPFcltXeCjkfyiTorXJLfZ1nCox4a9qg4MCHFy8vYlzqQmvwLmKKpfo3f89SxTJwO/XibYFuD3E5N1959b4MjTskvIh2sGsxglcFiMYpx5q167jmxuuYmJigWqvQnm9y+OGHsrBljjiu0lucY2q8xk033szXXvIX8tR//7db3usMBc8pRXr2ln+xbLSuux6ZW2B1VEOaHaYbDRab80zMTNNL54njCjZbOi/KcWIKQ2a/w9GF5MN76mTaS+NE+d1hKRvrG9zqgWizb0VPaXirC/G2d1nLCy9e44at9kuPFodRmjwEE4a0caiwylXXXMtjDkyTjXAbQxSF1AEGng6QaUUS0M+umhVjMVeDHWlpYzRsuNind+X9d3jWsL1aZgLEaK657loesIu65c55usywt5XuL7ii9l0Vet7Z5xEEFSr1Cltu3shENfZeFnFML00JdYjTCpzuq5OsMtjC00LhK1HSEM90eGPPXBcKKeXQrkgL4PznMvKqksFvfRyO0g7C+5qVa4iWXbezKJ+LNbMWZy1GGbQGjcaIYPKc7rbtdKOS0u5vqELSEGBU3l9jtai+tCdTxjNXBV0yThEXVvo+qdsyLfaVI3OWqBHTRTPfa9PZuBnSbLc/OfUNf6GqhPLNb36Tn/36bH76u9/QdQlja1fK7M2bmc4jAmOoHLKal73mlUycdnK/0QIcnHPllaxoVGmllusXm0yO12lnOaGp0cl9xLxc634XGmcIlK+sBAEaH8TEiSEyIWjFXNql0pig53JEBJWKDwAWBD5tvMvJkoRGLSBWil6vQzWO6bVbVIKA1eNTzG/ZRtWY/qAqib4UjA2U6hzH0GYe8C6qIo48SalV6yQCs60OnHexcNI9bitzgwOOcjL1F0QAGTBj25sLjE1NYZXQzhKCakyz3SKqhog4wtBgcUxY4aazz+fKD31Mjv2rF++2fTSKOAjRaeY74QC25Df/+/NUMtvPzyNYwmqFxV4HVY3oOUtY6KW9EagXO4LXT4fOW5VrhFpjjE3z89hKiG7U2NxcZHrFKvJmD2WhMT7O1rlZ4noNqyF1lqjiCaZ/76K9RXk7D1FYLSRBwWw7xXDMmdLozSjotnMqsaarDGklYkuWseF/fiqHPP4hd4xx+IvzfFbE6Wk4/sjbpk5XbxSOXnfHeP9lwikfx6VWqeBaKdYKQRigKyHzaQcX1+ioIq1DEQsiLDgFEX9e7xB7Z1cu8n2j+f5zfdkLFC0nbF6/azVKVAnJC2+W/oLLkOut2tG+bmdorQmC3ecPuviSyyCzzJJRn5rB2QzlLNZZBENOEeJMNCJ+cRfAio+cGocxWbdHJajS63YxYYANNQs2I6jX6aY+2nBQGG721aXKbxHaLqcaRlibISJoJcQmIG+2Ga/XkCQBBa6/AfBz1IeGB1cwK0opTBggzpFKhhENShMqQwVI0pzOtddQu9uRu2+sZcEzRZ5RDbA4tHJ9iVZmArJKTNaocXNzjiCOfKoOJ0Q6wNrlC1ucdqQVg4oVC1lOGlVwYcBNF17IoXc/ZLe/u88bXqzu8/DT5eyzz+a8s3/D5u1buGHzZmqNGocfdXdOOfUBHHv/E+HoI5YM7gADT/zz51MTS9zqEm2f46iZVTDfxCU9dLVa6MF9bIu+Xsw5UEX4amuphnVQEfQSmBynbRMWlaOrvKgqKgN25Y520mV7e5FWa5Ewy9m8cQPbt271wujqOK1Ol2ZrOxONCJV5f/LSV7w0jnF6mKiXftx+pSn1YJ4xcbg8w2hDpBS9uTkqy+6eOzaWGuW6QpRLYSTpdxBalZNrYFSZdRNCG7GyEvK/H/sUh689XCp//JhdLgSBhqTbY2U1Jk2zA+aP4n53gWy//kYOy72hlBI/3vr2Q/g4eN69d/D+JWNa7oKMiXBGsWl+nsrqlczlKQsI2aopLl+cZ6wxyeTYJFOHHsIRtXux+tB1BHGA0wZMaaMyEMPuGPArKyUbZTAwUQPJiBJvcIZQrzaYbTZRYxPM42gcefgBarld4ILLpXnVNay/4kquXX8NmzZtYnGxie32qDjBdnoEUUR9vIYoJaKg0qhTG59g3RFHcO9T78/YUx61bMZg7vyL5dv//QWquYNWB5PlTFYbdLtd0bEpDMyXA0232yU3hsYhqzn2lJM59omPu00ZGBGh100xmWVibJL5ToduqmBygoc/46m0Qi/hDUQVY9KPHD+GQfV3TZoy7PbwzrwsBf89hcRSi/aB/Goxs27XET7zPB9I7Cildc6r/PawlZxzOLf7/nnYU55Mo5cxUYnobNnEYbUxkrntGGMI6zVslgE+GCGFVNyLYguD7tz5iJ9WQ6VG3mqSVkMWQ0VaicgDg9ZepaCzjG67x2JrgdnWIkm3TdUqrl9/NWlXqMQhebPFTDVGJGdLs8lUXPEG5UtsIjyGpR2lBNMWza6KzbRNEqJahMoss5s3UduzZttjKOeT4jnl6bVSRZI6DZkytBSsPf5YDr3ffVjUgqn64JBh5lD5cBLAXY+bWypF5UggqCigZxVhVKXVSTn0bkffesVPOU6dcspxnMLz9vhdA45eo047+tmDM+tvFK5aD/MtdBhCbjEaTJkmUABXuutAJVb+cwKk1uttVs1QiQ31Rzxo7yb+uefJtRdcwAU/+wU3X3wpSgy1Ii+sEghkQOxDNyTyZucNdsn9BoGml/uolWEQsGXTZm5DMn/A4SUahYmaor/9cUsWyYF4v1ysy99WxxsszG6jHlew7YR1lTpn/dt/8MfHHivc56479Z/WEISadrtLDLvQCu8fXHvRpZheSjCkeitFyH1jMl1owp1/RyOlNTd9Q81WL6E2PYkLDBuSLp1KwEIAj33m01h19NFMP3nXTNWBwMrb6kEAl10j2393Hl/5z09jOj1cN0ElOaE2TJmANTrCqJgkSQjiMVCCbabYLKeXdjHhPMF4i+uuuIbffe2b9N74FjnshOO436PO4G4POg3uvufZa6fEcPmPf8lhlQaysEAld1Ct0ZxfoFJZfuj6XAONOpt7bTqXhizOz3PsEx+37PvtLbRAJYqwmUMrH567l1takaITBax47CNZcZ99zB66DxDnbdesFigi6AIIA5X1nlTulmw27v3SZw1uceElwsatVJLDwfo8LEYD6ILbgT6zUajio6jiN6g9C+NjBMYQVAJqjzht79rtkstl6+WX8n/f+BYb11+PkZRj73II2dZZPG1wBXPh+irnMojksBdMoVX1ilXR6CJYuLKO1sLiXlXp1tCXNhU8QD9CsQYn3i7Fjo9xxKn3Zea1L1ar9+vTb3vsJB/rbb6Jf337P1Kd6zIex0UEs0ECsLBv4evFcz3jl5uoJ0yOT9EWuGTLRtTha3nXI767d7U5+SR15MknceQp95XL/ud7/O9/fZZDTZXI+h26KXVwUHAYPuSrz1boA7eqgvMo40AoY8jSBCeeI5yb3f4HxGwMhZKn4FfLRRmAgY1N+RlKuxYN2nHDhptYt24d1gpxWGHbQpvEbeVTr3wVf/YfHxXutlTU3e12qVQq5O0O8b6k+70VXPKbsxkzIcZloAYGoMMW+VJKbbTXh5fGxbqQMuRaQ63C5qRHPlFnc6fJKY94JKc+/9lwr2Pv1CL83eLK6+X6H/yIH37pa7Q3b2ZltU6YW8JcfD6FTFCdHiQdcmcJqhFB7LOL2iwliiImVEDeywnsIisadaYqDRIT0L7qes76/b9iPv5fPOSxj5GTn/5kuOcxt96O7YSVhEz0MsIUVtXq9BbmmYpCVL5cqYaPHtxrdREFNzdbbL7iymXfa7nQWiPaEQUhnY5PZy5hSAsHtyOjARAWBoBQ0MOhhRYZ2L7dErTWe5xmoW1TPvi2t9LoZlSVj0KTxwbQfXf8UpFTGm1mAi4XxuIq2xea5PUKrXqFtzzie3v3siccp1aecBxn3vseMve7C/jyB/6VazfdzNqgQlDE+ujbhTDkcCClNwdDMT8K6S9QDUN6zoILMMu1jbgFlLaJMrRjLm1qcg1bu00WtTCz359822MnZqNiQlQnYSaqELaTPrNRdlRo6UdeBMHYHqumZug2F2lvup7GqtWcfMhR3Bjtwzy7573U8Vbkdz/+OfnN24rASoK3wPaXlGusK84psQMDSefrJgCBRow3AnLOYe2B2ovfviiJhi0mTt+X3C21Nx8ETfOL9SGHHMKGDRuYmVlJr9NmKq7Tzi0y3+Kbb/x7nvyetwlHDRgO63I6qWXN+DhZa/9y+sO4+oKLWdVNKXNFlDYoprDLyPqp4QcSnNKAE8rMiopOFNIKhDkyXvHed6DvcRwcddgfJqPx+yvlM6//O5rX3MAhYxOsVDGq3SEcUisFuRCKohIGEERsTbuYUHldu1jqRhMYRa58Ir/eli0+2VUcMVGrsao6SauTc+mXzuLsb/4Pj33pC+SIl/7JLbdnL2MMA/OLRGkPLRk056hNTtJNssIrYu+hlSZMc2bGalijmZ1bQH59tqhTT7mN+teRZbkPgKjrdLotqpOTzBshua18w28BoSjycrNReu0Jg+Bj4o35b028sSexNgCi1FFtZdwlqBPllmZzgbwWYpW3nyrV3IMYI0JYrZImOXWnqFLBRePckN564rfd4uhj1VRmZeUhh6AlhoUWMKwI9RsyUYNMsQO5b1EW0gVTCGFKN9O9TTlxa/BNXwYns4PNcvGtKAgrMVnwh0GudmI2kmabmgmp9hxR5rzBjhReIAJRYbPhlVo5YzrEbtnGmmCMaMUkNy222NxusTi1j5YR97m3MkEkJdeJeAYCBp4Cdojj1kUseiMgxnOsVoFF0EFErnwkx5nJ6X2r1x0M3vV3YJhYouTaveX7wIiy9HUvF+otW7Zx/PHHc8011zHeGKMRVpndsJEVhx/GxivXc8mnP8cJb31N/75jk2MkG7Zho/2tvRzCxVcJ7YRYBunfhdLbpnAtLHz3ywxLS6ejz5eTBJq0GjHnEp7y8hejjz/mD5fR+NV58sG/eR2HEbGy0kC2zhPi0BpUMRgEh3WCzoUMjcoDKoHXGUdRQJrmpEmbXAlYL+aeavh+znJIFtuIajOmDQ0TURfh15/9Mt3FBTn+CY+Cu+9GWhRV0KklVprJagWddRlrxNi8izEhsoc7551u64QVlRqJaDKl6FnhivMv4LhTbylZ9v5DmSJeCsbMGE0QGrq9Fo7wNqnDLSLPBuoBSnWrl4YGzp8tvfd2B2+zsWf90202WRHWYLZF7ISJap3F3IfaDmyZ9NChRRE5H9+ms61JPa4gnQ6TccRNm2fRE9V9eGng+OPVxNikbGle7zOYFzSw9BKz+OWr7/jrFAxJLUQNVE5ZLyGoxBgKc4H9jjKgoJf49O1JnPNG506wt+AdcmfCTsxGqCAGVLdHXTQuzfv2DwohKiUbhXGhVt7jI8x7SC5ETlizepru2PIzewJw7qUyt207M650NQRQRZjWgXuiqGFXTB/itRwToiC3FhNGKOvTDa9bs3bf6nWHhKPMOlm6/PpgVQwSHwlI4VGELu02HBP1MW68/iYsFoewsDjH6qlJ0nabuoaffPXrrLzrobLq+Wcq1l8mQWRQUUCr06YRhLg93PXsDbZftZ6pap1aN0VL3j/vDT+9WNfbbXiLamQg3aB0PTTQCzTbbMLRDziZtQ9/yB8uo3HxVfLhN76Flc4gW7eTt7tMVyoopB8J2GkNoUFHPkFX5uXX3sWulxMEAWGgyWyGMoogDkGEdtImz3MCFVKJqoQokjTHCUyGVW6+9iZ+/Zkv0+12Oektr911/ZKEXq/DTGCwLgOVo42ll6WYIrvlcqAd5O2UHKhM1mhUK1x24YUct/yW3Ev4yRVVI2wvJ44ikrTn2/U2i6+7eyg7iKCpC66jv1MvDAXyPZBs7Ck6SY96FDERZoTtDtncAmGjinI+A7VXrAhGcqLcbyPDMAAH3U6XKAqZqtfJGvtuwt/ZtkBFAiKb9e37vMRiQCd8tGXVl56WPK831PRMmHaCOEeAZqoxvs/1WgrP/JURVFVhS2MK6VNsNRUn1NXuvYHuTNjpLXQQEJqAahAhvR6BKVLg6sJIs5RsUHh9OMt4dQxSR5YlVKsVOmnC1i0L+1azbdv6Kpt+JDWRvnV1CVWEpNX9cOUeRsA5hc1zwmoVcYITRTiz99qvHcVnt6TnXBoJbuCWumNckP0JKfSx5dt7glJmglWFbzYDk2ugr3pQCqM09Xrd30sEl2ZMjU/Qbi6yrj7Op9/zAV5ztyOEBzxAdWbnZcwYtPaRZjkAzMb1115DmFuSZptqIUL0oek9Q1UGLhPjinDjg353Q25jqYZuLeRRL3r+XjMav/vMVySbW6QaBn3m2venHrJi98RT4wovA1UELyqsy5UQGoNNE8bCCotz86xcsYa5bod5hAe+4gX7PiKuvE4+8fo3Ec0tUs1g0kTU6gZtM5QGrUNSyUjS3IeH9qIORCu0QC2u0Ol0yEQg9MGNRBlEhLTTpWJCdBFd0eYpSgcEgSZXFpd0OHJ8muvnF7n4Bz9mbO1qOebFz9vlO41VK8R5SrfZZLwRe9ufWo0s94G4tRdd9ceoKibLIB5CURZMJnj1bqVeQbKUUGnydpdrLrhkn5t0b5B0UyYbdfK0i44jOr2U2niNVuX2l2woyg2fH5tKBOUG1uF7wuQppfbYZmPNmlXMbZ9lKjfEcUhooCsWHJihAHxlNGglgPX5Uxr1Cgu9DiYep9tu7vW7LsGF18jWGzawNjCYNCti73idiBY9MDQvVc3lGCtTuavSWwOkVqHjLC4yTK1Zs2/1WgJZWo/CG2nwtQ8WJyIEeh837ncQ7Mwy5UIvyUjFEkcGK5ZS/ARgtffZKkPq6iAgR5MYixhNKhlOFJONfROF/fzHPyAyELmcyEkRK953TKZKf2td5BnwBL9MEOe0oJ2X0mSZRSpCJ0sIpsbglBOWTeDLRUbtcA6WeksMwoYvDY99YIJflUaxriAtQlAEfRHl1QitXo8V9THmZ7ejQ8PY9DitXgtrM1AGEyjEKkQssQ4woskX20zrkE4r5VCl+Oab38WTX/JiibspY41Jku1txqp1LPugX90Nbrr5BqTXZTIKUS7rR4kV47w2DQ3k/fe2NiPUAU4s1WqVbichqlWxRmgccSjc/6S9avltvzlHfvmRTzDRTTGS+QyMBbMRFmnFRemh7IkDRsirqAYJuUQrnLMESoPTOKtJKhHbKob7nHh3qT/oAfs0Km784Y9Ir7mWQ1SFWmpRSYpEEV3nEGsZC2Kam2aZmpiiNjHGTVs2QRwR1xtYyXEWKnGNxV4H6xy1Rh2b5aTthLGgTt2EdHptTBDgtKYrOYtpl9rUBCpXSK/HqqjKhvlFfvClL3DMw08XjlrqX48RtOToNCGOIyR1BKZOnpqCAjm63R5RHBCaEJzD5pZIG7DebdvzyroIf+2ZOtHQiQIWkjZa1RkPYra1e/CLs4UHLc9uY9g+wbm+EneXMKIZD6t05tpMxg2sCXCF8XWeHQiR+14iCHEEaHE4F/Q3Y2XcDW+3dcvNtKf2GgBJkqBjgxVoJglR4GPSBENNUdLCVBdeIBqcy3E6AK2wWUoY7dtO/ppvnUWkBNvrUaop+jnLKEKmK5aoToB+eAUpvk8CTQvHzS5FVw3mbsfsZU1KRc3u27iMLlt6EjpKjxhFpgM6zqHjP1RmY6BZ84RUyl3FIChK6X4IxeARjWB99lFg186oe4GLLpMLfvFr6u0WoVM+3HTJhauy0AWX7HWBhZalqJvqD+parcFikhCNjXHkifdadpV2lXm2PD+cqbasx3DkUwU7SWT2B5YYNwmFEa3/wogjVyChodPOWOx1mJyZJrMZi4vzZJJRb9Sw2VKDWVGlwa2ffBUrRL0ebJxl/Vn/w7gOsL0e9ahywIxt07RHgBAqhZUhRpdS1Om8YY4SjDHgLFp7z5Rekviw7HlOV8ExJ957r58f25ypJGemk2AkR6kMP6qE0BrPbBSRckt1onGBV9tpv3sLHGhynFHkYtHKIKIgN3RQdI0j3tf2u3qj/PArXydotVkxNUbW7GKzjB6WVOWEgVd3HXHEkbQX2jTnm0ytXEPHZWzr9gjDEGUzrDiiyXHCOGCx20NpTb0+RpJaWlvmOWTNatrdFgvzTcZXTxOO1VhIu6gc6hKiegnViqa92OSK7/+Au73sRUvrqXzKbFUkD0MUWkKcUag8J3c5tUaDXpp6UTdQHa+To7FZDv3InIXkSEOOQomjlSbIWExcj8iCAO2Ey35/Mcc/6Lax2wCNMSGdNMMFYKoVUufodruw/gbhqMNvN32KX8BU4cKp+y6nMFCjOvbfQlbO0zIjuFGe2TBSLqrFdUXMEG8q4dmzMobIcM6PZeHCq+U3//djpNtjvD6GLLaXrEaqiPekC0WXLYhoSTpNueDj9fTxZJ2xaJx0ehLy/bux6jMYO44Q8bl1HBAGGmXzXfz6zod9YiHLdN0KV4Qqp8iLovphevcal10jP/rYp4gXu6yOGkS9NuBdb0u3zmHxV2nwM/CJHcowK5rUQWZCtmUJjzjt1H153TskyiBB6KEsikBuvGfK9sUFVq9eTXfrAp1mC/n/7b13vGRZVfb/3eGEijf07TQ558QMYcgMvCNIEIlKUnJ4JRgQBAWz4qsi6ism/KlgFlBBRSSJEgbJ4R1mBiYxoeONVXXqpL337499TlXdDjN97+3umcb7fD6nq6tu1Yk7rL3Ws56FpdtpkZqMIstRovKH1BO674lVJ7Aoreg0G/SzlC9/5nPEQQhZiUZ40u4xGEr7/T6REN6COgJYa5GBBqUojEWHATIMUNrx4Ksfsubjj2rMTHilYML1W2E0QFERk6s+gBgXfxLWfy6Uf3X1/g/Y13qw+P+uZ2XPPk7rdhHGYsuSVqOJ02BchgoCTGnYtbxElhXIVpNCWObLFNmJMRLiqEMvGSAiiaWglw+ZabUgbpPNL9CdnWLJlAgd0mhNMVgZYgOBCiShDHDGULqShmyi8pL//NChjI1REhl+mUAlaAWhiPxnIoRQs7e3Qnv7FhaKkoV+n3Z3yi98nMNVlUoNzi9wBDQ6XYyzpHlBkufknSZfuuXbXLixW3tEcEBhDUEzxuVe+tlIi3GOTrvNfWlonCiYrJErXV2ddv37u+5P303/7j2cNT3Lyr69tJT2RRlHfIzxsaAqZDnKCJmsK+WRpjmDEh7+iEfAhccqlXkym662CR2htbRESNs4uOkWx3kH6x6dSNgw80Q6X+RqctKpiwitB7f+68e447ovM2ck+cI8zdCL/tgDDI3q6KO/jcqeV6t95bwCW2oszHbpO0Pr0ovWdU73V0jqTiOredl7oowEYyWlAKFD9iwvsLXRwiZD2s026bBPXqR0um3yrFgVAjLS+mB49UjLLKc71cakA5IiRVpBrBSmyIijmPQw6oUbwcrSElut854Tsdp7VKN+L/HEX+dEVefAElT6MEZAeM0j19xB605fpw3XO5g0NlwVykN4g6LWd5H493XanK0Nj8rocHY8qG505PjcJz/JbLtNnKQs71/wSrtKkBQ5JSWV09HL1Rcl+9MhSzbDzU4xd+pJnHvBhUxt2YKMInJr0FqT9Pp85XOf48Ybbuak2RmkarDnrt1ExtKNAmRpiYKAoizJ8yFaN1DKex87oeY7t98Bn/uK4yFXjC5vVDFarDawpBPY0mARLCz2aZy0DdmIedobfhJmuv5m6sBzTAQj41NYh/d2lKRFQhiGKBWD1pRRg31ZssE7e+TwnlSDVholBKawNLRAGwGf+IzjmjWKUx3NczsGfKqjCVctEJ0Y961xBt3aUX7w4+6LH/0Yc0JjBwmR9NNbLd8ANd+rqpgrHIW2I11NWf2nNkSsgLQsGACXXvvYDV3r4eG99rYOhbtx9kxgJfn8Ard++StsdyX9QLhBaRAqIrLe8zHUllJWWh0cPKbUsviHaoTKSiIZ0TMlduc0Vz/rGce0rW7Q2LAjd1idXOVbkETYtbvnFt/zD+6Gj/wHatc8MZKZqI0tcy+pXe+68lx4dvM4K8WISsyp3pkTWCWxjYj9puDKJ1wLV373CTnVq3ArJMKCqW57KSGXEE61CZAUiUVozWCY0ggitJBkKwk6DEZpzbWyqFP+WQoH6XAIgSSwltmo5VPB8BoH4mgnnldYWVlhu5Rgi0rK9x6uX0pUXbURSWkNyglWkiFZe33Ne3LQGxkYYiJs5cYepJFBYsef1U62+ru22l+dva3sWIBsI7jpi19jejjEJENiHLOdKUpjKLMUHWsKZymB7yzOkwhBdNIO9FSDF77+dfC4xxz6rl5/ozv/ja8VfOI695fv+L9cf+OtbOs0aTnNMBnQjdooAVma0ohirLPoSJKlQ1pRmxkZsvvGb7PjIVeMdmkOeIarDI5Ao5WkzAXzpWFvKOEBl8J5qwm9hzpZARzIDNPA8cw3C4KAdDhAiJhYaGRpmbGKvbfv5mO//nt8+yfe4oz2JEu/anfj65cOhKnCbr6tOlRViKyyYIuCpg7RhdcIGgqBbbXYU6Q8+WUv4qqX34vGyf0ck44EVfWVA70LR4TPfc390S+/jW4pmFUh+cI8c90pkmI4mh+AMWW26qi2KuqGq0K0FYHUiKoQXBxw1UMfBJdfdAzuc61XVZESnBuF3aUzBM4yHWi+85Wv8PVvfJWeMzgZEgcxugRhLM5Z6rpQBxrzNQ73uS+kGrJPWs58/MO4+lnPOPqXOIENGRtOQCEtQoGpXMjeFaVRazQ2sn/9mPurd/wu7b0rnCQjztq6lb1334kMRJXiOE7rPOg8GLuf6rRPn40gGSjJsrQ86geP7Y28T1CVqJZiPEHWxZZ8+qfke1/3Gv7wl36ZOd2g24gIjWFh/zzbpruoIMQ6t6oxjvLQKxJZq9UiS4cEQYQ2Fq0UrihRSpBlmS+WcpSRDVMiHeA18O/p+gXWgrP+VQhQSiGUpCwLpqZn1nX82mM02uplA4zS5OAAojB+oKzDI/KA/8vqd642YBjvc124/k6XLS4TWUcgFc1AoSUkyZBGHGMaAUWWMTO3hX2DAdFUhwXpeOWv/RJcdg8k6YvO93+75mrxvGuu5oPPf7Xb++Xr6ShFo4zIi5Iy6ROEmjgMGBQZQoDLMtRQMd3qcucNNzHJ2zfSjQyO2ngT1Q3MBgmi0WBubhu3lwmy0YR16m7cFxAOnLEEAWgpILdoDYUR7PvKN9nabmOlGIfl6jo/gBAOJ0sEDm0U0vkJrpCQKUBYgtLQoESnJUhFojWlNiz1Ey4/9whqWHy348ZvO4Ylv//6N9IpDKLXI2xP02536PeWUZFe7RWdUFweT8B2pDoMnl+SKUGiJYuu5Hk/cOzmDi+fXnnsoFq1+L9JB1PNJsvDIYFzdKVECkMgCq9bUlY6OofIKpr0zhyIerwvpKbnCjrdBhefedaxucDJc9rIj42ANIA0cJRVoE1ZSVAKwjWkXnznz//S/e6b38pUUXLG9AxhkXPnt79FpGqxKjuS4K5jvSNBFiwCi7a2KifOqNOmWrKiHFc+/rFwxQUnzgh2hPBhJUFZuZlHkxtjBU0UvOID7+PW/iIrgaAnHY2ZaYZ5QSCDKtd8rDBZ06N8nNOiQ4XWVW0Ba3z1VWcosBTr1Ee4NxRFQRAcWepgmeUTqXkSoTRIhVQBO085fOXCe8JYt2Vicpw0Ztewj8Nx0X3RtnWdHgDFbXfSViEh/tkUecrKyhJpliClJBumWGvZu3+e1DoW0iEvf+NP3LOhcQg85dWvIGtq7l6aZ1DmyEAiA02r1WJxeQknHcYWNLVGZwVhVtDfu2/VPmqNg5GKZQVlYSpsEJYGnRfY3gBZlL4e+wkAAZgsp6FDtFSI0mfGhcayrdnktO4UHWNHW8MYYlsQW0PDWRoYYmuJraFp7Oj/oTOEGEJnaUqBLlLCoqDloBNqhHA0Zjvo2en7+hZsGH5FL0ZGgGPsYb1X3Pgdl33jW7zr1T8KexeIkpRTZrbg8pSFvXuYardGKp21t/HAxi+rVNxaXgGglIJhIFmJJGc89Eq45qHHbu5w4xGiTraYnJZ7i0uowjAXxOwIm2x1ATOFY4uBGSFpWEvIeIuc3wL8FlpDaA2BG2+6fm9LWkIyHcZcctGxpxhsyNiwAkrpKORYU75mEyt7ZLv+19f+uPvAO/+InTIk6ieQDOg2mzSbsa87IOwq66xedfrBvNI/qORvddVwrJBkGvqBJO1GXPOrb/muMzTA99FcefKsxXdY7331DThXEk7ZCb0FXv+ud7JbFOzKBgxDhYwaDIYZPuQlV1VLndz/Sm+JQCqKPPWhl9RnMWSmRDfjI64euRYYY5BrIBhrHaLwoRRjDHmek5cFzVZn3edQDwGHcj/W7W8Sk9lGB71OfK9Wv90o9n7nOzSVokyHSAdBoIjjmGaziRCObJjTbXVpNpuoKCJXAnnGmWs/0NWXip3nncXMSdtJyhy0oDAFeZkRNkKsMFhrmWq1CJG4YYo6QPHQVYZGvViYhJQOrKHfW6TdCGkoBRedOMRK5xxSK4Z5RlIM0aGidIY8STDDIaE1RKYkcCVaeGNdYlCYSkPIEppqsWR9hePAGrQzaFeibEFgLC2p0NYLKC4nfbadvhMuv/Ae79P9nbMBwIRKsKXimx3J07/+Dvf19/0z7/mVX8fduZdT4xbTUtNb2E8gBbOz06Rp6ucG62snKTv2XtShEkFVvt76MDxOUkhJL9AsR4onv+Ilx+a6J+A1hMbmkKNKoUcSx7GXIygscjBEDobEpaVROtxgUElCHH4LnPOZfc6hqq3+vwa0kCgcPPSqY97nNuwDd1JQmLIShxJoqXClodGM7vmHn/uSe++zf9jt+q8vsHVQ0E4yulIjjCEtUqyWDClGDW8UQ68m01r0R2IJFEhTokp/HpkzZM2IpcDx9Fe8eKOXeL/FyNhQY5KVqgwOqAqR2RwedKXgex4tHvWcp5FMtegFgqESFEIiVIBwzhP18gKTFWgESimMMQRRROksYRiSlwVBGJI7g4i8wXEshMrOPPNMhsPhERkc9Xc8SbRKhQUaUcyXv/ildR3fVeJx1jmEkgRBMDKAsixDSklZlhhjRsbDiGRLPblWISnnMJWAj/+emBB4W/9kkA362Dwj1JUHSAoKa/xrUdCKG2TDlCItMMZw5YMfAsH6oqbnXHIhy8OBF65RkJohIoTc5aN7niSJz4QxBnlQGMSOr3TCSjPSkeuSIizRLUVhMxQFfOmG+2yWnBSwurf25/Cp5anwBcdMI6BHSamdF0irhLMsFoPFUlJqi1UOI/ynqlogjbdqpV15aZXxqaPCWLQOkWGEjmLOvfTSNV3L/RHCQVkUmKKk3W6DliR55lVN7wk37nIffNvbue7v3s9MUnJKEKOTBJGltBoRuSsosDjpq+7UXovQjPkghfSGTT4siIViKmyQ9obIMKSHZTESXPuS58GVVxzDm1h5MZwGtM+6QmKEwghFKYVP93YCZwzKSkKlkcYvqoIgGHlQlV3NBavbkxaSAIk0DleUSOuFBgOlcAJSW3LZQx907C5xAkchGwW0E158RzqEEDgsuTm8nnvvXz/i/vTnfoW5AuaGJXHlfqwr4FlhR2GZyXLoNTF0si3mpqQTNRGBwBZglCQPFIvCcPFjHs4pD3rARi/xfotaAMYJsNaNRGms9F6OUgLR+BFf+lM/IRbnl9z1//4fxHFI28Ewy4h0QKwVkbBkzlCUfrXqNSyqidONsyvqFQiAMEfBYj0A07MzlG5XFU45kr2P18uTfAm5Th+CrxjhuSzDLCPQFiOhGYZIq5CBJhACFWiKIjvI4JCMY6XuAAOkRv3ZekeyQApCoSZqx1ReQGqWv49DR0HIoNIr4YIz13W46a1bEEogtWCYJczOzdDP+0SNECE0/ZUeoVD00gXCzhTyAHnlydWkv+5RQJSsyMgpoJQ0dQCDPov/8Uns577gBs6RFOWE98yPE4gSgV+xTjU6FFawKBzz0vHIwyiYHgvUJQIcnsA+mTLtQ5N2FHozXr5mVO10VYHEA3gEIw+jAy0CoEAEIaUUzCc9hu0pLrn66uN1mccUM1PT7Nu9h3379mGjiPbMDEvxYR7h9d925I4/f8PP0L/1TuasYMr5UEEdpvMblbRanSnmayrZynlQiHH/7Hanyft99g4WmN62nd1lzooWnPyAS7n0ZS89Dm2pZuX7c/MGx7jKtRNylEJfj21Qe2bkQaHJA+GcQ0of+pTGL6BcVc/DKM1AWk6+4Lxjd3kT2JCxIR2eFSs01hisNcjAUjhHZtND/ubL7/gD9/n3/xPb+yVTWUnT1KGPsRxYIVf1v1Hnm4yh1zVSEIKkyJBGUEqF7jbZnazQOvN8rnnpi+Dc+7bM87GGlW6CNGuRyLH+iPBks0n2w6N+/RfFLTf9oOvtXiJJEtrO0hUKZapwlJQYa7HWoMIAK30dDCHG+633PS4ZfXQRBAHDPKPZbpPlh09jrCf1+vplNZBbJyv3ooKbbnOcd8aa2oBQCrSvAaPDGGczbFGSFjlFVkCWUyKIRHxIpneVdFKx3asJlnGq32Qa93ollfyqeSwK5sWwxgaHP7xFVczVsly/MNAwTUmLnCkpSXo94naDYT4kEnjFxyCg3elgs4KBsVi1+nbXWWKTKda+xLmlGYUEBrLSQZGTLCzzH//fe+hlBUPjaE3WoxBezRhRM/AlaW+IjWP2hZp8tsMjX/5D677OtUK62ggfL4AkVXVd642h+nMzMcHJyoNhpFfSnFxQHTiB+BWsZlD6SrJ9rUjjgPhxa0/pvj9iZXGJZrNJGMbs7yfkvWVM3D7kd4sbb+WPfuVt6KUBl207mXT3Hpqlnz9KyShj0d9nuYpoWc8doxR/ASAYpBkIRTQ9xYItWNSOxpkn8YxXvfy4XL9DjMYP6WTFLpGjyrPgQ9z1EFPr+NSV2GvZBzFxrdVX/Ped80XkpNczMa5K9ZWSIpAMtWbqAZccl2vdkLEhAFWADCQlPovB4gdBdQiL61/e8FZ30yc+SWd5yClRGzMYEAV+uK0H36ISYHETxxjDywHVmhpGgFQBpYBUlOhOl9uTFTh5Bz/wlp+Ci879ruiQh4WwB/EHam+Hn+QkBnFQ/ckX/uov846Xv5ZmM0ApQehADgtEURAFIVp667rO0a4fwrHgZxwKp51xBjeI/yYvvXesNnAmO5RfwVcr5IrBXa8ia40MbR2LN93EzHlnrOn4ZUV+TW1JqEBIAaHG4FBRiBaaUCqkVuT5sVFRvTdYHHlRjAhlPs7rU5YnJ6uiKCBUlBuoWNkfJgRS0W7GqKIkTVO63S79YUqkQrQK6Q9TdLuFKQynnbM6S2Iyg2xcCwJAMhymI1dUp9Wk0+qS5AWdICRoRiTJ5KLFVhLxbtQWt8UtikYDpyzB9qNZu+LeMaoVhRfRq8nrdTusF0iTehL+KqiqF485PKL+zsR+QWKKjGZ7isW8T64i1HSX6ZPWR3y+P6LIcsJOG6UUWmvQEnWgsu7Nt7tPvfOPuf0LX6UzzIiNJd23B9vvocJ4xN+rx4VJOFZ7G+u/jzwHTqDjmDQM+c7KMvKkbbzoja+HB1x2fEa7AySoJVAIrwFSq3QfGA2zlWE1WTqjHh8nF18OH162osp8Et64qdtiriThti0bKuGxFmzIAy6dv2LpJFL7GFDpDFJaYuHg2zf7y/7SV927n/XD7q7//Cxbc5guLG55hVi60Q1yVV2TMftfIq0nL/q0pCo2L8a50UZKMmMxUQxzW/hWukJ+6nZe/Nu/Dlcenxt4X0K6MblpVBxvZPFWbsNDWQgXnS1e8Qs/g9k5x1IkSCKBbQSoKEQIgRbSc29MNXnV2v3UfBm5imx1tLHz1JMRQlBasyZOiHA+M0k5S1BJhl//la+t+fgi0D7TyhlW0oSh8dyhzJQgfSp2XhYsLi5Wx11NGp0kl47IzExkqLjVE/B6oOOAsvLkeG2AOt47ytoHwFpDEIX36m69J0x3prHGUKaZD90Yh5S6kolQOKdIjKFvDQmOaGo1MTew43tTE0VH5xeE2DAis5AMM7IiZ9BbJh8MyFaW0SYnLOutJCxLtCkITEFQGsp+j+HyAiYbcunFx6/eK/g+1ygkcSmJynFtDQ85klbPFWRKkmjJIPBbP/Ak9gOfinJ2xC8IjSVEYq0FrSAOSJ3h4nVI8N9f0e12KcuSJEloRAENrWE4YWDe+G33L2/9Je7+7Jfof+sW5oAtcUhoC+a2TI/S/CfHp9VEUN83Sum9HyN9HPxCSnXaLGnJt7M+w5Nmefabf/zYZp8cCsLrqIqqToSsQrg1xgkRUOtyWGlHFWwnx5Vaubj+fygV0jooDJSVhHwlhJibkh0XHb/06Q15NrzxLSgdOK2xlBhbEMqAuDCwaw/ccJP709/+fdLv7GFORbQEdJstkrt3sW3nTvYP+qvURoUb6xocOJnVViqMXWFGKJKyZO8gp3HeWbzs//wqXPLdJ951KAjnB3JZye3W96RUqhbARR2mPHHjsQ8V37P7Oe5Dv/v7LCz1AE0UhZAWuNIhtfciHYhxhUQAueFJ81CYnZtDBQHaWaxZrVA6DpmMWesWT6+CigAmvJdNObj1xht5+BqPb4X3bmRlQafdRIsSKRylNQgpEVYQxz5bSrixgTzKlKrPU6zW3mDCHbrRBtqdmUaHAaS+SJyXl6+NQlvVygElFUoJ0vJeNEvuAVNT09isZNDPiIBmI2ZpuY8OA1zhQ3lxq82udEAaN33K9QSkXR1rttJWmWQBxgkkCiF9gmKAotVoEigF1iGN/2HtDLGAc9J7cQToRkyBJYg0D3jgVeu+xvViJPTGBC/H+rap8O3QVS7xmrchqpU2Vo4EmczEirTmo4APqyRJAu2YXMG+ZIWLrrri+F7kMYRxBikFBkdZFJTGEYXADd9yLO7jt1/zU2yzGrt3gStOOpX+0gLOZAiluGvXXmam5rx3r2pyyk6Eq6hSacXqeQPqiRt2LS+xHApa55zO0171ElpP/p7jPHdMGAwwupZVisTUAoN1P1/N17unRZ/WGmtKSmNwwmf+OOdwzlEKx4VXXXmsL3CEDXk2nAAbBKQYCuGwyqcfxkIQDTO46Rb+5I1vJbx9DxfoNs35FaaNwAyHTG2Z4jvzu8mqbIraOj1wtV7Xp6gNDTcRrzJC0OrOkqLZefFFvOw3fu1/jKEBleVqLYEZD1Q+dcyN4sBFcmjuDMDZz32WuPLaxxDPzdIvs9HkbYxBIlCTjAI39jApK9FGHBXJ7UOh9bj/Jbrdrh9k7wWrVgCMO22tG7Lv7t2sfP5LazKJSmtQUUhrukvuDP10OMq8sQL6yYA8z4mCcFU8eJUnw602QGT9f1i1ElkvWt2OJ31NeP0OvC8WUIEmLXKWlpfXfaxdd+2m05ymHXXQKJpBg1BoYh3RbXotg5UkYWgM4VSbnaefuur3VYSAOitlZHA50ATIUhLKiFCElMOcQGhMVmCzAmFKpCmRZVllnFmEscgCMJasyLFa4kKNPuP4hhequnojz0UuJbmsxrPazT3qM3VGhCQqJXEhCU3l+pbjleqq1SoWIRxWeb5GzxVEs13iax/1XTPGZWXhJ09rMUVJU2mm4xZ87Ru8801vYYeM2CoCTg4bLN16B6rw1WTTYsDcyVsplKVUPmRcF1nz84Yn/hnpn1Ht2ZjMbgTobJ2ldepOXvLLb2X2KU867oaGqzwVPiRuK00QL2EuK1mHSY9tLfcw8nAI33bqyIARE/+XllIYSgy2mkjrz50GFYWcccnxK+Gx4WwUoRVlCqF1aOEosD6WnWUMds/TFA22NGLcvkVOaU2xMuhjXU4WKBrTXYbG3zTJuIDa+IlXpNEJqzSXkkJ54ZVMaRYHy1z9fU/iipe+AC5aH9v+SHCgO3/MG5i4F5U1ekAYbqwaeSzCDqOJxk68eq+EdNAI43v8+cN+4a0ifc1PuJsXPsNQBujSIY1FKAl2nAlQ10xReGKexFV6/sfgmgDaLUSnS1mmVScbM/lBjlQpxwXkKhl76ondEliLXVrhrhtupPugI7fgw7k5OuedxVYVYU1OkQ2YajcIDcheym3X30g68KXnD7z7sNqIGJE1J7waRwWNmFSKkWsYJjwo9XkIn6WUDYYk80vrPtTnPv0pZgJFs9PEZgOWen1UI2KYpRR5TtBuo51lZnqGPWWJ6rQO2oe0EuE0VtSKtX4wLV1JWViCUKGEJC0KwjgkMxBqjTNuJLxUr+ZEFat2QjIUDjnVIe624fzjy9GyeFlxI8ZlEzz51Y4KjNXeDBg/G1UtpEZcgol9+u+MrXgnJI1Oi4ViyBDJyWcfn8yB44WwypbTIkAKRVk6kiTFDnOSXkIncST9gh1B7KtUh4LMZZRlSVYWGAnCWpBjjaHRPa0ncvDeziq0XAiFFZJ+oDnp8ot4+mtfBZfds2bJRlGToldj9ehRUwScqCQexPg7pfSeS087WO1xrrNsJr3O9cXYohil8KMkpXAUAkQQQrsJV1163PrMxsIowrNdIx0Q5RlaKxIlGThYacS0rr2W4l8/xvJSwpzUGFsipKEscyBG4AcSUZUWnpSMrQdQrRR5mhK2QlaGCXK2y6J07LM5jZNneeLzXsjpL3j6cblhVvjMDnfAZzAeQCaNj1o4pm4aGyqdfKjzQVJKOeHKrXP2Lcopn8fu7EEE0QPx2Nf+CPP7FrnrS9dzdqOFNoYsS331UAFSK4zzOfEid4QyQMmgkug++tkoABc/+jF86j1/S9tatjaalP0VhLFEcczKYEBjZguDpI/WIeM+WaUVOhA4IlOy1YV85n3/wIUveM4RH7t17jniWX/+e4f+4zdvd59+9vPZGsfovCCoJ4wDXJq1Z8lIqLmZXiLYr7Q2qk+iHvNQseRw08KiTUYjjMgHA7a3uxR5yqDIvCaDEzSNpFgawn98zvGYh6z5yKfv2MLdN3wbPSzYPtMh6a2QFgVxI0QGJYUdEKBIspyy24ZHPHDVMRwCbQJUaUAJLIVftVFQOENjqokb5BjriFshictJtcOFiiAtkZXwglcGtiMvaKYlaRCwv59w9WOv2dgNXQecsFhtKLFIpdBSMhwkGAetqS0sLSwShuEovDkyjCWUtgoKWVBOAGa80KpSDhyS0jjKomRYlhgRceHlR87XOBFEvYoiI5AKUYYI4yiUpr1lDnnxJWw9/XTEjXcShoIiL+g0IvbnPWSgCYMWFIA0OOlwNsCikOiqCrjPvmoFAaUpWOr3UJ0ORbvNrqIkaTa59oeewyU/8sLjNtmOstSoCfz4GmJOYYTByXFRtdCMeO+USpE3QkprKJOUwEq0CFHCYVwB2KqWC1At2gPrDRacpBlF9IcJQmv6xnvHloqcUy47voVJNyyRYK0F54VnlHFg/YqzCAJoNrn44Q8nDUMyKSgoWRn0aE91CeOIJElWrca8R0CMhI+MkGR5jgo0WmuiRsxSkqC7HR72xMfzql/5xeNiaBw4MdyTh2Lyb47VmRRH27PhqlCSEWKUgVKvGFVNjT+SR3zuWeJZP/0mglN2cNvyEqbVwChFEIV+IrWmSplyiEAhAomQderlsTE2Tr30csp2C9lsMximKCGRwpHnKVEUUpjcs9cBKgKrqTgLVni3Y2ANUT+h3L2Pu/7274/O3b/wdNGLNYVWFbnIox48JjEp7iUP+N5ROZlWA6slYRwRRgFaS5aWFyiKgqgRg3Tkw5S5VpdpGbF0w83rOsyXP3sdkZIEWjIcDonjGF1xV8DL10vpCapbTz3lEHvwLm5ZZ86MPDGWSGtcXqAFUHoB/NSVZKEmDwKGSpGNNkmmNJnSDLUmVYKs1SJrxFx17bXru4cbRJHltOMGZpiRLffZ2p5hqtEhTYZMzUxjlKLUmjLQlDrEKI3VmiL0760MsFLhVIjVevT3UinfxsKYUiimpudAaC669LL75DqPFWrxQOccUdzECMHelRVotnnY464l6HZIypwSx97F+ZH+jxbBhGjZ2IMxDkB4Yujy8jLWlmzfuoXClCwO+5z34Kv4sT/8/eNqaBwaAt8ffN+x1B4yh3ReNylUmqzIWUgTBkKgOh1ku00hYJDlGCEphaZQmlzqUf+ot0JIktIgohgbRrgwYu9gyHyeceGDj4+YV40NGxvOORACK0W1irO+uqUQEGiuevbT2ZcPKJoBJgppdDqUZcnSwiKdVmeU6Tu2ScIAAEAYSURBVDCamKn5GP7GB80Yg6HX72OModNpEUrB1S95KVx5+XdN7PI+x6Xnihf+/E8jd8yya5igWm3y1BA6TWQEsgSJd3WLusqqOTaGBoC+8GyYaeEiTZrnvsCaUBSlRccReZ6jpRp5lGoOxOQkLh00UTRTyyf+7h/gW7celTm+HBGJ7pu01xo7du6kqBQYy2FGq9HEKEGpHS4QXulVCISxiMLw1es+v/aDfO4rbriwTDdsEDtJUDrCUtCwGpWWBEbijCeID2zBOZcevFoaZQZQu5NrT4VEWwGppSkbSAKskxBEpA72FzkDFbCi6y2kp0NWtKavNCtBwK0rC/S1gJO3rf9GrhPKQdsGuIUB3TJge2MalVqypZTe0oBePyc3ktRJEidJ8NsASSIUfSHpSUVfBPTQ9ISmLzQ9pehLRSIUAyGYH2QsDoYIAqIzzz/u13ks4aqsHZ+5o3DKq4hy0eni3Mc8gn1FQrxzC0Uomd22lTiOSYdDkiRBKTXm9dmaE1XrsPi2psOAMGrQTzPSsuCs887lmuc/D644634xd9SE7hp1sV9Z1YsRUiOCCKdCcinIhCKxkCDIgpCh1AyUJpGaodIMpSZR1WdKk0UNEh0yUAELWclQh2QiwEUttl10fA3XjSuISukfLj4eZIytLFUFWsADzxUPfsLj3B0f+QRxYciKjOmgRSOMKdIClKhuuBwJltTsbScs/TRHKUGj2axioYK7d+2B/Ytw3ukbPf1NTOKRDxLPeO2r3Pt++50s94Y0gNjqUcDRVRkAxphKX8l6DYpjgfN2iNOuuMjd+W+fYC6Kqjo5JaqS3C4LL9VtnTiIaFnHR5WztNBgJbd841vc9fFPcfK5Z2741ArpvTz3tZt652mnsPcb1yMKQ9JbobVlhrDZwEhLYgqEAokgGfSQcZPbv3kD3Hi74/zTj/ihffHfPsZZJ52G6ue4rCBUAWkyJIojCudrLyRlCVrTz4ace8nF97xDJ1ZlY1sncFIxBPIgYhBoTn/wA5iXhtw5GiL0buPKpVwoW7mLLZmWbOu06Z52Epx96n0weUiUClAioigKFpb6yCBgascOimFCXwmGypEpn3ppK/lzAQgrRtyuMb8AwIv06UrsKQhCMufIg4Ct55wO5+y8X0ySRwNOgClLgijGFsqLM4YxOqqI6RefL6555lPdF97/AVquQKcO4RwNHdLoNinyDFGFDuoQ/IE9Mm412bs4T9hsELYa7NqzG7v7LiTHd1V/aLiKADrOwqxbgRGAlCz1+8yccxazZ55EEQSYNMdZi9KaIArJTTlamPssFTniByoHsoA4CBnmGb1sSDDdxsUBQwG0Gsf1ajdsbMCYlb2KnCY1nH2yAHjEi5/Hr3/wA3Snpin6gqIo6cRtH0eSesTyn1Tbq2Oc7akOg0GP5d4ShRBEjS3smNnCh3/z7Tx+7pcc5504RZtOBHRe8HTxgFu+7b7+/g8RoyiTnABBqLxAWGkt1vkBUWnFsQqjAFz9xGv50w99hG2NFsVggCgtUSsmK4qKouFQVqySBx+J2lRy3SorYDDkgpN28N7feSevu/h8xyMevKE24zOj7MHsvuOMHaedwv5A02ppsiQlHwwpNRjtVXXbUROTG2IVEAYBvX7Ct/7xXzn3ja864mN88ZOf5mQVk64s0Lauum4HUnq1WhzW+riy6LaYPecQCwA3JnrXISWLoJSCPgIbKYqyxHVbJHNtrnjNy+GqS+73/doCA+fbQamhtWUrqRR87s7bkFumeMU73l6lRkhsoHzhrzrN3/o+5PVRgFr5VXjFx9pbV+YlOogY4jyh77sM1oIQwuvYlCVCS4QeP/qLn/lU3v9Xf8nlW2ZY2T1PG0egAtrdJrv29ohijax1hirypHReb8YBg2FCu9vBCEEySDHNJn/1nr/g+Q98oOPcU+7TNiaoM2e80eFspQWCIJeej6dmt/CAJ19L/OTvgUtObDXsDRsbrjSgHAaLFL7hKClHBbEAuPhsccEjr3a7PvPfnLZlC2axx3CY0W60GZTpKOV11X4rA2Sxt0IYKGZmZlgeJGT9hP7KCnfM7+ear3+d8LzTNnoJmzgAlz//B9n97dsYfP1buMzQMqYiXfqB0rkSKRVKa0yZ38ve1o/WYx8hZs88zaXf2UtgHIFxSKkohgmNMMLZEklYWfHjCsGTtTTIDDONBiv759kaa/7ut36HZz/iLzZ0XkKI0bYR9sVGOTznXHoR/znsMydDZtsdhv0eRgiUinC587VlgFazwUI6pBHHXPcvH+bc73+y4/x79wTs+esPuqA3JFnq0zSGZrPBMOnTaDZIbYF1Bu083yDBcfrFF8JF59/jft0By892o0WpQxZ7fXpFzp3798FUd2M35jjBCbBKEIQBRQH7ez3KRsTUGadg5qbhpK1w2Xkj/vKhYtb3FseuB+jjuwY9PhCu4myUFqT2XDAUaTExppxztrjm2U931//9P3PqdIdgWJAPBvR6vqyBtIK6KKeg1t8ZcziarQ7z8/uIW012bNvG3XnG3bfdzr7Pfpat5z7r+F/0ATgwA1NQZZ4gyZTgzqV5Lg8lO05wQwM2rCBa3yzvUvarFkHAwbn/T3n5i1mSlgxB2OwQBg3SJBu5vw5HoIzjGGMMw0GCMJZOENIQmtNmtvK37/qzjZz+Jg6Hs08Tj/+ZNyFPPYm03SANQ0qhcSgUfpI1OAxrU/hcDx7yhGtZwVAGGiFDTGGRxhFFEcaYQ6QN1mE4H7dttRvk/T5zQUw3sxTf2cUnfvQNG5rmBZ6rZO7jMErrUQ8RU6fsYN/KEkopGjpEOUEgJIFU2NIQKI0tckyeEZSGbM9e9vzbR+9955+/3n32/R9kixMEWUorDnDaUmhHog154MilI7cCEcYMHFz1mEcdel/OjeLoo4+Ej7O75QS9PGRahMyoBm3VgHNOHG9lJCXpoE+sNdOdLmVWstIfsJilcERFBP8Hw0m01D5by4kRF+zAXvWIn/lpsSIF+wdDnNTEUZMyN0Q6wFbJBJNzx2Tj6S2vMNWZxmaG4VKPsDDMRQ3+6d1/CTd95z5P16lrfB242DaVLoiansZ0O4f+8QmGDfcGLcekQYkYKSgeRB58yJXiymseRaoEu+b3g9JI4ZMyR+JHcJDh4ZxBVWvqqUaDYjBkJopJ9u4n37fAV9/1F/d5g/muxPmniu//uTeRzLQZtCJSrb3Sq/RETePsqHbJscTZ1zyKJQW20cSGEWVukEgCrSmswY0msXF7q/UYjLRkpqTZiukvLDIbhoj9y3zrPz7DdT/3i+tuN6L0oQNr7/um98DHPppEQWYsgQyQ1uHykoYKfJVarC+412qhrWUKzYfe/dfwqXsWOlv86vXs+uo3KPcvMBOFCFcySPvISNEb9tGRRmpNisNEISvCcOqVVxx2f/XBDrQiNGDyjEj5Yo7mGKVSHwsILK7ImW40cElGurhEN46JdEBv0IcLT/zV6LGGl9UWSCEwRYmzJY1mdND3nvS851A2G/TLkrJa8BRFPf7UGU4OUWWm1N6CUEc0gpB23PDe0cLSKh1iaYXP/vl7jt+FHga1tsYkj8lnbgFIrHXkx5CIfzyxIWOj9mroWrnKOi+PbQ5N1H/sC57LvmFKd8dOUidwSsMEoaWOvdWqi8riyTDSk/3KNKMpNAxzpoMGUWb4xN+/H75+w30/6n834qoLxPN/6We4g4JeKKDVoDCWMAx9GuyBFYKOBS4+Vzzi+57CrnxIEYQY65VN02FGEIUjLZMak7LYpQSjHUtJn+nZKcpkyHYdMpdZvvH+f+Ubv/h/1tVuIhminSJUR4XytCHsuPB8GifvZH44ZJAVtKMWpIaiNySUPq1QaYExJcUwYSaIaGUFv/PKV8PXbnTceONB92D49x9y//B7f8AWBy0MosgpSq+j0+m0cUVB0U+Iw5CeLbHdDpc+8hGHF0aqRhkhxKoaMk6A1eAiSaEdAwrK5nrr4B4dTJJ+7b0Ur5POc+BlkdPE0ZUBMs1oKk10PPrGCQ4/7kukFSjnCJQGayjzgxcxFz7hCbhOm55zDExBGDVQKqhSRg8XpAKFIE0yRO5oWEnHKpq5oZ3mfOEjH8V+7qv32dzhGCubjnQ3qnkvMF5htoHCrty7kvKJgA17NsZFpty9F5h6yAPFZY9+OMvCsm/Qxyg1Ej+qT6a+2YKJWhOjzUu6ausIraVZWoKFZT7+N+/d6GVs4nB49APFa972CyxqwXyR0S9L8rKg3W4ft2yMq37+9SJtxvS1oNQaFTUxzpKm6Yjbc2A4p2b5GyVQsaYwOUU2JDKOORGgd8/z+ff+C//1hl9Z80V4lUJ12LozxxOz3/8UsaQE8bZtiGaDJEmJg5huo0U+GBIFIUWR0YgC2o2QhT13c1Kry8mqyduf/Xxu/vDHyD7yUccXv+L4yCfdv734Ne53X/9TzBaGGSFpCkGoHK04ZnFxnjTps33LHC0V0lsZ0Ny+na/vvpPHPv+5hz/JCR6N79+V3gY1z8Z5qW5RyzefOPBucDvSt6mlpo9XheQTHX7OsJV3e3wfD8Il54oLHv5Q9NZZEiV8hk5Zeo0KMenXrLRbhRsZteMSGJLIOJqFpVVYOrnhE+/9B7jh6KTErxX1QqlWNq3PdVSs0UrvoQzuWQX6RMGGjY2KS11Vm7OjIjGHi+U/4vufxJJyhNu30q+Uz1btb2S8jLdaEXLk8ai8IFFpmUot//0P/wwf+fSmd+MYQT7xUeKKxz8WN9Nm5pQd9LOM3soApe5Nm/Qo4eY73NVPfRLDdszudAhxhAhCWu0xkXBUN2diUgMYDIegFaUSqDBAOUtXBpzdnWPLoOC2//ocn/vZt6+p7TjnMGlOmefHpBDdWvHkF76AW3qLDKMQ1WqTZQVJktKIGijtQ5z9lWW67RbtOGT+7juZLi1nqJjr/vLv+J0f+VF+/8Wv5D1v/nn2XfclLpyaZdqBTQYoCeDYs3cXp598CjI3ZAsrmJWUTqvDHUmPBz7le+HBh5c9rsvC1wq3k9L9QgiENUhrvPLtCWRrGGnJtGUYWDLtyKu03Lo+yibuHWKk+mtH/z8cHvaDz2I5VhSdFjRC0rzAVkYrjLOdVu9lLCinDQQGIuOIS0srt3zxwx9hz9e+cWwu7oggRvpSNSb7xyBJJsJFJzY2riA68S/UD9zb+IfE4x8nLrv2USxJi2s3KKVYZXDUoRk/iNcFZyb/PraCQwuzVjCbWf7lz/5so5eyiXvAQ17xIqbOPo3bFvahmzFzc3MjAZpjjrNPFVc982ksRIqZ887ipt134ZQmT7PKGB3XFqhRFz4LtU+tLpxBxwFJlrKwdw+xEczKgHhphes/8nH+7iU/csRXEipNGIZEQXi0r3RdOPPFPyTs1lkGjZCeM2TO0Z6eISty+ssrzHa72DxjZWGe2ekuLa2g32eLFTTme5ytG5xJRHt+mZ1O0M4KFu6+i+lWizRNyMqCU089lXSYszC/zOyWbciwwXyWkU81edwrX3qP51fXDRktHg45p7iRNsCJAstEgS+5eoF1AtlM9ymcFx2pxnlvkB727j3wQvHQp30fSxoW0oTW1PQhvrRa1OtAr6ey3ssRGkPDlJwcNfnXP3k3fOXgcOLxhKg3N2k4WXQUkrvyvjy1o4YNV311Ew9zVOJc1jrth8bDXvZCdpuUJFRkqq5UutojMjmJWeHG5aUnjqetpZEXnBTG3PmVr/PNt61thbqJNeCck8W1b3kT8fZZEmfpraxg0+O4sr/0LPHwZ30/twyXaZ66k36eY4py5AlzMEEW9S7IoJQ0ZITLLcOsQIYhOo5wWmKMIVlaIu4P4M67KW/+Dr//xO93fO4L93pFpUkpTUpRrL9s+9HGY5/7LG4Z9kjCgGjLDIPCr/q01BRpxnSzhSgKVgYrBHFAJCSDvXuZsTBrIb97D9NW0Mgttp9w0o6dDPOMRqsJQjLopyRpwWnnnMfdSyusaMWw2+Ixz302XHzPaox1TBrGlZyhmghklYHgQAlxyAq2939IlBVoI/1mJYE9Ea/jvoeT9xyCuvDHXi7KuSmKKKIQnhJa045HXCD8WFCXlq9LOoznjqqcgXE0Bylq7wJf+au/PcZXdngIJyop/9VwAoJGiLvvo7VHBRvuEbWhMPm+tvQPi3POFtc+++ncsTJPrnzM6sCVwciAYbVRU3+vLv2hkpS2tcyKgI+/7wPwmes2DY5jhQtOE7fs34tuxgRKEx1nguQDXvdSEZ5+Mv1IkZYls1Oz1MrhthpcTCUaFVi/qdwQCUWgFGlZUAhH2G0RtBpEgWYuDDhZB5g77qC9b4Hfe90buPHXfsdxw+2Hbkc3fds5Z1FKINX9JzB/3qtfJE570OWsBLBiS/atLBM2Y+I4Jh8MaQURrSiitAX9pIeWljNOOolWqJFpzlSgiQFRFF6Z1ZZerA9BaX3ef6M9xc27djFsxuRz08xccTEXvPal93oTRmXT8SvLUXVKwajMQU30E+JEij+MiYnjUvISbU5Uo+l4w/N1rBh7NOzIw3F4XPOsp9EzJWmVDTcuRDm559rgECOFzZHKZsUNClxJMEjpZCVf+fh/wr/953GeO2pmYvWuykIZa29YlhbmJ6pdn9jYUI8YFZUStaqiH+yLe/FsAFz5M68T2848nVLKkRDTZKnmA1Erijq8aIutJIulMbSEQCQDorLgH//03XDzLZsGxzFCe+c2BtawvH+BWOpjVmH+cHjpz/8Me/IEFwSURVF5NlYrVIKf0IIqRhtLTRxGJFnK4jBhKU1ZKBJK5Yiko5EPOUWHbB3kbF9M+Oy7/pL3PPdlzL/j3Y6vHNCWzjtHxA2N0lCY/KAw332Jp7/mf9M9/WR2D3pMnbSNlSwjTVPacQNZlqTDIXGrQdiKGOZDdu25m/5gQJbntLsd8qKgwOI07JnfhwwDsqJEBSFOaPatLBNt3Y48aQfXZz2+592/e0SP3zGR+jrKRqmKZUlJLiWFEFghD+Jw3d9hEVWtF4l0YsQPEIcaxDaxCquLElZaLBye71fjwpe/SEzt2E6z3aGucroKVZ+s55PygM1WnwsHUV4wbQQdK/n7P/xjuPk+0N5w40lP4D1/PtQDp2/ZTlQY+NaJP6cdYmlqJ16rnGV8I6jd1fYgG0VihUBMkHWORFnxUU97Ch//wz8kKxXCeYeYKsdEMlsNSnV4xlIV2qwIowhL3IlY2L+Prdu2kCz32f3l67npQx/nvFefteabcTiMWM1WIQQ4J0Yk1vpqJ6XWqYmywmKFv3tuRJI7MtiKpazrY2NXiRQoh6+5WnuA6nCCmKis6cRRZ/enyQBhSmbnZnDD3LvEpaWsOOSull3mwBZQDyv3EJM9ElxynnjhT77efejtv49bHjCrJMFEiqI44H5Z58gyi9CCKIoI4oZXLcxKGo0mveVlWo0IZxXJ4jJbp2bYEgQsLQ/56J+8h8Hf/D2nXnWx237B2Zx2yg6mGy1YTtBIXxeoPq5vnaOwjnR25H0TdecBZCVwJRBH0kXWhgddLK59wXPd3/7277A3SZhqRMQqoJ+ktEpBHDXIDCT9PtubXWxoyKRFA0u9ZdqNFtZAmqXs2LadNM9ASqzWZBb0tjnuzlPml3Le9PVPHfFsKmDVRDJpEAoLsiq37uSJ5w3whFfhF0GS0TO9PxCHD52lJbHVuDWWSp8YR6oONPrdiE9x7xiRfhkXRZMTtXAmyZtO1HViLMpZBGqs0XQEeObrXs173vhW5qREW4sBhLBVZoufP7BVTZrKiBXOoqoHJJwDDFPdJouDZWLVZu8t3+Frf/M+LvvpHzvCs7inm1FdZ/XWjw4Hwnm+mfBUgVXTQyW7nuzfx0fe8zckH/oX5ovMNaKIbJhDYdCNiKKac6Xzs3LNoxO4VYTZuhq2w9cyq4shOmvRKsA/LQdCsa/fo3XaTp7wrGfwyOc946hZzQcbG6HCuhKpHDYvkcJPEmO7y8MI38GwDoTAEWJcFRdzAmnvvSLm6a98gQg+8E9u6bY7mdaCQDiKLKXbiDFFiUKSWzkmkQqvI6+cJbQ5Vjj6oqCMLV1TssNIihQ+/H/fxXnXXrumglP3BK/5oREuqMirFukczpe3pbau63igrTqoFWClw1Gl9h2aGXdIlIGkEJLIaYQrGU/S3l2rraxqMjjfbqxPKbQATmHxoakSx9GkMXZKSVxaUpvhXE6IRJcCoSyFlJRC4ISXr580WCWll2YTJU5uzFW+7fnPFOfetd994s/fw2Uo2okhz3KmOi2yYUoYKIx1SCUxznkRMmMQViIFuMKhnKQwFh21GFqHKxytZhdbOozJaQpJmGZERcHif1zH/k9ex/+rjOAdRiFNJbFs/LMZjc2MM6oq51tllDpwrhK+sygnOBY0wu6znySuGa64f/zj/488M1gFcQl5WTLb6lL0ejQKSShDesUKLvSDTBAElHlOIBQtpXBJSiAEBAF958g7LfZRYk7ZwZt+/i1rOqemUxRFhggDkn5COwxRCCgMjVKSLPeJmi2iQBBKh/3kdU4++ur7xDUwqR0jpYR7GMeUg6CQoCCvyg+XtsRK443J+xilrBY4E8aC9w77MRUYLSKFsKMaQ7YymkbLgiPUDFEINA5hDBoQxiAqHSUD41Lq1eJRYYmM51dJK8mdRFqNOxK+y4Xnc9ZjH83dH/svpqY79PpLiDylq0Nc5kXtrPYVUk2VM+kA5Yy3n4SllJa+6WOVoTVMOcU1+PS7/4bLHvhgx+MfvrEH6BwWM1pkCixOVhXRq8WgHyfMaO4wk0Zd9f82EJYlxd4ltkqQbjj6ik0zSilHhqE4hKE7yX/xC8+6oJN/dVIgrEBZjUQhnWbGOuYX+1xx8cEVnDeCg59qFQYZW8XjMx+L8YxtV1EtVxyiMknkKtf2veH5P/mTZK0GdFoMjcFgUNaRDhJEWee6jMsQj8yeatIvXUlnusNgcYkpFdBJC04PW/zTz/0KfPswcfd1wCIrd5cCN37Ak3IyYnKSqT4Yu43dwe6+e4R3z9ZxYDHKH/eGjMQr73nCnR2VWldWjmqFTAooHS3UhYOM9J21Rh1G85sYh71GjX3c1I6Gt+XSJ34Plz3lCezT0FOCcHqKJC8Iw5AyL9BKMRwODwrN1RkPujICVqXLjdIzfTy3YXLaRcpsmrJ1mLJ1mDOb5rSKksD4Tj3JJ1q1inRy3E5G/UNWA241CByj+eicH36OeP1v/QZu5zZuTFYod27DbJnh9pUVRKNJPDXD3fOLDIWklIpSKEqlKZQmBYbOMXCWgXDcNehhZ7vcmvaYe8Al/MiH3yu4+vI1nbmfYgQIR6PRYDgcEoYhznqhvh1bt5HnOQsLC+R5fq9iWvcX1PoNyvkJulD1gmKD3rujhEkZAW1BVxP7JHdGHbB5fYex11ayxmZ6CK6KzxiTIxmD8bH83v1cU4/tmiOK7p93qnjIs59K0o25dX43iS1wWhLHIZiSPB1CWYyy0g4NixUlShimWjHp/DynRx3+6m2/sZYrPiyEk2MPuJMIO35fzxXKVvoijA3B+hUsgYFWXjKdGuaGBVuGhtm0YDY1bEkLtiYFW5OMrUnB3DBjblgwm2bVd/z7+nP/3fG2ZViwJc1o9/pMJ0O2pAUzScEONKdumaVzxWFE+taJg55DoSSFlBRSVGIjojIuqslvdPPGK7ZJU0NMNKYjwjUPESdffgkLeY4NA7Zt28Hi4hIzM9OUrhx5BPzuKvKQqD0KIIwlQKMC7a1XYyn6CXd97Rt8/f3/fBRuUUUskp7oZuVYgGg0pDhfDGjcqSSB8UQxbSWhkYRGEN4ja3Y1ala7HhkRVcGhahKzVQnqqIS48KvXyNhqc2jrG+rRTiX0JExvTBQKMgWZhlxVMVEhKYWs0p8n1P1cFWKrDbYNonPpWeIpz3sO2664mLsDx0qkWDGG0gjaUQczNEy3u5UHoeb8VGfkHIG1hNYABitzEAWIHEGxalPu4E1Xm3SlFw6rDOGyqtRYHPC66nMh/HshVxsnRxsPuly8/AN/I17wptdzw3CJL8/vIZmb4U5hWY5D9KknUXQ69KwkRZHqkGEU0Y8jVloxS+2QxW6EPPNkbsj7/Ohv/CrPfPNPrutUimFOrCLKYY5GI42gHBa+LYQhmRAs5xlzJ5+MU5obb/rWUb4Zxw6HClXAUWDeHwVoZwmN3wJrR+ODHy8cjWrciAtBVPrsrcAIAisqEayatHhkV2OkxEy08ULWSyQ/b+hqHIwLQbMQBMb3y0wJMiXJlRyRvI/o+h5ztTjvsY8gOnknBBFhEDMYDFFhwMz2rQxshvfKl5WOR5UtWSUlgKSjG8RBzG277kS1GigcxZ55vvD6X9rYyFlnJlXzgKwylJSV1XhehzzGOiDigE0esB34PW0kUSlpFuvbolISSw3OIKpVaWZKMgwnnXHahi7/UDioFflY2qTnYlworRbVqt00tcGhqjiZrEIc0lrUGlYnT371q0iigFQq7tq3D6cluTFIrcbelUOshoWTBGh6Kys0O20KaxASIms4OWpz3Xv/ieE/f2zD061XObTUBb5slZ5VF/uqBxxXuRvrBqGqxiWtNxzUGmQFVfX7mnRWPypbe3jqlToWbf3m5d7tSIVVVl6Io4ma0V1b397wkN4Yq4siAcL6dC7lBMIphBOV10Ujj1Za4GXniCe/5adoX3weu52lccop7M9ShqWltA5X4g3kekXBuL3qqq0qSqRzSMz4FYNyBn2ILbSW0HrPh3I1e6k2qCZdHOM+VBteTkjsxP+Px5R0yot/ULzh7/6Kl/zyz2FO28G+dsgdgeP/9Ra5E0s+O0PSnWIhjLhbCr6jLHfHisXZKZIdW7nyWU/ljX/+LvQTHys4e31hybIsCYMAl1tsUdJotOgnKYQhiZTcsbJEPDvD/mQAYchn/vvzR/s2/I/E5Ap6NFZbb3j4zY3HiWoSrMeuuj2LanFzJHAISiFWGdmFHBvj9TnVE62ycpy9KOrjrC2T56G/9nNiFyWy3WKYGaJGk8WVHnuXF2l1OyDsKPQunR3x/4wQWDTDlQSXW7Zs30YQaUSe08wM//3+D5L86T+uf/B0spova2OB0fX7RakfI+px1C+j5SrvxuSYb6v3duJzqEt91HP02l6VA+0EkdJIhA/7BIJekXH+pRev+9IPh4M4G341DqGRBKVAC1mlFo4bLKOCN1TGBeAsFoETcu2utysuEtc+97nu3377nXQaDZpxiyQd+KJMSlSGRtUBhK2Cip7w05AxhSkZFgVICc6wY3qab93+HWZ2bONvfv0dvOi0U11d6nn98LE3KyxCWBw+faoUqva++/tU0WQnU+KksxinOSQf9zAQNaPdSRxmVbYPAsyEB8nJMRnRy/f6+OCxUNwa77HuGPUf5MgYVc6nnUonMcKBtYR4KyU42hoE554unv++v+LvfuiV7hvXfZkzZmfpZyWxa5A5f54SizbeBlAVeczfmsowm9jd5C07VIORk7UzqsFiZFfUYaz6u1jcqGP7UJgStSF5HNMjzzlFzJ1zCi94wdPhKze5xdtuZWHffu685VaW9s77GkRaEDRjZrfOctJZp3PKOefAgx9wVHwvjdk5hmnOdBhjjUNLgQxDcq3plyXRju3sNxnLwhJ2Orzs1a8+Goc9fnBVaoOT3mA9BuHL9WKcKWiRdZbGxPnZKtW4drpOZojUoQ0rjtCzMeHhQxikkFg5rodTLxxrgTfvsa5Gy2oxq43PwlgLnvjyF/KZd/4ZTedYHqRMz26BVsj84iLtoFmFmP01lMJ7YJzw4aJWo0NW5AyGGQWCZqCYlorpuM3f/Ppv8eJTtjmufdj6+kHlgfb3r5oZxFiA0FI5emGUfHEoHG6NKp3nwmwIeeYDV8KROYtsxViTcfrll250zwfhoNlPVu6zEQeguhOTpBO/wndVzPpAnq2feR1rc5Wf/7qXim9++jPO3nYX++7ew5ZGgyLpI50lsGPX2qgTV43HZoaZ9hTzSQ8VRjhTkPSW2RKEhEj6d+/nn37113nqX//xms5nNVx1bFtZklDLIBppR4ZB7W2wowmstkzHnXgtR3QTv6vTtWwVvpFOeeJpxbBWlUfBCksh6hXFoV28G0Hlu0E4MzFgjXUUcOM2VL+3DgRjD9mxmGSf/e4/EO994avdXZ//CjRjkjJnKgihyEYDmfe+1b+w49VD/dkEgUpUrFvpJtjbk694Y8pSPWtbab8w7isH+uLEIfrScccV54mZK85jBjj7eB3zQVeIQZY5EbYo0ozeMKW5ZZqlPCPvNtmXJTDV5hnP+0HOfM2LBDfcdj+Zqo8Eh6S93S9Qr+IL5cbjFjBq14zHVTtS4bUj3ZM6pHGkD2OyiOaBdbLcKBtJVgu1sRFUH6AeX9ca+j37RT8kvvSP/+bIDMo40qTPcHmZqU4Xm+aj/bnKQzAK52Lp9xOmpqfp9ZeY27qNhT3zSCSxs0w5y3/82Xt4TLfpeMgVa3usotb2cFjpFzWOsWCZE27kMBKsfp1EbYgdDhvpKAIQpUULgVNQ2hInHN2dW+DKi456Mz64p1g34gmMCIlVhoWRllKV5KqkUHZUC6CU1mtrqLHGRrmOsPyTXvIibhn2mReWgSkJw9CLMxkffzxQ3EQ6iSksEoUOIgyOAstg0OPkrVuxyyuc1e1y62c/z3U//2vrfi61y0kwJlEp67079X2x0o0EasZSuXZkaJQVgexI4bkqbiKEMw7j1H8rq9oMSQBJAMMAhhpS7bkUuYJiDRkwRwJVxXMD6w0sf711O6mlmSbTp2vjdEJL5RiNxs9800/y5Ne8glvImW8ELAaSoVaUUlVGwNjr4O8hGDRGBFgCrAsxBBhC/16ElCKgPMRrLkLPBJ/oQpOdaXUs35N6V70/6nmv9290tm9jICEJNL1AsKQE/WbI/kiz40FX8OrfeJs3NAAuOOP+Ml/fKw73FO8Png0jLLm2ZMqPC0no/FaNFX7ccAy1q+q7WDLtuViegzUeg44EcWlpFJZGAc2iel96noi2PtTOqjHTy3AL6gJ2nvgv1iFi9aw3v5E70gHzpsCEAWVuKIZpVdSzzg6c7IMCnKLV7tLr9QicYGn3HnZu20qrGZEOemxrxdz66ev40t++D2769tqeaJWhVCpLIS2l8lw/K8YbeLqBvoctuIdNWzuqKbOeTTlLpDTCWM+qkYJemXHWReev+f4fCQ6xxBwXTbIja9Rh5ORmR5s3NuTI0LB1DH8dJxM8/pHinEc9DHnydkyrybAokRZC6zyTetRY61OXBEHE8nIPpRQIgdSCHSdv5867bqOhBcXCIqc3O/z3P/0LvX/+6LqGgFGs3/pVe+31kVX8f1xEaHKSnXCXVeTEtUyyrmqME64cfEZLHeEbT+S112PS0LPywAnv6EBZT/SSVo6KZrmJzlOfZ210GVEZotKSa0eh1mZ0rQnnny7OeuULxI+87RdQZ57MLgp6oSYJJJlSFLLOamJE0jRCVQZH9f/JV/xrUcWhCyHIlSSXglL6z9yEMe6veWwc1u/rVd3489XG2P8E7Dj/HJYV9GOF2zrDbpuTb5nimhf8AM989+8JHnF0QjbHFxOeS8aZG/JwlUuPM0beA3mAqFXNk5BVe5ST7dWN23EthHKk2WPO+VLxzk+EoRl7yUfDmBjPHVb6sWK1t7EKAa8VD7lcfN8rXsywETE/HHLSzlOQxlWcNTdRUdginCdsSiBJc7QOmWl3aUUx+/btwZiCbjsmXVnilHaHr/77x7n14/+5ptMZJTZMFCEc3cvRWFkZWW59W11hWLn1bcJBIBW2NCAFRCG5dJx9ydHna8AhjI28SCCUlNrRzxOMtBTKjgfNkZyszyEe2hLZapKa8So+iiKGg8G6TujxL34++wNJ1ogZGIfJDQ0ZMtVsYrMCia+loLXGWotzjjAM/Q3DkzT3ryzSmGpjMZBlBIOE03WTv/jV34Dr167EJqzz3BXraAQh2SAhEBry0rO23WorVE00CGzp4/SCNQ1A1hQ4UyImGoe2tjqWI6hWC4ETBE6gnUD5YAUS4atpCkGgjm6xMGU80TMwAo3yRpQct43xqsWnxq4UCWE3ZrEcYCKJaIfsT1eO6jkdiOb3Pkb88C++hcuf8njmm5r5QNJvRixJR6IVJopZyQpyQIYaQ0lpfYeT2guhFfhMqEIa77WSFqPBKEeuHKkwpDafGDj9ZqSrVjHj36QmIzUZQSOgsCW6EZC7AvNdUmDpSHDpox/Ofm1ZaAbsDyWnP+xBvOTtb+OiV7/4/mVkVOOKEOKIUnCDICDPS6y1BEGAyQsE3C+K9EmpEUKNxgIhJAqJRIzGjcA5QucIHAQ49OTmHMIabHlkVUdzUaIaAWmZUdbqutb4bAdncBhKYfwCRFhKDEU2JNAKU+TIQGGk95ivB2f9xP8WdusMotvlzrt20wqbaB1gcSwnPQgEZV4QCEkoFRKFUhorIE1TAMJI46QlszlKCUiHdEvLB/7gT0j//RNHPHcIaSnLHCa9Cc55To9lNKa7CeNrrZsT3lu03k1iERaKovSE9VBTRoqtF563rvt/bzjI2AhbMU4KUJJWp43BT+g4h7AOZfwWVK+znRn23b2XbrNDM2wyXEkww4Lt01vXd0JXXS6+7+Uv5luL88ycfhphu41xll133sVUp421FmstWmvKoqLHVOxpweqVvhEw1W4xHcawb4nmYsK7fvyNcNMaJWmdIE1TisJgcbQ7U/R6A6Y63WqlzyhVTFa8gLGwkzeOyjzHHGGnBbBFSafVQFgHziKsQ1rjrXXj0MYRlI6gFIQFBCUoA9IKpBFg/fOi2DCFaBUCGdBudihz440a6pWLW1U+vA4xzczNsNhfIW416GdD5pfm2bFjx1E9p0PiyovFw9/2VvGyn/8Zpi49j13a0WvFLGnJIFAEc7OIZsxK0kNKCAKFsTlZniJwaCXBlShZCfLYAlumWJOjhKERKbrtGJjUUpmEX7m40rB161bCSJMNU7AlNi9QElQcH/v7cD/BtgvPYbkR4HbO8ewffzVP/KPfFFxx/v3L0JiAOAIhKwsMh0OiKKIsS5QSNBoNBr0Vkn4Prv/WfRpMKfPCE6YsSCNQpUOVgqAUBKUjLARRIQgLR1j48USXnvcgrUVaR7MRwRGGNUwkWEyWUXFAGMcHGWuHCi11W23ISwIhsUWJUoq4uf5+8YxXvZJdWcZJZ53DICvpDVOiVpO5HdsojSEMQ7SUZP0El5djflVNrBcVn0I4EIZGoGngmHOa9/zq2+HGW4/omQosjSgcjcPCmurVIasN66oFulv35sZEuLVv+DkybLbIESwmCaLbhkc+5Jj0y4MIojbLyYcpg15GA0WIGpGJanEYEDjrha7cUsr2uEuUC1YGA7Y1pxnKmCUUfOHrjgdeuuYTP+sFPyCu+sLX3A3/8lG2DlPOnJ5mWsHi4iJxu4txjt6gT9xqYEpfMGo0wTvv3SirVmSMYbC0wszUFpST7N+/yMd+/w953G/98pGdzLdvdUIr4mabhizYv7jIVLOJDEKWen2CUI1CLHUq0ghVs2zGDaSUBGtIdSyLnCQr6DBJOJQVq7quweCNi9pmHFXbVQKDz3g42jobSZqSZBAHitKUBFVtm8l4TR1mEgIGKwOk8Iz0LVNdsvkeIjt+1VL1Ex8rvv/8s93+L3yZf3/ve7nlK9ezVTfpOoXKC2bbTbQtcaYglA6lFFo6sJbSGco0Q0rhw3QSrDXkaU5pDLm1dKKWDxxVRNjRoqzm7VjLYHGZspfQ7UwTxU2WSwgwlIsra8hPOrEhH3SFeN2v/Jyb2TqHvPj+a2SsFXHcJCv9JNnv9yFzTG+ZJp9qwHB47zs4htCVtz6sdNQFY+2ewIyzDD0XzWKFD4eXruJVSegvrUD7yLw0pQSjFGlaEkqJVoGPGjAOMQlb6d1Ih3AKkpKyP2R6qoUxxi/osiNflB2I1tMeLx74yc+4b33w39kZx0Q6Yv/KIk4LnHF0A4VwBiUhjiJf34iqHMbE8Ox5I5L+MAEVMhsK5PKQv/2pn+MHfuVnHRfec6VjN8yJpB5lvvkkAstYo0qOGPTuCAzbw3GA1iDddMh9OiexQYRsNtEa5i44NnwNOFQYpTTouIGOGzgVUAhFiRxt1kmcVaMtzwvarS4rKwmBjmjELfbs2YtxsB5Do8ajX/xCVlohdnaaOwd9FpKEztQ0Ukqcc6ggILcGK8fznHB+MvYTrJdTX+732LFtO00pCZIhernPzdd9jjv+/C+PbBo+50yho5jdCwvkQtCcnSFTCtFqotodShlgZIBRAUYpjPRKjIXSFFpRCEGS56wkQ/I1eDZmZmeRjRCrJVYrrNbVprAqBKVBBgi8qxSpEEJ5KXAhQCofhzvCtLUjRdTpkEuBjSN0s4kTsnLVVhu6OpcApCIvDSBJkiGm8AJsdnicwwdnny7mfuD7xXP//i/E69/xm5z76EewEGl6jZBBIFjIE5bKnDxS5IFgIR2wkCSUEkSgcXqsa6KUII5jOp0O09Oz/v4KhaueAVL6VXH1WdSIMaVjdmaOOGywstyjzAs6zQ661T2+9+E+xpbHPFx8NxkaAKU1FEVBq9XCWlBK0Ygi5vfuY+G22+/Tc9NBBFLhhPDeahGAUCDqYIpGjNpvMGrLfpM4IQjjiO7M9BEdL+kPmZqaAqkoHMgwqgptShwaiwbnN2FVRdCcotGe9jwpJzAWynJj3thH/MgrENu30gs1u3o9bBTSmpqiO91lqbeEtZZOp0OS9KvQBpV20nhRXWtRRFoRCLArfRr9jPTbt/P/3vtPR3AWkqWlZYTUOKUnxm+N0SFWhTgVjp6JD4IfepPu8H9DKKxc32ZkQOIsS3nOrt4Ky7bkQf/rmg3d+3vCQQurMGqRlAYbt1geLtMIAmoim8CTEMVIhlmCjlg2hiIOkXGD/cMBotMiEwJuvstx9snrG1wuP1d83ytf5j74zndy8Snb6d18KzNKk670UCpAKIlxXmt+Uvq11n8A//nUzDSLy0s4A52ZKdIyhZWEv/vN3+LHdmx38vH/6x7Pz37zJpcrydT0NLsWV5jptHFKMBwOacYxyCpFGH9sU7njhKtErrTERSFKCEQcHfHlz6cpDSEpBeiq+pwnfInKkyJ9uqvwcUBLRdYFciSFsyRWUIqjWxulCCVpJFlZXmCmEXmeiBPU1UGkE15PwoFB0JyZYX5lgdmpaZJBRhw3acWto3hGa0PwpGvEo590DY/+zNfdLZ/5NF//xMcZ7IFBL6GpoR3GiDhAlZBJSTFMx6GxanlhjcUWBa5MiVTkPWkOLHaUz4/zjq0yLXz8P4jYs7BEKSVRe4q9WU7eHxzVZ7OJo4CK33CkKIqCIArJsgKlFK1Gk5VBgjWG5cUlZo/hqd4bjITElkTO4oTxY6QAjSRCeLJmpf2g8YNoicPr6gpK50Bq9vf6R3S8togwSYlWMaXJWUwymqEf84wY148SWK/LJOHOlR5OKuwwIYjb0AhX1whZD849STz1Na9yf/mrv8b2bbM0BSwt7GPr1DSNVpPCFrgMdKhHYfcDUXuTnRCETtIIQxaGCbEN+fwH/pWzL7vAxU/93sM2FDk1RdydYdhLRqpLSghyIZBAXg0TnkA7XhAeyoNxuOWixScDrNd5bSRYrYlmZkmlZX/aY/qMU9e5t3vHwTob09MsWcsgVASdJiljFr1wdcojo5Q/IQR5ntOYaTGfpqimIpybZV+5wroNjQrnvuqHxPnf/Jq76T/+k0tOP5V9t32Hto4IlWRYZqggxDo3dtHhH15d7AdgcWGZTrtNs9Fm7+I8YRxwSqvLcM8Sf/1b/5dnTs266OorD99oLjxPLCWJO+/kkyikZu/SArOz06AEy0VBo9kA5KjBmGqgqqvuDYsUY0uCKMaFRz61FI2QoS0QOvJEWOFGomk4iTa6ymmvuAFVtkstxVsKjYsDcimP6oR21+J+GmGD1rY5cpMjbd2EpF+xjESsPMFyKR0gGjFLeNGYUCkW+kc2eB1TPOxScdbDLuWs178SvvhVt3zjTfz3Zz7LN7/8NQaLA9oqpB2EhLqFywpfZwFBGChCpasiXY5hWXijQspRmMsPVJ6zkpcFSgbsKVIyDVt2nMw8hoWsINy25T6+CZs4HGpSJfeiwBuGIUZAnmd0prqs7F8mb0WcdtppfPSjH+VlL33BcTrjg7Gv1yNoRpRKT6SZ+myy0nply7xayOiq2KNf4buRmJdFY45wAGnNzLBreYkwbNFodcniIUk1HtbGRjgqoeBJjlk7otFuUfQyMqlJ8oLeUQj9tp/zveKyL33BffPDHyauQlyBcUy1u5i8oN8bsHV2C0lSGQPWO4QReDHFGpml0QhYXFhi+7atJFrztdu/w7t+8W28ets2x0OvOuTckQ4zVkxBOw4xRmGwlFhcFffIpcYJn7EjJzgxB2pqHC584lVCxpIC/imu7dUISLMCYwqKMKJ76knoK9eoJ7IGHGRs3La4j/Dkrdy1b4VmQ44KWZVV+ed6Uq0JNUEQ0O+ntEKLbEc0g4i7+/MsTzeOygk+6Xd+Q/zUBRe7bUKzZbpL2yisMegwYHnQox03sHjFyknBqFrrIuxOI7Tirr13s2XrHCv9Hvn8IqcGTXbdvov3/fl7+N5u281cdHiF0V6R8bVv3cAF23YgbJNlW6IaIaLVZKHMcbjxqnfC2ACItkyxtLSEMAXxGqTDy06LuxfuZksjQkkxGgCcEN7YqMzdurpqTW4aiYBhWBYCOdVc+02/B+ipFsmwAK3o9fvoduTdj66KCztPmAycT//Kg5BWt83e+WVUJ6IVN0iPQiG2o4qrLhdTV13Otc99FtdWHw3/87/dTV/9Br09e1nZv8DeO+9ieX6BMstHxkSAIwq90G9ZtTdlx8/YCpDNmEBLRJIjGx0WshXu6C0RnXUqPe3o3BfXu4mjBmscaZnT6rbQWlMUBULEDAYDbrll4T49t9nTT+LOG79NqQylGqfeK1Vz7xxFxbkKrBgVFkQ4nx7qYKXXQ2456YiOtzdPCc86lT2LyxS6oAicz+7BzxcCqnRYi0BghGLoSqRM0JFA48f11qk7j8r1P/SFz+Wrn/gY/TTjogsuZvdtt9JL+rQbLeImLCcrXnUaP3+AVxet9ZGUBQqDc0NO3bmDW3bdTU85LjnnLFaKnN9/w5t51X99+JDHHkqQnQ693oDc+XmhClzhhPdsGAlOH3pOOMjoOODvBxohkyrfR/oK0Jnpsm9liVLBKedcsoa7u3YId7gJ8MZbHeefeZ/HV8vbbnbpjbfwZ298CztSw2wBMYLlQcLUzDR56nkQdaXZSQ16hEWqgP4wod3pkJqCQjhyaxBhyP5myDc6Ea97x29y8gMuu8drTT74UdfUETRC6PeruCYQhIzSYPyZVK9jLQVrjI9fdmL0g46sYubKZ7/kugZIh4xytGvJ9kr6e3Sh1aplnA8vAU2iBc1HHt1S3fZzX3VyqQ9ZAu0G2NJ3WKfH96BmTMoSIkm/v0I7bkJSQtRhKKDxuGPDeD4u+NZux+IC+coyIYaxYJdktTqqxWKwxiByg5reAskQE2nUjq1w/j2TzDZxH+BTn3e/+7qf4LTM0RrmaFsZ87KuOaSrMcZLUTskQwyiHbN/aZHp2S1kjZib7ZCX/NJbmHnC4+6zZ7z0pS+77nKKNCWoWum38rxZP44Y5U9POU+KHmlA2GoBIQNMHKIevoYV7023Oc7bgDDbzbscZ+88OvftU19y7/ihF3FOqw29Hs0woMxyIh2ghaYwxoc4KiJrKWsdJ0dgoa1jlpd6yGaDPAoYtmJWbMlKMmQwN8Nj3/hjXPG0Jx7yXBf+7dNuVgc+/bcem6u2gxSVeHGlu3OAQrF0te9i9auY/Nwd/Ls1vToLmYE4gmYEc1PHdEw6vLFxP8O/veHN7raP/henFIJGb0jDgrSOUgSIQJNRkBYZOhQEWkJeEBiDNp6wVyLJlMRMtdmVJwwjTeOCc3nGW99M6+ILNgf9TWxiEwD88lUPdWcaRTdJmRYaMxhggUajgXOKfJh61eJmg6XMkAYaOd1iXz4kb8Wc+7AHce1LfhguPmdzXLkf4Nbf+iP3kT/+M7Zb2NFssfu2WzlpxzaWlpaIghgpJXme+xT4KEAqEKYk6Q+ZaU8zv9xDtjsUnRZ325KVSBNu28ozXv0qtj3pms1nfIQ4YTLvnvCKl/OuG29m/y13sbPZoFgeMNVoMSwtvXRI3I5pxQohHGWRYrKcqaku/YUVutMzlA76pmDR5PQ7LR7+9O/jiqc9BS44d7OxbGITmxghnupgeynWCfrLy8y1O1gLZWFJy4Kw3SLPc1aKDDWzhcQadi3Oc8ZVl/P9L3sR+nvWWbhrE8cEZ37fk9n5uS+y9I0bYGmZqZk5sqwgDiOEkDgn6Ha7LK0sEgjFwv5Fts3O0Ol0SI0hkTCzdQu3Ly3Qn2rzoCc9gYc97alw+UaLe/7Pwgnj2QDgS193v/7Cl3N+s0tnZUixsEzUbKBDxcrSMu1mjBJQ5jmtRpOFxWXaW7awPxmQhN51vRBJnvdjr6X15O/ZbCib2MQmDsK7nvZsF926i+nlIac3Ogzm52m2u/TLjEQJBs7Q2bKFvUnCknXI6Wke+eTHc9Fzng1n79gcV+6P+NI33V+84U3kN9/O+TNz9O/aRTuOUFHMwvISrUaEErBlapq9e/egdUAhHIUKiLdv5bZ+n0Er4gd+7DXM/MBTN5/xOnBiGRtA8r5/dn/wll/gFBfQNZaGhpX5/cy2urSiJksLixhjaLQ7iFaT3dmQXqDoNUMueNTDedwrXgIXbMbKN7GJTRwaH/yR17m9//kFTskFjV5KVDqCdoMVW7IU+EyxPAq4u9/jrCuv4hmv/RF4yCWbY8r9HL33f9D97S+/ncb8Eud0ZlnZu5+wU6mVFgatBEVaEDUbDIoC14hYkY55LGc+5Cqu/fHXwaWb3oz14oQJo9RoPuPJ4pJPfcp9+xOfIRCasrfI3NwMyfwK5CXTnWly6ygaMXdnQxaaEeFpJ/O0Fz2PuQvP2zQ0NrGJTdwjLr7scm79yGdQ8RQyczTbDb55663MnnsadCL2l0OSwPH8n/5Jdj7/WZvjyQmCztOfIi778tfcN/7pw+zrpUy1u2TFkCgKEKGkKC0DY1HNFov9FXrGUHZaPPfHX0v7OZvejI3ihPNs1PjLH3yxW/zaNzgnDhCLK4QohBWYUmAaLVa05I5yyFnXPIKnvv51cP7pm41lE5vYxL3jui+6t7/of3OqaBAsDZhtdQi3zPCt+d3sUiUXPvphPOUlPwwPPnaaBJs4dvj4S3/U3fbvn+aUsEmkLYv799OdmcFI5RU1yxI73eWkyy/i2uf9APJ/bXJwjgZOWGODr1zv/uAn38TU3XfTTQvmtmzj1tvuYO7U01gwli/ddSdvfuc76D7r8ZsNZROb2MSa8O6nPscNb7mT7UGL4SCh5wxy6wwv/cW3wGNP4LTtTcANt7m/etVP0JzvMWUKeosLRLPTrFjHvCsJd27nosc8gqvf+hObz/ko4ugWzjieuOIi8cI3/AQ9rUmbTW7YP0/zvLP5xsoS8pzTedtnP0n3imMrUrKJTWziuxNnXHEp2VSbOyiYn4q54plP5qWf/mexaWh8F+CCM8Rz3/JmdivLviJHzkyzz5TsC6F10Tk8/2ffuGloHAOcuJ6NCkt/8tfub37vDyilwjZbPORxj+UhP/tjmw1lE5vYxPrxlW+4X3jjmzh5+06e9bzn0n38YzbHlO8ypP/4UfcXP//LxAj2mpSHPe37uPrnf2rzOR8jnPDGBsBHX/+z7vZdu3nSDz6bHU+57xT7NrGJTXz34PoP/LO78OKLEGdvksq/K3Hzne7OD32ED/79e3nZm38SvWlQHlN8Vxgbm9jEJjaxiU2sCxuVV9/EEeH/BzHYnw+eKwtTAAAAAElFTkSuQmCC"
      alt="Ring of Fire"
      style={{ height: height, width: "auto", display: "block", flexShrink: 0 }}
    />
  );
}

// ─── STYLE TOKENS ─────────────────────────────────────────────────────────────
const S = {
  inp: {
    width: "100%",
    background: TH.surface,
    border: `1px solid ${TH.border}`,
    borderRadius: 8,
    color: TH.text,
    padding: "9px 13px",
    fontSize: 13,
    boxSizing: "border-box",
    outline: "none",
    fontFamily: "inherit",
    marginBottom: 14,
  },
  lbl: {
    fontSize: 10,
    letterSpacing: "0.12em",
    color: TH.textMuted,
    textTransform: "uppercase",
    display: "block",
    marginBottom: 5,
    fontWeight: 600,
  },
  sec: {
    fontSize: 11,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: TH.textMuted,
    marginBottom: 14,
    fontWeight: 600,
    display: "block",
  },
  card: {
    background: TH.surface,
    border: `1px solid ${TH.border}`,
    borderRadius: 12,
    padding: "18px 20px",
    boxShadow: `0 2px 8px ${TH.shadow}`,
  },
  btn: {
    padding: "9px 22px",
    borderRadius: 8,
    border: "none",
    background: `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`,
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 13,
  },
};

// ─── SETTINGS DROPDOWN ───────────────────────────────────────────────────────
function SettingsDropdown({
  isAdmin,
  onTeam,
  onVendors,
  onSizes,
  onCategories,
  onUsers,
  onBrands,
  onSeasons,
  onCustomers,
  onOrderTypes,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);
  const items = [
    { icon: "👥", label: "Team", onClick: onTeam, always: true },
    { icon: "🏭", label: "Vendors", onClick: onVendors, always: true },
    { icon: "🏷️", label: "Brands", onClick: onBrands, always: false },
    { icon: "🌿", label: "Seasons", onClick: onSeasons, always: false },
    { icon: "🏪", label: "Customers", onClick: onCustomers, always: false },
    { icon: "📐", label: "Sizes", onClick: onSizes, always: false },
    { icon: "🗂️", label: "Categories", onClick: onCategories, always: false },
    { icon: "📋", label: "Order Types", onClick: onOrderTypes, always: false },
    { icon: "👤", label: "Users", onClick: onUsers, always: false },
  ].filter((it) => it.always || isAdmin);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: "7px 13px",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.15)",
          background: open ? "rgba(255,255,255,0.1)" : "none",
          color: "rgba(255,255,255,0.8)",
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        ⚙️ Settings
        <span style={{ fontSize: 9, opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            background: "#1A202C",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
            minWidth: 170,
            zIndex: 999,
            overflow: "hidden",
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => {
                it.onClick();
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "11px 16px",
                border: "none",
                background: "none",
                color: "rgba(255,255,255,0.8)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 500,
                textAlign: "left",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.08)")
              }
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              <span>{it.icon}</span>
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── CUSTOMER MANAGER ─────────────────────────────────────────────────────────
function CustomerManager({ customers, setCustomers }) {
  const [editing, setEditing] = useState(null); // null | "new" | index
  const [form, setForm] = useState({ name: "", channel: "" });

  function save() {
    const name = form.name.trim();
    if (!name) return;
    const entry = { name, channel: form.channel.trim() };
    if (editing === "new") {
      setCustomers((c) => [...c, entry]);
    } else {
      setCustomers((c) => c.map((x, i) => i === editing ? entry : x));
    }
    setEditing(null);
    setForm({ name: "", channel: "" });
  }

  if (editing !== null)
    return (
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: TH.text, marginBottom: 20 }}>
          {editing === "new" ? "Add Customer" : "Edit Customer"}
        </div>
        <label style={S.lbl}>Customer Name</label>
        <input style={S.inp} value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="e.g. Macy's" autoFocus />
        <label style={S.lbl}>Channel Type</label>
        <select style={S.inp} value={form.channel} onChange={(e) => setForm(f => ({ ...f, channel: e.target.value }))}>
          <option value="">-- Select --</option>
          {CHANNEL_TYPES.map(c => <option key={c}>{c}</option>)}
        </select>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={() => { setEditing(null); setForm({ name: "", channel: "" }); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button disabled={!form.name.trim()} onClick={save} style={{ ...S.btn, opacity: form.name.trim() ? 1 : 0.5 }}>Save Customer</button>
        </div>
      </div>
    );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Customers ({customers.length})</span>
        <button onClick={() => { setForm({ name: "", channel: "" }); setEditing("new"); }} style={S.btn}>+ Add Customer</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {customers.map((c, i) => (
          <div key={i} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>{c.name || c}</div>
              {c.channel && <div style={{ fontSize: 11, color: TH.textMuted }}>{c.channel}</div>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setForm({ name: c.name || c, channel: c.channel || "" }); setEditing(i); }} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
              <button onClick={() => setCustomers((cs) => cs.filter((_, j) => j !== i))} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {customers.length === 0 && <div style={{ textAlign: "center", color: TH.textMuted, padding: "24px", fontSize: 13, border: `1px dashed ${TH.border}`, borderRadius: 10 }}>No customers yet.</div>}
    </div>
  );
}

// ─── ORDER TYPE MANAGER ──────────────────────────────────────────────────────
function OrderTypeManager({ orderTypes, setOrderTypes }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState("");

  function save() {
    const val = form.trim();
    if (!val) return;
    if (editing === "new") {
      setOrderTypes((s) => [...s, val]);
    } else {
      setOrderTypes((s) => s.map((x, i) => (i === editing ? val : x)));
    }
    setEditing(null);
    setForm("");
  }

  if (editing !== null)
    return (
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: TH.text, marginBottom: 20 }}>
          {editing === "new" ? "Add Order Type" : "Edit Order Type"}
        </div>
        <label style={S.lbl}>Order Type Name</label>
        <input
          style={S.inp}
          value={form}
          onChange={(e) => setForm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="e.g. At Once"
          autoFocus
        />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={() => { setEditing(null); setForm(""); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button disabled={!form.trim()} onClick={save} style={{ ...S.btn, opacity: form.trim() ? 1 : 0.5 }}>Save Order Type</button>
        </div>
      </div>
    );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Order Types ({orderTypes.length})</span>
        <button onClick={() => { setForm(""); setEditing("new"); }} style={S.btn}>+ Add Order Type</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {orderTypes.map((ot, i) => (
          <div key={i} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: TH.text }}>{ot}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setForm(ot); setEditing(i); }} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
              <button onClick={() => setOrderTypes((arr) => arr.filter((_, j) => j !== i))} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {orderTypes.length === 0 && <div style={{ textAlign: "center", color: TH.textMuted, padding: "24px", fontSize: 13, border: `1px dashed ${TH.border}`, borderRadius: 10 }}>No order types yet.</div>}
    </div>
  );
}

// ─── SEASON MANAGER ───────────────────────────────────────────────────────────
function SeasonManager({ seasons, setSeasons }) {
  const [editing, setEditing] = useState(null); // null | "new" | index
  const [form, setForm] = useState("");

  function save() {
    const val = form.trim();
    if (!val) return;
    if (editing === "new") {
      setSeasons((s) => [...s, val]);
    } else {
      setSeasons((s) => s.map((x, i) => (i === editing ? val : x)));
    }
    setEditing(null);
    setForm("");
  }

  if (editing !== null)
    return (
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: TH.text, marginBottom: 20 }}>
          {editing === "new" ? "Add Season" : "Edit Season"}
        </div>
        <label style={S.lbl}>Season Name</label>
        <input
          style={S.inp}
          value={form}
          onChange={(e) => setForm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="e.g. Spring, Summer, Fall, Holiday"
          autoFocus
        />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={() => { setEditing(null); setForm(""); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>
            Cancel
          </button>
          <button disabled={!form.trim()} onClick={save} style={{ ...S.btn, opacity: form.trim() ? 1 : 0.5 }}>
            Save Season
          </button>
        </div>
      </div>
    );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Seasons ({seasons.length})</span>
        <button onClick={() => { setForm(""); setEditing("new"); }} style={S.btn}>+ Add Season</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {seasons.map((s, i) => (
          <div key={i} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: TH.text }}>{s}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setForm(s); setEditing(i); }} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>
                Edit
              </button>
              <button
                onClick={() => setSeasons((ss) => ss.filter((_, j) => j !== i))}
                style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {seasons.length === 0 && (
        <div style={{ textAlign: "center", color: TH.textMuted, padding: "24px", fontSize: 13, border: `1px dashed ${TH.border}`, borderRadius: 10 }}>
          No seasons yet. Add one above.
        </div>
      )}
    </div>
  );
}

// ─── BRAND MANAGER ────────────────────────────────────────────────────────────
function BrandManager({ brands, setBrands }) {
  const BLANK = () => ({
    id: uid(),
    name: "",
    short: "",
    color: "#3498DB",
    isPrivateLabel: false,
  });
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  function save() {
    const b = {
      ...form,
      short: form.short.toUpperCase().slice(0, 5),
    };
    if (editing === "new") setBrands((bs) => [...bs, b]);
    else setBrands((bs) => bs.map((x) => (x.id === editing ? b : x)));
    setEditing(null);
    setForm(null);
  }

  if (editing)
    return (
      <div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: TH.text,
            marginBottom: 20,
          }}
        >
          {editing === "new" ? "Add Brand" : "Edit Brand"}
        </div>
        <label style={S.lbl}>Brand Name</label>
        <input
          style={S.inp}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Ring of Fire"
        />
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
        >
          <div>
            <label style={S.lbl}>Short Code (up to 5 chars)</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.short}
              onChange={(e) =>
                set("short", e.target.value.toUpperCase().slice(0, 5))
              }
              placeholder="ROF"
            />
          </div>
          <div>
            <label style={S.lbl}>Brand Color</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="color"
                value={form.color}
                onChange={(e) => set("color", e.target.value)}
                style={{
                  width: 44,
                  height: 38,
                  borderRadius: 6,
                  border: `1px solid ${TH.border}`,
                  cursor: "pointer",
                  padding: 2,
                }}
              />
              <input
                style={{ ...S.inp, marginBottom: 0, flex: 1 }}
                value={form.color}
                onChange={(e) => set("color", e.target.value)}
                placeholder="#3498DB"
              />
            </div>
          </div>
        </div>
        <div style={{ height: 14 }} />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: TH.surfaceHi,
            borderRadius: 8,
            border: `1px solid ${form.isPrivateLabel ? TH.primary : TH.border}`,
            cursor: "pointer",
            marginBottom: 20,
          }}
        >
          <input
            type="checkbox"
            checked={form.isPrivateLabel}
            onChange={(e) => set("isPrivateLabel", e.target.checked)}
            style={{ accentColor: TH.primary }}
          />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: TH.text }}>
              Private Label
            </div>
            <div style={{ fontSize: 11, color: TH.textMuted }}>
              Enables Line Review & Compliance/Testing phases
            </div>
          </div>
        </label>
        {/* Color preview */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            background: form.color + "12",
            border: `1px solid ${form.color}44`,
            borderRadius: 10,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: form.color,
              flexShrink: 0,
            }}
          />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>
              {form.name || "Brand Name"}
            </div>
            <div style={{ fontSize: 12, color: TH.textMuted }}>
              {form.short || "CODE"}
              {form.isPrivateLabel ? " · Private Label" : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={() => {
              setEditing(null);
              setForm(null);
            }}
            style={{
              padding: "9px 18px",
              borderRadius: 8,
              border: `1px solid ${TH.border}`,
              background: "none",
              color: TH.textMuted,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            disabled={!form.name || !form.short}
            onClick={save}
            style={{ ...S.btn, opacity: form.name && form.short ? 1 : 0.5 }}
          >
            Save Brand
          </button>
        </div>
      </div>
    );

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <span style={S.sec}>Brands ({brands.length})</span>
        <button
          onClick={() => {
            setForm(BLANK());
            setEditing("new");
          }}
          style={S.btn}
        >
          + Add Brand
        </button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {brands.map((b) => (
          <div
            key={b.id}
            style={{
              ...S.card,
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: "50%",
                background: b.color + "22",
                border: `2px solid ${b.color}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 800,
                fontSize: 12,
                color: b.color,
                flexShrink: 0,
              }}
            >
              {b.short}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>
                {b.name}
              </div>
              <div style={{ fontSize: 11, color: TH.textMuted }}>
                Code: <strong>{b.short}</strong>
                {b.isPrivateLabel && (
                  <span
                    style={{ marginLeft: 8, color: "#7C3AED", fontWeight: 600 }}
                  >
                    · Private Label
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  setForm({ ...b });
                  setEditing(b.id);
                }}
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: `1px solid ${TH.border}`,
                  background: "none",
                  color: TH.textMuted,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                Edit
              </button>
              <button
                onClick={() =>
                  setBrands((bs) => bs.filter((x) => x.id !== b.id))
                }
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: "1px solid #FCA5A5",
                  background: "none",
                  color: "#B91C1C",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {brands.length === 0 && (
        <div
          style={{
            textAlign: "center",
            color: TH.textMuted,
            padding: "24px",
            fontSize: 13,
            border: `1px dashed ${TH.border}`,
            borderRadius: 10,
          }}
        >
          No brands yet. Add one above.
        </div>
      )}
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ users, onLogin, teamsConfig, onTeamsToken }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [teamsAuthStatus, setTeamsAuthStatus] = useState("idle"); // idle|loading|ok|skipped

  async function doTeamsAuth(user) {
    const cfg = teamsConfig;
    if (!cfg || !cfg.clientId || !cfg.tenantId || !user.teamsEmail) {
      onLogin(user);
      return;
    }
    setTeamsAuthStatus("loading");
    try {
      const scopes = [
        "https://graph.microsoft.com/ChannelMessage.Read.All",
        "https://graph.microsoft.com/Team.ReadBasic.All",
        "https://graph.microsoft.com/Channel.ReadBasic.All",
        "https://graph.microsoft.com/ChannelMessage.Send",
      ];
      const authUrl =
        "https://login.microsoftonline.com/" + cfg.tenantId + "/oauth2/v2.0/authorize?" +
        "client_id=" + cfg.clientId +
        "&response_type=token" +
        "&redirect_uri=" + encodeURIComponent(window.location.origin + "/auth-callback") +
        "&scope=" + encodeURIComponent(scopes.join(" ")) +
        "&login_hint=" + encodeURIComponent(user.teamsEmail) +
        "&response_mode=fragment";
      const popup = window.open(authUrl, "msauth", "width=500,height=700,left=400,top=100");
      const token = await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          try {
            if (popup.closed) { clearInterval(timer); reject(new Error("Closed")); return; }
            const hash = popup.location.hash;
            if (hash && hash.includes("access_token")) {
              clearInterval(timer); popup.close();
              resolve(new URLSearchParams(hash.substring(1)).get("access_token"));
            }
          } catch (_) {}
        }, 300);
        setTimeout(() => { clearInterval(timer); if (!popup.closed) popup.close(); reject(new Error("Timeout")); }, 120000);
      });
      onTeamsToken(token);
      setTeamsAuthStatus("ok");
    } catch (e) {
      setTeamsAuthStatus("skipped");
    }
    onLogin(user);
  }

  function handleLogin() {
    const user = users.find(
      (u) =>
        u.username.toLowerCase() === username.trim().toLowerCase() && u.password === password
    );
    if (user) {
      setError("");
      doTeamsAuth(user);
    } else setError("Invalid username or password.");
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: TH.header,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'DM Sans',sans-serif",
      }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;}`}</style>
      <div style={{ width: "100%", maxWidth: 400, padding: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <ROFLogoFull height={52} />
          </div>
          <div
            style={{
              marginTop: 14,
              fontSize: 20,
              fontWeight: 800,
              color: "#fff",
              letterSpacing: "-0.01em",
            }}
          >
            Design Calendar
          </div>
          <div
            style={{
              fontSize: 12,
              color: "rgba(255,255,255,0.4)",
              marginTop: 4,
            }}
          >
            Sign In to Continue
          </div>
        </div>
        <div
          style={{
            background: TH.surface,
            borderRadius: 16,
            padding: 32,
            boxShadow: `0 20px 60px rgba(0,0,0,0.35)`,
          }}
        >
          <div style={{ marginBottom: 18 }}>
            <label style={S.lbl}>Username</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              placeholder="Enter username"
              autoFocus
            />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={S.lbl}>Password</label>
            <div style={{ position: "relative" }}>
              <input
                type={showPassword ? "text" : "password"}
                style={{ ...S.inp, marginBottom: 0, paddingRight: 40 }}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                placeholder="Enter password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                style={{
                  position: "absolute",
                  right: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 4,
                  color: TH.textMuted,
                  fontSize: 16,
                  lineHeight: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                tabIndex={-1}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "🙈" : "👁"}
              </button>
            </div>
          </div>
          {error && (
            <div
              style={{
                padding: "8px 12px",
                background: "#FEF2F2",
                border: "1px solid #FCA5A5",
                borderRadius: 8,
                color: "#B91C1C",
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}
          {teamsAuthStatus === "loading" && (
            <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "#1E40AF" }}>
              <span style={{ fontSize: 16 }}>💬</span>
              <span>Signing in to Microsoft Teams… <b>Please complete the popup.</b></span>
            </div>
          )}
          <button
            onClick={handleLogin}
            disabled={teamsAuthStatus === "loading"}
            style={{ ...S.btn, width: "100%", padding: "12px", fontSize: 15, opacity: teamsAuthStatus === "loading" ? 0.6 : 1 }}
          >
            {teamsAuthStatus === "loading" ? "Signing in…" : "Sign In →"}
          </button>
          {teamsConfig && teamsConfig.clientId && (
            <div style={{ marginTop: 12, textAlign: "center", fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
              💬 Microsoft Teams will be connected automatically
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── USER MANAGER (admin only) ───────────────────────────────────────────────
function UserManager({ users, setUsers, team, setTeam, isAdmin, currentUser }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const [createTeamMember, setCreateTeamMember] = useState(false);
  const [tmRole, setTmRole] = useState(ROLES[0]);
  const [tmColor, setTmColor] = useState("#3498DB");
  const [newRoleInput, setNewRoleInput] = useState("");
  const [availableRoles, setAvailableRoles] = useState([...ROLES]);
  const TEAM_COLORS = ["#E74C3C","#3498DB","#2ECC71","#9B59B6","#F39C12","#1ABC9C","#E67E22","#E91E63","#00BCD4","#8BC34A"];
  const BLANK = () => ({ id: uid(), username: "", password: "", name: "", role: "user", color: "#3498DB", initials: "", teamMemberId: null, teamsEmail: "", permissions: { view_all: false, edit_all: false, view_own: true, edit_own: true } });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setPerm = (k, v) => setForm((f) => ({ ...f, permissions: { ...f.permissions, [k]: v } }));

  function save() {
    const initials = form.name.split(" ").map((w) => w[0] || "").join("").toUpperCase().slice(0, 2);
    let teamMemberId = form.teamMemberId;
    if (editing === "new" && createTeamMember) {
      const newMember = { id: uid(), name: form.name, role: tmRole, initials, color: tmColor, avatar: null };
      setTeam((t) => [...t, newMember]);
      teamMemberId = newMember.id;
    }
    const u = { ...form, initials, teamMemberId };
    if (editing === "new") setUsers((us) => [...us, u]);
    else setUsers((us) => us.map((x) => (x.id === editing ? u : x)));
    setEditing(null); setForm(null); setCreateTeamMember(false); setTmRole(ROLES[0]); setTmColor("#3498DB");
  }

  function addRoleOnTheFly() {
    const trimmed = newRoleInput.trim();
    if (!trimmed || availableRoles.includes(trimmed)) return;
    setAvailableRoles((r) => [...r, trimmed]);
    setTmRole(trimmed);
    setNewRoleInput("");
  }

  if (!isAdmin) return (
    <div style={{ padding: 32, textAlign: "center", color: TH.textMuted }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: TH.textSub }}>Admin access required</div>
      <div style={{ fontSize: 13, marginTop: 6 }}>Only admins can manage users.</div>
    </div>
  );

  if (editing) return (
    <div>
      <label style={S.lbl}>Full Name</label>
      <input style={S.inp} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Full name" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <label style={S.lbl}>Username</label>
          <input style={{ ...S.inp, marginBottom: 0 }} value={form.username} onChange={(e) => set("username", e.target.value)} placeholder="username" />
        </div>
        <div>
          <label style={S.lbl}>Password</label>
          <input style={{ ...S.inp, marginBottom: 0 }} value={form.password} onChange={(e) => set("password", e.target.value)} placeholder="password" />
        </div>
      </div>
      <div style={{ height: 14 }} />
      <label style={S.lbl}>Microsoft Teams Email</label>
      <input style={S.inp} value={form.teamsEmail || ""} onChange={(e) => set("teamsEmail", e.target.value)} placeholder="user@ringoffireclothing.com (optional — enables auto Teams login)" />
      <label style={S.lbl}>System Role</label>
      <select style={S.inp} value={form.role} onChange={(e) => set("role", e.target.value)}>
        <option value="admin">Admin (full access)</option>
        <option value="user">User (restricted)</option>
      </select>
      {editing === "new" && (
        <div style={{ border: `1px solid ${createTeamMember ? TH.primary : TH.border}`, borderRadius: 10, padding: "12px 14px", marginBottom: 14, background: createTeamMember ? TH.accent : TH.surfaceHi, transition: "all 0.15s" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: createTeamMember ? 14 : 0 }}>
            <input type="checkbox" checked={createTeamMember} onChange={(e) => setCreateTeamMember(e.target.checked)} style={{ accentColor: TH.primary, width: 16, height: 16 }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: TH.textSub }}>Also create as Team Member</span>
          </label>
          {createTeamMember && (
            <div>
              <label style={S.lbl}>Team Role</label>
              <select style={{ ...S.inp, marginBottom: 12 }} value={tmRole} onChange={(e) => setTmRole(e.target.value)}>
                {availableRoles.map((r) => <option key={r}>{r}</option>)}
              </select>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input style={{ ...S.inp, marginBottom: 0, flex: 1 }} value={newRoleInput} onChange={(e) => setNewRoleInput(e.target.value)} placeholder="Add new role…" onKeyDown={(e) => e.key === "Enter" && addRoleOnTheFly()} />
                <button onClick={addRoleOnTheFly} disabled={!newRoleInput.trim()} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: TH.primary, color: "#fff", cursor: newRoleInput.trim() ? "pointer" : "not-allowed", fontFamily: "inherit", fontSize: 12, fontWeight: 700, opacity: newRoleInput.trim() ? 1 : 0.5, whiteSpace: "nowrap" }}>+ Add Role</button>
              </div>
              <label style={S.lbl}>Member Color</label>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 4 }}>
                {TEAM_COLORS.map((c) => <div key={c} onClick={() => setTmColor(c)} style={{ width: 26, height: 26, borderRadius: "50%", background: c, cursor: "pointer", border: `3px solid ${tmColor === c ? "#1A202C" : "transparent"}` }} />)}
              </div>
            </div>
          )}
        </div>
      )}
      {!(editing === "new" && createTeamMember) && (
        <>
          <label style={S.lbl}>Link to Team Member</label>
          <select style={S.inp} value={form.teamMemberId || ""} onChange={(e) => set("teamMemberId", e.target.value || null)}>
            <option value="">-- None --</option>
            {team.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
          </select>
        </>
      )}
      {form.role === "user" && (
        <>
          <label style={S.lbl}>Permissions</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            {[["view_all","View All Collections"],["edit_all","Edit All Tasks"],["view_own","View Own Tasks Only"],["edit_own","Edit Own Tasks"]].map(([k, label]) => (
              <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: TH.surfaceHi, borderRadius: 8, cursor: "pointer", border: `1px solid ${form.permissions?.[k] ? TH.primary : TH.border}` }}>
                <input type="checkbox" checked={!!form.permissions?.[k]} onChange={(e) => setPerm(k, e.target.checked)} style={{ accentColor: TH.primary }} />
                <span style={{ fontSize: 12, color: TH.textSub }}>{label}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={() => { setEditing(null); setForm(null); setCreateTeamMember(false); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button disabled={!form.name || !form.username} onClick={save} style={{ ...S.btn, opacity: form.name && form.username ? 1 : 0.5 }}>Save User</button>
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Users ({users.length})</span>
        <button onClick={() => { setForm(BLANK()); setEditing("new"); setCreateTeamMember(false); }} style={S.btn}>+ Add User</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {users.map((u) => (
          <div key={u.id} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: u.color + "22", border: `2px solid ${u.color}`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, color: u.color, flexShrink: 0 }}>{u.initials}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>{u.name}</div>
              <div style={{ fontSize: 12, color: TH.textMuted }}>
                @{u.username} · <span style={{ color: u.role === "admin" ? TH.primary : "#6D28D9", fontWeight: 600 }}>{u.role}</span>
                {u.teamMemberId && <span style={{ color: "#059669", marginLeft: 6 }}>· 👥 team member</span>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setForm({ ...u, permissions: u.permissions || { view_own: true, edit_own: true } }); setEditing(u.id); }} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
              <button onClick={() => setUsers((us) => us.filter((x) => x.id !== u.id))} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ─── SMALL COMPONENTS ─────────────────────────────────────────────────────────
function Avatar({ member, size = 28 }) {
  if (!member) return null;
  return member.avatar ? (
    <img
      src={member.avatar}
      alt={member.name}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        objectFit: "cover",
        border: `2px solid ${member.color}`,
        flexShrink: 0,
      }}
    />
  ) : (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: member.color + "22",
        border: `2px solid ${member.color}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.38,
        fontWeight: 700,
        color: member.color,
        flexShrink: 0,
      }}
    >
      {member.initials}
    </div>
  );
}

function Modal({ title, onClose, children, wide, extraWide }) {
  const mw = extraWide ? 980 : wide ? 740 : 540;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        style={{
          background: TH.surface,
          border: `1px solid ${TH.border}`,
          borderRadius: 18,
          padding: 32,
          width: "100%",
          maxWidth: mw,
          maxHeight: "93vh",
          overflowY: "auto",
          boxShadow: `0 40px 100px rgba(0,0,0,0.4)`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 26,
          }}
        >
          <span
            style={{
              fontSize: 19,
              fontWeight: 700,
              color: TH.text,
              letterSpacing: "0.02em",
            }}
          >
            {title}
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: TH.textMuted,
              cursor: "pointer",
              fontSize: 26,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = "Accept",
  danger,
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 16,
      }}
    >
      <div
        style={{
          background: TH.surface,
          border: `1px solid ${danger ? "#FCA5A5" : TH.border}`,
          borderRadius: 16,
          padding: 32,
          maxWidth: 440,
          width: "100%",
          boxShadow: `0 40px 100px rgba(0,0,0,0.4)`,
        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: TH.text,
            marginBottom: 12,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 13,
            color: TH.textMuted,
            lineHeight: 1.6,
            marginBottom: 28,
          }}
          dangerouslySetInnerHTML={{ __html: message }}
        />
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: `1px solid ${TH.border}`,
              background: "none",
              color: TH.textMuted,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: "10px 24px",
              borderRadius: 8,
              border: "none",
              background: danger
                ? `linear-gradient(135deg,#C0392B,#E74C3C)`
                : S.btn.background,
              color: "#fff",
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImageUploader({ images = [], onChange, label = "Images" }) {
  const fileRef = useRef();
  const focusStealRef = useRef<HTMLButtonElement>(null);
  const [urlInput, setUrlInput] = useState("");
  const [draggingOver, setDraggingOver] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  // Keep a ref to track pending uploads so we can update the parent correctly
  const pendingImagesRef = useRef([]);

  async function handleFiles(files) {
    const validFiles = Array.from(files).filter(f =>
      f.type.startsWith("image/") || f.name.match(/\.(pdf|ai|eps|psd|png|jpg|jpeg|gif|webp|svg)$/i)
    );
    if (!validFiles.length) return;

    // Step 1: immediately add placeholders so user can keep working
    const newImgs = [];
    for (const f of validFiles) {
      const isImg = f.type.startsWith("image/");
      const preview = isImg ? await fileToDataURL(f) : null;
      newImgs.push({ id: uid(), src: preview || "", name: f.name, type: "uploading", file: f });
    }

    const combined = [...images, ...newImgs];
    pendingImagesRef.current = combined;
    onChange(combined);
    if (fileRef.current) fileRef.current.value = "";
    setUploadingCount(c => c + newImgs.length);

    // Step 2: upload each file to Dropbox in the background
    for (const img of newImgs) {
      (async () => {
        try {
          const dbxUrl = await dbxUploadFileGlobal(img.file, "images");
          // Update the ref and call onChange with a plain array (no function updater)
          pendingImagesRef.current = pendingImagesRef.current.map(i =>
            i.id === img.id
              ? { id: i.id, src: dbxUrl || i.src, name: i.name, type: dbxUrl ? "dropbox" : "base64" }
              : i
          );
          onChange(pendingImagesRef.current);
        } catch (e) {
          console.warn("Background upload error:", e);
          // On error, mark as base64 (already has preview)
          pendingImagesRef.current = pendingImagesRef.current.map(i =>
            i.id === img.id ? { ...i, type: "base64", file: undefined } : i
          );
          onChange(pendingImagesRef.current);
        } finally {
          setUploadingCount(c => Math.max(0, c - 1));
        }
      })();
    }
  }
  function addUrl() {
    if (!urlInput.trim()) return;
    onChange([
      ...images,
      { id: uid(), src: urlInput.trim(), name: "URL Image" },
    ]);
    setUrlInput("");
  }
  function onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(true);
  }
  function onDragLeave(e) {
    e.preventDefault();
    setDraggingOver(false);
  }
  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(false);
    // Immediately steal focus back from the OS file manager
    // by focusing a real DOM element synchronously before any async work
    if (focusStealRef.current) {
      focusStealRef.current.focus();
      focusStealRef.current.blur();
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length) handleFiles(files);
  }
  return (
    <div style={{ marginBottom: 16 }}>
      {/* Hidden button used to steal focus back from OS file manager after drag-drop */}
      <button
        ref={focusStealRef}
        style={{
          position: "absolute",
          opacity: 0,
          pointerEvents: "none",
          width: 0,
          height: 0,
          padding: 0,
          border: "none",
        }}
        tabIndex={-1}
        aria-hidden="true"
      />
      <label style={S.lbl}>{label}</label>
      {images.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 10,
          }}
        >
          {images.map((img) => {
            const isImage = img.name?.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i) || img.src?.startsWith("data:image");
            const ext = (img.name || "").split(".").pop()?.toUpperCase() || "FILE";
            const fileIcons = { PDF: "📄", AI: "🎨", EPS: "🎨", PSD: "🖼️", SVG: "🔷" };
            const icon = fileIcons[ext] || "📎";
            return (
            <div
              key={img.id}
              style={{ position: "relative", width: 80, height: 80 }}
            >
              {isImage ? (
              <div style={{ position: "relative", width: "100%", height: "100%" }}>
                <img
                  src={img.src}
                  alt={img.name}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    borderRadius: 8,
                    border: `1px solid ${TH.border}`,
                    opacity: img.type === "uploading" ? 0.4 : 1,
                  }}
                />
                {img.type === "uploading" && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, fontSize: 16 }}>⏳</div>
                )}
              </div>
              ) : img.type === "uploading" ? (
              <div style={{ width: "100%", height: "100%", borderRadius: 8, border: `1px solid ${TH.border}`, display: "flex", alignItems: "center", justifyContent: "center", background: TH.surfaceHi, fontSize: 20 }}>⏳</div>
              ) : (
              <a href={img.src} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <div style={{
                  width: "100%", height: "100%", borderRadius: 8,
                  border: `1px solid ${TH.border}`, display: "flex",
                  flexDirection: "column", alignItems: "center", justifyContent: "center",
                  background: TH.surfaceHi, cursor: "pointer", fontSize: 24,
                }}>
                  <div>{icon}</div>
                  <div style={{ fontSize: 9, color: TH.textMuted, marginTop: 2 }}>{ext}</div>
                </div>
              </a>
              )}
              <button
                onClick={() => onChange(images.filter((i) => i.id !== img.id))}
                style={{
                  position: "absolute",
                  top: -6,
                  right: -6,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "#FEF2F2",
                  border: "none",
                  color: "#B91C1C",
                  fontSize: 12,
                  lineHeight: "18px",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                ×
              </button>
            </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          style={{ ...S.inp, marginBottom: 0, flex: 1 }}
          placeholder="Paste image URL..."
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addUrl()}
        />
        <button
          onClick={addUrl}
          style={{
            padding: "9px 14px",
            borderRadius: 8,
            border: `1px solid ${TH.border}`,
            background: TH.surfaceHi,
            color: TH.text,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Add URL
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,.pdf,.ai,.eps,.psd,.svg"
        multiple
        style={{ display: "none" }}
        onChange={(e) => handleFiles(Array.from(e.target.files))}
      />
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          width: "100%",
          padding: "18px",
          borderRadius: 8,
          border: `2px dashed ${draggingOver ? TH.primary : TH.border}`,
          background: draggingOver ? TH.primary + "08" : "transparent",
          color: draggingOver ? TH.primary : TH.textMuted,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 13,
          textAlign: "center",
          transition: "all 0.15s",
        }}
        onClick={() => fileRef.current.click()}
      >
        {draggingOver ? "Drop files here" : "📁 Upload or Drag & Drop (Images, PDF, AI, PSD)"}
      </div>
      {uploadingCount > 0 && (
        <div style={{ fontSize: 11, color: TH.primary, marginTop: 6, textAlign: "center", display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: TH.primary, animation: "pulse 1s infinite" }} />
          Uploading {uploadingCount} file{uploadingCount > 1 ? "s" : ""} to Dropbox in background…
        </div>
      )}
    </div>
  );
}

function ContextMenu({ x, y, items, onClose }) {
  useEffect(() => {
    const h = () => onClose();
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed",
        left: x,
        top: y,
        background: TH.surface,
        border: `1px solid ${TH.border}`,
        borderRadius: 10,
        padding: "6px 0",
        zIndex: 3000,
        minWidth: 180,
        boxShadow: `0 16px 40px ${TH.shadowMd}`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item === "---" ? (
          <div
            key={i}
            style={{ height: 1, background: TH.border, margin: "4px 0" }}
          />
        ) : (
          <button
            key={i}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "9px 16px",
              background: "none",
              border: "none",
              color: item.danger ? "#B91C1C" : TH.text,
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "inherit",
              textAlign: "left",
            }}
            onMouseEnter={(e) => (e.target.style.background = TH.surfaceHi)}
            onMouseLeave={(e) => (e.target.style.background = "none")}
          >
            {item.icon} {item.label}
          </button>
        )
      )}
    </div>
  );
}

// ─── DATE INPUT (click anywhere opens picker) ────────────────────────────────
function DateInput({ value, onChange, onBlur, style, disabled, min }) {
  const ref = useRef();
  return (
    <input
      ref={ref}
      type="date"
      value={value || ""}
      min={min}
      onChange={(e) => onChange && onChange(e.target.value)}
      onBlur={(e) => onBlur && onBlur(e.target.value)}
      disabled={disabled}
      onClick={() => {
        if (disabled || !ref.current) return;
        try {
          ref.current.showPicker();
        } catch (e) {}
      }}
      style={{ ...style, cursor: disabled ? "default" : "pointer" }}
    />
  );
}

// ─── VENDOR FORM ──────────────────────────────────────────────────────────────
function VendorForm({ vendor, onSave, onCancel }) {
  const [f, setF] = useState(
    vendor || {
      id: uid(),
      name: "",
      country: "",
      transitDays: 21,
      categories: [],
      contact: "",
      email: "",
      moq: 0,
      lead: {
        Concept: 168,
        Design: 154,
        "Tech Pack": 140,
        Costing: 126,
        Sampling: 112,
        Revision: 84,
        "Purchase Order": 70,
        Production: 42,
        QC: 14,
        "Ship Date": 0,
        DDP: 0,
      },
    }
  );
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setL = (k, v) =>
    setF((x) => ({ ...x, lead: { ...x.lead, [k]: parseInt(v) || 0 } }));
  const toggleCat = (c) =>
    setF((x) => ({
      ...x,
      categories: x.categories.includes(c)
        ? x.categories.filter((x) => x !== c)
        : [...x.categories, c],
    }));
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <label style={S.lbl}>Vendor Name *</label>
          <input
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Factory name"
          />
        </div>
        <div>
          <label style={S.lbl}>Country</label>
          <input
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.country}
            onChange={(e) => set("country", e.target.value)}
            placeholder="e.g. China"
          />
        </div>
      </div>
      <div style={{ height: 14 }} />
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}
      >
        <div>
          <label style={S.lbl}>Transit Days</label>
          <input
            type="number"
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.transitDays}
            onChange={(e) => set("transitDays", parseInt(e.target.value) || 0)}
          />
        </div>
        <div>
          <label style={S.lbl}>MOQ</label>
          <input
            type="number"
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.moq}
            onChange={(e) => set("moq", parseInt(e.target.value) || 0)}
          />
        </div>
        <div>
          <label style={S.lbl}>Contact Email</label>
          <input
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </div>
      </div>
      <div style={{ height: 14 }} />
      <label style={S.lbl}>Contact Name</label>
      <input
        style={S.inp}
        value={f.contact}
        onChange={(e) => set("contact", e.target.value)}
      />
      <label style={S.lbl}>Category Specialties</label>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 16 }}
      >
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => toggleCat(c)}
            style={{
              padding: "4px 12px",
              borderRadius: 16,
              border: `1px solid ${
                f.categories.includes(c) ? TH.primary : TH.border
              }`,
              background: f.categories.includes(c)
                ? TH.primary + "15"
                : "transparent",
              color: f.categories.includes(c) ? TH.primary : TH.textMuted,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          >
            {c}
          </button>
        ))}
      </div>
      <span style={S.sec}>Lead Times (days before DDP)</span>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: 10,
          marginBottom: 20,
        }}
      >
        {[
          "Concept",
          "Design",
          "Tech Pack",
          "Costing",
          "Sampling",
          "Revision",
          "Purchase Order",
          "Production",
          "QC",
        ].map((phase) => (
          <div key={phase}>
            <div style={{ fontSize: 10, color: TH.textMuted, marginBottom: 3 }}>
              {phase}
            </div>
            <input
              type="number"
              style={{ ...S.inp, marginBottom: 0, padding: "7px 10px" }}
              value={f.lead[phase] || 0}
              onChange={(e) => setL(phase, e.target.value)}
            />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            border: `1px solid ${TH.border}`,
            background: "none",
            color: TH.textMuted,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Cancel
        </button>
        <button
          disabled={!f.name}
          onClick={() => onSave(f)}
          style={{ ...S.btn, opacity: f.name ? 1 : 0.4 }}
        >
          Save Vendor
        </button>
      </div>
    </div>
  );
}

function VendorManager({ vendors, setVendors }) {
  const fileRef = useRef();
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = window.XLSX.read(ev.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, {
          header: 1,
          defval: "",
        });
        const hi = rows.findIndex((r) =>
          r.some((c) => String(c).trim() === "Vendor Name")
        );
        if (hi < 0) {
          setMsg({ t: "err", m: "Can't find 'Vendor Name' header." });
          return;
        }
        const hdrs = rows[hi].map((h) => String(h).trim());
        const col = (n) => hdrs.indexOf(n);
        const parsed = [];
        for (let i = hi + 1; i < rows.length; i++) {
          const r = rows[i],
            name = String(r[col("Vendor Name")] || "").trim();
          if (!name) continue;
          const exist = vendors.find(
            (v) => v.name.toLowerCase() === name.toLowerCase()
          );
          parsed.push({
            id: exist ? exist.id : uid(),
            name,
            country: String(r[col("Country of Origin")] || "").trim(),
            transitDays: parseInt(r[col("Transit Days (to US)")]) || 21,
            categories: String(r[col("Category Specialties")] || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            contact: String(r[col("Contact Name")] || "").trim(),
            email: String(r[col("Contact Email")] || "").trim(),
            moq: parseInt(r[col("MOQ")]) || 0,
            _up: !!exist,
            lead: {
              Concept: parseFloat(r[col("Concept (days)")]) || 168,
              Design: parseFloat(r[col("Design (days)")]) || 154,
              "Tech Pack": parseFloat(r[col("Tech Pack (days)")]) || 140,
              Costing: parseFloat(r[col("Costing (days)")]) || 126,
              Sampling: parseFloat(r[col("Sampling (days)")]) || 112,
              Revision: parseFloat(r[col("Revision (days)")]) || 84,
              "Purchase Order":
                parseFloat(
                  r[col("Purchase Order (days)")] || r[col("Bulk Order (days)")]
                ) || 70,
              Production: parseFloat(r[col("Production (days)")]) || 42,
              QC: parseFloat(r[col("QC (days)")]) || 14,
              "Ship Date": 0,
              DDP: 0,
            },
          });
        }
        const added = parsed.filter((v) => !v._up).length,
          updated = parsed.filter((v) => v._up).length;
        setVendors((vs) => {
          const names = parsed.map((v) => v.name.toLowerCase());
          return [
            ...vs.filter((v) => !names.includes(v.name.toLowerCase())),
            ...parsed.map((v) => ({ ...v, _up: undefined })),
          ];
        });
        setMsg({ t: "ok", m: `✓ ${added} added, ${updated} updated.` });
      } catch (err) {
        setMsg({ t: "err", m: "Parse error: " + err.message });
      }
    };
    reader.readAsArrayBuffer(file);
  }

  if (editing === "new")
    return (
      <div>
        <div style={{ fontSize: 13, color: TH.textMuted, marginBottom: 20 }}>
          Add New Vendor
        </div>
        <VendorForm
          onSave={(v) => {
            setVendors((vs) => [...vs, { ...v, id: uid() }]);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  if (editing) {
    const v = vendors.find((x) => x.id === editing);
    return (
      <div>
        <div style={{ fontSize: 13, color: TH.textMuted, marginBottom: 20 }}>
          Edit Vendor
        </div>
        <VendorForm
          vendor={v}
          onSave={(u) => {
            setVendors((vs) => vs.map((x) => (x.id === editing ? u : x)));
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  const visible = vendors.filter(
    (v) =>
      !search ||
      v.name.toLowerCase().includes(search.toLowerCase()) ||
      v.country.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div>
      <div style={{ ...S.card, marginBottom: 18 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: TH.text,
                marginBottom: 3,
              }}
            >
              Upload Vendor Excel
            </div>
            <div style={{ fontSize: 12, color: TH.textMuted }}>
              Use the template below — adds new vendors, updates existing by
              name.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                if (!window.XLSX) {
                  alert("XLSX library loading, try again.");
                  return;
                }
                const headers = [
                  "Vendor Name",
                  "Country of Origin",
                  "Transit Days (to US)",
                  "MOQ",
                  "Contact Name",
                  "Contact Email",
                  "Category Specialties",
                  "Sub-Categories",
                  "Concept (days)",
                  "Design (days)",
                  "Tech Pack (days)",
                  "Costing (days)",
                  "Sampling (days)",
                  "Revision (days)",
                  "Purchase Order (days)",
                  "Production (days)",
                  "QC (days)",
                ];
                const example = [
                  "Blue Star Apparel",
                  "China",
                  "21",
                  "500",
                  "Wei Chen",
                  "wei@bluestar.cn",
                  "Denim, Shorts",
                  "Slim Fit, Cargo",
                  "168",
                  "154",
                  "140",
                  "126",
                  "112",
                  "84",
                  "70",
                  "42",
                  "14",
                ];
                const ws = window.XLSX.utils.aoa_to_sheet([headers, example]);
                ws["!cols"] = headers.map(() => ({ wch: 22 }));
                const wb = window.XLSX.utils.book_new();
                window.XLSX.utils.book_append_sheet(wb, ws, "Vendors");
                window.XLSX.writeFile(wb, "ROF_Vendor_Template.xlsx");
              }}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${TH.primary}`,
                background: TH.primary + "10",
                color: TH.primary,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              ⬇ Download Template
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: "none" }}
              onChange={handleFile}
            />
            <button
              onClick={() => fileRef.current.click()}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${TH.border}`,
                background: TH.surfaceHi,
                color: TH.text,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              📂 Upload Excel
            </button>
          </div>
        </div>
        {msg && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 14px",
              borderRadius: 8,
              background: msg.t === "ok" ? "#ECFDF5" : "#FEF2F2",
              color: msg.t === "ok" ? "#047857" : "#B91C1C",
              fontSize: 13,
            }}
          >
            {msg.m}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
          gap: 12,
        }}
      >
        <input
          style={{ ...S.inp, marginBottom: 0, flex: 1 }}
          placeholder="Search vendors..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          onClick={() => setEditing("new")}
          style={{ ...S.btn, whiteSpace: "nowrap", flexShrink: 0 }}
        >
          + Add Vendor
        </button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {visible.map((v) => (
          <div
            key={v.id}
            style={{
              ...S.card,
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
            }}
          >
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: TH.text,
                  marginBottom: 2,
                }}
              >
                {v.name}
              </div>
              <div style={{ fontSize: 12, color: TH.textMuted }}>
                🌏 {v.country} · Transit {v.transitDays}d · MOQ{" "}
                {v.moq?.toLocaleString()} · {v.contact}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginTop: 6,
                  flexWrap: "wrap",
                }}
              >
                {v.categories.map((c) => (
                  <span
                    key={c}
                    style={{
                      fontSize: 11,
                      padding: "2px 9px",
                      borderRadius: 10,
                      background: TH.surfaceHi,
                      border: `1px solid ${TH.border}`,
                      color: TH.textSub2,
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => setEditing(v.id)}
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: `1px solid ${TH.border}`,
                  background: "none",
                  color: TH.textMuted,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                Edit
              </button>
              <button
                onClick={() =>
                  setVendors((vs) => vs.filter((x) => x.id !== v.id))
                }
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: "1px solid #FCA5A5",
                  background: "none",
                  color: "#B91C1C",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: TH.textMuted,
              padding: "24px",
              fontSize: 13,
            }}
          >
            No vendors found.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TEAM MANAGER ─────────────────────────────────────────────────────────────
function TeamManager({ team, setTeam, isAdmin }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const [availableRoles, setAvailableRoles] = useState([...ROLES]);
  const [newRoleInput, setNewRoleInput] = useState("");
  const fileRef = useRef();
  const COLORS = ["#E74C3C","#3498DB","#2ECC71","#9B59B6","#F39C12","#1ABC9C","#E67E22","#E91E63","#00BCD4","#8BC34A"];

  function openNew() { setForm({ id: uid(), name: "", role: availableRoles[0] || ROLES[0], initials: "", color: "#E74C3C", avatar: null }); setEditing("new"); }
  function openEdit(m) { setForm({ ...m }); setEditing(m.id); }
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function handleAvatar(e) { const f = e.target.files[0]; if (!f) return; set("avatar", await fileToDataURL(f)); }
  function save() {
    if (editing === "new") setTeam((t) => [...t, form]);
    else setTeam((t) => t.map((m) => (m.id === editing ? form : m)));
    setEditing(null); setForm(null); setNewRoleInput("");
  }
  function addRoleOnTheFly() {
    const trimmed = newRoleInput.trim();
    if (!trimmed || availableRoles.includes(trimmed)) return;
    setAvailableRoles((r) => [...r, trimmed]);
    set("role", trimmed);
    setNewRoleInput("");
  }

  if (!isAdmin) return (
    <div style={{ padding: 32, textAlign: "center", color: TH.textMuted }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: TH.textSub }}>Admin access required</div>
      <div style={{ fontSize: 13, marginTop: 6 }}>Only admins can manage team members.</div>
    </div>
  );

  if (editing) return (
    <div>
      <label style={S.lbl}>Name</label>
      <input style={S.inp} value={form.name} onChange={(e) => { set("name", e.target.value); set("initials", e.target.value.split(" ").map((w) => w[0] || "").join("").toUpperCase().slice(0, 2)); }} placeholder="Full name" />
      <label style={S.lbl}>Role</label>
      <select style={S.inp} value={form.role} onChange={(e) => set("role", e.target.value)}>
        {availableRoles.map((r) => <option key={r}>{r}</option>)}
      </select>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input style={{ ...S.inp, marginBottom: 0, flex: 1 }} value={newRoleInput} onChange={(e) => setNewRoleInput(e.target.value)} placeholder="Add new role…" onKeyDown={(e) => e.key === "Enter" && addRoleOnTheFly()} />
        <button onClick={addRoleOnTheFly} disabled={!newRoleInput.trim()} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: TH.primary, color: "#fff", cursor: newRoleInput.trim() ? "pointer" : "not-allowed", fontFamily: "inherit", fontSize: 12, fontWeight: 700, opacity: newRoleInput.trim() ? 1 : 0.5, whiteSpace: "nowrap" }}>+ Add Role</button>
      </div>
      <label style={S.lbl}>Avatar</label>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
        <Avatar member={form} size={52} />
        <div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatar} />
          <button onClick={() => fileRef.current.click()} style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginBottom: 8, display: "block" }}>Upload Photo</button>
          {form.avatar && <button onClick={() => set("avatar", null)} style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>Remove</button>}
        </div>
      </div>
      <label style={S.lbl}>Color</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {COLORS.map((c) => <div key={c} onClick={() => set("color", c)} style={{ width: 28, height: 28, borderRadius: "50%", background: c, cursor: "pointer", border: `3px solid ${form.color === c ? "#1A202C" : "transparent"}` }} />)}
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={() => { setEditing(null); setForm(null); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button disabled={!form.name} onClick={save} style={{ ...S.btn, opacity: form.name ? 1 : 0.4 }}>Save</button>
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Team Members ({team.length})</span>
        <button onClick={openNew} style={S.btn}>+ Add Member</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {team.map((m) => (
          <div key={m.id} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <Avatar member={m} size={44} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>{m.name}</div>
              <div style={{ fontSize: 12, color: m.color }}>{m.role}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => openEdit(m)} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
              <button onClick={() => setTeam((t) => t.filter((x) => x.id !== m.id))} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ─── SKU MANAGER (with auto-generate) ────────────────────────────────────────
function SkuManager({ skus = [], onChange, brand, category, availableSizes }) {
  const rawSizes =
    availableSizes && availableSizes.length > 0
      ? availableSizes
      : DEFAULT_SIZES;
  const SIZES = [...rawSizes].sort((a, b) => {
    const na = parseFloat(a),
      nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    if (!isNaN(na)) return 1;
    if (!isNaN(nb)) return -1;
    return 0;
  });
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const [autoCount, setAutoCount] = useState(3);
  const [showAuto, setShowAuto] = useState(false);
  const [localSizes, setLocalSizes] = useState(null); // null = use SIZES prop
  const [newSizeInput, setNewSizeInput] = useState("");
  const [userTypedTargets, setUserTypedTargets] = useState([]); // tracks which target fields user manually typed
  const effectiveSizes = localSizes || SIZES;
  function addCustomSize() {
    const s = newSizeInput.trim().toUpperCase();
    if (!s) return;
    const next = [...effectiveSizes];
    if (!next.includes(s)) {
      next.push(s);
      next.sort((a, b) => {
        const na = parseFloat(a),
          nb = parseFloat(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        if (!isNaN(na)) return 1;
        if (!isNaN(nb)) return -1;
        return 0;
      });
    }
    setLocalSizes(next);
    setNewSizeInput("");
  }
  const BLANK = () => ({
    id: uid(),
    styleNum: "",
    description: "",
    colorways: "",
    fabric: "",
    sizes: [],
    units: 0,
    fob: "",
    landed: "",
    wholesale: "",
    retail: "",
    marginPct: "",
    targetDDP: "",
    targetSelling: "",
    targetMargin: "",
    images: [],
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleSize = (sz) =>
    setForm((f) => ({
      ...f,
      sizes: f.sizes.includes(sz)
        ? f.sizes.filter((s) => s !== sz)
        : [...f.sizes, sz],
    }));

  // Dynamic target costing: use userTypedTargets to know which fields are user-entered anchors
  function handleTargetField(field, val) {
    // Mark this field as user-typed
    setUserTypedTargets((prev) =>
      prev.includes(field) ? prev : [...prev, field]
    );
    setForm((f) => {
      const next = { ...f, [field]: val };
      const typedArr = userTypedTargets.includes(field)
        ? userTypedTargets
        : [...userTypedTargets, field];
      const ddp = parseFloat(field === "targetDDP" ? val : next.targetDDP);
      const sell = parseFloat(
        field === "targetSelling" ? val : next.targetSelling
      );
      const mgn = parseFloat(
        field === "targetMargin" ? val : next.targetMargin
      );
      const validDDP = typedArr.includes("targetDDP") && !isNaN(ddp) && ddp > 0;
      const validSell =
        typedArr.includes("targetSelling") && !isNaN(sell) && sell > 0;
      const validMgn =
        typedArr.includes("targetMargin") &&
        !isNaN(mgn) &&
        mgn > 0 &&
        mgn < 100;
      // Derive exactly the one field the user has NOT typed yet
      if (field === "targetDDP") {
        if (validMgn && !typedArr.includes("targetSelling"))
          next.targetSelling = (ddp / (1 - mgn / 100)).toFixed(2);
        else if (validSell && !typedArr.includes("targetMargin"))
          next.targetMargin = (((sell - ddp) / sell) * 100).toFixed(2);
      } else if (field === "targetSelling") {
        if (validDDP && !typedArr.includes("targetMargin"))
          next.targetMargin = (((sell - ddp) / sell) * 100).toFixed(2);
        else if (validMgn && !typedArr.includes("targetDDP"))
          next.targetDDP = (sell * (1 - mgn / 100)).toFixed(2);
      } else if (field === "targetMargin") {
        if (validDDP && !typedArr.includes("targetSelling"))
          next.targetSelling = (ddp / (1 - mgn / 100)).toFixed(2);
        else if (validSell && !typedArr.includes("targetDDP"))
          next.targetDDP = (sell * (1 - mgn / 100)).toFixed(2);
      }
      return next;
    });
  }
  function clearTargets() {
    setForm((f) => ({
      ...f,
      targetDDP: "",
      targetSelling: "",
      targetMargin: "",
    }));
    setUserTypedTargets([]);
  }

  function save() {
    if (editing === "new") onChange([...skus, form]);
    else onChange(skus.map((s) => (s.id === editing ? form : s)));
    setEditing(null);
    setForm(null);
    setUserTypedTargets([]);
  }
  function handleAutoGen() {
    const newSkus = autoGenSkus(brand, category, autoCount);
    const merged = [...skus, ...newSkus];
    onChange(merged);
    setShowAuto(false);
  }

  if (editing)
    return (
      <div>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
        >
          <div>
            <label style={S.lbl}>Style Number</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.styleNum}
              onChange={(e) => set("styleNum", e.target.value)}
              placeholder="ROF-DN-1042"
            />
          </div>
          <div>
            <label style={S.lbl}>Units</label>
            <input
              type="number"
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.units}
              onChange={(e) => set("units", parseInt(e.target.value) || 0)}
            />
          </div>
        </div>
        <div style={{ height: 14 }} />
        <label style={S.lbl}>Style Description</label>
        <input
          style={S.inp}
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="5-pocket slim fit denim"
        />
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
        >
          <div>
            <label style={S.lbl}>Colorways</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.colorways}
              onChange={(e) => set("colorways", e.target.value)}
            />
          </div>
          <div>
            <label style={S.lbl}>Fabric/Material</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.fabric}
              onChange={(e) => set("fabric", e.target.value)}
            />
          </div>
        </div>
        <div style={{ height: 14 }} />
        <label style={S.lbl}>Sizes</label>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}
        >
          {effectiveSizes.map((sz) => (
            <button
              key={sz}
              onClick={() => toggleSize(sz)}
              style={{
                padding: "4px 11px",
                borderRadius: 16,
                border: `1px solid ${
                  form.sizes.includes(sz) ? TH.primary : TH.border
                }`,
                background: form.sizes.includes(sz)
                  ? TH.primary + "15"
                  : "transparent",
                color: form.sizes.includes(sz) ? TH.primary : TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
              }}
            >
              {sz}
            </button>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 14,
            alignItems: "center",
          }}
        >
          <input
            value={newSizeInput}
            onChange={(e) => setNewSizeInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCustomSize()}
            placeholder="Add size (e.g. 40)"
            style={{
              ...S.inp,
              marginBottom: 0,
              flex: 1,
              fontSize: 12,
              padding: "5px 10px",
            }}
          />
          <button
            onClick={addCustomSize}
            style={{
              padding: "5px 12px",
              borderRadius: 8,
              border: `1px solid ${TH.primary}`,
              background: TH.primary + "12",
              color: TH.primary,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            + Add Size
          </button>
        </div>
        <span style={S.sec}>Costing</span>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3,1fr)",
            gap: 12,
          }}
        >
          {[
            ["FOB Cost", "fob", "$"],
            ["Landed Cost", "landed", "$"],
            ["Wholesale", "wholesale", "$"],
            ["Retail", "retail", "$"],
            ["Margin %", "marginPct", "%"],
          ].map(([lbl, key, sym]) => (
            <div key={key}>
              <label style={S.lbl}>{lbl}</label>
              <div style={{ position: "relative" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: TH.textMuted,
                    fontSize: 13,
                  }}
                >
                  {sym}
                </span>
                <input
                  style={{ ...S.inp, marginBottom: 0, paddingLeft: 22 }}
                  value={form[key]}
                  onChange={(e) => set(key, e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
          ))}
        </div>
        <div style={{ height: 14 }} />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <span style={S.sec}>
            Target Costing{" "}
            <span
              style={{
                fontWeight: 400,
                fontSize: 11,
                color: TH.textMuted,
                textTransform: "none",
              }}
            >
              {" "}
              — enter any 2, third auto-calculates
            </span>
          </span>
          <button
            onClick={clearTargets}
            style={{
              padding: "3px 10px",
              borderRadius: 6,
              border: `1px solid ${TH.border}`,
              background: "none",
              color: TH.textMuted,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 11,
            }}
          >
            Clear All
          </button>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 12,
            background: TH.primary + "06",
            border: `1px solid ${TH.primary}22`,
            borderRadius: 10,
            padding: "14px",
          }}
        >
          {[
            ["Target DDP Cost", "targetDDP", "$"],
            ["Target Selling Price", "targetSelling", "$"],
            ["Target Margin %", "targetMargin", "%"],
          ].map(([lbl, key, sym]) => (
            <div key={key}>
              <label style={{ ...S.lbl, color: TH.primary }}>{lbl}</label>
              <div style={{ position: "relative" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: TH.primary,
                    fontSize: 13,
                    opacity: 0.7,
                  }}
                >
                  {sym}
                </span>
                <input
                  style={{
                    ...S.inp,
                    marginBottom: 0,
                    paddingLeft: 22,
                    borderColor: TH.primary + "44",
                    background: TH.primary + "05",
                  }}
                  value={form[key] || ""}
                  onChange={(e) => handleTargetField(key, e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
          ))}
        </div>
        <div style={{ height: 14 }} />
        <ImageUploader
          images={form.images || []}
          onChange={(v) => set("images", v)}
          label="Style Images"
        />
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            marginTop: 8,
          }}
        >
          <button
            onClick={() => {
              setEditing(null);
              setForm(null);
            }}
            style={{
              padding: "9px 18px",
              borderRadius: 8,
              border: `1px solid ${TH.border}`,
              background: "none",
              color: TH.textMuted,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button onClick={save} style={S.btn}>
            Save SKU
          </button>
        </div>
      </div>
    );

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span style={S.sec}>SKUs ({skus.length})</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowAuto(!showAuto)}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: `1px solid ${TH.primary}`,
              background: TH.primary + "10",
              color: TH.primary,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          >
            ⚡ Auto-Generate
          </button>
          <button
            onClick={() => {
              setForm(BLANK());
              setEditing("new");
            }}
            style={{ ...S.btn, padding: "6px 14px", fontSize: 12 }}
          >
            + Add SKU
          </button>
        </div>
      </div>

      {showAuto && (
        <div
          style={{
            ...S.card,
            marginBottom: 16,
            background: TH.primary + "08",
            border: `1px solid ${TH.primary}33`,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: TH.text,
              marginBottom: 8,
            }}
          >
            ⚡ Auto-Generate SKUs
          </div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 12 }}>
            System will generate style numbers, descriptions, colorways, and
            fabrics based on <strong>{category}</strong> category.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ ...S.lbl, marginBottom: 0 }}>
                Number of SKUs:
              </label>
              <input
                type="number"
                min="1"
                max="20"
                value={autoCount}
                onChange={(e) =>
                  setAutoCount(
                    Math.min(20, Math.max(1, parseInt(e.target.value) || 1))
                  )
                }
                style={{
                  ...S.inp,
                  marginBottom: 0,
                  width: 70,
                  textAlign: "center",
                }}
              />
            </div>
            <button
              onClick={() => {
                handleAutoGen();
              }}
              style={S.btn}
            >
              Generate & Save {autoCount} SKU{autoCount !== 1 ? "s" : ""}
            </button>
            <button
              onClick={() => setShowAuto(false)}
              style={{
                padding: "9px 14px",
                borderRadius: 8,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {skus.length === 0 && (
        <div
          style={{
            textAlign: "center",
            color: TH.textMuted,
            padding: "24px",
            fontSize: 13,
            border: `1px dashed ${TH.border}`,
            borderRadius: 10,
          }}
        >
          No SKUs yet. Add manually or use Auto-Generate.
        </div>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {skus.map((s) => (
          <div
            key={s.id}
            style={{
              ...S.card,
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
            }}
          >
            {s.images?.[0] ? (
              <img
                src={s.images[0].src}
                alt={s.styleNum}
                style={{
                  width: 64,
                  height: 64,
                  objectFit: "cover",
                  borderRadius: 8,
                  flexShrink: 0,
                }}
              />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 64,
                  background: TH.surfaceHi,
                  border: `1px solid ${TH.border}`,
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: TH.textMuted,
                  fontSize: 22,
                  flexShrink: 0,
                }}
              >
                👕
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 4,
                }}
              >
                <div>
                  <span
                    style={{ fontSize: 13, fontWeight: 700, color: TH.text }}
                  >
                    {s.styleNum || "No Style #"}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: TH.textMuted,
                      marginLeft: 10,
                    }}
                  >
                    {s.description}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => {
                      setForm({ ...s });
                      setEditing(s.id);
                      setUserTypedTargets(
                        Object.entries({
                          targetDDP: s.targetDDP,
                          targetSelling: s.targetSelling,
                          targetMargin: s.targetMargin,
                        })
                          .filter(([, v]) => v)
                          .map(([k]) => k)
                      );
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: `1px solid ${TH.border}`,
                      background: "none",
                      color: TH.textMuted,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 11,
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onChange(skus.filter((x) => x.id !== s.id))}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid #FCA5A5",
                      background: "none",
                      color: "#B91C1C",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 11,
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                {s.colorways && (
                  <span style={{ fontSize: 11, color: TH.textMuted }}>
                    🎨 {s.colorways}
                  </span>
                )}
                {s.fabric && (
                  <span style={{ fontSize: 11, color: TH.textMuted }}>
                    🧵 {s.fabric}
                  </span>
                )}
                {s.sizes?.length > 0 && (
                  <span style={{ fontSize: 11, color: TH.textMuted }}>
                    📐 {s.sizes.join(", ")}
                  </span>
                )}
                {s.units > 0 && (
                  <span style={{ fontSize: 11, color: TH.textMuted }}>
                    📦 {s.units.toLocaleString()}
                  </span>
                )}
              </div>
              {(s.fob ||
                s.wholesale ||
                s.retail ||
                s.targetDDP ||
                s.targetSelling ||
                s.targetMargin) && (
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    marginTop: 5,
                    flexWrap: "wrap",
                  }}
                >
                  {s.fob && (
                    <span
                      style={{
                        fontSize: 11,
                        color: TH.primary,
                        fontWeight: 600,
                      }}
                    >
                      FOB ${s.fob}
                    </span>
                  )}
                  {s.wholesale && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#B45309",
                        fontWeight: 600,
                      }}
                    >
                      WHL ${s.wholesale}
                    </span>
                  )}
                  {s.retail && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#065F46",
                        fontWeight: 600,
                      }}
                    >
                      RTL ${s.retail}
                    </span>
                  )}
                  {s.marginPct && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#6D28D9",
                        fontWeight: 600,
                      }}
                    >
                      MGN {s.marginPct}%
                    </span>
                  )}
                  {s.targetDDP && (
                    <span
                      style={{
                        fontSize: 11,
                        color: TH.primary,
                        fontWeight: 600,
                        opacity: 0.75,
                      }}
                    >
                      T-DDP ${s.targetDDP}
                    </span>
                  )}
                  {s.targetSelling && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#065F46",
                        fontWeight: 600,
                        opacity: 0.75,
                      }}
                    >
                      T-SELL ${s.targetSelling}
                    </span>
                  )}
                  {s.targetMargin && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#6D28D9",
                        fontWeight: 600,
                        opacity: 0.75,
                      }}
                    >
                      T-MGN {s.targetMargin}%
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── TASK EDIT MODAL ──────────────────────────────────────────────────────────
function TaskEditModal({
  task,
  team,
  collections,
  allTasks,
  onSave,
  onSaveCascade,
  onDelete,
  onClose,
  vendors,
  currentUser,
  onSkuChange,
  customerList,
  orderTypes,
}) {
  const [f, setF] = useState({
    ...task,
    history: task.history || [],
    images: task.images || [],
  });
  const [tab, setTab] = useState("details");
  const [cascadeWarn, setCascadeWarn] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const collKey = `${task.brand}||${task.collection}`;
  const collData = collections[collKey] || {};
  const skus = collData.skus || [];
  const brand = getBrand(task.brand);
  const canEdit =
    currentUser.role === "admin" ||
    currentUser.permissions?.edit_all ||
    (currentUser.permissions?.edit_own &&
      task.assigneeId === currentUser.teamMemberId);

  function handleStatusChange(newStatus) {
    if (!canEdit) return;
    const entry = {
      id: uid(),
      field: "status",
      from: f.status,
      to: newStatus,
      changedBy: currentUser.name,
      at: new Date().toISOString(),
    };
    setF((x) => ({
      ...x,
      status: newStatus,
      history: [...(x.history || []), entry],
    }));
  }
  function handleAssign(memberId) {
    if (!canEdit) return;
    const prev = team.find((m) => m.id === f.assigneeId)?.name || "Unassigned";
    const next = team.find((m) => m.id === memberId)?.name || "Unassigned";
    const entry = {
      id: uid(),
      field: "assignee",
      from: prev,
      to: next,
      changedBy: currentUser.name,
      at: new Date().toISOString(),
    };
    setF((x) => ({
      ...x,
      assigneeId: memberId,
      history: [...(x.history || []), entry],
    }));
  }

  function handleDueChange(newDue) {
    if (!canEdit) return;
    // Only update the local form — cascade and DDP warning happen on Save
    setF((x) => ({ ...x, due: newDue }));
  }

  function handleSave() {
    const { updatedTasks, ddpChanged, newDDP, oldDDP, affectedCount } =
      cascadeDates(allTasks, collKey, task.id, f.due);

    // Build history entry if date changed
    const dateChanged = f.due !== task.due;
    const fWithHistory = dateChanged
      ? {
          ...f,
          history: [
            ...(f.history || []),
            {
              id: uid(),
              field: "due date",
              from: task.due,
              to: f.due,
              changedBy: currentUser.name,
              at: new Date().toISOString(),
            },
          ],
        }
      : f;

    if (ddpChanged) {
      // Show DDP warning — user decides how to handle before committing
      const collTasks = allTasks
        .filter((t) => `${t.brand}||${t.collection}` === collKey)
        .sort((a, b) => new Date(a.due) - new Date(b.due));
      setCascadeWarn({
        updatedTasks,
        newDDP,
        oldDDP,
        affectedCount,
        newDue: f.due,
        collTasks,
        fWithHistory,
      });
    } else if (dateChanged) {
      // Date changed but DDP unaffected — apply cascade and save atomically
      const merged = updatedTasks.map((t) =>
        t.id === fWithHistory.id ? { ...t, ...fWithHistory } : t
      );
      onSaveCascade(merged);
    } else {
      // No date change — simple single-task save
      onSave(fWithHistory);
    }
  }

  function proportionalResize(collTasks, changedTaskId, newDue) {
    // Resize pre-Production tasks proportionally so DDP stays the same
    const sorted = [...collTasks].sort(
      (a, b) => new Date(a.due) - new Date(b.due)
    );
    const ddpTask = sorted.find((t) => t.phase === "DDP");
    const ddpDate = ddpTask?.due;
    if (!ddpDate) return allTasks;
    const prodIdx = sorted.findIndex((t) => t.phase === "Production");
    const prePhases = prodIdx >= 0 ? sorted.slice(0, prodIdx) : sorted;
    const postPhases = prodIdx >= 0 ? sorted.slice(prodIdx) : [];
    // Find the changed task in prePhases
    const changedPreIdx = prePhases.findIndex((t) => t.id === changedTaskId);
    if (changedPreIdx < 0) return allTasks; // changed task is production or later — no proportional resize
    // Original span: first pre-task to production
    const origFirst = new Date(prePhases[0].due);
    const origProd =
      prodIdx >= 0 ? new Date(sorted[prodIdx].due) : new Date(ddpDate);
    const origSpan = diffDays(
      origProd.toISOString().split("T")[0],
      prePhases[0].due
    );
    // New span: newDue replaces the changed task; scale all pre-prod tasks to keep same ratios
    // Anchor: keep first task fixed at its current date, stretch/compress around the changed task
    // Strategy: compute ratio of changedTask in span, solve for new total span
    const origChangedOffset = diffDays(
      prePhases[changedPreIdx].due,
      prePhases[0].due
    );
    const newChangedOffset = diffDays(newDue, prePhases[0].due);
    const scale =
      origChangedOffset > 0 ? newChangedOffset / origChangedOffset : 1;
    const resizedPre = prePhases.map((t, i) => {
      if (i === 0) return t; // anchor first task
      const origOffset = diffDays(t.due, prePhases[0].due);
      const newOffset = Math.round(origOffset * scale);
      return { ...t, due: addDays(prePhases[0].due, newOffset) };
    });
    const resizedIds = new Set(resizedPre.map((t) => t.id));
    return allTasks.map((t) => {
      if (`${t.brand}||${t.collection}` !== collKey) return t;
      const r = resizedPre.find((x) => x.id === t.id);
      if (r) return r;
      return t;
    });
  }

  const assignee = team.find((m) => m.id === f.assigneeId) || null;
  const pd = team.find((m) => m.id === f.pdId) || null;
  const designer = team.find((m) => m.id === f.designerId) || null;
  const graphic = team.find((m) => m.id === f.graphicId) || null;
  const vendor = vendors.find((v) => v.id === f.vendorId) || null;

  const tabs = [
    { id: "details", label: "Details" },
    {
      id: "images",
      label: `Images${f.images?.length ? " (" + f.images.length + ")" : ""}`,
    },
    { id: "skus", label: `SKUs${skus.length ? " (" + skus.length + ")" : ""}` },
    {
      id: "history",
      label: `History${f.history?.length ? " (" + f.history.length + ")" : ""}`,
    },
  ];

  return (
    <>
      <Modal
        title={`${task.phase} — ${task.collection}`}
        onClose={onClose}
        extraWide
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 22,
            padding: "12px 16px",
            background: TH.surfaceHi,
            borderRadius: 12,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: brand.color,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 13, color: TH.textMuted }}>
              {brand.name} · {task.season} · {task.category}
              {vendor ? ` · ${vendor.name}` : ""}
            </span>
          </div>
          {f.customer && (
            <span
              style={{
                fontSize: 12,
                color: TH.primary,
                background: TH.primary + "15",
                padding: "2px 10px",
                borderRadius: 10,
                fontWeight: 600,
              }}
            >
              {f.customer}
            </span>
          )}
          {f.orderType && (
            <span
              style={{
                fontSize: 12,
                color: TH.textSub2,
                background: TH.surfaceHi,
                border: `1px solid ${TH.border}`,
                padding: "2px 10px",
                borderRadius: 10,
              }}
            >
              {f.orderType}
            </span>
          )}
          {!canEdit && (
            <span
              style={{
                fontSize: 11,
                color: "#6D28D9",
                background: "#F5F3FF",
                border: "1px solid #C4B5FD",
                padding: "2px 8px",
                borderRadius: 8,
              }}
            >
              👁 View Only
            </span>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3,1fr)",
            gap: 10,
            marginBottom: 22,
          }}
        >
          {[
            ["DDP Date", "ddpDate", TH.primary],
            ["Cust Ship Date", "customerShipDate", "#065F46"],
            ["Cancel Date", "cancelDate", "#B91C1C"],
          ].map(([label, key, color]) => (
            <div
              key={key}
              style={{
                background: TH.surfaceHi,
                borderRadius: 8,
                padding: "10px 14px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: TH.textMuted,
                  marginBottom: 4,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                {label}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color }}>
                {formatDate(f[key] || task[key])}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            gap: 2,
            marginBottom: 22,
            borderBottom: `1px solid ${TH.border}`,
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "8px 16px",
                borderRadius: "8px 8px 0 0",
                border: "none",
                cursor: "pointer",
                background: tab === t.id ? TH.surfaceHi : "transparent",
                color: tab === t.id ? TH.text : TH.textMuted,
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: tab === t.id ? 600 : 400,
                borderBottom:
                  tab === t.id
                    ? `2px solid ${TH.primary}`
                    : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "details" && (
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}
          >
            <div>
              <label style={S.lbl}>Status</label>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginBottom: 14,
                }}
              >
                {Object.keys(STATUS_CONFIG).map((st) => (
                  <button
                    key={st}
                    onClick={() => handleStatusChange(st)}
                    disabled={!canEdit}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 16,
                      border: `1px solid ${
                        f.status === st ? STATUS_CONFIG[st].dot : TH.border
                      }`,
                      background:
                        f.status === st ? STATUS_CONFIG[st].bg : "transparent",
                      color:
                        f.status === st
                          ? STATUS_CONFIG[st].color
                          : TH.textMuted,
                      cursor: canEdit ? "pointer" : "default",
                      fontFamily: "inherit",
                      fontSize: 12,
                    }}
                  >
                    {st}
                  </button>
                ))}
              </div>
              <label style={S.lbl}>Due Date</label>
              <DateInput
                style={S.inp}
                value={f.due}
                onChange={(v) => handleDueChange(v)}
                disabled={!canEdit}
              />
              {/* Days from previous task */}
              {(() => {
                const sortedColl = allTasks
                  .filter((t) => `${t.brand}||${t.collection}` === collKey)
                  .sort((a, b) => new Date(a.due) - new Date(b.due));
                const thisIdx = sortedColl.findIndex((t) => t.id === task.id);
                const prevTask = thisIdx > 0 ? sortedColl[thisIdx - 1] : null;
                if (!prevTask) return null;
                const currentGap = diffDays(f.due, prevTask.due);
                return (
                  <div style={{ marginBottom: 14 }}>
                    <label style={S.lbl}>Days from Previous Task</label>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <input
                        type="number"
                        disabled={!canEdit}
                        value={currentGap}
                        min={0}
                        onChange={(e) => {
                          const n = parseInt(e.target.value);
                          if (isNaN(n) || n < 0) return;
                          const newDue = addDays(prevTask.due, n);
                          handleDueChange(newDue);
                        }}
                        style={{
                          ...S.inp,
                          marginBottom: 0,
                          width: 90,
                          textAlign: "center",
                          fontWeight: 700,
                          fontSize: 15,
                          color: TH.primary,
                          border: `1px solid ${TH.primary}44`,
                          background: TH.primary + "06",
                        }}
                      />
                      <div
                        style={{
                          fontSize: 12,
                          color: TH.textMuted,
                          lineHeight: 1.4,
                        }}
                      >
                        days after{" "}
                        <span style={{ fontWeight: 700, color: TH.textSub2 }}>
                          {prevTask.phase}
                        </span>
                        <br />
                        <span style={{ fontSize: 11 }}>
                          (due {formatDate(prevTask.due)})
                        </span>
                      </div>
                    </div>
                    {currentGap < 0 && (
                      <div
                        style={{
                          marginTop: 5,
                          fontSize: 11,
                          color: "#B91C1C",
                          fontWeight: 600,
                        }}
                      >
                        ⚠️ This task is scheduled before the previous task
                      </div>
                    )}
                  </div>
                );
              })()}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                }}
              >
                <div>
                  <label style={S.lbl}>Customer</label>
                  {/* FIX: use select+datalist combo so it always works */}
                  <select
                    style={{ ...S.inp, marginBottom: 0 }}
                    value={f.customer || ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      set("customer", v);
                      if (v && !f.channelType) {
                        const custObj = (customerList || []).find(c => (typeof c === "string" ? c : c.name) === v);
                        const ch = (custObj && typeof custObj !== "string" && custObj.channel) || getChannelForCustomer(v);
                        if (ch) set("channelType", ch);
                      }
                    }}
                    disabled={!canEdit}
                  >
                    <option value="">-- Select --</option>
                    {(customerList || DEFAULT_CUSTOMERS).map((c) => {
                      const name = typeof c === "string" ? c : c.name;
                      return <option key={name} value={name}>{name}</option>;
                    })}
                  </select>
                </div>
                <div>
                  <label style={S.lbl}>Order Type</label>
                  <select
                    style={{ ...S.inp, marginBottom: 0 }}
                    value={f.orderType || ""}
                    onChange={(e) => set("orderType", e.target.value)}
                    disabled={!canEdit}
                  >
                    <option value="">-- Select --</option>
                    {orderTypes.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ height: 12 }} />
              <label style={S.lbl}>
                Channel Type{" "}
                <span
                  style={{
                    textTransform: "none",
                    fontWeight: 400,
                    color: TH.textMuted,
                  }}
                >
                  (auto-fills from customer)
                </span>
              </label>
              <select
                style={S.inp}
                value={f.channelType || ""}
                onChange={(e) => set("channelType", e.target.value)}
                disabled={!canEdit}
              >
                <option value="">-- Select --</option>
                {CHANNEL_TYPES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <label style={S.lbl}>Notes</label>
              <textarea
                style={{ ...S.inp, minHeight: 80, resize: "vertical" }}
                value={f.notes || ""}
                onChange={(e) => set("notes", e.target.value)}
                disabled={!canEdit}
                placeholder="Add notes..."
              />
            </div>
            <div>
              <label style={S.lbl}>Assign To</label>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  marginBottom: 14,
                }}
              >
                <button
                  onClick={() => handleAssign(null)}
                  disabled={!canEdit}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: `1px solid ${
                      !f.assigneeId ? TH.primary : TH.border
                    }`,
                    background: !f.assigneeId
                      ? TH.primary + "15"
                      : "transparent",
                    cursor: canEdit ? "pointer" : "default",
                    fontFamily: "inherit",
                    textAlign: "left",
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: TH.surfaceHi,
                      border: `1px solid ${TH.border}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      color: TH.textMuted,
                    }}
                  >
                    ?
                  </div>
                  <span
                    style={{
                      fontSize: 13,
                      color: !f.assigneeId ? TH.primary : TH.textMuted,
                    }}
                  >
                    Unassigned
                  </span>
                </button>
                {team.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => handleAssign(m.id)}
                    disabled={!canEdit}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: `1px solid ${
                        f.assigneeId === m.id ? m.color + "88" : TH.border
                      }`,
                      background:
                        f.assigneeId === m.id ? m.color + "22" : "transparent",
                      cursor: canEdit ? "pointer" : "default",
                      fontFamily: "inherit",
                      textAlign: "left",
                    }}
                  >
                    <Avatar member={m} size={28} />
                    <div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: f.assigneeId === m.id ? m.color : TH.text,
                        }}
                      >
                        {m.name}
                      </div>
                      <div style={{ fontSize: 11, color: TH.textMuted }}>
                        {m.role}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              {(pd || designer || graphic) && (
                <div>
                  <label style={S.lbl}>Collection Team</label>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {[
                      ["PD", pd],
                      ["Designer", designer],
                      ["Graphic", graphic],
                    ]
                      .filter(([, m]) => m)
                      .map(([role, m]) => (
                        <div
                          key={role}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <Avatar member={m} size={24} />
                          <div>
                            <div style={{ fontSize: 11, color: TH.text }}>
                              {m.name}
                            </div>
                            <div style={{ fontSize: 10, color: TH.textMuted }}>
                              {role}
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "images" && (
          <ImageUploader
            images={f.images || []}
            onChange={(v) => canEdit && set("images", v)}
            label="Task Images / Concepts"
          />
        )}
        {tab === "skus" && (
          <div>
            <div
              style={{ fontSize: 12, color: TH.textMuted, marginBottom: 14 }}
            >
              SKUs are shared collection-wide. Changes save immediately.
            </div>
            <SkuManager
              skus={skus}
              onChange={(newSkus) => {
                if (!canEdit) return;
                onSkuChange(collKey, newSkus);
              }}
              brand={task.brand}
              category={task.category}
              availableSizes={collData.availableSizes}
            />
          </div>
        )}

        {tab === "history" && (
          <div>
            {(!f.history || f.history.length === 0) && (
              <div
                style={{
                  textAlign: "center",
                  color: TH.textMuted,
                  padding: "32px",
                  fontSize: 13,
                }}
              >
                No changes recorded yet.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...(f.history || [])].reverse().map((h) => (
                <div
                  key={h.id}
                  style={{
                    background: TH.surfaceHi,
                    borderRadius: 10,
                    padding: "12px 16px",
                    borderLeft: `3px solid ${TH.primary}33`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{ fontSize: 12, fontWeight: 600, color: TH.text }}
                    >
                      {h.changedBy}
                    </span>
                    <span style={{ fontSize: 11, color: TH.textMuted }}>
                      {formatDT(h.at)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: TH.textMuted }}>
                    Changed{" "}
                    <span style={{ color: TH.primary, fontWeight: 600 }}>
                      {h.field}
                    </span>{" "}
                    from{" "}
                    <span
                      style={{
                        background: TH.surfaceHi,
                        border: `1px solid ${TH.border}`,
                        padding: "1px 7px",
                        borderRadius: 4,
                        color: TH.text,
                      }}
                    >
                      {h.from || "—"}
                    </span>{" "}
                    →{" "}
                    <span
                      style={{
                        background: TH.primary + "15",
                        border: `1px solid ${TH.primary}44`,
                        padding: "1px 7px",
                        borderRadius: 4,
                        color: TH.primary,
                        fontWeight: 600,
                      }}
                    >
                      {h.to}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 12,
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 26,
            paddingTop: 18,
            borderTop: `1px solid ${TH.border}`,
          }}
        >
          {canEdit ? (
            <button
              onClick={() => onDelete(task.id)}
              style={{
                background: "none",
                border: "none",
                color: "#B91C1C",
                cursor: "pointer",
                fontSize: 13,
                fontFamily: "inherit",
                textDecoration: "underline",
                padding: 0,
              }}
            >
              Delete task
            </button>
          ) : (
            <div />
          )}
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={() => {
                onClose();
              }}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
            {canEdit && (
              <button onClick={handleSave} style={S.btn}>
                Save Changes
              </button>
            )}
          </div>
        </div>
      </Modal>

      {cascadeWarn && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2100,
            padding: 16,
          }}
        >
          <div
            style={{
              background: "#FFFFFF",
              border: `1px solid ${TH.accentBdr}`,
              borderRadius: 16,
              padding: 32,
              maxWidth: 500,
              width: "100%",
              boxShadow: "0 40px 100px rgba(0,0,0,0.4)",
            }}
          >
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: TH.text,
                marginBottom: 12,
              }}
            >
              ⚠️ DDP Date Will Change
            </div>
            <div
              style={{
                fontSize: 13,
                color: TH.textMuted,
                lineHeight: 1.65,
                marginBottom: 20,
              }}
            >
              This change affects{" "}
              <strong>{cascadeWarn.affectedCount} tasks</strong> and would push
              the <strong>DDP date</strong> from&nbsp;
              <strong style={{ color: TH.primary }}>
                {formatDate(cascadeWarn.oldDDP)}
              </strong>{" "}
              to&nbsp;
              <strong style={{ color: "#B91C1C" }}>
                {formatDate(cascadeWarn.newDDP)}
              </strong>
              .<br />
              <br />
              How would you like to handle this?
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                onClick={() => {
                  const fw = cascadeWarn.fWithHistory || f;
                  const merged = cascadeWarn.updatedTasks.map((t) =>
                    t.id === fw.id ? { ...t, ...fw } : t
                  );
                  onSaveCascade(merged);
                  setCascadeWarn(null);
                  onClose();
                }}
                style={{
                  padding: "12px 20px",
                  borderRadius: 10,
                  border: "none",
                  background: `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`,
                  color: "#fff",
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                ✓ Accept New DDP Date —{" "}
                <span style={{ fontWeight: 400 }}>
                  {formatDate(cascadeWarn.newDDP)}
                </span>
              </button>
              <button
                onClick={() => {
                  const fw = cascadeWarn.fWithHistory || f;
                  const resized = proportionalResize(
                    cascadeWarn.collTasks,
                    task.id,
                    cascadeWarn.newDue
                  );
                  const merged = resized.map((t) =>
                    t.id === fw.id ? { ...t, ...fw } : t
                  );
                  onSaveCascade(merged);
                  setCascadeWarn(null);
                  onClose();
                }}
                style={{
                  padding: "12px 20px",
                  borderRadius: 10,
                  border: `2px solid ${TH.primary}`,
                  background: TH.primary + "10",
                  color: TH.primary,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                ⚖️ Proportionally Resize Task Durations —{" "}
                <span style={{ fontWeight: 400 }}>
                  keep DDP {formatDate(cascadeWarn.oldDDP)}
                </span>
              </button>
              <button
                onClick={() => {
                  // Keep DDP as-is: only save the changed task's fields, no cascade
                  const fw = cascadeWarn.fWithHistory || f;
                  onSave(fw);
                  setCascadeWarn(null);
                  onClose();
                }}
                style={{
                  padding: "12px 20px",
                  borderRadius: 10,
                  border: `2px solid #065F46`,
                  background: "#ECFDF5",
                  color: "#065F46",
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                📌 Keep DDP as-is —{" "}
                <span style={{ fontWeight: 400 }}>
                  only update this task's date
                </span>
              </button>
              <button
                onClick={() => {
                  // Revert the date change in the form
                  setF((x) => ({ ...x, due: task.due }));
                  setCascadeWarn(null);
                }}
                style={{
                  padding: "10px 20px",
                  borderRadius: 10,
                  border: `1px solid ${TH.border}`,
                  background: "none",
                  color: TH.textMuted,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                }}
              >
                Cancel — keep original date
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── DEFERRED DATE INPUT — only commits on blur/enter, not on every keystroke ─
function DeferredDateInput({ value, onCommit, style }) {
  const [local, setLocal] = useState(value || "");
  useEffect(() => { setLocal(value || ""); }, [value]);
  function commit() {
    if (local && local !== value) onCommit(local);
  }
  return (
    <input
      type="date"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") setLocal(value || ""); }}
      style={{ ...style, cursor: "pointer" }}
    />
  );
}

// ─── DAYS BACK INPUT (deferred commit – no DDP warning mid-typing) ──────────
function DaysBackInput({ value, onCommit }) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => {
    setLocal(String(value));
  }, [value]);
  function commit() {
    const n = parseInt(local);
    if (!isNaN(n) && n >= 0) onCommit(n);
    else setLocal(String(value));
  }
  return (
    <input
      type="number"
      value={local}
      min="0"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") setLocal(String(value));
      }}
      style={{
        width: 75,
        padding: "5px 8px",
        borderRadius: 6,
        border: `1px solid ${TH.border}`,
        background: "#FFFFFF",
        color: TH.text,
        fontFamily: "inherit",
        fontSize: 13,
        textAlign: "center",
        outline: "none",
      }}
    />
  );
}

// ─── COLLECTION WIZARD ────────────────────────────────────────────────────────
function CollectionWizard({ vendors, team, customers, seasons, orderTypes, onSave, onClose }) {
  const [step, setStep] = useState(1);

  // Compute initial recommended vendor for Denim (default category)
  const initialMatchV = vendors.filter(
    (v) => v.categories.length === 0 || v.categories.includes("Denim")
  );
  const initialVendorId =
    initialMatchV.length > 0 ? initialMatchV[0].id : vendors[0]?.id || "";

  // Calculate DDP from vendor lead times: DDP = today + max(lead days) + transit
  function calcDdpFromVendor(vendorId) {
    const v = vendors.find((vv) => vv.id === vendorId);
    if (!v) return "";
    const maxLead = Math.max(...Object.values(v.lead).filter((x) => x > 0), 0);
    const total = maxLead + (v.transitDays || 0);
    return addDays(new Date().toISOString().split("T")[0], total);
  }

  const initialDdp = calcDdpFromVendor(initialVendorId);

  const [form, setForm] = useState({
    brand: "ring-of-fire",
    collection: "",
    season: "Fall",
    year: new Date().getFullYear(),
    gender: "Men's",
    category: "Denim",
    vendorId: initialVendorId,
    ddpDate: initialDdp,
    customerShipDate: initialDdp ? addDays(initialDdp, 24) : "",
    cancelDate: initialDdp ? addDays(addDays(initialDdp, 24), 6) : "",
    pdId: team.filter((m) => m.role === "Product Developer")[0]?.id || "",
    designerId: team.filter((m) => m.role === "Designer")[0]?.id || "",
    graphicId: team.filter((m) => m.role === "Graphic Artist")[0]?.id || "",
    customer: "Ross",
    orderType: "Projected",
    channelType: "Off-Price (Ross, TJX)",
    sampleDueDate: "",
  });
  // Editable preview phases: [{name, daysBack, due, edited}]
  const [editPhases, setEditPhases] = useState([]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // Creation date clamping — warn user if earliest task predates today
  const [creationDateWarn, setCreationDateWarn] = useState(null);

  const brand = getBrand(form.brand);
  const isPriv = brand.isPrivateLabel;
  const matchV = form.category
    ? vendors.filter(
        (v) => v.categories.length === 0 || v.categories.includes(form.category)
      )
    : vendors;
  const selV = vendors.find((v) => v.id === form.vendorId);
  const byRole = (r) => team.filter((m) => m.role === r);

  // Today's date string — no task may be scheduled before this
  const todayStr = new Date().toISOString().split("T")[0];

  // Build preview tasks from editPhases
  const previewTasks =
    form.ddpDate && form.vendorId ? generateTasks({ ...form, vendors }) : [];

  // Proportional resize helper: compress pre-Production phases so first task = today, DDP unchanged
  function applyProportionalResize(rawPhases) {
    const ddpDate = form.ddpDate;
    const prodIdx = rawPhases.findIndex((p) => p.name === "Production");
    const prePhases = prodIdx >= 0 ? rawPhases.slice(0, prodIdx) : rawPhases;
    const postPhases = prodIdx >= 0 ? rawPhases.slice(prodIdx) : [];
    if (prePhases.length === 0) return rawPhases;
    const origFirstDue = prePhases[0].due;
    const origProdDue = prodIdx >= 0 ? rawPhases[prodIdx].due : ddpDate;
    const origSpan = diffDays(origProdDue, origFirstDue);
    const newSpan = diffDays(origProdDue, todayStr);
    const resized = prePhases.map((p) => {
      if (origSpan <= 0)
        return {
          ...p,
          due: todayStr,
          daysBack: diffDays(ddpDate, todayStr),
          edited: true,
        };
      const ratio = origSpan > 0 ? diffDays(p.due, origFirstDue) / origSpan : 0;
      const newDue = addDays(todayStr, Math.round(ratio * newSpan));
      return {
        ...p,
        due: newDue,
        daysBack: diffDays(ddpDate, newDue),
        edited: true,
      };
    });
    return [...resized, ...postPhases];
  }

  // When we reach step 3, initialize editPhases from generated tasks
  // Enforce: no task date may be before today (creation date)
  useEffect(() => {
    if (step === 3 && previewTasks.length > 0 && editPhases.length === 0) {
      const rawPhases = previewTasks.map((t) => ({
        id: t.id,
        name: t.phase,
        due: t.due,
        daysBack: diffDays(form.ddpDate, t.due),
      }));
      const firstTask = rawPhases[0];
      if (firstTask && firstTask.due < todayStr) {
        // Clamp: shift ALL tasks so first task = today, cascade forward
        const delta = diffDays(todayStr, firstTask.due);
        const clampedPhases = rawPhases.map((p) => ({
          ...p,
          due: addDays(p.due, delta),
          daysBack: diffDays(form.ddpDate, addDays(p.due, delta)),
          edited: true,
        }));
        const ddpPhase = clampedPhases.find((p) => p.name === "DDP");
        const oldDDP = form.ddpDate;
        const newDDP = ddpPhase?.due;
        if (newDDP && newDDP !== oldDDP) {
          // DDP would shift — ask user: accept new DDP or proportionally resize
          setCreationDateWarn({ oldDDP, newDDP, clampedPhases, rawPhases });
          setEditPhases(rawPhases); // show raw until user decides
        } else {
          setEditPhases(clampedPhases);
        }
      } else {
        setEditPhases(rawPhases);
      }
    }
  }, [step]);

  // When vendor changes, recalc DDP from vendor lead times, then recalc ship/cancel
  useEffect(() => {
    if (form.vendorId) {
      const newDdp = calcDdpFromVendor(form.vendorId);
      if (newDdp) {
        setForm((f) => ({
          ...f,
          ddpDate: newDdp,
          customerShipDate: addDays(newDdp, 24),
          cancelDate: addDays(addDays(newDdp, 24), 6),
        }));
      }
    }
  }, [form.vendorId]);

  // When DDP changes manually, recalc ship/cancel
  useEffect(() => {
    if (form.ddpDate && form.vendorId) {
      set("customerShipDate", addDays(form.ddpDate, 24));
      set("cancelDate", addDays(addDays(form.ddpDate, 24), 6));
    }
  }, [form.ddpDate]);

  // When customer changes, auto-fill channel type
  useEffect(() => {
    if (form.customer) {
      const ch = getChannelForCustomer(form.customer);
      if (ch) set("channelType", ch);
    }
  }, [form.customer]);

  const [ddpWarn, setDdpWarn] = useState(null);
  const [pendingPhaseEdit, setPendingPhaseEdit] = useState(null);

  function applyPhaseDue(idx, newDue) {
    setEditPhases((eps) => {
      const updated = [...eps];
      const delta = diffDays(newDue, updated[idx].due);
      updated[idx] = {
        ...updated[idx],
        due: newDue,
        daysBack: diffDays(form.ddpDate, newDue),
        edited: true,
      };
      for (let i = idx + 1; i < updated.length; i++) {
        const nd = addDays(updated[i].due, delta);
        updated[i] = {
          ...updated[i],
          due: nd,
          daysBack: diffDays(form.ddpDate, nd),
          edited: true,
        };
      }
      return updated;
    });
  }

  // Proportionally compress/expand all phases between the changed phase and DDP
  // so that DDP stays fixed. The changed phase gets its requested date;
  // every phase between it and DDP is scaled to fit the remaining span.
  function proportionalResizePhases(idx, newDue) {
    const phases = [...editPhases];
    const ddpIdx = phases.findIndex((e) => e.name === "DDP");
    if (ddpIdx < 0) return;
    const ddpDue = phases[ddpIdx].due;

    // Set the changed phase to the new date
    phases[idx] = {
      ...phases[idx],
      due: newDue,
      daysBack: diffDays(ddpDue, newDue),
      edited: true,
    };

    // Phases between changed+1 and ddpIdx-1 get proportionally distributed
    const afterIdx = idx + 1;
    const beforeDDP = ddpIdx; // exclusive
    const count = beforeDDP - afterIdx;
    if (count > 0) {
      const newStart = newDue;           // start of the window
      const windowEnd = ddpDue;          // end = DDP stays fixed
      const totalSpan = diffDays(windowEnd, newStart);
      const origStart = editPhases[idx].due;
      const origEnd = editPhases[ddpIdx].due;
      const origSpan = diffDays(origEnd, origStart);

      for (let i = afterIdx; i < beforeDDP; i++) {
        if (origSpan <= 0) {
          // Degenerate: all collapse to newStart
          phases[i] = { ...phases[i], due: newStart, daysBack: diffDays(ddpDue, newStart), edited: true };
        } else {
          const ratio = diffDays(editPhases[i].due, origStart) / origSpan;
          const nd = addDays(newStart, Math.round(ratio * totalSpan));
          phases[i] = { ...phases[i], due: nd, daysBack: diffDays(ddpDue, nd), edited: true };
        }
      }
    }

    // Phases at/after DDP stay unchanged (DDP itself was not moved)
    setEditPhases(phases);
  }

  function updatePhaseDue(idx, newDue) {
    // Check if DDP row is being changed or if cascade would affect DDP
    const ep = editPhases[idx];
    const isDDP = ep.name === "DDP";
    if (isDDP) {
      const oldDDP = ep.due;
      if (newDue !== oldDDP) {
        setDdpWarn({ idx, newDue, oldDDP });
        return;
      }
    }
    // Check if cascading would push DDP
    const ddpIdx = editPhases.findIndex((e) => e.name === "DDP");
    if (ddpIdx > idx) {
      const delta = diffDays(newDue, editPhases[idx].due);
      const newDDPDue = addDays(editPhases[ddpIdx].due, delta);
      if (newDDPDue !== editPhases[ddpIdx].due && delta > 0) {
        const affectedCount = ddpIdx - idx;
        setDdpWarn({
          idx,
          newDue,
          oldDDP: editPhases[ddpIdx].due,
          newDDP: newDDPDue,
          cascade: true,
          affectedCount,
        });
        return;
      }
    }
    applyPhaseDue(idx, newDue);
  }

  function updatePhaseDaysBack(idx, newDaysBack) {
    const newDue = addDays(form.ddpDate, -newDaysBack);
    updatePhaseDue(idx, newDue);
  }

  function buildFinalTasks() {
    // Use editPhases dates instead of auto-generated ones
    return previewTasks.map((t) => {
      const ep = editPhases.find((e) => e.name === t.phase);
      return ep ? { ...t, due: ep.due, originalDue: ep.due } : t;
    });
  }

  const s1ok = form.collection && form.brand && form.season && form.category;
  const s2ok = form.vendorId && form.ddpDate;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 26 }}>
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background:
                step >= s
                  ? `linear-gradient(90deg,${TH.primary},${TH.primaryLt})`
                  : TH.border,
              transition: "all 0.3s",
            }}
          />
        ))}
      </div>

      {step === 1 && (
        <div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 18 }}>
            Step 1 of 3 — Brand, Collection & Team
          </div>
          <label style={S.lbl}>Brand</label>
          <select
            style={S.inp}
            value={form.brand}
            onChange={(e) => set("brand", e.target.value)}
          >
            {BRANDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.isPrivateLabel ? " (PL)" : ""}
              </option>
            ))}
          </select>
          {isPriv && (
            <div
              style={{
                background: "#F5F3FF",
                border: "1px solid #C4B5FD",
                borderRadius: 8,
                padding: "10px 14px",
                marginBottom: 14,
                fontSize: 12,
                color: "#6D28D9",
              }}
            >
              ✦ Private label — Line Review & Compliance/Testing auto-added
            </div>
          )}
          <label style={S.lbl}>Collection Name</label>
          <input
            style={S.inp}
            value={form.collection}
            onChange={(e) => set("collection", e.target.value)}
            placeholder="e.g. Heritage Series Fall 2025"
          />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: 14,
            }}
          >
            <div>
              <label style={S.lbl}>Season</label>
              <select
                style={{ ...S.inp, marginBottom: 0 }}
                value={form.season}
                onChange={(e) => set("season", e.target.value)}
              >
                {seasons.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={S.lbl}>Year</label>
              <select
                style={{ ...S.inp, marginBottom: 0 }}
                value={form.year}
                onChange={(e) => set("year", parseInt(e.target.value))}
              >
                {[2024, 2025, 2026, 2027, 2028].map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={S.lbl}>Gender</label>
              <select
                style={{ ...S.inp, marginBottom: 0 }}
                value={form.gender}
                onChange={(e) => set("gender", e.target.value)}
              >
                {GENDERS.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={S.lbl}>Category</label>
              <select
                style={{ ...S.inp, marginBottom: 0 }}
                value={form.category}
                onChange={(e) => {
                  const newCat = e.target.value;
                  const newMatchV = vendors.filter(
                    (v) =>
                      v.categories.length === 0 || v.categories.includes(newCat)
                  );
                  const newVendorId =
                    newMatchV.length > 0 ? newMatchV[0].id : "";
                  set("category", newCat);
                  set("vendorId", newVendorId);
                }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ height: 16 }} />
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
          >
            <div>
              <label style={S.lbl}>Customer</label>
              {/* FIX: pure select dropdown - no datalist combo issue */}
              <select
                style={S.inp}
                value={form.customer}
                onChange={(e) => set("customer", e.target.value)}
              >
                <option value="">-- Select Customer --</option>
                {(customers || DEFAULT_CUSTOMERS).map((c) => {
                  const name = typeof c === "string" ? c : c.name;
                  return <option key={name} value={name}>{name}</option>;
                })}
              </select>
            </div>
            <div>
              <label style={S.lbl}>Order Type</label>
              <select
                style={S.inp}
                value={form.orderType}
                onChange={(e) => set("orderType", e.target.value)}
              >
                {orderTypes.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </div>
          </div>
          <label style={S.lbl}>
            Channel Type{" "}
            <span style={{ textTransform: "none", fontWeight: 400 }}>
              (auto-fills from customer)
            </span>
          </label>
          <select
            style={S.inp}
            value={form.channelType}
            onChange={(e) => set("channelType", e.target.value)}
          >
            <option value="">-- Select --</option>
            {CHANNEL_TYPES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <span style={S.sec}>Collection Team</span>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 12,
            }}
          >
            {[
              ["Product Developer", "pdId"],
              ["Designer", "designerId"],
              ["Graphic Artist", "graphicId"],
            ].map(([role, key]) => (
              <div key={key}>
                <label style={S.lbl}>{role}</label>
                <select
                  style={{ ...S.inp, marginBottom: 0 }}
                  value={form[key]}
                  onChange={(e) => set(key, e.target.value)}
                >
                  <option value="">-- None --</option>
                  {byRole(role).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div style={{ height: 16 }} />
          <button
            disabled={!s1ok}
            onClick={() => setStep(2)}
            style={{
              ...S.btn,
              width: "100%",
              padding: "12px",
              fontSize: 14,
              opacity: s1ok ? 1 : 0.5,
            }}
          >
            Select Vendor →
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 18 }}>
            Step 2 of 3 — Vendor & Dates
          </div>
          <label style={S.lbl}>
            Vendor{" "}
            <span style={{ textTransform: "none", color: TH.textMuted }}>
              — {form.category} specialists shown first
            </span>
          </label>
          <select
            style={S.inp}
            value={form.vendorId}
            onChange={(e) => set("vendorId", e.target.value)}
          >
            <option value="">-- Select Vendor --</option>
            {matchV.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.country})
              </option>
            ))}
            {vendors.filter((v) => !matchV.includes(v)).length > 0 && (
              <option disabled>── Other vendors ──</option>
            )}
            {vendors
              .filter((v) => !matchV.includes(v))
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.country})
                </option>
              ))}
          </select>

          {selV && (
            <div style={{ ...S.card, marginBottom: 16 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  marginBottom: 14,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: TH.text,
                      marginBottom: 2,
                    }}
                  >
                    {selV.name}
                  </div>
                  <div style={{ fontSize: 12, color: TH.textMuted }}>
                    🌏 {selV.country} · ⛵ {selV.transitDays}d transit · MOQ{" "}
                    {selV.moq?.toLocaleString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {selV.categories.map((c) => (
                    <span
                      key={c}
                      style={{
                        fontSize: 11,
                        padding: "2px 9px",
                        borderRadius: 10,
                        background: TH.surfaceHi,
                        border: `1px solid ${TH.border}`,
                        color: TH.textSub2,
                      }}
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: TH.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 8,
                }}
              >
                Task Lead Times — Days Before DDP (editable)
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,1fr)",
                  gap: 8,
                }}
              >
                {[
                  "Concept",
                  "Design",
                  "Tech Pack",
                  "Costing",
                  "Sampling",
                  "Revision",
                  "Purchase Order",
                  "Production",
                ].map((phase) => {
                  const val = selV.lead[phase] ?? 0;
                  const calcDate = form.ddpDate
                    ? addDays(form.ddpDate, -val)
                    : "";
                  return (
                    <div
                      key={phase}
                      style={{
                        background: TH.surfaceHi,
                        borderRadius: 8,
                        padding: "10px 12px",
                        border: `1px solid ${TH.border}`,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          color: TH.textMuted,
                          marginBottom: 6,
                          fontWeight: 600,
                        }}
                      >
                        {phase}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <input
                          type="number"
                          min="0"
                          defaultValue={val}
                          onBlur={(e) => {
                            const n = parseInt(e.target.value) || 0;
                            set("vendorId", form.vendorId); // trigger re-render
                            // Update local vendor lead time for preview
                            selV.lead[phase] = n;
                            set("_leadOverride", Date.now());
                          }}
                          style={{
                            width: 60,
                            padding: "4px 8px",
                            borderRadius: 6,
                            border: `1px solid ${TH.primary}44`,
                            background: "#fff",
                            color: TH.text,
                            fontFamily: "inherit",
                            fontSize: 13,
                            fontWeight: 700,
                            textAlign: "center",
                          }}
                        />
                        <span style={{ fontSize: 10, color: TH.textMuted }}>
                          days
                        </span>
                      </div>
                      {calcDate && (
                        <div
                          style={{
                            fontSize: 11,
                            color: TH.primary,
                            marginTop: 4,
                            fontWeight: 600,
                          }}
                        >
                          {formatDate(calcDate)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <label style={S.lbl}>DDP Date (Delivered Duty Paid)</label>
          <DateInput
            style={S.inp}
            value={form.ddpDate}
            onChange={(v) => set("ddpDate", v)}
          />

          <label style={S.lbl}>Sample Due Date</label>
          <DateInput
            style={S.inp}
            value={form.sampleDueDate}
            onChange={(v) => set("sampleDueDate", v)}
          />

          {form.ddpDate && selV && (
            <div
              style={{
                background: TH.surfaceHi,
                border: `1px solid ${TH.border}`,
                borderRadius: 10,
                padding: "12px 16px",
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: TH.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 10,
                }}
              >
                Auto-Calculated Dates
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                }}
              >
                <div>
                  <label style={S.lbl}>
                    Customer Ship Date{" "}
                    <span style={{ textTransform: "none", fontWeight: 400 }}>
                      (DDP +24d)
                    </span>
                  </label>
                  <DateInput
                    style={{ ...S.inp, marginBottom: 0 }}
                    value={form.customerShipDate}
                    onChange={(v) => set("customerShipDate", v)}
                  />
                </div>
                <div>
                  <label style={S.lbl}>
                    Cancel Date{" "}
                    <span style={{ textTransform: "none", fontWeight: 400 }}>
                      (Cust Ship +6d)
                    </span>
                  </label>
                  <DateInput
                    style={{ ...S.inp, marginBottom: 0 }}
                    value={form.cancelDate}
                    onChange={(v) => set("cancelDate", v)}
                  />
                </div>
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => setStep(1)}
              style={{
                flex: 1,
                padding: "12px",
                borderRadius: 10,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ← Back
            </button>
            <button
              disabled={!s2ok}
              onClick={() => {
                setEditPhases([]);
                setStep(3);
              }}
              style={{
                ...S.btn,
                flex: 2,
                padding: "12px",
                fontSize: 14,
                opacity: s2ok ? 1 : 0.5,
              }}
            >
              Preview Timeline →
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 16 }}>
            Step 3 of 3 — Review & Edit Timeline
          </div>
          <div style={{ ...S.card, marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: TH.text,
                    marginBottom: 2,
                  }}
                >
                  {form.collection}
                </div>
                <div style={{ fontSize: 12, color: TH.textMuted }}>
                  {brand.name} · {form.gender} · {form.season} {form.year} ·{" "}
                  {form.category}
                </div>
                {form.customer && (
                  <div
                    style={{
                      fontSize: 12,
                      color: TH.primary,
                      fontWeight: 600,
                      marginTop: 2,
                    }}
                  >
                    {form.customer} · {form.orderType}
                  </div>
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,1fr)",
                  gap: 10,
                  textAlign: "center",
                }}
              >
                {[
                  ["DDP", form.ddpDate, TH.primary],
                  ["Ship", form.customerShipDate, "#065F46"],
                  ["Cancel", form.cancelDate, "#B91C1C"],
                ].map(([l, d, c]) => (
                  <div key={l}>
                    <div style={{ fontSize: 10, color: TH.textMuted }}>{l}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: c }}>
                      {formatDate(d)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 11, color: TH.textMuted, marginBottom: 8 }}>
            💡 Edit any date or days-back value — all later phases adjust
            automatically. DDP changes require approval.
          </div>
          <div
            style={{
              overflowY: "auto",
              marginBottom: 18,
              border: `1px solid ${TH.border}`,
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 110px 130px 110px 110px",
                gap: 0,
                padding: "8px 14px",
                background: TH.header,
                borderBottom: `1px solid ${TH.border}44`,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                Phase
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  textAlign: "center",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                Days to Complete
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  textAlign: "center",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                Due Date
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  textAlign: "center",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                Days To DDP
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  textAlign: "center",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                From Prev Task
              </span>
            </div>
            {editPhases.map((ep, i) => {
              const days = getDaysUntil(ep.due);
              const isPL =
                ep.name === "Line Review" || ep.name === "Compliance/Testing";
              const isDDP = ep.name === "DDP";
              const isPast = ep.due < todayStr && !isDDP;
              const dtcColor =
                days < 0
                  ? "#B91C1C"
                  : days <= 7
                  ? "#B45309"
                  : days <= 14
                  ? "#D97706"
                  : "#065F46";
              const dtcLabel =
                days < 0
                  ? `${Math.abs(days)}d overdue`
                  : days === 0
                  ? "Due today"
                  : `${days}d`;
              return (
                <div
                  key={ep.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 110px 130px 110px 110px",
                    gap: 0,
                    padding: "9px 14px",
                    background: isPast
                      ? "#FEF2F2"
                      : isDDP
                      ? TH.primary + "20"
                      : isPL
                      ? "#F5F3FF"
                      : i % 2 === 0
                      ? "#F9FAFB"
                      : "#FFFFFF",
                    borderBottom: `1px solid ${isPast ? "#FCA5A5" : TH.border}`,
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 5,
                        background: brand.color + "22",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        color: brand.color,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {i + 1}
                    </div>
                    <span
                      style={{
                        fontSize: 14,
                        color: isDDP ? TH.primary : TH.text,
                        fontWeight: isDDP ? 700 : 600,
                      }}
                    >
                      {ep.name}
                    </span>
                    {isPL && (
                      <span
                        style={{
                          fontSize: 9,
                          color: "#6D28D9",
                          background: "#F5F3FF",
                          border: "1px solid #C4B5FD",
                          padding: "1px 5px",
                          borderRadius: 4,
                        }}
                      >
                        PL
                      </span>
                    )}
                    {ep.edited && (
                      <span
                        style={{
                          fontSize: 9,
                          color: TH.primary,
                          background: TH.primary + "15",
                          padding: "1px 5px",
                          borderRadius: 4,
                        }}
                      >
                        edited
                      </span>
                    )}
                    {isPast && (
                      <span
                        style={{
                          fontSize: 9,
                          color: "#B91C1C",
                          background: "#FEF2F2",
                          border: "1px solid #FCA5A5",
                          padding: "1px 5px",
                          borderRadius: 4,
                        }}
                      >
                        ⚠️ past
                      </span>
                    )}
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: dtcColor,
                        background: dtcColor + "15",
                        borderRadius: 6,
                        padding: "3px 8px",
                        display: "inline-block",
                      }}
                    >
                      {dtcLabel}
                    </span>
                  </div>
                  <div style={{ textAlign: "center", overflow: "hidden", paddingLeft: 4, paddingRight: 4 }}>
                    <DeferredDateInput
                      value={ep.due}
                      onCommit={(v) => updatePhaseDue(i, v)}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "5px 4px",
                        borderRadius: 6,
                        border: `1px solid ${TH.border}`,
                        background: isDDP ? TH.primary + "20" : "#FFFFFF",
                        color: isDDP ? TH.primary : TH.text,
                        fontFamily: "inherit",
                        fontSize: 11,
                        outline: "none",
                      }}
                    />
                  </div>
                  <div style={{ textAlign: "center", paddingLeft: 4, paddingRight: 4 }}>
                    {isDDP ? (
                      <span
                        style={{
                          fontSize: 13,
                          color: TH.primary,
                          fontWeight: 700,
                        }}
                      >
                        0
                      </span>
                    ) : (
                      <DaysBackInput
                        value={ep.daysBack}
                        onCommit={(v) => updatePhaseDaysBack(i, v)}
                      />
                    )}
                  </div>
                  {/* From Prev Task — editable, updates due date */}
                  <div style={{ textAlign: "center" }}>
                    {i === 0 ? (
                      <span style={{ fontSize: 12, color: TH.textMuted }}>—</span>
                    ) : (() => {
                      const prevDue = editPhases[i - 1]?.due;
                      const fromPrev = prevDue ? diffDays(ep.due, prevDue) : null;
                      return (
                        <input
                          type="number"
                          min="0"
                          value={fromPrev ?? ""}
                          onChange={(e) => {
                            const n = parseInt(e.target.value);
                            if (isNaN(n) || n < 0) return;
                            const newDue = addDays(editPhases[i - 1].due, n);
                            updatePhaseDue(i, newDue);
                          }}
                          style={{
                            width: 64,
                            padding: "4px 6px",
                            borderRadius: 6,
                            border: `1px solid ${TH.border}`,
                            background: "#FFFFFF",
                            color: TH.text,
                            fontFamily: "inherit",
                            fontSize: 12,
                            textAlign: "center",
                            outline: "none",
                          }}
                        />
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>

          {ddpWarn && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2100, padding: 16 }}>
              <div style={{ background: "#FFFFFF", border: `1px solid ${TH.accentBdr}`, borderRadius: 16, padding: 32, maxWidth: 520, width: "100%", boxShadow: "0 40px 100px rgba(0,0,0,0.4)" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: TH.text, marginBottom: 12 }}>⚠️ DDP Date Will Change</div>
                <div style={{ fontSize: 13, color: TH.textMuted, lineHeight: 1.65, marginBottom: 20 }}>
                  {ddpWarn.cascade ? (
                    <>
                      This change affects{" "}
                      <strong>{ddpWarn.affectedCount} phase{ddpWarn.affectedCount !== 1 ? "s" : ""}</strong> and would push the{" "}
                      <strong>DDP date</strong> from{" "}
                      <strong style={{ color: TH.primary }}>{formatDate(ddpWarn.oldDDP)}</strong> to{" "}
                      <strong style={{ color: "#B91C1C" }}>{formatDate(ddpWarn.newDDP)}</strong>.
                    </>
                  ) : (
                    <>
                      You are changing the <strong>DDP date</strong> from{" "}
                      <strong style={{ color: TH.primary }}>{formatDate(ddpWarn.oldDDP)}</strong> to{" "}
                      <strong style={{ color: "#B91C1C" }}>{formatDate(ddpWarn.newDue)}</strong>.
                    </>
                  )}
                  <br /><br />How would you like to handle this?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Option 1: Accept new DDP — cascade all later phases */}
                  <button
                    onClick={() => { applyPhaseDue(ddpWarn.idx, ddpWarn.newDue); setDdpWarn(null); }}
                    style={{ padding: "12px 20px", borderRadius: 10, border: "none", background: `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`, color: "#fff", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left" }}
                  >
                    ✓ Accept New DDP Date —{" "}
                    <span style={{ fontWeight: 400 }}>{formatDate(ddpWarn.newDDP || ddpWarn.newDue)}</span>
                  </button>
                  {/* Option 2: Proportionally resize phases — keep DDP fixed */}
                  {ddpWarn.cascade && (
                    <button
                      onClick={() => { proportionalResizePhases(ddpWarn.idx, ddpWarn.newDue); setDdpWarn(null); }}
                      style={{ padding: "12px 20px", borderRadius: 10, border: `2px solid ${TH.primary}`, background: TH.primary + "10", color: TH.primary, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left" }}
                    >
                      ⚖️ Proportionally Resize Phase Durations —{" "}
                      <span style={{ fontWeight: 400 }}>keep DDP {formatDate(ddpWarn.oldDDP)}</span>
                    </button>
                  )}
                  {/* Option 3: Keep DDP — only move this phase, no cascade */}
                  <button
                    onClick={() => {
                      setEditPhases((prev) => prev.map((p, i) =>
                        i === ddpWarn.idx
                          ? { ...p, due: ddpWarn.newDue, daysBack: diffDays(form.ddpDate, ddpWarn.newDue), edited: true }
                          : p
                      ));
                      setDdpWarn(null);
                    }}
                    style={{ padding: "12px 20px", borderRadius: 10, border: "2px solid #065F46", background: "#ECFDF5", color: "#065F46", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left" }}
                  >
                    📌 Keep DDP as-is —{" "}
                    <span style={{ fontWeight: 400 }}>only update this phase's date</span>
                  </button>
                  {/* Option 4: Cancel */}
                  <button
                    onClick={() => setDdpWarn(null)}
                    style={{ padding: "10px 20px", borderRadius: 10, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}
                  >
                    Cancel — keep original date
                  </button>
                </div>
              </div>
            </div>
          )}

          {creationDateWarn && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.55)",
                backdropFilter: "blur(6px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 2100,
                padding: 16,
              }}
            >
              <div
                style={{
                  background: "#FFFFFF",
                  border: `1px solid ${TH.accentBdr}`,
                  borderRadius: 16,
                  padding: 32,
                  maxWidth: 500,
                  width: "100%",
                  boxShadow: "0 40px 100px rgba(0,0,0,0.4)",
                }}
              >
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: TH.text,
                    marginBottom: 12,
                  }}
                >
                  📅 Timeline Starts Before Today
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: TH.textMuted,
                    lineHeight: 1.65,
                    marginBottom: 20,
                  }}
                >
                  Using today as the first task date would push the{" "}
                  <strong>DDP date</strong> from&nbsp;
                  <strong style={{ color: TH.primary }}>
                    {formatDate(creationDateWarn.oldDDP)}
                  </strong>{" "}
                  to&nbsp;
                  <strong style={{ color: "#B91C1C" }}>
                    {formatDate(creationDateWarn.newDDP)}
                  </strong>
                  .<br />
                  <br />
                  How would you like to handle this?
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 10 }}
                >
                  <button
                    onClick={() => {
                      // Accept new DDP: use clamped phases as-is, update form DDP
                      const newDDP = creationDateWarn.newDDP;
                      set("ddpDate", newDDP);
                      set("customerShipDate", addDays(newDDP, 24));
                      set("cancelDate", addDays(addDays(newDDP, 24), 6));
                      setEditPhases(creationDateWarn.clampedPhases);
                      setCreationDateWarn(null);
                    }}
                    style={{
                      padding: "12px 20px",
                      borderRadius: 10,
                      border: "none",
                      background: `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`,
                      color: "#fff",
                      fontWeight: 700,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 13,
                      textAlign: "left",
                    }}
                  >
                    ✓ Accept New DDP Date —{" "}
                    <span style={{ fontWeight: 400 }}>
                      {formatDate(creationDateWarn.newDDP)}
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      // Proportionally resize pre-production phases to fit today → DDP
                      const resized = applyProportionalResize(
                        creationDateWarn.rawPhases
                      );
                      setEditPhases(resized);
                      setCreationDateWarn(null);
                    }}
                    style={{
                      padding: "12px 20px",
                      borderRadius: 10,
                      border: `2px solid ${TH.primary}`,
                      background: TH.primary + "10",
                      color: TH.primary,
                      fontWeight: 700,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 13,
                      textAlign: "left",
                    }}
                  >
                    ⚖️ Proportionally Resize Task Durations —{" "}
                    <span style={{ fontWeight: 400 }}>
                      keep DDP {formatDate(creationDateWarn.oldDDP)}
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      // Keep DDP as-is: use raw phases unchanged, DDP stays fixed
                      setEditPhases(creationDateWarn.rawPhases);
                      setCreationDateWarn(null);
                    }}
                    style={{
                      padding: "12px 20px",
                      borderRadius: 10,
                      border: "2px solid #065F46",
                      background: "#ECFDF5",
                      color: "#065F46",
                      fontWeight: 700,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 13,
                      textAlign: "left",
                    }}
                  >
                    📌 Keep DDP as-is —{" "}
                    <span style={{ fontWeight: 400 }}>
                      use original dates, edit manually
                    </span>
                  </button>
                  <button
                    onClick={() => setCreationDateWarn(null)}
                    style={{
                      padding: "10px 20px",
                      borderRadius: 10,
                      border: `1px solid ${TH.border}`,
                      background: "none",
                      color: TH.textMuted,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 13,
                    }}
                  >
                    Cancel — I'll adjust dates manually
                  </button>
                </div>
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => {
                setEditPhases([]);
                setStep(2);
              }}
              style={{
                flex: 1,
                padding: "12px",
                borderRadius: 10,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ← Back
            </button>
            <button
              onClick={() =>
                onSave(buildFinalTasks(), {
                  gender: form.gender,
                  year: form.year,
                  customerShipDate: form.customerShipDate,
                  cancelDate: form.cancelDate,
                  customer: form.customer,
                  orderType: form.orderType,
                  channelType: form.channelType,
                  sampleDueDate: form.sampleDueDate,
                })
              }
              style={{ ...S.btn, flex: 2, padding: "12px", fontSize: 14 }}
            >
              ✓ Create {editPhases.length} Tasks
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CATEGORY MANAGER ────────────────────────────────────────────────────────
function CategoryManager({ categories, setCategories }) {
  const [newCat, setNewCat] = useState("");
  const [newSub, setNewSub] = useState({});
  const [editCat, setEditCat] = useState(null); // {id, name}
  const [editName, setEditName] = useState("");

  function addCategory() {
    const name = newCat.trim();
    if (!name || categories.find((c) => c.name === name)) return;
    setCategories((cs) => [...cs, { id: uid(), name, subCategories: [] }]);
    setNewCat("");
  }
  function deleteCategory(id) {
    setCategories((cs) => cs.filter((c) => c.id !== id));
  }
  function renameCategory(id, name) {
    setCategories((cs) => cs.map((c) => (c.id === id ? { ...c, name } : c)));
    setEditCat(null);
  }
  function addSubCategory(catId) {
    const name = (newSub[catId] || "").trim();
    if (!name) return;
    setCategories((cs) =>
      cs.map((c) =>
        c.id === catId && !c.subCategories.includes(name)
          ? { ...c, subCategories: [...c.subCategories, name] }
          : c
      )
    );
    setNewSub((s) => ({ ...s, [catId]: "" }));
  }
  function deleteSubCategory(catId, sub) {
    setCategories((cs) =>
      cs.map((c) =>
        c.id === catId
          ? { ...c, subCategories: c.subCategories.filter((s) => s !== sub) }
          : c
      )
    );
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: TH.textMuted, marginBottom: 16 }}>
        Manage categories and sub-categories used across vendors and SKUs.
      </div>
      {/* Add new category */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        <input
          style={{ ...S.inp, marginBottom: 0, flex: 1 }}
          placeholder="New category name..."
          value={newCat}
          onChange={(e) => setNewCat(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCategory()}
        />
        <button
          onClick={addCategory}
          style={{ ...S.btn, whiteSpace: "nowrap" }}
        >
          + Add Category
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {categories.map((cat) => (
          <div key={cat.id} style={{ ...S.card, padding: "14px 16px" }}>
            {/* Category header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 10,
              }}
            >
              {editCat === cat.id ? (
                <>
                  <input
                    autoFocus
                    style={{
                      ...S.inp,
                      marginBottom: 0,
                      flex: 1,
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameCategory(cat.id, editName);
                      if (e.key === "Escape") setEditCat(null);
                    }}
                  />
                  <button
                    onClick={() => renameCategory(cat.id, editName)}
                    style={{ ...S.btn, padding: "5px 12px", fontSize: 12 }}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditCat(null)}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 7,
                      border: `1px solid ${TH.border}`,
                      background: "none",
                      color: TH.textMuted,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 12,
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 15,
                      fontWeight: 700,
                      color: TH.text,
                    }}
                  >
                    {cat.name}
                  </span>
                  <button
                    onClick={() => {
                      setEditCat(cat.id);
                      setEditName(cat.name);
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: `1px solid ${TH.border}`,
                      background: "none",
                      color: TH.textMuted,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 12,
                    }}
                  >
                    ✏️ Rename
                  </button>
                  <button
                    onClick={() => deleteCategory(cat.id)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid #FCA5A5",
                      background: "none",
                      color: "#B91C1C",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 12,
                    }}
                  >
                    🗑️ Delete
                  </button>
                </>
              )}
            </div>
            {/* Sub-categories */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginBottom: 8,
              }}
            >
              {(cat.subCategories || []).map((sub) => (
                <div
                  key={sub}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 10px",
                    borderRadius: 16,
                    border: `1px solid ${TH.border}`,
                    background: TH.surfaceHi,
                    fontSize: 12,
                    color: TH.textSub,
                  }}
                >
                  {sub}
                  <button
                    onClick={() => deleteSubCategory(cat.id, sub)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#B91C1C",
                      cursor: "pointer",
                      fontSize: 13,
                      lineHeight: 1,
                      padding: "0 0 0 3px",
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {(cat.subCategories || []).length === 0 && (
                <span
                  style={{
                    fontSize: 12,
                    color: TH.textMuted,
                    fontStyle: "italic",
                  }}
                >
                  No sub-categories yet
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{
                  ...S.inp,
                  marginBottom: 0,
                  flex: 1,
                  fontSize: 12,
                  padding: "5px 10px",
                }}
                placeholder="Add sub-category..."
                value={newSub[cat.id] || ""}
                onChange={(e) =>
                  setNewSub((s) => ({ ...s, [cat.id]: e.target.value }))
                }
                onKeyDown={(e) => e.key === "Enter" && addSubCategory(cat.id)}
              />
              <button
                onClick={() => addSubCategory(cat.id)}
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: `1px solid ${TH.primary}`,
                  background: TH.primary + "12",
                  color: TH.primary,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                + Sub
              </button>
            </div>
          </div>
        ))}
        {categories.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: TH.textMuted,
              padding: "24px",
              fontSize: 13,
              border: `1px dashed ${TH.border}`,
              borderRadius: 10,
            }}
          >
            No categories yet. Add one above.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SIZE LIBRARY ─────────────────────────────────────────────────────────────
function SizeLibrary({ sizes, setSizes }) {
  const [newSize, setNewSize] = useState("");
  function addSize() {
    const s = newSize.trim().toUpperCase();
    if (!s || sizes.includes(s)) {
      setNewSize("");
      return;
    }
    setSizes((sz) => [...sz, s]);
    setNewSize("");
  }
  return (
    <div>
      <div style={{ fontSize: 13, color: TH.textMuted, marginBottom: 16 }}>
        Manage available sizes shown in SKU editor. Changes apply to new
        collections.
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 20,
          padding: "16px",
          background: TH.surfaceHi,
          borderRadius: 10,
          border: `1px solid ${TH.border}`,
        }}
      >
        {[...sizes]
          .sort((a, b) => {
            const na = parseFloat(a),
              nb = parseFloat(b);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            if (!isNaN(na)) return 1;
            if (!isNaN(nb)) return -1;
            return 0;
          })
          .map((sz) => (
            <div
              key={sz}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "5px 10px",
                borderRadius: 20,
                border: `1px solid ${TH.border}`,
                background: TH.surface,
                fontSize: 13,
                fontWeight: 600,
                color: TH.text,
              }}
            >
              {sz}
              <button
                onClick={() => setSizes((s) => s.filter((x) => x !== sz))}
                style={{
                  background: "none",
                  border: "none",
                  color: "#B91C1C",
                  cursor: "pointer",
                  fontSize: 14,
                  lineHeight: 1,
                  padding: "0 0 0 4px",
                }}
              >
                ×
              </button>
            </div>
          ))}
        {sizes.length === 0 && (
          <span style={{ color: TH.textMuted, fontSize: 13 }}>
            No sizes. Add some below.
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <input
          style={{ ...S.inp, marginBottom: 0, flex: 1 }}
          placeholder="e.g. 4XL or 40"
          value={newSize}
          onChange={(e) => setNewSize(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addSize()}
        />
        <button onClick={addSize} style={{ ...S.btn, whiteSpace: "nowrap" }}>
          + Add Size
        </button>
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{ fontSize: 12, color: TH.textMuted, alignSelf: "center" }}
        >
          Quick add:
        </span>
        {[
          ["Numeric Denim", "28,29,30,31,32,33,34,36,38"],
          ["Alpha Basics", "XS,S,M,L,XL,XXL"],
          ["Extended", "XS,S,M,L,XL,XXL,2XL,3XL,4XL"],
          ["Kids", "4,6,8,10,12,14,16"],
        ].map(([label, vals]) => (
          <button
            key={label}
            onClick={() => {
              const toAdd = vals
                .split(",")
                .filter((v) => !sizes.includes(v.trim()));
              setSizes((s) => [...s, ...toAdd]);
            }}
            style={{
              padding: "4px 12px",
              borderRadius: 16,
              border: `1px solid ${TH.primary}`,
              background: TH.primary + "10",
              color: TH.primary,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        style={{
          marginTop: 16,
          padding: "10px 14px",
          background: "#FFFBEB",
          border: "1px solid #FCD34D",
          borderRadius: 8,
          fontSize: 12,
          color: "#92400E",
        }}
      >
        💡 To reset to defaults:{" "}
        <button
          onClick={() => setSizes(DEFAULT_SIZES)}
          style={{
            background: "none",
            border: "none",
            color: TH.primary,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 12,
            textDecoration: "underline",
            padding: 0,
          }}
        >
          Restore defaults
        </button>
      </div>
    </div>
  );
}

// ─── EDIT COLLECTION MODAL ───────────────────────────────────────────────────
function EditCollectionModal({
  collKey,
  collMap,
  collections,
  tasks,
  setTasks,
  setCollections,
  seasons,
  customerList,
  orderTypes,
  onClose,
}) {
  const coll = collMap[collKey];
  if (!coll) return null;
  const meta = collections[collKey] || {};
  const ddpTaskDate = coll.tasks?.find((t) => t.phase === "DDP")?.due || "";
  const [f, setF] = useState({
    collectionName: coll.collection || "",
    brand: coll.brand || "ring-of-fire",
    season: coll.season || "Fall",
    year: meta.year || new Date().getFullYear(),
    gender: meta.gender || "Men's",
    category: coll.category || "Denim",
    customer: meta.customer || "",
    orderType: meta.orderType || "",
    channelType: meta.channelType || "",
    customerShipDate: meta.customerShipDate || "",
    cancelDate: meta.cancelDate || "",
    ddpDate: meta.ddpDate || ddpTaskDate,
    sampleDueDate: meta.sampleDueDate || "",
  });
  const set = (k, v) =>
    setF((x) => {
      const next = { ...x, [k]: v };
      if (k === "ddpDate" && v) {
        next.customerShipDate = addDays(v, 24);
        next.cancelDate = addDays(addDays(v, 24), 6);
      }
      return next;
    });
  useEffect(() => {
    if (f.customer) {
      const ch = getChannelForCustomer(f.customer);
      if (ch && !f.channelType) set("channelType", ch);
    }
  }, [f.customer]);
  function save() {
    const collTasks = tasks.filter(
      (t) => `${t.brand}||${t.collection}` === collKey
    );
    const ddpTask = collTasks.find((t) => t.phase === "DDP");
    const oldDDP = ddpTask?.due || "";
    const newDDP = f.ddpDate;
    let updatedTasks = tasks.map((t) =>
      `${t.brand}||${t.collection}` === collKey
        ? {
            ...t,
            brand: f.brand,
            season: f.season,
            category: f.category,
            collection: f.collectionName,
            customer: f.customer,
            orderType: f.orderType,
            channelType: f.channelType,
          }
        : t
    );
    if (newDDP && oldDDP && newDDP !== oldDDP) {
      const shift = Math.round(
        (new Date(newDDP) - new Date(oldDDP)) / 86400000
      );
      updatedTasks = updatedTasks.map((t) => {
        if (`${t.brand}||${t.collection}` !== collKey) return t;
        const shiftedDue = addDays(t.due, shift);
        return {
          ...t,
          due: shiftedDue,
          ddpDate: t.phase === "DDP" ? newDDP : t.ddpDate,
        };
      });
    }
    setTasks(updatedTasks);
    setCollections((c) => ({
      ...c,
      [collKey]: {
        ...(c[collKey] || {}),
        customer: f.customer,
        orderType: f.orderType,
        channelType: f.channelType,
        customerShipDate: f.customerShipDate,
        cancelDate: f.cancelDate,
        ddpDate: newDDP,
        gender: f.gender,
        year: f.year,
        sampleDueDate: f.sampleDueDate,
      },
    }));
    onClose();
  }
  return (
    <Modal
      title={`Edit Collection — ${coll.collection}`}
      onClose={onClose}
      wide
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div>
          <label style={S.lbl}>Collection Name</label>
          <input
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.collectionName}
            onChange={(e) => set("collectionName", e.target.value)}
          />
        </div>
        <div>
          <label style={S.lbl}>Brand</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.brand}
            onChange={(e) => set("brand", e.target.value)}
          >
            {BRANDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.isPrivateLabel ? " (PL)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div>
          <label style={S.lbl}>Season</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.season}
            onChange={(e) => set("season", e.target.value)}
          >
            {seasons.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Year</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.year}
            onChange={(e) => set("year", parseInt(e.target.value))}
          >
            {[2024, 2025, 2026, 2027, 2028].map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Gender</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.gender}
            onChange={(e) => set("gender", e.target.value)}
          >
            {GENDERS.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Category</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.category}
            onChange={(e) => set("category", e.target.value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div>
          <label style={S.lbl}>Customer</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.customer}
            onChange={(e) => set("customer", e.target.value)}
          >
            <option value="">-- Select --</option>
            {(customerList || DEFAULT_CUSTOMERS).map((c) => {
              const name = typeof c === "string" ? c : c.name;
              return <option key={name} value={name}>{name}</option>;
            })}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Order Type</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.orderType}
            onChange={(e) => set("orderType", e.target.value)}
          >
            <option value="">--</option>
            {orderTypes.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
      </div>
      <label style={S.lbl}>Channel Type</label>
      <select
        style={S.inp}
        value={f.channelType}
        onChange={(e) => set("channelType", e.target.value)}
      >
        <option value="">--</option>
        {CHANNEL_TYPES.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14 }}
      >
        <div>
          <label style={S.lbl}>DDP Date</label>
          <DateInput
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.ddpDate}
            onChange={(v) => set("ddpDate", v)}
          />
        </div>
        <div>
          <label style={S.lbl}>Sample Due Date</label>
          <DateInput
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.sampleDueDate}
            onChange={(v) => set("sampleDueDate", v)}
          />
        </div>
        <div>
          <label style={S.lbl}>Customer Ship Date</label>
          <DateInput
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.customerShipDate}
            onChange={(v) => set("customerShipDate", v)}
          />
        </div>
        <div>
          <label style={S.lbl}>Cancel Date</label>
          <DateInput
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.cancelDate}
            onChange={(v) => set("cancelDate", v)}
          />
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 12,
          justifyContent: "flex-end",
          marginTop: 20,
        }}
      >
        <button
          onClick={onClose}
          style={{
            padding: "10px 20px",
            borderRadius: 8,
            border: `1px solid ${TH.border}`,
            background: "none",
            color: TH.textMuted,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Cancel
        </button>
        <button onClick={save} style={S.btn}>
          Save Collection
        </button>
      </div>
    </Modal>
  );
}

// ─── ADD TASK MODAL ───────────────────────────────────────────────────────────
function AddTaskModal({ tasks, vendors, team, collections, onSave, onClose }) {
  const collOptions = [
    ...new Set(tasks.map((t) => `${t.brand}||${t.collection}`)),
  ];
  const todayStr = new Date().toISOString().split("T")[0];
  const [form, setForm] = useState({
    collKey: collOptions[0] || "",
    phase: "Custom",
    due: todayStr,
    status: "Not Started",
    assigneeId: "",
    notes: "",
  });
  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  function handleSave() {
    if (!form.collKey || !form.phase || !form.due) return;
    const [brand, collection] = form.collKey.split("||");
    const refTask = tasks.find(
      (t) => t.brand === brand && t.collection === collection
    );
    const newTask = {
      id: uid(),
      brand,
      collection,
      phase: form.phase,
      due: form.due,
      originalDue: form.due,
      status: form.status,
      assigneeId: form.assigneeId || null,
      notes: form.notes,
      season: refTask?.season || "",
      year: refTask?.year || new Date().getFullYear(),
      gender: refTask?.gender || "",
      category: refTask?.category || "",
      vendorId: refTask?.vendorId || null,
      ddpDate: refTask?.ddpDate || "",
      deliveryDate: refTask?.deliveryDate || "",
      customerShipDate: refTask?.customerShipDate || "",
      customer: refTask?.customer || "",
      orderType: refTask?.orderType || "",
      channelType: refTask?.channelType || "",
      images: refTask?.images || [],
      skus: [],
      isCustomTask: true,
    };
    onSave(newTask);
  }

  return (
    <Modal title="Add Task to Timeline" onClose={onClose}>
      <div>
        <label style={S.lbl}>Collection</label>
        <select
          style={S.inp}
          value={form.collKey}
          onChange={(e) => setF("collKey", e.target.value)}
        >
          <option value="">-- Select Collection --</option>
          {collOptions.map((k) => {
            const [brand, coll] = k.split("||");
            const bObj = getBrand(brand);
            return (
              <option key={k} value={k}>
                {bObj?.short} — {coll}
              </option>
            );
          })}
        </select>

        <label style={S.lbl}>Task / Phase Name</label>
        <input
          style={S.inp}
          value={form.phase}
          onChange={(e) => setF("phase", e.target.value)}
          placeholder="e.g. Proto Review, Lab Dip, Final Approval…"
        />

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
        >
          <div>
            <label style={S.lbl}>Due Date</label>
            <DateInput
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.due}
              onChange={(v) => setF("due", v)}
            />
          </div>
          <div>
            <label style={S.lbl}>Status</label>
            <select
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.status}
              onChange={(e) => setF("status", e.target.value)}
            >
              {Object.keys(STATUS_CONFIG).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ height: 14 }} />

        <label style={S.lbl}>Assignee</label>
        <select
          style={S.inp}
          value={form.assigneeId}
          onChange={(e) => setF("assigneeId", e.target.value)}
        >
          <option value="">-- None --</option>
          {team.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.role})
            </option>
          ))}
        </select>

        <label style={S.lbl}>Notes</label>
        <textarea
          style={{ ...S.inp, height: 72, resize: "vertical" } as any}
          value={form.notes}
          onChange={(e) => setF("notes", e.target.value)}
          placeholder="Optional notes…"
        />

        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            marginTop: 6,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "9px 22px",
              borderRadius: 8,
              border: `1px solid ${TH.border}`,
              background: "none",
              color: TH.textSub,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!form.collKey || !form.phase || !form.due}
            style={{
              ...S.btn,
              opacity: !form.collKey || !form.phase || !form.due ? 0.5 : 1,
            }}
          >
            Add Task
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── IMAGE GALLERY MODAL ──────────────────────────────────────────────────────
function ImageGalleryModal({ title, images, onClose }) {
  const [lightbox, setLightbox] = useState(null); // index of enlarged image

  function handleDownload(img) {
    if (!img.src) return;
    const a = document.createElement("a");
    a.href = img.src;
    a.download = img.title || img.name || "image";
    a.click();
  }

  function copyLink() {
    // Generate the blob URL and copy to clipboard
    const url = buildGalleryUrl();
    navigator.clipboard?.writeText(url).catch(() => {});
    // Brief visual feedback handled by caller
  }

  function buildGalleryUrl() {
    const cards = images
      .map((img, idx) => {
        const metaRows = img.meta
          ? Object.entries(img.meta)
              .filter(([, v]) => v)
              .map(
                ([k, v]) =>
                  `<tr><td style="font-size:10px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.06em;padding:2px 8px 2px 0;white-space:nowrap">${k}</td><td style="font-size:10px;color:rgba(255,255,255,0.82);font-weight:600;padding:2px 0">${v}</td></tr>`
              )
              .join("")
          : "";
        const name = (img.title || img.name || `Image ${idx + 1}`).replace(
          /"/g,
          "&quot;"
        );
        return `<div class="card" data-idx="${idx}">
        <div class="img-wrap">
          ${
            img.src
              ? `<img src="${img.src}" alt="${name}" draggable="false">`
              : `<div class="no-img">🖼️</div>`
          }
        </div>
        <div class="info">
          <div class="img-title">${name}</div>
          ${
            metaRows
              ? `<table style="width:100%;border-collapse:collapse;margin-top:4px">${metaRows}</table>`
              : ""
          }
          ${img.subtitle ? `<div class="subtitle">${img.subtitle}</div>` : ""}
          <div class="actions">
            <button onclick="dlImg(${idx})">⬇ Download</button>
            <button onclick="printImg(${idx})">🖨 Print</button>
          </div>
        </div>
        <div class="ctx-menu" id="ctx-${idx}">
          <div onclick="dlImg(${idx})">⬇ Download Image</div>
          <div onclick="printImg(${idx})">🖨 Print Image</div>
          <div onclick="copyImgUrl(${idx})">🔗 Copy Image URL</div>
        </div>
      </div>`;
      })
      .join("");

    const srcs = JSON.stringify(
      images.map((i) => ({
        src: i.src || "",
        title: i.title || i.name || "image",
      }))
    );
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0F1117;font-family:-apple-system,'Helvetica Neue',sans-serif;padding:0}
.header{display:flex;align-items:center;justify-content:space-between;padding:12px 24px;background:#1A202C;border-bottom:1px solid rgba(255,255,255,0.1);position:sticky;top:0;z-index:10}
.header-title{font-size:15px;font-weight:800;color:#fff;letter-spacing:-.01em}
.header-count{font-size:11px;color:rgba(255,255,255,0.4);background:rgba(255,255,255,0.08);padding:2px 9px;border-radius:20px;margin-left:10px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:20px 24px}
.card{border-radius:12px;overflow:visible;background:#1A202C;border:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;cursor:pointer;position:relative;transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-3px);box-shadow:0 8px 32px rgba(0,0,0,0.6)}
.img-wrap{width:100%;aspect-ratio:3/4;overflow:hidden;background:#0F1117;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:center}
.img-wrap img{width:100%;height:100%;object-fit:cover;display:block}
.no-img{font-size:48px;opacity:.3}
.info{padding:10px 12px;border-top:1px solid rgba(255,255,255,0.08)}
.img-title{font-size:12px;font-weight:800;color:#fff;margin-bottom:4px;line-height:1.3}
.subtitle{font-size:10px;color:rgba(255,255,255,0.35);margin-top:4px}
.actions{display:flex;gap:6px;margin-top:8px}
.actions button{flex:1;padding:5px 0;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.7);font-size:10px;font-weight:600;cursor:pointer;font-family:inherit}
.actions button:hover{background:rgba(255,255,255,0.12)}
.ctx-menu{display:none;position:fixed;background:#1E2532;border:1px solid rgba(255,255,255,0.15);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.6);min-width:180px;z-index:9999;overflow:hidden;padding:4px 0}
.ctx-menu div{padding:9px 16px;font-size:12px;color:rgba(255,255,255,0.82);cursor:pointer;font-weight:500}
.ctx-menu div:hover{background:rgba(255,255,255,0.08)}
@media print{.header,.actions{display:none!important}.grid{grid-template-columns:repeat(2,1fr);gap:12px;padding:0}.card{break-inside:avoid;border:1px solid #ddd;background:#fff}.img-title{color:#000}.info{color:#333}}
</style></head>
<body>
<div class="header">
  <div style="display:flex;align-items:center">
    <span class="header-title">${title.replace(/</g, "&lt;")}</span>
    <span class="header-count">${images.length} image${
      images.length !== 1 ? "s" : ""
    }</span>
  </div>
  <button onclick="window.print()" style="padding:5px 14px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.7);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">🖨 Print All</button>
</div>
<div class="grid">${cards}</div>
<script>
const imgs=${srcs};
function dlImg(i){const a=document.createElement('a');a.href=imgs[i].src;a.download=imgs[i].title||'image';a.click();}
function printImg(i){const w=window.open('','_blank');w.document.write('<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="'+imgs[i].src+'" style="max-width:100%;max-height:100vh;object-fit:contain"><script>window.onload=()=>{window.print();window.close();}<\\/script></body></html>');w.document.close();}
function copyImgUrl(i){navigator.clipboard&&navigator.clipboard.writeText(imgs[i].src);}
let activeCtx=null;
document.querySelectorAll('.card').forEach((card,i)=>{
  card.addEventListener('contextmenu',e=>{
    e.preventDefault();
    if(activeCtx){activeCtx.style.display='none';}
    const m=document.getElementById('ctx-'+i);
    m.style.display='block';
    m.style.left=Math.min(e.clientX,window.innerWidth-190)+'px';
    m.style.top=Math.min(e.clientY,window.innerHeight-130)+'px';
    activeCtx=m;
  });
});
document.addEventListener('click',()=>{if(activeCtx){activeCtx.style.display='none';activeCtx=null;}});
</script>
</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    return URL.createObjectURL(blob);
  }

  const [copied, setCopied] = useState(false);

  function openNewTab() {
    window.open(buildGalleryUrl(), "_blank");
  }

  function handleCopyLink() {
    const url = buildGalleryUrl();
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
    // Do NOT open a new tab — just copy
  }

  return (
    <>
      {/* Full-screen — above all app chrome */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "#0F1117",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Compact header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            borderBottom: "1px solid rgba(255,255,255,0.1)",
            flexShrink: 0,
            background: "#1A202C",
            height: 36,
            minHeight: 36,
            maxHeight: 36,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "#fff",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 300,
              }}
            >
              {title}
            </span>
            <span
              style={{
                fontSize: 10,
                color: "rgba(255,255,255,0.35)",
                background: "rgba(255,255,255,0.07)",
                padding: "1px 7px",
                borderRadius: 20,
                flexShrink: 0,
              }}
            >
              {images.length}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              gap: 5,
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <button
              onClick={openNewTab}
              style={{
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 6,
                padding: "3px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 10,
                color: "rgba(255,255,255,0.65)",
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              ↗ New Tab
            </button>
            <button
              onClick={handleCopyLink}
              style={{
                background: copied
                  ? "rgba(16,185,129,0.15)"
                  : "rgba(255,255,255,0.07)",
                border: `1px solid ${
                  copied ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.12)"
                }`,
                borderRadius: 6,
                padding: "3px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 10,
                color: copied
                  ? "rgba(52,211,153,0.9)"
                  : "rgba(255,255,255,0.65)",
                fontWeight: 600,
                whiteSpace: "nowrap",
                transition: "all 0.2s",
              }}
            >
              {copied ? "✓ Copied!" : "🔗 Copy Link"}
            </button>
            <button
              onClick={onClose}
              style={{
                background: "rgba(220,38,38,0.12)",
                border: "1px solid rgba(220,38,38,0.3)",
                borderRadius: 6,
                padding: "3px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 10,
                color: "rgba(252,129,129,0.85)",
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          {images.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                color: "rgba(255,255,255,0.3)",
                padding: "100px 0",
                fontSize: 16,
              }}
            >
              No images found.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 20,
              }}
            >
              {images.map((img, idx) => (
                <div
                  key={img.id || idx}
                  style={{
                    borderRadius: 14,
                    overflow: "hidden",
                    background: "#1A202C",
                    border: "1px solid rgba(255,255,255,0.1)",
                    boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
                    display: "flex",
                    flexDirection: "column",
                    cursor: "pointer",
                    transition: "transform 0.15s, box-shadow 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.transform =
                      "translateY(-3px)";
                    (e.currentTarget as HTMLDivElement).style.boxShadow =
                      "0 8px 32px rgba(0,0,0,0.6)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.transform =
                      "none";
                    (e.currentTarget as HTMLDivElement).style.boxShadow =
                      "0 4px 20px rgba(0,0,0,0.4)";
                  }}
                  onClick={() => setLightbox(idx)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    handleDownload(img);
                  }}
                  title="Click to enlarge · Right-click to download"
                >
                  {/* Vertical image — 3:4 portrait ratio */}
                  <div
                    style={{
                      width: "100%",
                      aspectRatio: "3/4",
                      overflow: "hidden",
                      background: "#0F1117",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative",
                    }}
                  >
                    {img.src ? (
                      <img
                        src={img.src}
                        alt={img.title || img.name || "Image"}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                        draggable={false}
                      />
                    ) : (
                      <span style={{ fontSize: 56, opacity: 0.3 }}>🖼️</span>
                    )}
                    {/* Hover overlay hint */}
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(0,0,0,0)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        transition: "background 0.15s",
                      }}
                      className="img-overlay"
                    />
                  </div>
                  {/* Info panel */}
                  <div
                    style={{
                      padding: "12px 14px",
                      borderTop: "1px solid rgba(255,255,255,0.08)",
                      flex: 1,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: "#fff",
                        marginBottom: 4,
                        lineHeight: 1.3,
                      }}
                    >
                      {img.title || img.name || `Image ${idx + 1}`}
                    </div>
                    {img.meta &&
                      Object.entries(img.meta).map(([k, v]) =>
                        v ? (
                          <div
                            key={k}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              marginBottom: 2,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 10,
                                color: "rgba(255,255,255,0.4)",
                                textTransform: "uppercase",
                                letterSpacing: "0.06em",
                              }}
                            >
                              {k}
                            </span>
                            <span
                              style={{
                                fontSize: 10,
                                color: "rgba(255,255,255,0.75)",
                                fontWeight: 600,
                              }}
                            >
                              {v as string}
                            </span>
                          </div>
                        ) : null
                      )}
                    {img.subtitle && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "rgba(255,255,255,0.4)",
                          marginTop: 4,
                        }}
                      >
                        {img.subtitle}
                      </div>
                    )}
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 9,
                        color: "rgba(255,255,255,0.2)",
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>Click to enlarge</span>
                      <span>Right-click to download</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lightbox !== null && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1200,
            background: "rgba(0,0,0,0.92)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
          onClick={() => setLightbox(null)}
        >
          <button
            style={{
              position: "fixed",
              left: 20,
              top: "50%",
              transform: "translateY(-50%)",
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: "50%",
              width: 48,
              height: 48,
              cursor: "pointer",
              color: "#fff",
              fontSize: 22,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={(e) => {
              e.stopPropagation();
              setLightbox((i) => (i - 1 + images.length) % images.length);
            }}
          >
            ‹
          </button>

          <div
            style={{
              maxWidth: "80vw",
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={images[lightbox]?.src}
              alt={images[lightbox]?.title || ""}
              style={{
                maxWidth: "100%",
                maxHeight: "75vh",
                objectFit: "contain",
                borderRadius: 12,
                boxShadow: "0 20px 60px rgba(0,0,0,0.8)",
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                handleDownload(images[lightbox]);
              }}
              draggable={false}
            />
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "#fff",
                  marginBottom: 4,
                }}
              >
                {images[lightbox]?.title ||
                  images[lightbox]?.name ||
                  `Image ${lightbox + 1}`}
              </div>
              {images[lightbox]?.meta && (
                <div
                  style={{
                    display: "flex",
                    gap: 16,
                    justifyContent: "center",
                    flexWrap: "wrap",
                  }}
                >
                  {Object.entries(images[lightbox].meta).map(([k, v]) =>
                    v ? (
                      <span
                        key={k}
                        style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}
                      >
                        <span
                          style={{
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            marginRight: 4,
                          }}
                        >
                          {k}:
                        </span>
                        <span
                          style={{
                            color: "rgba(255,255,255,0.85)",
                            fontWeight: 600,
                          }}
                        >
                          {v as string}
                        </span>
                      </span>
                    ) : null
                  )}
                </div>
              )}
              <div
                style={{
                  fontSize: 11,
                  color: "rgba(255,255,255,0.3)",
                  marginTop: 8,
                }}
              >
                {lightbox + 1} / {images.length} · Right-click to download
              </div>
            </div>
          </div>

          <button
            style={{
              position: "fixed",
              right: 20,
              top: "50%",
              transform: "translateY(-50%)",
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: "50%",
              width: 48,
              height: 48,
              cursor: "pointer",
              color: "#fff",
              fontSize: 22,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={(e) => {
              e.stopPropagation();
              setLightbox((i) => (i + 1) % images.length);
            }}
          >
            ›
          </button>

          <button
            style={{
              position: "fixed",
              top: 20,
              right: 20,
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 8,
              padding: "6px 16px",
              cursor: "pointer",
              color: "rgba(255,255,255,0.7)",
              fontFamily: "inherit",
              fontSize: 13,
            }}
            onClick={() => setLightbox(null)}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

// ─── COLLECTION IMAGE BUTTON (concept / sku submenu) ─────────────────────────
function CollImageBtn({ collKey, collData, brand, collections, tasks }) {
  const [open, setOpen] = useState(false);
  const [gallery, setGallery] = useState(null); // { title, images }
  const ref = useRef(null);

  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function openConcept(e) {
    e.stopPropagation();
    setOpen(false);
    const [brandId, collName] = collKey.split("||");
    const conceptTask = tasks.find(
      (t) => `${t.brand}||${t.collection}` === collKey && t.phase === "Concept"
    );
    const imgs = (conceptTask?.images || collData?.conceptImages || []).map(
      (img) => ({
        ...img,
        title: collName,
        subtitle: "Concept Image",
        meta: {
          Brand: getBrand(brandId)?.name,
          Season: conceptTask?.season || "",
          Category: conceptTask?.category || "",
          Customer: collData?.customer || conceptTask?.customer || "",
        },
      })
    );
    setGallery({ title: `Concept Images — ${collName}`, images: imgs });
  }

  function openSkus(e) {
    e.stopPropagation();
    setOpen(false);
    const [brandId, collName] = collKey.split("||");
    const refTask = tasks.find(
      (t) => `${t.brand}||${t.collection}` === collKey
    );
    const skus = collData?.skus || [];
    const imgs = [];
    skus.forEach((sku) => {
      if (sku.images?.length) {
        sku.images.forEach((img) => {
          imgs.push({
            ...img,
            title: sku.styleNum || "SKU",
            subtitle: sku.description || "",
            meta: {
              Style: sku.styleNum || "",
              Description: sku.description || "",
              Colorways: sku.colorways || "",
              Fabric: sku.fabric || "",
              Units: sku.units ? String(sku.units) : "",
              Season: refTask?.season || "",
              Brand: getBrand(brandId)?.name || "",
              Collection: collName,
            },
          });
        });
      }
    });
    setGallery({ title: `SKU Images — ${collName}`, images: imgs });
  }

  return (
    <div ref={ref} style={{ position: "relative", flex: 1 }}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          width: "100%",
          padding: "4px 6px",
          borderRadius: 6,
          border: `1px solid ${brand.color}44`,
          background: brand.color + "12",
          color: brand.color,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 10,
          fontWeight: 700,
        }}
      >
        🖼️ Images
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            right: 0,
            background: "#1A202C",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            zIndex: 500,
            overflow: "hidden",
          }}
        >
          {[
            { label: "🎨 Concept Images", fn: openConcept },
            { label: "👕 SKU Images", fn: openSkus },
          ].map(({ label, fn }) => (
            <button
              key={label}
              onClick={fn}
              style={{
                display: "block",
                width: "100%",
                padding: "9px 12px",
                border: "none",
                background: "none",
                color: "rgba(255,255,255,0.85)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 600,
                textAlign: "left",
                borderBottom: "1px solid rgba(255,255,255,0.07)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.1)")
              }
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {gallery && (
        <ImageGalleryModal
          title={gallery.title}
          images={gallery.images}
          onClose={() => setGallery(null)}
        />
      )}
    </div>
  );
}

// ─── FILTER BAR with collapsible Brand + Season dropdowns ────────────────────
function FilterBar({
  brands,
  seasons,
  filterBrand,
  setFilterBrand,
  filterSeason,
  setFilterSeason,
  canViewAll,
}) {
  const [brandOpen, setBrandOpen] = useState(false);
  const [seasonOpen, setSeasonOpen] = useState(false);
  const brandRef = useRef(null);
  const seasonRef = useRef(null);

  useEffect(() => {
    function handle(e) {
      if (brandRef.current && !brandRef.current.contains(e.target))
        setBrandOpen(false);
      if (seasonRef.current && !seasonRef.current.contains(e.target))
        setSeasonOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function toggleBrand(id) {
    setFilterBrand((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSeason(s) {
    setFilterSeason((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  const brandCount = filterBrand.size;
  const seasonCount = filterSeason.size;

  const brandLabel =
    brandCount === 0
      ? "All Brands"
      : brandCount === 1
      ? brands.find((b) => filterBrand.has(b.id))?.short || "1 Brand"
      : `${brandCount} Brands`;

  const seasonLabel =
    seasonCount === 0
      ? "All Seasons"
      : seasonCount === 1
      ? [...filterSeason][0]
      : `${seasonCount} Seasons`;

  const dropBtn = (label, isActive, onClick) => (
    <button
      onClick={onClick}
      style={{
        padding: "5px 12px",
        borderRadius: 8,
        border: `1px solid ${
          isActive ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.15)"
        }`,
        background: isActive ? "rgba(255,255,255,0.12)" : "none",
        color: isActive ? "#fff" : "rgba(255,255,255,0.7)",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        gap: 6,
        whiteSpace: "nowrap",
        transition: "all 0.15s",
      }}
    >
      {label}
      <span style={{ fontSize: 9, opacity: 0.6 }}>▼</span>
    </button>
  );

  const multiItem = (label, isChecked, onToggle, color) => (
    <button
      key={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 14px",
        border: "none",
        background: isChecked ? "rgba(255,255,255,0.1)" : "none",
        color: "rgba(255,255,255,0.85)",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: isChecked ? 700 : 500,
        textAlign: "left",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "rgba(255,255,255,0.08)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = isChecked
          ? "rgba(255,255,255,0.1)"
          : "none")
      }
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          flexShrink: 0,
          border: `2px solid ${isChecked ? "#fff" : "rgba(255,255,255,0.3)"}`,
          background: isChecked ? "#fff" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {isChecked && (
          <span
            style={{
              fontSize: 9,
              color: "#1A202C",
              fontWeight: 900,
              lineHeight: 1,
            }}
          >
            ✓
          </span>
        )}
      </div>
      {color && (
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
      )}
      {label}
    </button>
  );

  const dropMenu: any = {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    background: "#1A202C",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 10,
    boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
    minWidth: 190,
    zIndex: 999,
    overflow: "hidden",
  };

  return (
    <div
      style={{
        padding: "10px 22px",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        display: "flex",
        gap: 8,
        alignItems: "center",
        background: "#2D3748dd",
        backdropFilter: "blur(8px)",
      }}
    >
      {/* Brand multi-select dropdown */}
      <div ref={brandRef} style={{ position: "relative" }}>
        {dropBtn(`Brand: ${brandLabel}`, brandCount > 0, () => {
          setBrandOpen((v) => !v);
          setSeasonOpen(false);
        })}
        {brandOpen && (
          <div style={dropMenu}>
            {/* All Brands — clears selection */}
            <button
              onClick={() => {
                setFilterBrand(new Set());
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "8px 14px",
                border: "none",
                background: brandCount === 0 ? "rgba(255,255,255,0.1)" : "none",
                color: brandCount === 0 ? "#fff" : "rgba(255,255,255,0.6)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: brandCount === 0 ? 700 : 500,
                borderBottom: "1px solid rgba(255,255,255,0.08)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.08)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background =
                  brandCount === 0 ? "rgba(255,255,255,0.1)" : "none")
              }
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  flexShrink: 0,
                  border: `2px solid ${
                    brandCount === 0 ? "#fff" : "rgba(255,255,255,0.3)"
                  }`,
                  background: brandCount === 0 ? "#fff" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {brandCount === 0 && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "#1A202C",
                      fontWeight: 900,
                      lineHeight: 1,
                    }}
                  >
                    ✓
                  </span>
                )}
              </div>
              All Brands
            </button>
            {brands.map((b) =>
              multiItem(
                b.name,
                filterBrand.has(b.id),
                () => toggleBrand(b.id),
                b.color
              )
            )}
          </div>
        )}
      </div>

      <span
        style={{
          width: 1,
          height: 18,
          background: "rgba(255,255,255,0.15)",
          flexShrink: 0,
        }}
      />

      {/* Season multi-select dropdown */}
      <div ref={seasonRef} style={{ position: "relative" }}>
        {dropBtn(`Season: ${seasonLabel}`, seasonCount > 0, () => {
          setSeasonOpen((v) => !v);
          setBrandOpen(false);
        })}
        {seasonOpen && (
          <div style={dropMenu}>
            <button
              onClick={() => {
                setFilterSeason(new Set());
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "8px 14px",
                border: "none",
                background:
                  seasonCount === 0 ? "rgba(255,255,255,0.1)" : "none",
                color: seasonCount === 0 ? "#fff" : "rgba(255,255,255,0.6)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: seasonCount === 0 ? 700 : 500,
                borderBottom: "1px solid rgba(255,255,255,0.08)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.08)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background =
                  seasonCount === 0 ? "rgba(255,255,255,0.1)" : "none")
              }
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  flexShrink: 0,
                  border: `2px solid ${
                    seasonCount === 0 ? "#fff" : "rgba(255,255,255,0.3)"
                  }`,
                  background: seasonCount === 0 ? "#fff" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {seasonCount === 0 && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "#1A202C",
                      fontWeight: 900,
                      lineHeight: 1,
                    }}
                  >
                    ✓
                  </span>
                )}
              </div>
              All Seasons
            </button>
            {seasons.map((s) =>
              multiItem(s, filterSeason.has(s), () => toggleSeason(s), null)
            )}
          </div>
        )}
      </div>

      {(brandCount > 0 || seasonCount > 0) && (
        <button
          onClick={() => {
            setFilterBrand(new Set());
            setFilterSeason(new Set());
          }}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "none",
            color: "rgba(255,255,255,0.5)",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 11,
          }}
        >
          ✕ Clear
        </button>
      )}

      {!canViewAll && (
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: TH.primary,
            background: TH.primary + "15",
            border: `1px solid ${TH.primary}44`,
            padding: "3px 10px",
            borderRadius: 20,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          👁 My Tasks Only
        </span>
      )}
    </div>
  );
}

// ─── MICROSOFT TEAMS VIEW ─────────────────────────────────────────────────────
function TeamsView({ collList, collMap, isAdmin, teamsConfig, setTeamsConfig, teamsToken, setTeamsToken, showTeamsConfig, setShowTeamsConfig, getBrand }) {
  const [selectedCollKey, setSelectedCollKey] = useState(null);
  const [messages, setMessages] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [replyText, setReplyText] = useState({});
  const [newMsg, setNewMsg] = useState("");
  const [configForm, setConfigForm] = useState({ ...teamsConfig });
  const [authStatus, setAuthStatus] = useState("idle");
  const [teams, setTeams] = useState([]);
  const [channels, setChannels] = useState({});
  const [expandedTeam, setExpandedTeam] = useState(null);
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [msgTab, setMsgTab] = useState("channel");
  const [selectedMsg, setSelectedMsg] = useState(null);
  const [replies, setReplies] = useState([]);
  const [loadingReplies, setLoadingReplies] = useState(false);
  const token = teamsToken;
  const cfg = teamsConfig;

  async function authenticate() {
    if (!cfg.clientId || !cfg.tenantId) { setAuthStatus("error"); return; }
    setAuthStatus("loading");
    try {
      const authUrl = "https://login.microsoftonline.com/" + cfg.tenantId + "/oauth2/v2.0/authorize?" +
        "client_id=" + cfg.clientId + "&response_type=token&redirect_uri=" + encodeURIComponent(window.location.origin + "/auth-callback") +
        "&scope=" + encodeURIComponent(["https://graph.microsoft.com/ChannelMessage.Read.All","https://graph.microsoft.com/Team.ReadBasic.All","https://graph.microsoft.com/Channel.ReadBasic.All","https://graph.microsoft.com/ChannelMessage.Send"].join(" ")) +
        "&response_mode=fragment&prompt=select_account";
      const popup = window.open(authUrl, "msauth", "width=500,height=700,left=400,top=100");
      const result = await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          try {
            if (popup.closed) { clearInterval(timer); reject(new Error("Popup closed")); return; }
            const hash = popup.location.hash;
            if (hash && hash.includes("access_token")) { clearInterval(timer); popup.close(); resolve(new URLSearchParams(hash.substring(1)).get("access_token")); }
          } catch (_) {}
        }, 300);
        setTimeout(() => { clearInterval(timer); if (!popup.closed) popup.close(); reject(new Error("Timeout")); }, 120000);
      });
      setTeamsToken(result); setAuthStatus("ok");
    } catch (e) { setAuthStatus("error"); }
  }

  async function graph(path) {
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  async function graphPost(path, body) {
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }

  async function loadTeams() {
    if (!token) return;
    setLoadingTeams(true);
    try { const d = await graph("/me/joinedTeams"); setTeams(d.value || []); } catch(e) { console.error(e); }
    setLoadingTeams(false);
  }
  async function loadChannels(teamId) {
    try { const d = await graph("/teams/" + teamId + "/channels"); setChannels(c => ({ ...c, [teamId]: d.value || [] })); setExpandedTeam(teamId === expandedTeam ? null : teamId); }
    catch(e) { console.error(e); }
  }
  function mapChannel(collKey, channelId, teamId) {
    const updated = { ...cfg, channelMap: { ...cfg.channelMap, [collKey]: { channelId, teamId } } };
    setTeamsConfig(updated); try { localStorage.setItem("teamsConfig", JSON.stringify(updated)); } catch(_) {}
  }
  function unmapChannel(collKey) {
    const nm = { ...cfg.channelMap }; delete nm[collKey];
    const updated = { ...cfg, channelMap: nm };
    setTeamsConfig(updated); try { localStorage.setItem("teamsConfig", JSON.stringify(updated)); } catch(_) {}
  }
  async function loadMessages(collKey) {
    const mapping = cfg.channelMap[collKey];
    if (!mapping || !token) return;
    setLoading(l => ({ ...l, [collKey]: true })); setErrors(e => ({ ...e, [collKey]: null }));
    try { const d = await graph("/teams/" + mapping.teamId + "/channels/" + mapping.channelId + "/messages?$top=50"); setMessages(m => ({ ...m, [collKey]: (d.value || []).filter(m => m.messageType === "message") })); }
    catch(e) { setErrors(err => ({ ...err, [collKey]: e.message })); }
    setLoading(l => ({ ...l, [collKey]: false }));
  }
  async function loadReplies(collKey, messageId) {
    const mapping = cfg.channelMap[collKey];
    if (!mapping || !token) return;
    setLoadingReplies(true); setSelectedMsg(messageId);
    try { const d = await graph("/teams/" + mapping.teamId + "/channels/" + mapping.channelId + "/messages/" + messageId + "/replies"); setReplies(d.value || []); }
    catch(e) { setReplies([]); }
    setLoadingReplies(false); setMsgTab("replies");
  }
  async function sendMessage(collKey) {
    const mapping = cfg.channelMap[collKey];
    if (!mapping || !newMsg.trim() || !token) return;
    try { const sent = await graphPost("/teams/" + mapping.teamId + "/channels/" + mapping.channelId + "/messages", { body: { content: newMsg.trim(), contentType: "text" } }); setMessages(m => ({ ...m, [collKey]: [sent, ...(m[collKey] || [])] })); setNewMsg(""); }
    catch(e) { alert("Failed to send: " + e.message); }
  }
  async function sendReply(collKey, messageId) {
    const mapping = cfg.channelMap[collKey];
    const text = replyText[messageId] || "";
    if (!mapping || !text.trim() || !token) return;
    try { const sent = await graphPost("/teams/" + mapping.teamId + "/channels/" + mapping.channelId + "/messages/" + messageId + "/replies", { body: { content: text.trim(), contentType: "text" } }); setReplies(r => [...r, sent]); setReplyText(r => ({ ...r, [messageId]: "" })); }
    catch(e) { alert("Failed to reply: " + e.message); }
  }
  function saveConfig() {
    setTeamsConfig(configForm); try { localStorage.setItem("teamsConfig", JSON.stringify(configForm)); } catch(_) {}
    setShowTeamsConfig(false);
  }

  useEffect(() => { if (token) loadTeams(); }, [token]);
  useEffect(() => { if (selectedCollKey && token) loadMessages(selectedCollKey); }, [selectedCollKey, token]);

  const selectedColl = selectedCollKey ? collMap[selectedCollKey] : null;
  const brand = selectedColl ? getBrand(selectedColl.brand) : null;
  const mapping = selectedCollKey ? (cfg.channelMap && cfg.channelMap[selectedCollKey]) : null;
  const msgs = (selectedCollKey ? messages[selectedCollKey] : null) || [];
  const isLoadingMsgs = selectedCollKey ? !!loading[selectedCollKey] : false;
  const msgError = selectedCollKey ? errors[selectedCollKey] : null;

  if (showTeamsConfig) return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "8px 0" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: TH.text, marginBottom: 18 }}>Microsoft Teams Configuration</div>
      <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "12px 16px", marginBottom: 18, fontSize: 12, color: "#1E40AF", lineHeight: 1.6 }}>
        <b>Azure AD Setup:</b> Register an app, enable implicit grant for Access tokens, add Graph API permissions
        (ChannelMessage.Read.All, Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Send),
        set redirect URI to <b>{window.location.origin}/auth-callback</b>.
      </div>
      <label style={S.lbl}>Azure AD Client ID</label>
      <input style={S.inp} value={configForm.clientId} onChange={e => setConfigForm(f => ({...f, clientId: e.target.value}))} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      <label style={S.lbl}>Tenant ID</label>
      <input style={S.inp} value={configForm.tenantId} onChange={e => setConfigForm(f => ({...f, tenantId: e.target.value}))} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
        <button onClick={() => setShowTeamsConfig(false)} style={{ padding: "9px 18px", borderRadius: 8, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button onClick={saveConfig} style={S.btn}>Save Configuration</button>
      </div>
    </div>
  );

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => { const ev = new CustomEvent("closeTeamsView"); window.dispatchEvent(ev); }} title="Close Teams"
        style={{ position: "absolute", top: 10, right: 10, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: "1px solid rgba(91,94,166,0.3)", background: "rgba(91,94,166,0.1)", color: TEAMS_PURPLE, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, transition: "all 0.15s" }}
        onMouseEnter={e => { e.currentTarget.style.background = TEAMS_PURPLE; e.currentTarget.style.color = "#fff"; }}
        onMouseLeave={e => { e.currentTarget.style.background = "rgba(91,94,166,0.1)"; e.currentTarget.style.color = TEAMS_PURPLE; }}>✕</button>
      <div style={{ display: "flex", height: "calc(100vh - 200px)", minHeight: 500, background: TH.surface, borderRadius: 12, border: "1px solid " + TH.border, overflow: "hidden" }}>

        {/* LEFT: project list */}
        <div style={{ width: 280, flexShrink: 0, borderRight: "1px solid " + TH.border, overflowY: "auto", background: TH.surfaceHi, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid " + TH.border, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: TH.textMuted }}>Projects ({collList.length})</span>
            {isAdmin && <button onClick={() => { setConfigForm({ ...cfg }); setShowTeamsConfig(true); }} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>⚙ Config</button>}
          </div>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid " + TH.border, background: token ? "#ECFDF5" : "#FFF7ED", flexShrink: 0 }}>
            {token ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#065F46", fontWeight: 600 }}>✓ Connected to Microsoft Teams</span>
                <button onClick={() => { setTeamsToken(null); setAuthStatus("idle"); }} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: "1px solid #6EE7B7", background: "none", color: "#065F46", cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 11, color: "#92400E", fontWeight: 600, marginBottom: 6 }}>{authStatus === "error" ? "Authentication failed — check config" : "Sign in to load conversations"}</div>
                {(!cfg.clientId || !cfg.tenantId) ? (
                  <div style={{ fontSize: 11, color: "#B45309" }}>{isAdmin ? 'Click "⚙ Config" to enter Azure AD credentials' : "Contact an admin to set up Teams integration"}</div>
                ) : (
                  <button onClick={authenticate} disabled={authStatus === "loading"} style={{ ...S.btn, fontSize: 11, padding: "5px 12px", opacity: authStatus === "loading" ? 0.6 : 1 }}>{authStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                )}
              </div>
            )}
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {collList.map(c => {
              const b = getBrand(c.brand);
              const hasCh = !!(cfg.channelMap && cfg.channelMap[c.key]);
              const isSelected = selectedCollKey === c.key;
              const msgCount = (messages[c.key] || []).length;
              return (
                <div key={c.key} onClick={() => { setSelectedCollKey(c.key === selectedCollKey ? null : c.key); setMsgTab("channel"); setSelectedMsg(null); }}
                  style={{ padding: "11px 16px", borderBottom: "1px solid " + TH.border, cursor: "pointer", background: isSelected ? TH.accent : "transparent", borderLeft: isSelected ? "3px solid " + TH.primary : "3px solid transparent", transition: "all 0.12s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: b ? b.color : TH.textMuted, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? TH.primary : TH.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.collection}</div>
                      <div style={{ fontSize: 11, color: TH.textMuted }}>{b ? b.short : ""} · {c.season}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 10, background: hasCh ? "#D1FAE5" : TH.surfaceHi, color: hasCh ? "#065F46" : TH.textMuted, border: hasCh ? "none" : "1px solid " + TH.border, fontWeight: 700 }}>{hasCh ? "LINKED" : "UNLINKED"}</span>
                      {msgCount > 0 && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 10, background: TH.primary, color: "#fff", fontWeight: 700 }}>{msgCount}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {collList.length === 0 && <div style={{ padding: 24, fontSize: 13, color: TH.textMuted, textAlign: "center" }}>No collections yet</div>}
          </div>
        </div>

        {/* RIGHT: conversation panel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!selectedCollKey ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: TH.textMuted }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>💬</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: TH.textSub, marginBottom: 6 }}>Select a project to view conversations</div>
              <div style={{ fontSize: 13 }}>Each collection maps to a Microsoft Teams channel</div>
            </div>
          ) : (
            <>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid " + TH.border, background: "#fff", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: brand ? brand.color : TH.textMuted, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: TH.text }}>{selectedColl ? selectedColl.collection : ""}</div>
                  <div style={{ fontSize: 12, color: TH.textMuted }}>{brand ? brand.name : ""}{selectedColl ? " · " + selectedColl.season + " · " + selectedColl.category : ""}</div>
                </div>
                {isAdmin && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    {mapping ? (
                      <>
                        <span style={{ fontSize: 11, color: "#065F46", background: "#D1FAE5", padding: "3px 8px", borderRadius: 6 }}>Channel linked</span>
                        <button onClick={() => loadMessages(selectedCollKey)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
                        <button onClick={() => unmapChannel(selectedCollKey)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit" }}>Unlink</button>
                      </>
                    ) : token ? (
                      <button onClick={() => { if (!teams.length) loadTeams(); setExpandedTeam(expandedTeam ? null : "__picker__"); }} style={{ ...S.btn, fontSize: 11, padding: "5px 12px" }}>+ Link Channel</button>
                    ) : null}
                  </div>
                )}
              </div>

              {isAdmin && !mapping && token && (
                <div style={{ padding: "12px 20px", background: "#FFFBEB", borderBottom: "1px solid #FCD34D", flexShrink: 0, overflowY: "auto", maxHeight: 240 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#92400E", marginBottom: 10 }}>Link this project to a Teams channel:</div>
                  {loadingTeams ? <div style={{ fontSize: 12, color: TH.textMuted }}>Loading teams…</div> :
                    teams.length === 0 ? <button onClick={loadTeams} style={{ ...S.btn, fontSize: 11, padding: "5px 12px" }}>Load My Teams</button> : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {teams.map(tm => (
                        <div key={tm.id}>
                          <div onClick={() => loadChannels(tm.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 7, background: expandedTeam === tm.id ? "#EFF6FF" : TH.surfaceHi, cursor: "pointer", border: "1px solid " + TH.border }}>
                            <span style={{ fontSize: 14 }}>👥</span>
                            <span style={{ fontSize: 12, fontWeight: 600, color: TH.text, flex: 1 }}>{tm.displayName}</span>
                            <span style={{ fontSize: 10, color: TH.textMuted }}>{expandedTeam === tm.id ? "▲" : "▼"}</span>
                          </div>
                          {expandedTeam === tm.id && channels[tm.id] && (
                            <div style={{ marginLeft: 16, marginTop: 4, display: "flex", flexDirection: "column", gap: 3 }}>
                              {channels[tm.id].map(ch => (
                                <div key={ch.id} onClick={() => mapChannel(selectedCollKey, ch.id, tm.id)}
                                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, cursor: "pointer", background: "#fff", border: "1px solid " + TH.border }}
                                  onMouseEnter={e => e.currentTarget.style.background = "#EFF6FF"}
                                  onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
                                  <span style={{ fontSize: 12, color: TH.textMuted }}>#</span>
                                  <span style={{ fontSize: 12, color: TH.text }}>{ch.displayName}</span>
                                  <span style={{ fontSize: 10, color: TH.primary, marginLeft: "auto", fontWeight: 600 }}>Link →</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {mapping && (
                <div style={{ display: "flex", borderBottom: "1px solid " + TH.border, background: "#fff", flexShrink: 0 }}>
                  {[["channel","Channel Messages"],["replies", selectedMsg ? "Thread" : "Thread Replies"]].map(([tab, label]) => (
                    <button key={tab} onClick={() => setMsgTab(tab)} style={{ padding: "9px 18px", border: "none", borderBottom: msgTab === tab ? "2px solid " + TH.primary : "2px solid transparent", background: "none", color: msgTab === tab ? TH.primary : TH.textMuted, fontWeight: msgTab === tab ? 700 : 500, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>{label}</button>
                  ))}
                </div>
              )}

              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                {!token ? (
                  <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div><div style={{ fontSize: 13 }}>Sign in with Microsoft to view conversations</div></div>
                ) : !mapping ? (
                  <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>🔗</div><div style={{ fontSize: 13 }}>{isAdmin ? 'Click "+ Link Channel" above to connect a Teams channel' : "No Teams channel linked for this project yet"}</div></div>
                ) : isLoadingMsgs ? (
                  <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
                ) : msgError ? (
                  <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: "12px 16px", color: "#B91C1C", fontSize: 13 }}>⚠ {msgError}</div>
                ) : msgTab === "channel" ? (
                  msgs.length === 0 ? (
                    <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>💬</div><div style={{ fontSize: 13 }}>No messages yet</div></div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {msgs.map(msg => {
                        const author = (msg.from && msg.from.user && msg.from.user.displayName) || "Unknown";
                        const initials = author.split(" ").map(w => w[0] || "").join("").toUpperCase().slice(0, 2);
                        const clean = ((msg.body && msg.body.content) || "").replace(/<[^>]+>/g, "").trim();
                        const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                        return (
                          <div key={msg.id} style={{ background: "#fff", border: "1px solid " + TH.border, borderRadius: 10, padding: "12px 16px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                              <div style={{ width: 34, height: 34, borderRadius: "50%", background: TH.primary + "22", border: "2px solid " + TH.primary, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TH.primary, flexShrink: 0 }}>{initials}</div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: TH.text }}>{author}</span>
                                  <span style={{ fontSize: 11, color: TH.textMuted }}>{time}</span>
                                </div>
                                <div style={{ fontSize: 13, color: TH.textSub, lineHeight: 1.5, wordBreak: "break-word" }}>{clean || "[Attachment or card]"}</div>
                                <button onClick={() => loadReplies(selectedCollKey, msg.id)} style={{ marginTop: 6, fontSize: 11, padding: "3px 9px", borderRadius: 6, border: "1px solid " + TH.border, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>💬 View Thread</button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                ) : (
                  <div>
                    {!selectedMsg ? (
                      <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40, fontSize: 13 }}>Click "View Thread" on a message to open its replies</div>
                    ) : loadingReplies ? (
                      <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 24, fontSize: 13 }}>Loading replies…</div>
                    ) : replies.length === 0 ? (
                      <div style={{ textAlign: "center", color: TH.textMuted, paddingTop: 40, fontSize: 13 }}>No replies yet — be the first!</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                        {replies.map(r => {
                          const author = (r.from && r.from.user && r.from.user.displayName) || "Unknown";
                          const initials = author.split(" ").map(w => w[0] || "").join("").toUpperCase().slice(0, 2);
                          const clean = ((r.body && r.body.content) || "").replace(/<[^>]+>/g, "").trim();
                          const time = r.createdDateTime ? new Date(r.createdDateTime).toLocaleString() : "";
                          return (
                            <div key={r.id} style={{ background: TH.surfaceHi, border: "1px solid " + TH.border, borderRadius: 8, padding: "10px 14px" }}>
                              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#6D28D922", border: "2px solid #6D28D9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#6D28D9", flexShrink: 0 }}>{initials}</div>
                                <div style={{ flex: 1 }}>
                                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: TH.text }}>{author}</span>
                                    <span style={{ fontSize: 10, color: TH.textMuted }}>{time}</span>
                                  </div>
                                  <div style={{ fontSize: 12, color: TH.textSub, lineHeight: 1.5 }}>{clean || "[Attachment]"}</div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {selectedMsg && (
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <input value={(replyText[selectedMsg] || "")} onChange={e => setReplyText(r => ({...r, [selectedMsg]: e.target.value}))} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply(selectedCollKey, selectedMsg); }}} placeholder="Write a reply…" style={{ ...S.inp, flex: 1, marginBottom: 0 }} />
                        <button onClick={() => sendReply(selectedCollKey, selectedMsg)} style={S.btn}>Reply</button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {mapping && token && msgTab === "channel" && (
                <div style={{ padding: "12px 20px", borderTop: "1px solid " + TH.border, background: "#fff", display: "flex", gap: 10, flexShrink: 0 }}>
                  <input value={newMsg} onChange={e => setNewMsg(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(selectedCollKey); }}} placeholder={"Message " + (selectedColl ? selectedColl.collection : "") + "…"} style={{ ...S.inp, flex: 1, marginBottom: 0 }} />
                  <button onClick={() => sendMessage(selectedCollKey)} disabled={!newMsg.trim()} style={{ ...S.btn, opacity: newMsg.trim() ? 1 : 0.5 }}>Send</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  // ── Dropbox persistence ───────────────────────────────────────────────────
  const DBX_TOKEN = "sl.u.AGUcjMEcACemDUZHoLi92xdgZ13WI8iSDzLrDH79Xgcn7fQKuN8tfpn01xSY-JhTMgcNe-tGiNYqsVkrbII3NoWk0KO1MumGTJV1CX1DZb7qCUFR9lOlx9oQoAtuuAiMockw9inV9CuMwsVRIAA7h5qrrjKqAZ65SfmWt0bq73FFlircuF1x7LkEsABbzJGznX7y5q8Qo76unECnZw_QOKIF7JeYlshwpIbb-6i4qktHbqbOZ5lHEe5U2nuCmE1QVj80sMPoFvcRTa-D1WptAgnL_gHlZqnsLppUPlJ17RVpoXfmF5qkxC6q3P_d5Et2x_4MUKPAeeMc9cGp2vHZBITl5Uqs472avmEnAaa8Ob9g7eeJIIVcQOlg7gXwgpeoxeyuTYHGaAeOiyoNCihv8QBP3SPTA0HnK0KnaXLixBddFtUo97JPVxMDeEsdEeiXqooalU2qJ_BAqOHbk6zUEb3EaZa-2LpslUdktWiP6YaGJgUePX-2JBS4BmN_rfIjVlsikaObNC1U9hhX1ea0FHuThyzijnVqVdze9-fcFszuvJIar3eXf7tzXPzW_JahCXJr-eMdNx68Bpu7Bj-485LL_P0F09mhS219DTWoBVoflXSOF9UE8eE8kiybDGL__qfFfRJwB_-8qEFoDRj1f-wcrWxRYx16yZdiEYBXaMM7KR83Fhiru2gFNFSExAERAqZdBC_PWIicVhHl7nRkAMnlZ7Wu9uu3CGA1v_MqXXgXxvqaqpWlMJxjJMyNHZfA5Th3VwA9NNgB3nOK0umNT8BUVx371VRqreNByWsme6Ara66ZRd9EuPwFQAoz3-q64KqgbfRRiPWjv7edgi6e49BEUBE26B7e1XW2muTnJxncZfp8jF3g9g0P5pBiNf9Z_7w5gXRyU2ZhfNuHrb2epYnBQrq_LyEOsZC2aG2cQgyqRr5-6vdsH0giZoXneSUCqEsuaNmIgY7zLb9gd98oRy1DnwcEpwJY7Ja_lzwMKR9-Bc9MPLt9x_zYQKYR7TRTFOPQDLCtce6wJ4o5r5AbYmn0Vo33ceURUtI6_I3fRH1Bv3W7pydx9QAgI2BVF-2OD2Rwzai2MUghm3yUah-wYjbQGao7VYRT9h7Fcr--qW8W0GYMgGZYbO7_J7A5KixWGA375AH3-_4L4n87IlfxNqd8nvEb7e2hABTrznLm1dgMzYBCSF-O7tFEr24TzWfsA9L0awYgw1v2qN-9-eESJphwJ6KyYNa78ar2cCgc6M6Xsnza8fZJa-BcJrBI-gW_Y830PoQMtsCtgglC4KBu6W0sAwzgr98EKjOgGHNB7Le0qzLO-HAFUyepGOZ2q3bVU0_poNEgEfjpXanfvDtAxZ00Jjdn5AhKumbb9gwxnEmKgAIRmf9eOxr99jABC4Y6GdtBMX3PV6MHRB1N0W11-HpFtO6tTZ5Ui-YEWYPfZfuwqyMG2poXqlepeJNpbTPT65bjtOpMTAb6LZ23M5ezFEOf";
  
  async function dbxUpload(filename, data) {
    console.log("[DBX] uploading:", filename);
    try {
      const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DBX_TOKEN}`,
          "Dropbox-API-Arg": JSON.stringify({
            path: `/${filename}`,
            mode: "overwrite",
            autorename: false,
            mute: true,
          }),
          "Content-Type": "application/octet-stream",
        },
        body: JSON.stringify(data),
      });
      const txt = await res.text();
      if (!res.ok) {
        console.error("[DBX] upload FAILED", res.status, txt);
      } else {
        console.log("[DBX] upload OK:", filename);
      }
    } catch (e) { console.error("[DBX] upload ERROR:", e); }
  }

  async function dbxDownload(filename) {
    console.log("[DBX] downloading:", filename);
    try {
      const res = await fetch("https://content.dropboxapi.com/2/files/download", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DBX_TOKEN}`,
          "Dropbox-API-Arg": JSON.stringify({ path: `/${filename}` }),
        },
      });
      if (!res.ok) {
        const txt = await res.text();
        console.warn("[DBX] download FAILED", filename, res.status, txt);
        return null;
      }
      const text = await res.text();
      console.log("[DBX] download OK:", filename);
      return JSON.parse(text);
    } catch (e) { console.error("[DBX] download ERROR:", filename, e); return null; }
  }

  const [dbxLoaded, setDbxLoaded] = useState(false);

  function usePersist(key, fallback) {
    const [val, setVal] = useState(fallback);
    const setter = (updater) => {
      setVal((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        dbxUpload(`${key}.json`, next);
        return next;
      });
    };
    return [val, setter];
  }

  const [users, setUsers] = usePersist("rof_users", DEFAULT_USERS);
  const [currentUser, setCurrentUser] = useState(null);
  const [brands, setBrands] = usePersist("rof_brands", BRANDS);
  const [seasons, setSeasons] = usePersist("rof_seasons", SEASONS);
  const [customers, setCustomers] = usePersist("rof_customers", DEFAULT_CUSTOMERS.map(n => ({ name: n, channel: CUSTOMER_CHANNEL_MAP[n] || "" })));
  const [vendors, setVendors] = usePersist("rof_vendors", SAMPLE_VENDORS);
  const [team, setTeam] = usePersist("rof_team", SAMPLE_TEAM);
  const [tasks, setTasks] = usePersist("rof_tasks", []);
  const [collections, setCollections] = usePersist("rof_collections", {});
  const [view, setView] = useState("dashboard");
  const [filterBrand, setFilterBrand] = useState<Set<string>>(new Set());
  const [filterSeason, setFilterSeason] = useState<Set<string>>(new Set());
  const [focusCollKey, setFocusCollKey] = useState(null);
  const [showNav, setShowNav] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [showVendors, setShowVendors] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [showSizeLib, setShowSizeLib] = useState(false);
  const [showCatLib, setShowCatLib] = useState(false);
  const [sizeLibrary, setSizeLibrary] = usePersist("rof_sizes", DEFAULT_SIZES);
  const [categoryLib, setCategoryLib] = usePersist("rof_categories", DEFAULT_CATEGORIES);
  const [editTask, setEditTask] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [editCollKey, setEditCollKey] = useState(null);
  const [statFilter, setStatFilter] = useState(null); // "overdue"|"week"|"30d"|"collections"
  const [showAddTask, setShowAddTask] = useState(false);
  const [showBrands, setShowBrands] = useState(false);
  const [showSeasons, setShowSeasons] = useState(false);
  const [showCustomers, setShowCustomers] = useState(false);
  const [showOrderTypes, setShowOrderTypes] = useState(false);
  const [orderTypes, setOrderTypes] = usePersist("rof_orderTypes", [...ORDER_TYPES]);
  const [miniCalDragOver, setMiniCalDragOver] = useState(null);
  const [teamsConfig, setTeamsConfig] = useState(() => {
    try { return JSON.parse(localStorage.getItem("teamsConfig") || "null") || { clientId: "", tenantId: "", channelMap: {} }; }
    catch { return { clientId: "", tenantId: "", channelMap: {} }; }
  });
  const [teamsToken, setTeamsToken] = useState(null);
  const [showTeamsConfig, setShowTeamsConfig] = useState(false);

  // Override getBrand to use stateful brands
  const getBrandDyn = (id) =>
    brands.find((b) => b.id === id) || brands[0] || BRANDS[0];
  // Shadow the global getBrand with the stateful version for all inner components
  const getBrand = getBrandDyn;

  // ── Load all data from Dropbox on startup ────────────────────────────────
  useEffect(() => {
    async function loadAll() {
      console.log("[DBX] loadAll starting...");
      const files = [
        ["rof_tasks", setTasks],
        ["rof_collections", setCollections],
        ["rof_vendors", setVendors],
        ["rof_team", setTeam],
        ["rof_users", setUsers],
        ["rof_brands", setBrands],
        ["rof_seasons", setSeasons],
        ["rof_customers", setCustomers],
        ["rof_sizes", setSizeLibrary],
        ["rof_categories", setCategoryLib],
        ["rof_orderTypes", setOrderTypes],
      ];
      await Promise.all(
        files.map(async ([key, setter]) => {
          const data = await dbxDownload(`${key}.json`);
          if (data !== null) setter(data);
        })
      );
      console.log("[DBX] loadAll complete, setting loaded=true");
      setDbxLoaded(true);
    }
    loadAll();
  }, []);

  // Load XLSX library dynamically
  useEffect(() => {
    if (window.XLSX) return;
    const s = document.createElement("script");
    s.src =
      "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    document.head.appendChild(s);
  }, []);

  // Close Teams view via X button
  useEffect(() => {
    const handler = () => setView("dashboard");
    window.addEventListener("closeTeamsView", handler);
    return () => window.removeEventListener("closeTeamsView", handler);
  }, []);

  // ── AUTO LOGOUT after 60 minutes of inactivity ──────────────────────────
  const IDLE_MS = 60 * 60 * 1000; // 60 minutes
  const [idleWarning, setIdleWarning] = useState(false);
  useEffect(() => {
    if (!currentUser) return;
    let warnTimer = null;
    let logoutTimer = null;

    function resetTimers() {
      setIdleWarning(false);
      clearTimeout(warnTimer);
      clearTimeout(logoutTimer);
      // Warn at 55 minutes
      warnTimer = setTimeout(() => setIdleWarning(true), IDLE_MS - 5 * 60 * 1000);
      // Log out at 60 minutes
      logoutTimer = setTimeout(() => {
        setCurrentUser(null);
        setIdleWarning(false);
        setTeamsToken(null);
        setView("dashboard");
      }, IDLE_MS);
    }

    const EVENTS = ["mousemove","mousedown","keydown","touchstart","scroll","click","wheel"];
    EVENTS.forEach(ev => window.addEventListener(ev, resetTimers, { passive: true }));
    resetTimers();

    return () => {
      clearTimeout(warnTimer);
      clearTimeout(logoutTimer);
      EVENTS.forEach(ev => window.removeEventListener(ev, resetTimers));
    };
  }, [currentUser]);



  if (!dbxLoaded)
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0F172A", gap: 16 }}>
        <div style={{ fontSize: 32 }}>🔄</div>
        <div style={{ color: "#fff", fontSize: 16, fontWeight: 600 }}>Loading from Dropbox…</div>
        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12 }}>Syncing your data</div>
      </div>
    );

  if (!currentUser)
    return <LoginScreen users={users} onLogin={setCurrentUser} teamsConfig={teamsConfig} onTeamsToken={setTeamsToken} />;

  const isAdmin = currentUser.role === "admin";
  const canViewAll = isAdmin || currentUser.permissions?.view_all;

  // Filter tasks based on permissions
  const visibleTasks = canViewAll
    ? tasks
    : tasks.filter((t) => t.assigneeId === currentUser.teamMemberId);
  const filtered = visibleTasks.filter(
    (t) =>
      (filterBrand.size === 0 || filterBrand.has(t.brand)) &&
      (filterSeason.size === 0 || filterSeason.has(t.season))
  );
  const overdue = filtered.filter(
    (t) => getDaysUntil(t.due) < 0 && t.status !== "Complete"
  );
  const dueThisWeek = filtered.filter((t) => {
    const d = getDaysUntil(t.due);
    return d >= 0 && d <= 7 && t.status !== "Complete";
  });
  const due30 = filtered.filter((t) => {
    const d = getDaysUntil(t.due);
    return d > 7 && d <= 30 && t.status !== "Complete";
  });

  function addCollection(newTasks, meta) {
    const key = `${newTasks[0].brand}||${newTasks[0].collection}`;
    // Concept images: grab images from concept task and copy to all tasks
    const conceptTask = newTasks.find((t) => t.phase === "Concept");
    const conceptImages = conceptTask?.images || [];
    const tasksWithImages =
      conceptImages.length > 0
        ? newTasks.map((t) =>
            t.phase === "Concept" ? t : { ...t, images: [...conceptImages] }
          )
        : newTasks;
    setCollections((c) => ({
      ...c,
      [key]: {
        skus: [],
        conceptImages,
        customerShipDate: meta?.customerShipDate,
        cancelDate: meta?.cancelDate,
        customer: meta?.customer,
        orderType: meta?.orderType,
        channelType: meta?.channelType,
        gender: meta?.gender,
        year: meta?.year,
        sampleDueDate: meta?.sampleDueDate,
        availableSizes: sizeLibrary,
      },
    }));
    setTasks((ts) => [...ts, ...tasksWithImages]);
    setShowWizard(false);
    setView("timeline");
  }

  function saveTask(f) {
    const clean = { ...f };
    // If this is the Concept task and images changed, copy images to all other tasks in collection
    if (clean.phase === "Concept" && clean.images?.length > 0) {
      const collKey = `${clean.brand}||${clean.collection}`;
      setTasks((ts) =>
        ts.map((t) => {
          if (t.id === clean.id) return clean;
          if (
            `${t.brand}||${t.collection}` === collKey &&
            t.phase !== "Concept"
          )
            return { ...t, images: [...clean.images] };
          return t;
        })
      );
    } else {
      setTasks((ts) => ts.map((t) => (t.id === f.id ? clean : t)));
    }
    setEditTask(null);
  }

  function saveCascade(updatedTasks) {
    setTasks(updatedTasks);
  }
  function deleteTask(id) {
    setTasks((ts) => ts.filter((t) => t.id !== id));
    setEditTask(null);
  }

  // Timeline drag: place dragged card at midpoint between its two neighbors
  function handleTimelineDrop(targetId, sortedCollTasks) {
    if (!dragId || dragId === targetId) return;
    setTasks((ts) => {
      const dragged = ts.find((t) => t.id === dragId);
      if (!dragged) return ts;
      const targetIdx = sortedCollTasks.findIndex((t) => t.id === targetId);
      if (targetIdx < 0) return ts;
      const prev = sortedCollTasks[targetIdx - 1];
      const next = sortedCollTasks[targetIdx];
      let newDue;
      if (prev && next) {
        const prevMs = parseLocalDate(prev.due).getTime();
        const nextMs = parseLocalDate(next.due).getTime();
        const midMs = Math.round((prevMs + nextMs) / 2);
        const mid = new Date(midMs);
        const mm = String(mid.getMonth() + 1).padStart(2, "0");
        const dd = String(mid.getDate()).padStart(2, "0");
        newDue = `${mid.getFullYear()}-${mm}-${dd}`;
      } else if (!prev && next) {
        newDue = addDays(next.due, -1);
      } else if (prev && !next) {
        newDue = addDays(prev.due, 1);
      } else {
        newDue = dragged.due;
      }
      return ts.map((t) => (t.id === dragId ? { ...t, due: newDue } : t));
    });
    setDragId(null);
    setDragOverId(null);
  }

  // Dashboard card drag: swap dates
  function handleDrop(targetId) {
    if (!dragId || dragId === targetId) return;
    setTasks((ts) => {
      const a = ts.find((t) => t.id === dragId),
        b = ts.find((t) => t.id === targetId);
      if (!a || !b) return ts;
      return ts.map((t) =>
        t.id === dragId
          ? { ...t, due: b.due }
          : t.id === targetId
          ? { ...t, due: a.due }
          : t
      );
    });
    setDragId(null);
    setDragOverId(null);
  }

  const collMap = {};
  tasks.forEach((t) => {
    const k = `${t.brand}||${t.collection}`;
    if (!collMap[k])
      collMap[k] = {
        brand: t.brand,
        collection: t.collection,
        season: t.season,
        category: t.category,
        vendorName: t.vendorName,
        tasks: [],
        key: k,
      };
    collMap[k].tasks.push(t);
  });
  const collList = Object.values(collMap).filter(
    (c) =>
      (filterBrand.size === 0 || filterBrand.has(c.brand)) &&
      (filterSeason.size === 0 || filterSeason.has(c.season))
  );
  const allCustomers = [
    ...new Set(
      Object.values(collections)
        .map((c) => c.customer)
        .filter(Boolean)
    ),
  ];

  const navBtn = (id, label) => {
    const isTeams = id === "teams";
    const isActive = view === id;
    const activeBg = isTeams
      ? `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`
      : `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`;
    const activeBorder = isTeams ? "rgba(123,131,235,0.5)" : "rgba(255,255,255,0.35)";
    return (
      <button
        key={id}
        onClick={() => {
          setView(id);
          setStatFilter(null);
          if (id !== "dashboard") setFocusCollKey(null);
        }}
        style={{
          padding: "7px 12px",
          borderRadius: 8,
          border: `1px solid ${isActive ? activeBorder : "rgba(255,255,255,0.15)"}`,
          cursor: "pointer",
          background: isActive ? activeBg : "none",
          color: isActive ? "#fff" : isTeams ? "rgba(123,131,235,0.9)" : "rgba(255,255,255,0.7)",
          fontWeight: isActive ? 700 : 600,
          fontFamily: "inherit",
          fontSize: 12,
          transition: "all 0.2s",
        }}
      >
        {label}
      </button>
    );
  };
  const pill = (cur, setPill, val, label, color) => (
    <button
      key={val}
      onClick={() => setPill(val)}
      style={{
        padding: "5px 12px",
        borderRadius: 20,
        border: `1px solid ${cur === val ? color || TH.primary : TH.border}`,
        background:
          cur === val
            ? color
              ? color + "22"
              : TH.primary + "15"
            : "transparent",
        color: cur === val ? color || TH.primary : TH.textMuted,
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12,
        whiteSpace: "nowrap",
        transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );

  const DAYS_OF_WEEK = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  const TaskCard = ({ task, showDayDate }) => {
    const brand = getBrand(task.brand),
      days = getDaysUntil(task.due),
      sc = STATUS_CONFIG[task.status] || STATUS_CONFIG["Not Started"],
      isOver = days < 0 && task.status !== "Complete",
      assignee = team.find((m) => m.id === task.assigneeId) || null;
    const dueDate = parseLocalDate(task.due);
    const dayOfWeek = DAYS_OF_WEEK[dueDate.getDay()];
    const formattedDue = formatDate(task.due);
    return (
      <div
        draggable
        onDragStart={() => setDragId(task.id)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOverId(task.id);
        }}
        onDrop={() => handleDrop(task.id)}
        onDragEnd={() => {
          setDragId(null);
          setDragOverId(null);
        }}
        onClick={() => setEditTask(task)}
        style={{
          background: dragOverId === task.id ? TH.surfaceHi : TH.surface,
          border: `1px solid ${
            dragOverId === task.id ? brand.color + "88" : TH.border
          }`,
          borderLeft: `3px solid ${brand.color}`,
          borderRadius: 9,
          padding: "12px 14px",
          cursor: "pointer",
          transition: "all 0.15s",
          opacity: dragId === task.id ? 0.4 : 1,
          boxShadow: `0 1px 4px ${TH.shadow}`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 5,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: TH.text }}>
            {task.phase}
          </span>
          <span
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 10,
              background: sc.bg,
              color: sc.color,
              fontWeight: 600,
            }}
          >
            {task.status}
          </span>
        </div>
        <div style={{ fontSize: 11, color: TH.textMuted, marginBottom: 2 }}>
          {task.collection}
        </div>
        <div style={{ fontSize: 11, color: TH.textSub2, marginBottom: 6 }}>
          {task.category}
          {task.vendorName ? ` · ${task.vendorName}` : ""}
        </div>
        {task.customer && (
          <div
            style={{
              fontSize: 11,
              color: TH.primary,
              fontWeight: 600,
              marginBottom: 5,
            }}
          >
            {task.customer}
            {task.orderType ? ` · ${task.orderType}` : ""}
          </div>
        )}
        {showDayDate && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              marginBottom: 6,
              padding: "6px 10px",
              background: isOver
                ? "#FEF2F2"
                : days === 0
                ? "#FFFBEB"
                : "#F0FDF4",
              borderRadius: 7,
              border: `1px solid ${
                isOver ? "#FCA5A5" : days === 0 ? "#FCD34D" : "#BBF7D0"
              }`,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: TH.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Due
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: isOver
                    ? "#B91C1C"
                    : days === 0
                    ? "#B45309"
                    : "#065F46",
                }}
              >
                {isOver
                  ? `${Math.abs(days)}d overdue`
                  : days === 0
                  ? "Today"
                  : `In ${days}d`}
              </span>
            </div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: isOver ? "#B91C1C" : TH.text,
              }}
            >
              {dayOfWeek}, {formattedDue}
            </div>
          </div>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: brand.color, fontWeight: 700 }}>
              {brand.short}
            </span>
            {assignee && (
              <>
                <Avatar member={assignee} size={18} />
                <span style={{ fontSize: 10, color: TH.textMuted }}>
                  {assignee.name.split(" ")[0]}
                </span>
              </>
            )}
          </div>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: isOver ? "#B91C1C" : days <= 7 ? "#B45309" : "#047857",
            }}
          >
            {isOver
              ? `${Math.abs(days)}d over`
              : days === 0
              ? "Today"
              : `${days}d`}
          </span>
        </div>
      </div>
    );
  };

  const Dashboard = () => {
    // Stat filter config
    const STAT_META = {
      overdue: {
        label: "Overdue Tasks",
        color: "#B91C1C",
        bg: "#FEF2F2",
        bdr: "#FCA5A5",
        accent: "#FC8181",
        tasks: overdue,
      },
      week: {
        label: "Due This Week",
        color: "#B45309",
        bg: "#FFFBEB",
        bdr: "#FCD34D",
        accent: "#F6AD55",
        tasks: dueThisWeek,
      },
      "30d": {
        label: "Due in Next 30 Days",
        color: "#1D4ED8",
        bg: "#EFF6FF",
        bdr: "#BFDBFE",
        accent: "#63B3ED",
        tasks: due30,
      },
      collections: {
        label: "All Collections",
        color: TH.primary,
        bg: TH.accent,
        bdr: TH.accentBdr,
        accent: TH.primary,
        tasks: [],
      },
    };
    const activeMeta = statFilter ? STAT_META[statFilter] : null;
    const showTaskList = statFilter && statFilter !== "collections";
    const showCollections = !statFilter || statFilter === "collections";

    return (
      <div onClick={() => setCtxMenu(null)}>
        {overdue.length > 0 && !statFilter && (
          <div
            style={{
              background: "#FFF5F5",
              border: "1px solid #FEB2B2",
              borderLeft: `4px solid ${TH.primary}`,
              borderRadius: 10,
              padding: "12px 20px",
              marginBottom: 22,
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <span>⚠️</span>
            <span style={{ color: "#B91C1C", fontSize: 13 }}>
              <strong>{overdue.length} overdue</strong> —{" "}
              {overdue
                .map((t) => `${getBrand(t.brand).short} ${t.phase}`)
                .join(", ")}
            </span>
          </div>
        )}
        {tasks.length === 0 && (
          <div style={{ textAlign: "center", padding: "80px 0" }}>
            <div style={{ fontSize: 52, marginBottom: 16 }}>📅</div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: TH.text,
                marginBottom: 8,
              }}
            >
              No collections yet
            </div>
            <div
              style={{ fontSize: 14, color: TH.textMuted, marginBottom: 28 }}
            >
              Create your first collection to auto-generate a full timeline.
            </div>
            {isAdmin && (
              <button
                onClick={() => setShowWizard(true)}
                style={{ ...S.btn, padding: "14px 32px", fontSize: 15 }}
              >
                + New Collection
              </button>
            )}
          </div>
        )}
        {tasks.length > 0 && (
          <>
            {/* Stat filter banner */}
            {statFilter && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 22,
                  padding: "12px 18px",
                  background: activeMeta.bg,
                  border: `1px solid ${activeMeta.bdr}`,
                  borderLeft: `4px solid ${activeMeta.accent}`,
                  borderRadius: 10,
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: activeMeta.color,
                  }}
                >
                  {activeMeta.tasks?.length ?? collList.length}{" "}
                  {activeMeta.label}
                </span>
                <button
                  onClick={() => setStatFilter(null)}
                  style={{
                    marginLeft: "auto",
                    padding: "4px 12px",
                    borderRadius: 6,
                    border: `1px solid ${activeMeta.bdr}`,
                    background: "none",
                    color: activeMeta.color,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  ✕ Clear Filter
                </button>
              </div>
            )}

            {/* Stat summary cards — only when no filter active */}
            {!statFilter && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,1fr)",
                  gap: 16,
                  marginBottom: 28,
                }}
              >
                {[
                  {
                    id: "overdue",
                    label: "Overdue",
                    count: overdue.length,
                    c: "#B91C1C",
                    bg: "#FEF2F2",
                    bdr: "#FCA5A5",
                  },
                  {
                    id: "week",
                    label: "Due This Week",
                    count: dueThisWeek.length,
                    c: "#B45309",
                    bg: "#FFFBEB",
                    bdr: "#FCD34D",
                  },
                  {
                    id: "30d",
                    label: "Next 30 Days",
                    count: due30.length,
                    c: "#1D4ED8",
                    bg: "#EFF6FF",
                    bdr: "#BFDBFE",
                  },
                ].map((s) => (
                  <div
                    key={s.label}
                    onClick={() => setStatFilter(s.id)}
                    style={{
                      background: s.bg,
                      border: `1px solid ${s.bdr}`,
                      borderTop: `4px solid ${s.c}`,
                      borderRadius: 12,
                      padding: "20px 24px",
                      boxShadow: `0 2px 8px ${TH.shadow}`,
                      cursor: "pointer",
                      transition: "transform 0.15s,box-shadow 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "translateY(-2px)";
                      e.currentTarget.style.boxShadow = `0 6px 16px ${TH.shadowMd}`;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "none";
                      e.currentTarget.style.boxShadow = `0 2px 8px ${TH.shadow}`;
                    }}
                  >
                    <div
                      style={{
                        fontSize: 40,
                        fontWeight: 800,
                        color: s.c,
                        lineHeight: 1,
                      }}
                    >
                      {s.count}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: TH.textMuted,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        marginTop: 6,
                      }}
                    >
                      {s.label}
                    </div>
                    {s.count > 0 && (
                      <div
                        style={{
                          fontSize: 11,
                          color: s.c,
                          marginTop: 4,
                          fontWeight: 600,
                        }}
                      >
                        Click to view →
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Filtered task list view */}
            {showTaskList && (
              <>
                {activeMeta.tasks.length === 0 ? (
                  <div
                    style={{
                      textAlign: "center",
                      color: TH.textMuted,
                      padding: "48px 0",
                      fontSize: 14,
                    }}
                  >
                    No tasks in this category 🎉
                  </div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill,minmax(240px,1fr))",
                      gap: 10,
                      marginBottom: 28,
                    }}
                  >
                    {[...activeMeta.tasks]
                      .sort((a, b) => new Date(a.due) - new Date(b.due))
                      .map((t) => (
                        <TaskCard key={t.id} task={t} showDayDate={true} />
                      ))}
                  </div>
                )}

                {/* Mini calendar for "This Week" */}
                {statFilter === "week" &&
                  (() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const days = Array.from({ length: 8 }, (_, i) => {
                      const d = new Date(today);
                      d.setDate(today.getDate() + i);
                      return d;
                    });
                    const DAY_NAMES_FULL = [
                      "Sun",
                      "Mon",
                      "Tue",
                      "Wed",
                      "Thu",
                      "Fri",
                      "Sat",
                    ];
                    return (
                      <div style={{ marginBottom: 28 }}>
                        {/* Dark gradient header */}
                        <div
                          style={{
                            background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
                            borderRadius: 14,
                            padding: "12px 16px 0",
                            marginBottom: 4,
                            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              marginBottom: 12,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 13,
                                  fontWeight: 800,
                                  color: "#fff",
                                  letterSpacing: "-0.01em",
                                }}
                              >
                                This Week
                              </span>
                              <span
                                style={{
                                  fontSize: 10,
                                  color: "rgba(255,255,255,0.4)",
                                  background: "rgba(255,255,255,0.07)",
                                  padding: "1px 8px",
                                  borderRadius: 20,
                                }}
                              >
                                {days[0].toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })}{" "}
                                –{" "}
                                {days[7].toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })}
                              </span>
                            </div>
                            {dragId && (
                              <span
                                style={{
                                  fontSize: 10,
                                  color: "#93C5FD",
                                  fontWeight: 600,
                                }}
                              >
                                ✋ Drop to reschedule
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(8,1fr)",
                              gap: 4,
                            }}
                          >
                            {days.map((day, i) => {
                              const isWeekend =
                                day.getDay() === 0 || day.getDay() === 6;
                              return (
                                <div
                                  key={i}
                                  style={{
                                    textAlign: "center",
                                    padding: "5px 0 7px",
                                    fontSize: 9,
                                    color: isWeekend
                                      ? "rgba(255,255,255,0.3)"
                                      : "rgba(255,255,255,0.5)",
                                    letterSpacing: "0.1em",
                                    textTransform: "uppercase",
                                    fontWeight: 700,
                                  }}
                                >
                                  {DAY_NAMES_FULL[day.getDay()]}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(8,1fr)",
                            gap: 4,
                          }}
                        >
                          {days.map((day, i) => {
                            const ds = `${day.getFullYear()}-${String(
                              day.getMonth() + 1
                            ).padStart(2, "0")}-${String(
                              day.getDate()
                            ).padStart(2, "0")}`;
                            const dayTasks = activeMeta.tasks.filter(
                              (t) => t.due === ds
                            );
                            const isToday =
                              day.toDateString() === today.toDateString();
                            const isDragTarget =
                              miniCalDragOver === ds && dragId;
                            return (
                              <div
                                key={i}
                                onDragOver={(e) => {
                                  if (!dragId) return;
                                  e.preventDefault();
                                  if (miniCalDragOver !== ds)
                                    setMiniCalDragOver(ds);
                                }}
                                onDragEnter={(e) => {
                                  if (!dragId) return;
                                  e.preventDefault();
                                  setMiniCalDragOver(ds);
                                }}
                                onDragLeave={(e) => {
                                  if (
                                    !e.currentTarget.contains(
                                      e.relatedTarget as Node
                                    )
                                  )
                                    setMiniCalDragOver(null);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const id =
                                    e.dataTransfer.getData("text/plain") ||
                                    dragId;
                                  if (!id) return;
                                  setTasks((ts) =>
                                    ts.map((t) =>
                                      t.id === id ? { ...t, due: ds } : t
                                    )
                                  );
                                  setDragId(null);
                                  setMiniCalDragOver(null);
                                }}
                                style={{
                                  borderRadius: "0 0 10px 10px",
                                  overflow: "hidden",
                                  border: `1px solid ${
                                    isDragTarget
                                      ? "#3B82F6"
                                      : isToday
                                      ? TH.primary
                                      : TH.border
                                  }`,
                                  borderTop: `3px solid ${
                                    isDragTarget
                                      ? "#3B82F6"
                                      : isToday
                                      ? TH.primary
                                      : TH.border
                                  }`,
                                  background: isDragTarget
                                    ? "#DBEAFE"
                                    : isToday
                                    ? TH.primary + "06"
                                    : TH.surface,
                                  boxShadow: `0 1px 4px ${TH.shadow}`,
                                  transition:
                                    "background 0.1s, border-color 0.1s",
                                }}
                              >
                                <div
                                  style={{
                                    padding: "6px 8px 3px",
                                    borderBottom: `1px solid ${TH.border}`,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 16,
                                      fontWeight: 800,
                                      color: isDragTarget
                                        ? "#1D4ED8"
                                        : isToday
                                        ? TH.primary
                                        : TH.text,
                                      lineHeight: 1.1,
                                    }}
                                  >
                                    {day.getDate()}
                                    {isDragTarget && " 📅"}
                                  </div>
                                </div>
                                <div style={{ padding: "5px 5px" }}>
                                  {dayTasks.length === 0 && !isDragTarget ? (
                                    <div
                                      style={{
                                        fontSize: 10,
                                        color: TH.textMuted,
                                        textAlign: "center",
                                        padding: "4px 0",
                                      }}
                                    >
                                      —
                                    </div>
                                  ) : (
                                    dayTasks.map((t) => {
                                      const b = getBrand(t.brand);
                                      const sc =
                                        STATUS_CONFIG[t.status] ||
                                        STATUS_CONFIG["Not Started"];
                                      const isBeingDragged = dragId === t.id;
                                      return (
                                        <div
                                          key={t.id}
                                          draggable
                                          onDragStart={(e) => {
                                            e.dataTransfer.setData(
                                              "text/plain",
                                              t.id
                                            );
                                            setTimeout(
                                              () => setDragId(t.id),
                                              0
                                            );
                                          }}
                                          onDragEnd={() => {
                                            setDragId(null);
                                            setMiniCalDragOver(null);
                                          }}
                                          onClick={() => {
                                            if (!dragId) setEditTask(t);
                                          }}
                                          style={{
                                            fontSize: 10.5,
                                            background: isBeingDragged
                                              ? "#F3F4F6"
                                              : "#FFFFFF",
                                            borderLeft: `3px solid ${b.color}`,
                                            padding: "3px 5px",
                                            borderRadius: 4,
                                            marginBottom: 3,
                                            cursor: isBeingDragged
                                              ? "grabbing"
                                              : "grab",
                                            boxShadow:
                                              "0 1px 2px rgba(0,0,0,0.08)",
                                            opacity: isBeingDragged ? 0.4 : 1,
                                            userSelect: "none",
                                          }}
                                        >
                                          <div
                                            style={{
                                              fontWeight: 700,
                                              color: TH.text,
                                            }}
                                          >
                                            {b.short} {t.phase}
                                          </div>
                                          <div
                                            style={{
                                              color: sc.color,
                                              fontWeight: 600,
                                              fontSize: 9.5,
                                            }}
                                          >
                                            {t.status}
                                          </div>
                                          <div
                                            style={{
                                              color: TH.textMuted,
                                              fontSize: 9.5,
                                            }}
                                          >
                                            {t.collection}
                                          </div>
                                        </div>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                {/* Mini calendar for "Next 30 Days" */}
                {statFilter === "30d" &&
                  (() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const rangeStart = new Date(today);
                    rangeStart.setDate(today.getDate() + 1);
                    const rangeEnd = new Date(today);
                    rangeEnd.setDate(today.getDate() + 30);
                    const tasksByDate = {};
                    [...dueThisWeek, ...activeMeta.tasks].forEach((t) => {
                      if (!tasksByDate[t.due]) tasksByDate[t.due] = [];
                      if (!tasksByDate[t.due].find((x) => x.id === t.id))
                        tasksByDate[t.due].push(t);
                    });
                    const months = [];
                    let cur = new Date(
                      rangeStart.getFullYear(),
                      rangeStart.getMonth(),
                      1
                    );
                    const endMonthStart = new Date(
                      rangeEnd.getFullYear(),
                      rangeEnd.getMonth(),
                      1
                    );
                    while (cur <= endMonthStart) {
                      months.push({
                        year: cur.getFullYear(),
                        month: cur.getMonth(),
                      });
                      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
                    }
                    const DAY_NAMES = [
                      "Sun",
                      "Mon",
                      "Tue",
                      "Wed",
                      "Thu",
                      "Fri",
                      "Sat",
                    ];
                    return (
                      <div style={{ marginBottom: 28 }}>
                        {months.map(({ year, month }) => {
                          const fd = new Date(year, month, 1).getDay();
                          const dim = new Date(year, month + 1, 0).getDate();
                          const cells = [
                            ...Array(fd).fill(null),
                            ...Array.from({ length: dim }, (_, i) => i + 1),
                          ];
                          return (
                            <div
                              key={`${year}-${month}`}
                              style={{ marginBottom: 16 }}
                            >
                              {/* Dark gradient month header */}
                              <div
                                style={{
                                  background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
                                  borderRadius: 14,
                                  padding: "12px 16px 0",
                                  marginBottom: 4,
                                  boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    marginBottom: 12,
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 10,
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 14,
                                        fontWeight: 800,
                                        color: "#fff",
                                        letterSpacing: "-0.01em",
                                      }}
                                    >
                                      {MONTHS[month]}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: 13,
                                        fontWeight: 400,
                                        color: "rgba(255,255,255,0.45)",
                                      }}
                                    >
                                      {year}
                                    </span>
                                  </div>
                                  {dragId && (
                                    <span
                                      style={{
                                        fontSize: 10,
                                        color: "#93C5FD",
                                        fontWeight: 600,
                                      }}
                                    >
                                      ✋ Drop to reschedule
                                    </span>
                                  )}
                                </div>
                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(7,1fr)",
                                    gap: 3,
                                  }}
                                >
                                  {DAY_NAMES.map((d, di) => {
                                    const isWeekend = di === 0 || di === 6;
                                    return (
                                      <div
                                        key={d}
                                        style={{
                                          textAlign: "center",
                                          padding: "5px 0 7px",
                                          fontSize: 9,
                                          color: isWeekend
                                            ? "rgba(255,255,255,0.3)"
                                            : "rgba(255,255,255,0.5)",
                                          letterSpacing: "0.1em",
                                          textTransform: "uppercase",
                                          fontWeight: 700,
                                        }}
                                      >
                                        {d}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "repeat(7,1fr)",
                                  gap: 3,
                                }}
                              >
                                {cells.map((d, i) => {
                                  if (!d)
                                    return (
                                      <div key={i} style={{ minHeight: 58 }} />
                                    );
                                  const ds = `${year}-${String(
                                    month + 1
                                  ).padStart(2, "0")}-${String(d).padStart(
                                    2,
                                    "0"
                                  )}`;
                                  const cellDate = new Date(year, month, d);
                                  const inRange =
                                    cellDate >= rangeStart &&
                                    cellDate <= rangeEnd;
                                  if (!inRange)
                                    return (
                                      <div key={i} style={{ minHeight: 58 }} />
                                    );
                                  const dayTasks = tasksByDate[ds] || [];
                                  const hasTasks = dayTasks.length > 0;
                                  const isDragTarget =
                                    miniCalDragOver === ds && dragId;
                                  return (
                                    <div
                                      key={i}
                                      onDragOver={(e) => {
                                        if (!dragId) return;
                                        e.preventDefault();
                                        if (miniCalDragOver !== ds)
                                          setMiniCalDragOver(ds);
                                      }}
                                      onDragEnter={(e) => {
                                        if (!dragId) return;
                                        e.preventDefault();
                                        setMiniCalDragOver(ds);
                                      }}
                                      onDragLeave={(e) => {
                                        if (
                                          !e.currentTarget.contains(
                                            e.relatedTarget as Node
                                          )
                                        )
                                          setMiniCalDragOver(null);
                                      }}
                                      onDrop={(e) => {
                                        e.preventDefault();
                                        const id =
                                          e.dataTransfer.getData(
                                            "text/plain"
                                          ) || dragId;
                                        if (!id) return;
                                        setTasks((ts) =>
                                          ts.map((t) =>
                                            t.id === id ? { ...t, due: ds } : t
                                          )
                                        );
                                        setDragId(null);
                                        setMiniCalDragOver(null);
                                      }}
                                      style={{
                                        minHeight: 58,
                                        padding: "4px 4px",
                                        borderRadius: 7,
                                        background: isDragTarget
                                          ? "#DBEAFE"
                                          : hasTasks
                                          ? "#EFF6FF"
                                          : "#F7F8FA",
                                        border: `1px solid ${
                                          isDragTarget
                                            ? "#3B82F6"
                                            : hasTasks
                                            ? "#BFDBFE"
                                            : TH.border
                                        }`,
                                        transition:
                                          "background 0.1s, border-color 0.1s",
                                      }}
                                    >
                                      <div
                                        style={{
                                          fontSize: 11,
                                          fontWeight:
                                            hasTasks || isDragTarget
                                              ? 800
                                              : 400,
                                          color: isDragTarget
                                            ? "#1D4ED8"
                                            : hasTasks
                                            ? "#1D4ED8"
                                            : TH.textMuted,
                                          marginBottom: 2,
                                        }}
                                      >
                                        {d}
                                        {isDragTarget && " 📅"}
                                      </div>
                                      {dayTasks.slice(0, 2).map((t) => {
                                        const b = getBrand(t.brand);
                                        const isBeingDragged = dragId === t.id;
                                        return (
                                          <div
                                            key={t.id}
                                            draggable
                                            onDragStart={(e) => {
                                              e.dataTransfer.setData(
                                                "text/plain",
                                                t.id
                                              );
                                              setTimeout(
                                                () => setDragId(t.id),
                                                0
                                              );
                                            }}
                                            onDragEnd={() => {
                                              setDragId(null);
                                              setMiniCalDragOver(null);
                                            }}
                                            onClick={() => {
                                              if (!dragId) setEditTask(t);
                                            }}
                                            style={{
                                              fontSize: 9.5,
                                              background: isBeingDragged
                                                ? "#F3F4F6"
                                                : "#fff",
                                              borderLeft: `2px solid ${b.color}`,
                                              padding: "2px 4px",
                                              borderRadius: 3,
                                              marginBottom: 2,
                                              cursor: isBeingDragged
                                                ? "grabbing"
                                                : "grab",
                                              color: TH.text,
                                              fontWeight: 600,
                                              lineHeight: 1.2,
                                              boxShadow:
                                                "0 1px 2px rgba(0,0,0,0.06)",
                                              opacity: isBeingDragged ? 0.4 : 1,
                                              userSelect: "none",
                                            }}
                                          >
                                            {b.short} {t.phase}
                                          </div>
                                        );
                                      })}
                                      {dayTasks.length > 2 && (
                                        <div
                                          style={{
                                            fontSize: 9,
                                            color: "#1D4ED8",
                                            fontWeight: 700,
                                          }}
                                        >
                                          +{dayTasks.length - 2}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
              </>
            )}

            {/* Collections grid */}
            {showCollections && (
              <>
                <span style={S.sec}>
                  Collections{" "}
                  <span style={{ color: TH.textSub2, fontWeight: 400 }}>
                    — click to focus · right-click for options
                  </span>
                </span>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))",
                    gap: 12,
                    marginBottom: 28,
                  }}
                >
                  {collList.map((c) => {
                    const brand = getBrand(c.brand),
                      done = c.tasks.filter((t) =>
                        ["Complete", "Approved"].includes(t.status)
                      ).length,
                      pct = Math.round((done / c.tasks.length) * 100),
                      hasDelay = c.tasks.some((t) => t.status === "Delayed");
                    const next = c.tasks
                      .filter(
                        (t) => !["Complete", "Approved"].includes(t.status)
                      )
                      .sort((a, b) => new Date(a.due) - new Date(b.due))[0];
                    const collData = collections[c.key] || {},
                      skuCount = collData.skus?.length || 0;
                    const assigneeIds = [
                      ...new Set(
                        c.tasks.map((t) => t.assigneeId).filter(Boolean)
                      ),
                    ];
                    const isFocused = focusCollKey === c.key;
                    const ddpTask = c.tasks.find((t) => t.phase === "DDP");
                    return (
                      <div
                        key={c.key}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusCollKey(isFocused ? null : c.key);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            collKey: c.key,
                          });
                        }}
                        style={{
                          ...S.card,
                          cursor: "pointer",
                          outline: isFocused
                            ? `2px solid ${brand.color}`
                            : "2px solid transparent",
                          outlineOffset: 2,
                          transition: "all 0.15s",
                          transform: isFocused ? "scale(1.01)" : "scale(1)",
                          position: "relative",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            height: 3,
                            background: `linear-gradient(90deg,${brand.color},${brand.color}44)`,
                          }}
                        />
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            marginBottom: 10,
                            paddingTop: 4,
                          }}
                        >
                          <div>
                            {/* Line 1: Collection Name — app red */}
                            <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 2 }}>
                              {c.collection}
                            </div>
                            {/* Line 2: Season Year · Gender · Category */}
                            <div style={{ fontSize: 11, color: TH.textSub2 }}>
                              {c.season}
                              {collData.year ? ` ${collData.year}` : ""}
                              {collData.gender ? ` · ${collData.gender}` : ""}
                              {c.category ? ` · ${c.category}` : ""}
                            </div>
                            {/* Line 3: Vendor · DDP · Exit Factory */}
                            {(() => {
                              const shipTask = c.tasks.find((t) => t.phase === "Ship Date");
                              const parts = [];
                              if (c.vendorName) parts.push(c.vendorName);
                              if (ddpTask) parts.push(`DDP: ${formatDate(ddpTask.due)}`);
                              if (shipTask) parts.push(`Exit Factory: ${formatDate(shipTask.due)}`);
                              return parts.length > 0 ? (
                                <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>
                                  {parts.join(" · ")}
                                </div>
                              ) : null;
                            })()}
                            {/* Line 4: Customer · Start Ship · Cancel */}
                            {(() => {
                              const parts = [];
                              if (collData.customer) {
                                parts.push(collData.customer + (collData.orderType ? ` (${collData.orderType})` : ""));
                              }
                              if (collData.customerShipDate) parts.push(`Start Ship: ${formatDate(collData.customerShipDate)}`);
                              if (collData.cancelDate) parts.push(`Cancel: ${formatDate(collData.cancelDate)}`);
                              return parts.length > 0 ? (
                                <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>
                                  {parts.join(" · ")}
                                </div>
                              ) : null;
                            })()}
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div
                              style={{
                                fontSize: 24,
                                fontWeight: 800,
                                color: pct === 100 ? "#047857" : TH.text,
                                lineHeight: 1,
                              }}
                            >
                              {pct}%
                            </div>
                            {hasDelay && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: "#B91C1C",
                                  fontWeight: 700,
                                }}
                              >
                                ⚠ Delayed
                              </div>
                            )}
                          </div>
                        </div>
                        <div
                          style={{
                            height: 5,
                            background: TH.surfaceHi,
                            border: `1px solid ${TH.border}`,
                            borderRadius: 3,
                            overflow: "hidden",
                            marginBottom: 10,
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${pct}%`,
                              background: `linear-gradient(90deg,${brand.color},${TH.primary})`,
                              borderRadius: 3,
                              transition: "width 0.6s",
                            }}
                          />
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 6,
                          }}
                        >
                          {next && (
                            <div style={{ fontSize: 11, color: TH.textMuted }}>
                              Next:{" "}
                              <span
                                style={{ color: TH.textSub2, fontWeight: 600 }}
                              >
                                {next.phase}
                              </span>{" "}
                              —{" "}
                              <span
                                style={{
                                  color:
                                    getDaysUntil(next.due) < 0
                                      ? "#B91C1C"
                                      : getDaysUntil(next.due) < 7
                                      ? "#B45309"
                                      : TH.primary,
                                  fontWeight: 600,
                                }}
                              >
                                {formatDate(next.due)}
                              </span>
                            </div>
                          )}
                          <div style={{ fontSize: 11, color: TH.textMuted }}>
                            {skuCount} SKU{skuCount !== 1 ? "s" : ""}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              gap: 3,
                              flexWrap: "wrap",
                            }}
                          >
                            {c.tasks
                              .sort((a, b) => new Date(a.due) - new Date(b.due))
                              .map((t) => (
                                <span
                                  key={t.id}
                                  title={`${t.phase}: ${t.status}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditTask(t);
                                  }}
                                  style={{
                                    width: 9,
                                    height: 9,
                                    borderRadius: 2,
                                    background:
                                      STATUS_CONFIG[t.status]?.dot || TH.border,
                                    display: "inline-block",
                                    cursor: "pointer",
                                  }}
                                />
                              ))}
                          </div>
                          <div style={{ display: "flex", gap: 3 }}>
                            {assigneeIds.slice(0, 4).map((id) => {
                              const m = team.find((x) => x.id === id);
                              return m ? (
                                <Avatar key={id} member={m} size={20} />
                              ) : null;
                            })}
                          </div>
                        </div>
                        <div
                          style={{
                            marginTop: 10,
                            paddingTop: 10,
                            borderTop: `1px solid ${TH.border}`,
                            display: "flex",
                            gap: 6,
                          }}
                        >
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusCollKey(c.key);
                              setView("timeline");
                            }}
                            style={{
                              flex: 1,
                              padding: "4px 6px",
                              borderRadius: 6,
                              border: `1px solid ${brand.color}44`,
                              background: brand.color + "12",
                              color: brand.color,
                              cursor: "pointer",
                              fontFamily: "inherit",
                              fontSize: 10,
                              fontWeight: 700,
                            }}
                          >
                            📊 Timeline
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusCollKey(c.key);
                              setView("calendar");
                            }}
                            style={{
                              flex: 1,
                              padding: "4px 6px",
                              borderRadius: 6,
                              border: `1px solid ${brand.color}44`,
                              background: brand.color + "12",
                              color: brand.color,
                              cursor: "pointer",
                              fontFamily: "inherit",
                              fontSize: 10,
                              fontWeight: 700,
                            }}
                          >
                            📅 Calendar
                          </button>
                          {/* Images button with concept/sku submenu */}
                          <CollImageBtn
                            collKey={c.key}
                            collData={collData}
                            brand={brand}
                            collections={collections}
                            tasks={tasks}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {!statFilter && dueThisWeek.length > 0 && (
                  <>
                    <span style={S.sec}>Due This Week</span>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fill,minmax(220px,1fr))",
                        gap: 10,
                      }}
                    >
                      {dueThisWeek.map((t) => (
                        <TaskCard key={t.id} task={t} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    );
  };

  const Timeline = () => {
    const g = {};
    const src = focusCollKey
      ? tasks.filter((t) => `${t.brand}||${t.collection}` === focusCollKey)
      : filtered;
    src.forEach((t) => {
      if (!g[t.brand]) g[t.brand] = {};
      if (!g[t.brand][t.collection]) g[t.brand][t.collection] = [];
      g[t.brand][t.collection].push(t);
    });
    if (!Object.keys(g).length)
      return (
        <div
          style={{
            textAlign: "center",
            color: TH.textMuted,
            padding: "60px 0",
          }}
        >
          No collections match.
          {focusCollKey && (
            <>
              <br />
              <button
                onClick={() => setFocusCollKey(null)}
                style={{
                  marginTop: 12,
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: `1px solid ${TH.border}`,
                  background: "none",
                  color: TH.textMuted,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Show All
              </button>
            </>
          )}
        </div>
      );
    return (
      <div
        style={{
          background: "#EEF1F6",
          borderRadius: 14,
          padding: "22px",
          minHeight: 200,
        }}
      >
        {focusCollKey && (
          <div
            style={{
              marginBottom: 18,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 13, color: TH.textMuted }}>
              Showing:{" "}
              <strong style={{ color: TH.text }}>
                {focusCollKey.split("||")[1]}
              </strong>
            </span>
            <button
              onClick={() => setFocusCollKey(null)}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
              }}
            >
              ✕ Show All
            </button>
          </div>
        )}
        {Object.entries(g).map(([bid, colls]) => {
          const brand = getBrand(bid);
          return (
            <div key={bid} style={{ marginBottom: 36 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    width: 4,
                    height: 28,
                    background: brand.color,
                    borderRadius: 2,
                  }}
                />
                <span style={{ fontSize: 17, fontWeight: 700, color: TH.primary }}>
                  {brand.name.toUpperCase()}
                  {(() => {
                    // Find sampleDueDate from any collection under this brand
                    const sampleDate = Object.keys(colls)
                      .map((cname) => (collections[`${bid}||${cname}`] || {}).sampleDueDate)
                      .find(Boolean);
                    return sampleDate ? (
                      <span style={{ fontSize: 12, fontWeight: 700, color: TH.textMuted, marginLeft: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        · SAMPLES DUE: {formatDate(sampleDate)}
                      </span>
                    ) : null;
                  })()}
                </span>
              </div>
              {Object.entries(colls).map(([cname, ctasks]) => {
                const ALL_PHASES = [
                  ...PHASE_KEYS.slice(0, PHASE_KEYS.indexOf("Purchase Order")),
                  "Line Review",
                  "Compliance/Testing",
                  ...PHASE_KEYS.slice(PHASE_KEYS.indexOf("Purchase Order")),
                ];
                const sorted = [...ctasks].sort((a, b) => {
                  // Primary sort: chronological by due date
                  const dateDiff = new Date(a.due) - new Date(b.due);
                  if (dateDiff !== 0) return dateDiff;
                  // Tiebreaker: use standard phase order when dates are equal
                  const ai = ALL_PHASES.indexOf(a.phase);
                  const bi = ALL_PHASES.indexOf(b.phase);
                  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
                });
                const collData = collections[`${bid}||${cname}`] || {};
                const ddpTask = sorted.find((t) => t.phase === "DDP");
                return (
                  <div key={cname} style={{ marginBottom: 24, marginLeft: 16 }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: TH.textMuted,
                        letterSpacing: "0.07em",
                        textTransform: "uppercase",
                        marginBottom: 8,
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                        flexWrap: "wrap",
                      }}
                    >
                      {/* Line 1: Collection — grey */}
                      <span style={{ fontWeight: 700, color: TH.textMuted }}>
                        {cname}
                      </span>
                      {/* Season · Year · Gender · Category */}
                      <span style={{ fontWeight: 400, color: TH.textMuted }}>
                        {ctasks[0]?.season ? `${ctasks[0].season}` : ""}
                        {collData.year ? ` ${collData.year}` : ""}
                        {collData.gender ? ` · ${collData.gender}` : ""}
                        {ctasks[0]?.category ? ` · ${ctasks[0].category}` : ""}
                      </span>
                      {/* Line 2: Vendor · DDP · Exit Factory */}
                      {(() => {
                        const shipTask = sorted.find((t) => t.phase === "Ship Date");
                        const parts = [];
                        if (ctasks[0]?.vendorName) parts.push(ctasks[0].vendorName);
                        if (ddpTask) parts.push(`DDP: ${formatDate(ddpTask.due)}`);
                        if (shipTask) parts.push(`Exit Factory: ${formatDate(shipTask.due)}`);
                        return parts.length > 0 ? (
                          <span style={{ color: TH.textMuted, fontWeight: 400 }}>
                            {parts.join(" · ")}
                          </span>
                        ) : null;
                      })()}
                      {/* Line 3: Customer · Start Ship · Cancel */}
                      {(() => {
                        const shipDays = collData.customerShipDate ? getDaysUntil(collData.customerShipDate) : null;
                        const parts = [];
                        if (collData.customer) parts.push(collData.customer + (collData.orderType ? ` (${collData.orderType})` : ""));
                        if (collData.customerShipDate) parts.push(`Start Ship: ${formatDate(collData.customerShipDate)}`);
                        if (collData.cancelDate) parts.push(`Cancel: ${formatDate(collData.cancelDate)}`);
                        return parts.length > 0 ? (
                          <span style={{ color: TH.textMuted, fontWeight: 400 }}>
                            {parts.join(" · ")}
                          </span>
                        ) : null;
                      })()}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "stretch",
                        overflowX: "auto",
                        paddingBottom: 16,
                        gap: 0,
                      }}
                    >
                      {sorted.map((t, i) => {
                        const sc =
                            STATUS_CONFIG[t.status] ||
                            STATUS_CONFIG["Not Started"],
                          days = getDaysUntil(t.due),
                          isOver = days < 0 && t.status !== "Complete",
                          isPL =
                            t.phase === "Line Review" ||
                            t.phase === "Compliance/Testing",
                          isDDP = t.phase === "DDP",
                          isShip = t.phase === "Ship Date";
                        const assignee =
                          team.find((m) => m.id === t.assigneeId) || null;
                        const countdownColor = isOver
                          ? "#B91C1C"
                          : days <= 7
                          ? "#B45309"
                          : days <= 14
                          ? "#D97706"
                          : "#065F46";
                        const countdownLabel =
                          t.status === "Complete"
                            ? "Done"
                            : isOver
                            ? `${Math.abs(days)}d over`
                            : days === 0
                            ? "Today"
                            : `${days}d`;
                        const isDraggingThis = dragId === t.id;
                        const gapKey = `${bid}-${cname}-gap-${i}`;
                        const isGapActive = dragOverId === gapKey;

                        // Days from concept (first task) to this task
                        const conceptTask = sorted[0];
                        const daysFromConcept = conceptTask
                          ? diffDays(t.due, conceptTask.due)
                          : 0;

                        // Days from previous task to this task
                        const prevTask = sorted[i - 1];
                        const daysFromPrev = prevTask
                          ? diffDays(t.due, prevTask.due)
                          : null;

                        return (
                          <div
                            key={t.id}
                            style={{
                              display: "flex",
                              alignItems: "stretch",
                              flexShrink: 0,
                            }}
                          >
                            {/* ── CARD ── */}
                            <div
                              draggable={true}
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", t.id);
                                setTimeout(() => setDragId(t.id), 0);
                              }}
                              onDragEnd={() => {
                                setDragId(null);
                                setDragOverId(null);
                              }}
                              onClick={() => {
                                if (!dragId) setEditTask(t);
                              }}
                              style={{
                                minWidth: 94,
                                textAlign: "center",
                                background: isDDP
                                  ? "#FFF5F5"
                                  : isShip
                                  ? "#F5FDFB"
                                  : isPL
                                  ? "#F9F8FF"
                                  : `${brand.color}08`,
                                border: `2px solid ${
                                  isDDP
                                    ? TH.primary
                                    : isShip
                                    ? "#10B981"
                                    : isPL
                                    ? "#8B5CF6"
                                    : brand.color + "44"
                                }`,
                                borderRadius: 10,
                                cursor: "pointer",
                                boxShadow: `0 2px 6px ${TH.shadow}`,
                                opacity: isDraggingThis ? 0.3 : 1,
                                transition: "opacity 0.15s",
                                userSelect: "none",
                                overflow: "hidden",
                              }}
                            >
                              {/* Drag handle */}
                              <div
                                style={{
                                  background: isDDP
                                    ? TH.primary + "22"
                                    : isShip
                                    ? "#10B98122"
                                    : isPL
                                    ? "#8B5CF622"
                                    : brand.color + "22",
                                  borderBottom: `1px solid ${brand.color}22`,
                                  padding: "4px 6px 3px",
                                  cursor: "grab",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  gap: 3,
                                }}
                              >
                                {[0, 1, 2, 3, 4].map((d) => (
                                  <div
                                    key={d}
                                    style={{
                                      width: 3,
                                      height: 3,
                                      borderRadius: "50%",
                                      background: brand.color + "99",
                                    }}
                                  />
                                ))}
                              </div>
                              <div style={{ padding: "6px 10px 8px" }}>
                                <div
                                  style={{
                                    fontSize: 13,
                                    color: TH.text,
                                    fontWeight: 700,
                                    marginBottom: 3,
                                  }}
                                >
                                  {t.phase}
                                </div>
                                {isPL && (
                                  <div
                                    style={{
                                      fontSize: 9,
                                      color: "#6D28D9",
                                      marginBottom: 2,
                                      fontWeight: 700,
                                    }}
                                  >
                                    PL REQ
                                  </div>
                                )}
                                <div
                                  style={{
                                    fontSize: 11,
                                    padding: "2px 6px",
                                    borderRadius: 5,
                                    background: sc.bg,
                                    color: sc.color,
                                    display: "inline-block",
                                    marginBottom: 4,
                                    fontWeight: 600,
                                  }}
                                >
                                  {t.status}
                                </div>
                                <div
                                  style={{
                                    fontSize: 10,
                                    color: TH.textMuted,
                                    fontWeight: 500,
                                    marginBottom: 1,
                                  }}
                                >
                                  Due
                                </div>
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: isOver
                                      ? "#B91C1C"
                                      : days <= 7
                                      ? "#B45309"
                                      : TH.textMuted,
                                    fontWeight: 600,
                                    marginBottom: 6,
                                  }}
                                >
                                  {formatDate(t.due)}
                                </div>

                                {/* Days section — matches design */}
                                <div
                                  style={{
                                    borderTop: `1px solid ${brand.color}22`,
                                    paddingTop: 6,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 8,
                                      color: TH.textMuted,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.08em",
                                      marginBottom: 4,
                                    }}
                                  >
                                    To Complete
                                  </div>
                                  <div style={{ marginBottom: 6 }}>
                                    <div
                                      style={{
                                        fontSize: 13,
                                        fontWeight: 800,
                                        color: countdownColor,
                                        background: countdownColor + "18",
                                        borderRadius: 6,
                                        padding: "2px 8px",
                                        display: "inline-block",
                                      }}
                                    >
                                      {countdownLabel}
                                    </div>
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 8,
                                      color: TH.textMuted,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.08em",
                                      marginBottom: 2,
                                    }}
                                  >
                                    From Last Task
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 13,
                                      fontWeight: 700,
                                      color:
                                        daysFromPrev != null && daysFromPrev < 0
                                          ? "#B91C1C"
                                          : TH.textSub2,
                                    }}
                                  >
                                    {daysFromPrev == null
                                      ? "—"
                                      : daysFromPrev === 0
                                      ? "0d"
                                      : `${daysFromPrev}d`}
                                  </div>
                                </div>

                                {assignee && (
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "center",
                                      marginTop: 5,
                                    }}
                                  >
                                    <Avatar member={assignee} size={16} />
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* ── DROP ZONE between cards ── */}
                            {i < sorted.length - 1 && (
                              <div
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (dragOverId !== gapKey)
                                    setDragOverId(gapKey);
                                }}
                                onDragEnter={(e) => {
                                  e.preventDefault();
                                  setDragOverId(gapKey);
                                }}
                                onDragLeave={(e) => {
                                  if (
                                    !e.currentTarget.contains(
                                      e.relatedTarget as Node
                                    )
                                  )
                                    setDragOverId(null);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const droppedId =
                                    e.dataTransfer.getData("text/plain") ||
                                    dragId;
                                  if (!droppedId) return;
                                  const prevTask = sorted[i];
                                  const nextTask = sorted[i + 1];
                                  const prevMs = parseLocalDate(
                                    prevTask.due
                                  ).getTime();
                                  const nextMs = parseLocalDate(
                                    nextTask.due
                                  ).getTime();
                                  const midMs = Math.round(
                                    (prevMs + nextMs) / 2
                                  );
                                  const mid = new Date(midMs);
                                  const mm = String(
                                    mid.getMonth() + 1
                                  ).padStart(2, "0");
                                  const dd = String(mid.getDate()).padStart(
                                    2,
                                    "0"
                                  );
                                  const newDue = `${mid.getFullYear()}-${mm}-${dd}`;
                                  setTasks((ts) =>
                                    ts.map((x) =>
                                      x.id === droppedId
                                        ? { ...x, due: newDue }
                                        : x
                                    )
                                  );
                                  setDragId(null);
                                  setDragOverId(null);
                                }}
                                style={{
                                  width: isGapActive ? 52 : 28,
                                  minHeight: "100%",
                                  flexShrink: 0,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  cursor: "copy",
                                  transition: "width 0.12s",
                                  position: "relative",
                                  zIndex: 2,
                                }}
                              >
                                {isGapActive ? (
                                  <div
                                    style={{
                                      width: 4,
                                      height: "100%",
                                      minHeight: 80,
                                      background: brand.color,
                                      borderRadius: 4,
                                      boxShadow: `0 0 0 3px ${brand.color}44`,
                                      position: "relative",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                    }}
                                  >
                                    <div
                                      style={{
                                        width: 24,
                                        height: 24,
                                        borderRadius: "50%",
                                        background: brand.color,
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        boxShadow: `0 0 0 4px ${brand.color}33`,
                                        zIndex: 3,
                                        position: "absolute",
                                      }}
                                    >
                                      <span
                                        style={{
                                          color: "#fff",
                                          fontSize: 14,
                                          fontWeight: 900,
                                          lineHeight: 1,
                                          marginTop: -1,
                                        }}
                                      >
                                        +
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    style={{
                                      width: "100%",
                                      height: 4,
                                      background: dragId
                                        ? brand.color + "66"
                                        : brand.color + "33",
                                      borderRadius: 2,
                                      transition: "background 0.15s",
                                    }}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  // ── CALENDAR VIEW ──────────────────────────────────────────────────────────
  const CalendarView = () => {
    const today = new Date();
    const [cy, setCy] = useState(today.getFullYear());
    const [cm, setCm] = useState(today.getMonth());
    const [calDragOver, setCalDragOver] = useState(null); // dateString being hovered
    const fd = new Date(cy, cm, 1).getDay(),
      dim = new Date(cy, cm + 1, 0).getDate();
    const cells = [
      ...Array(fd).fill(null),
      ...Array.from({ length: dim }, (_, i) => i + 1),
    ];
    const ds = (d) =>
      `${cy}-${String(cm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const src = focusCollKey
      ? tasks.filter((t) => `${t.brand}||${t.collection}` === focusCollKey)
      : filtered;

    function handleCalDrop(dateStr) {
      if (!dragId || !dateStr) return;
      setTasks((ts) =>
        ts.map((t) => (t.id === dragId ? { ...t, due: dateStr } : t))
      );
      setDragId(null);
      setCalDragOver(null);
    }

    return (
      <div>
        {dragId && (
          <div
            style={{
              marginBottom: 10,
              padding: "7px 14px",
              background: "#EFF6FF",
              border: "1px solid #BFDBFE",
              borderRadius: 8,
              fontSize: 12,
              color: "#1D4ED8",
              fontWeight: 600,
            }}
          >
            ✋ Drag a task to a day to reschedule
          </div>
        )}

        {/* ── Unified calendar header ── */}
        <div
          style={{
            background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
            borderRadius: 14,
            padding: "14px 20px 0",
            marginBottom: 4,
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
          }}
        >
          {/* Top row: collection filter + month nav */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            {/* Left: collection label */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {focusCollKey ? (
                <>
                  <span
                    style={{
                      fontSize: 11,
                      color: "rgba(255,255,255,0.45)",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    }}
                  >
                    Showing
                  </span>
                  <span
                    style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}
                  >
                    {focusCollKey.split("||")[1]}
                  </span>
                  <button
                    onClick={() => setFocusCollKey(null)}
                    style={{
                      padding: "3px 10px",
                      borderRadius: 20,
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: "rgba(255,255,255,0.08)",
                      color: "rgba(255,255,255,0.6)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 10,
                      fontWeight: 600,
                    }}
                  >
                    ✕ Show All
                  </button>
                </>
              ) : (
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "rgba(255,255,255,0.5)",
                    letterSpacing: "0.04em",
                  }}
                >
                  All Collections
                </span>
              )}
            </div>

            {/* Center: month navigation */}
            <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
              <button
                onClick={() => {
                  if (cm === 0) {
                    setCm(11);
                    setCy((y) => y - 1);
                  } else setCm((m) => m - 1);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "8px 0 0 8px",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRight: "none",
                  background: "rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.8)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 16,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.14)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.07)")
                }
              >
                ‹
              </button>
              <div
                style={{
                  padding: "0 22px",
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid rgba(255,255,255,0.15)",
                  background: "rgba(255,255,255,0.05)",
                  minWidth: 160,
                }}
              >
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    color: "#fff",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {MONTHS[cm]}
                </span>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 400,
                    color: "rgba(255,255,255,0.5)",
                    marginLeft: 8,
                  }}
                >
                  {cy}
                </span>
              </div>
              <button
                onClick={() => {
                  if (cm === 11) {
                    setCm(0);
                    setCy((y) => y + 1);
                  } else setCm((m) => m + 1);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "0 8px 8px 0",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderLeft: "none",
                  background: "rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.8)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 16,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.14)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.07)")
                }
              >
                ›
              </button>
            </div>

            {/* Right: today button */}
            <button
              onClick={() => {
                setCy(today.getFullYear());
                setCm(today.getMonth());
              }}
              style={{
                padding: "5px 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.07)",
                color: "rgba(255,255,255,0.65)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 600,
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.14)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.07)")
              }
            >
              Today
            </button>
          </div>

          {/* Day headers */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7,1fr)",
              gap: 4,
            }}
          >
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => {
              const isWeekend = i === 0 || i === 6;
              return (
                <div
                  key={d}
                  style={{
                    textAlign: "center",
                    padding: "6px 0 8px",
                    fontSize: 10,
                    color: isWeekend
                      ? "rgba(255,255,255,0.3)"
                      : "rgba(255,255,255,0.5)",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                  }}
                >
                  {d}
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7,1fr)",
            gap: 4,
          }}
        >
          {cells.map((d, i) => {
            const dateStr = d ? ds(d) : null;
            const dt = d ? src.filter((t) => t.due === ds(d)) : [];
            const isToday =
              d && new Date(ds(d)).toDateString() === today.toDateString();
            const isDragTarget = dateStr && calDragOver === dateStr;
            return (
              <div
                key={i}
                onDragOver={(e) => {
                  if (!d || !dragId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (calDragOver !== dateStr) setCalDragOver(dateStr);
                }}
                onDragEnter={(e) => {
                  if (!d || !dragId) return;
                  e.preventDefault();
                  setCalDragOver(dateStr);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node))
                    setCalDragOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleCalDrop(dateStr);
                }}
                style={{
                  minHeight: 90,
                  padding: 6,
                  background: isDragTarget
                    ? "#DBEAFE"
                    : d
                    ? "#E8ECF0"
                    : "transparent",
                  border: `1px solid ${
                    isDragTarget
                      ? "#3B82F6"
                      : isToday
                      ? TH.primary
                      : d
                      ? "#C8D0DA"
                      : "transparent"
                  }`,
                  borderTop: isDragTarget
                    ? `3px solid #3B82F6`
                    : isToday
                    ? `3px solid ${TH.primary}`
                    : d
                    ? `1px solid #C8D0DA`
                    : "none",
                  borderRadius: 8,
                  boxShadow: d ? `0 1px 3px ${TH.shadow}` : "none",
                  transition: "background 0.1s, border-color 0.1s",
                }}
              >
                {d && (
                  <div
                    style={{
                      fontSize: 13.8,
                      color: isDragTarget
                        ? "#1D4ED8"
                        : isToday
                        ? TH.primary
                        : TH.textMuted,
                      fontWeight: isDragTarget || isToday ? 800 : 400,
                      marginBottom: 4,
                    }}
                  >
                    {d}
                    {isDragTarget && (
                      <span style={{ fontSize: 10, marginLeft: 4 }}>📅</span>
                    )}
                  </div>
                )}
                {dt.slice(0, 3).map((t) => {
                  const b = getBrand(t.brand),
                    assignee = team.find((m) => m.id === t.assigneeId),
                    isDDP = t.phase === "DDP";
                  const collKey = `${t.brand}||${t.collection}`;
                  const collMeta = collections[collKey] || {};
                  const isBeingDragged = dragId === t.id;
                  return (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDragId(t.id);
                        setCalDragOver(null);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setCalDragOver(null);
                      }}
                      onClick={() => {
                        if (!dragId) setEditTask(t);
                      }}
                      style={{
                        fontSize: 11.5,
                        background: isBeingDragged ? "#F3F4F6" : "#FFFFFF",
                        borderLeft: `3px solid ${b.color}`,
                        padding: "3px 6px",
                        borderRadius: 4,
                        marginBottom: 3,
                        cursor: isBeingDragged ? "grabbing" : "grab",
                        color: "#1A202C",
                        fontWeight: isDDP ? 700 : 500,
                        boxShadow: "0 1px 3px rgba(0,0,0,0.10)",
                        opacity: isBeingDragged ? 0.4 : 1,
                        transition: "opacity 0.12s",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span style={{ fontWeight: 700, color: "#1A202C" }}>
                          {isDDP ? "🎯 " : ""}
                          {b.short} {t.phase}
                        </span>
                        {assignee && <Avatar member={assignee} size={13} />}
                      </div>
                      <div
                        style={{
                          fontSize: 10.5,
                          color: "#4A5568",
                          marginTop: 1,
                          lineHeight: 1.4,
                        }}
                      >
                        {t.collection} · {t.season}
                        {collMeta.year ? ` ${collMeta.year}` : ""} ·{" "}
                        {t.category}
                        {collMeta.customer ? ` · ${collMeta.customer}` : ""}
                        {isDDP ? ` · DDP: ${formatDate(t.due)}` : ""}
                      </div>
                    </div>
                  );
                })}
                {dt.length > 3 && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: TH.textMuted,
                      fontWeight: 600,
                    }}
                  >
                    +{dt.length - 3} more
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: TH.bg,
        fontFamily: "'DM Sans','Helvetica Neue',sans-serif",
        color: TH.text,
      }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;}::-webkit-scrollbar{width:10px;height:10px;}::-webkit-scrollbar-track{background:#E2E8EE;border-radius:5px;}::-webkit-scrollbar-thumb{background:#CBD5E0;border-radius:5px;}::-webkit-scrollbar-thumb:hover{background:#A0AEC0;}select option{background:#FFFFFF;color:#1A202C;}`}</style>

      {/* ── IDLE WARNING BANNER ── */}
      {idleWarning && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: "linear-gradient(135deg,#B45309,#D97706)",
          color: "#fff",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          boxShadow: "0 2px 16px rgba(0,0,0,0.35)",
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: "0.01em",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>⏱</span>
            <span>You've been inactive for 55 minutes. You'll be automatically logged out in 5 minutes.</span>
          </div>
          <button
            onClick={() => setIdleWarning(false)}
            style={{ padding: "6px 16px", borderRadius: 7, border: "1px solid rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.15)", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
          >
            I'm still here
          </button>
        </div>
      )}

      {/* Header */}
      <div
        style={{
          background: TH.header,
          padding: "0 22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 64,
          position: "sticky",
          top: 0,
          zIndex: 100,
          gap: 12,
          boxShadow: "0 2px 16px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexShrink: 0,
          }}
        >
          <ROFLogoFull height={40} />
          <div
            style={{
              width: 1,
              height: 30,
              background: "rgba(255,255,255,0.15)",
            }}
          />
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "rgba(255,255,255,0.75)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              Design Calendar
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          {[["dashboard","Dashboard"],["timeline","Timeline"],["calendar","Calendar"]].map(([v,label]) =>
            navBtn(v, label)
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexShrink: 0,
            alignItems: "center",
          }}
        >
          {/* Settings master dropdown */}
          <SettingsDropdown
            isAdmin={isAdmin}
            onTeam={() => setShowTeam(true)}
            onVendors={() => setShowVendors(true)}
            onSizes={() => setShowSizeLib(true)}
            onCategories={() => setShowCatLib(true)}
            onUsers={() => setShowUsers(true)}
            onBrands={() => setShowBrands(true)}
            onSeasons={() => setShowSeasons(true)}
            onCustomers={() => setShowCustomers(true)}
            onOrderTypes={() => setShowOrderTypes(true)}
          />
          <div
            style={{
              width: 1,
              height: 24,
              background: "rgba(255,255,255,0.15)",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                background: currentUser.color + "44",
                border: `2px solid ${currentUser.color}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 700,
                color: currentUser.color,
              }}
            >
              {currentUser.initials}
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.85)",
                  fontWeight: 600,
                  lineHeight: 1.2,
                }}
              >
                {currentUser.name}
              </span>
              {teamsToken && (
                <span style={{ fontSize: 9, color: "#6EE7B7", fontWeight: 700, display: "flex", alignItems: "center", gap: 3 }}>
                  💬 Teams
                </span>
              )}
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                {currentUser.role}
              </span>
            </div>
            <button
              onClick={() => setCurrentUser(null)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "none",
                color: "rgba(255,255,255,0.5)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
              }}
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <FilterBar
        brands={brands}
        seasons={seasons}
        filterBrand={filterBrand}
        setFilterBrand={setFilterBrand}
        filterSeason={filterSeason}
        setFilterSeason={setFilterSeason}
        canViewAll={canViewAll}
      />

      <div
        style={{ padding: "26px 22px 100px", maxWidth: 1440, margin: "0 auto" }}
      >
        {view === "dashboard" && <Dashboard />}
        {view === "timeline" && <Timeline />}
        {view === "calendar" && <CalendarView />}
        {view === "teams" && (
          <TeamsView
            collList={collList}
            collMap={collMap}
            isAdmin={isAdmin}
            teamsConfig={teamsConfig}
            setTeamsConfig={setTeamsConfig}
            teamsToken={teamsToken}
            setTeamsToken={setTeamsToken}
            showTeamsConfig={showTeamsConfig}
            setShowTeamsConfig={setShowTeamsConfig}
            getBrand={getBrand}
          />
        )}
      </div>

      {showAddTask && (
        <AddTaskModal
          tasks={tasks}
          vendors={vendors}
          team={team}
          collections={collections}
          onSave={(newTask) => {
            setTasks((ts) => [...ts, newTask]);
            setShowAddTask(false);
          }}
          onClose={() => setShowAddTask(false)}
        />
      )}

      {showWizard && (
        <Modal title="New Collection" onClose={() => setShowWizard(false)} wide>
          <CollectionWizard
            orderTypes={orderTypes}
            vendors={vendors}
            team={team}
            customers={customers}
            seasons={seasons}
            onSave={addCollection}
            onClose={() => setShowWizard(false)}
          />
        </Modal>
      )}
      {showVendors && (
        <Modal
          title="Vendor Manager"
          onClose={() => setShowVendors(false)}
          wide
        >
          <VendorManager vendors={vendors} setVendors={setVendors} />
        </Modal>
      )}
      {showTeam && (
        <Modal title="Team Members" onClose={() => setShowTeam(false)} wide>
          <TeamManager team={team} setTeam={setTeam} isAdmin={isAdmin} />
        </Modal>
      )}
      {showUsers && (
        <Modal title="User Management" onClose={() => setShowUsers(false)} wide>
          <UserManager users={users} setUsers={setUsers} team={team} setTeam={setTeam} isAdmin={isAdmin} currentUser={currentUser} />
        </Modal>
      )}
      {showCustomers && (
        <Modal title="Customer Manager" onClose={() => setShowCustomers(false)} wide>
          <CustomerManager customers={customers} setCustomers={setCustomers} />
        </Modal>
      )}
      {showOrderTypes && (
        <Modal title="Order Types" onClose={() => setShowOrderTypes(false)} wide>
          <OrderTypeManager orderTypes={orderTypes} setOrderTypes={setOrderTypes} />
        </Modal>
      )}
      {showSeasons && (
        <Modal title="Season Manager" onClose={() => setShowSeasons(false)} wide>
          <SeasonManager seasons={seasons} setSeasons={setSeasons} />
        </Modal>
      )}
      {showBrands && (
        <Modal title="Brand Manager" onClose={() => setShowBrands(false)} wide>
          <BrandManager brands={brands} setBrands={setBrands} />
        </Modal>
      )}
      {showSizeLib && (
        <Modal title="Size Library" onClose={() => setShowSizeLib(false)} wide>
          <SizeLibrary sizes={sizeLibrary} setSizes={setSizeLibrary} />
        </Modal>
      )}
      {showCatLib && (
        <Modal
          title="Category Manager"
          onClose={() => setShowCatLib(false)}
          wide
        >
          <CategoryManager
            categories={categoryLib}
            setCategories={setCategoryLib}
          />
        </Modal>
      )}
      {editTask && (
        <TaskEditModal
          task={editTask}
          team={team}
          collections={collections}
          allTasks={tasks}
          vendors={vendors}
          onSave={saveTask}
          onSaveCascade={saveCascade}
          onDelete={deleteTask}
          onClose={() => setEditTask(null)}
          currentUser={currentUser}
          customerList={customers}
          orderTypes={orderTypes}
          onSkuChange={(key, newSkus) =>
            setCollections((c) => ({
              ...c,
              [key]: { ...(c[key] || {}), skus: newSkus },
            }))
          }
        />
      )}
      {editCollKey && (
        <EditCollectionModal
          collKey={editCollKey}
          collMap={collMap}
          collections={collections}
          tasks={tasks}
          setTasks={setTasks}
          setCollections={setCollections}
          seasons={seasons}
          customerList={customers}
          orderTypes={orderTypes}
          onClose={() => setEditCollKey(null)}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            ...(isAdmin
              ? [
                  {
                    icon: "✏️",
                    label: "Edit Collection",
                    onClick: () => setEditCollKey(ctxMenu.collKey),
                  },
                  "---",
                ]
              : []),
            {
              icon: "📊",
              label: "Open Timeline",
              onClick: () => {
                setFocusCollKey(ctxMenu.collKey);
                setView("timeline");
              },
            },
            {
              icon: "📅",
              label: "Open Calendar",
              onClick: () => {
                setFocusCollKey(ctxMenu.collKey);
                setView("calendar");
              },
            },
            ...(isAdmin
              ? [
                  "---",
                  {
                    icon: "🗑️",
                    label: "Delete Collection",
                    danger: true,
                    onClick: () => {
                      const [brand, coll] = ctxMenu.collKey.split("||");
                      setTasks((ts) =>
                        ts.filter(
                          (t) => !(t.brand === brand && t.collection === coll)
                        )
                      );
                      setCollections((c) => {
                        const n = { ...c };
                        delete n[ctxMenu.collKey];
                        return n;
                      });
                    },
                  },
                ]
              : []),
          ]}
        />
      )}

      {/* ── BOTTOM NAV TOGGLE TAB ── */}
      <button
        onClick={() => setShowNav((v) => !v)}
        style={{
          position: "fixed",
          bottom: showNav ? 66 : 0,
          right: 24,
          zIndex: 201,
          background: "linear-gradient(135deg,#2D3748,#1A202C)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderBottom: "none",
          borderRadius: "8px 8px 0 0",
          padding: "4px 14px",
          cursor: "pointer",
          fontFamily: "inherit",
          display: "flex",
          alignItems: "center",
          gap: 6,
          transition: "bottom 0.3s ease",
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.5)",
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {showNav ? "Hide" : "Show"} Nav
        </span>
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          {showNav ? "▼" : "▲"}
        </span>
      </button>

      {/* ── BOTTOM NAV BAR ── */}
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 200,
          background:
            "linear-gradient(135deg,#1A202C 0%,#2D3748 60%,#1E2A3A 100%)",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 -4px 24px rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "stretch",
          height: 66,
          backdropFilter: "blur(12px)",
          transition: "transform 0.3s ease",
          transform: showNav ? "translateY(0)" : "translateY(100%)",
        }}
      >
        {/* Left: New Collection button */}
        {isAdmin && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              paddingLeft: 16,
              paddingRight: 8,
              borderRight: "1px solid rgba(255,255,255,0.06)",
              gap: 8,
            }}
          >
            <button
              onClick={() => setShowWizard(true)}
              style={{
                padding: "7px 14px",
                borderRadius: 8,
                border: "none",
                background: `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`,
                color: "#fff",
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                whiteSpace: "nowrap",
                boxShadow: `0 2px 10px ${TH.primary}66`,
              }}
            >
              + New Collection
            </button>
            {view === "timeline" && (
              <button
                onClick={() => setShowAddTask(true)}
                title="Add Task to Timeline"
                style={{
                  padding: "7px 14px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.8)",
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                }}
              >
                + Add Task
              </button>
            )}
          </div>
        )}
        {/* Center: quick stats — clickable */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 0,
          }}
        >
          {[
            {
              id: "overdue",
              label: "Overdue",
              count: overdue.length,
              color: "#FC8181",
              bg: "rgba(252,129,129,0.12)",
              activeBg: "rgba(252,129,129,0.22)",
            },
            {
              id: "week",
              label: "This Week",
              count: dueThisWeek.length,
              color: "#F6AD55",
              bg: "rgba(246,173,85,0.12)",
              activeBg: "rgba(246,173,85,0.22)",
            },
            {
              id: "30d",
              label: "Next 30d",
              count: due30.length,
              color: "#63B3ED",
              bg: "rgba(99,179,237,0.12)",
              activeBg: "rgba(99,179,237,0.22)",
            },
            {
              id: "collections",
              label: "Collections",
              count: collList.length,
              color: "#68D391",
              bg: "rgba(104,211,145,0.12)",
              activeBg: "rgba(104,211,145,0.22)",
            },
          ].map((s, i) => {
            const isActive = statFilter === s.id;
            return (
              <button
                key={s.id}
                onClick={() => {
                  setStatFilter(isActive ? null : s.id);
                  setView("dashboard");
                  setFocusCollKey(null);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  padding: "6px 19px",
                  borderRight:
                    i < 3 ? "1px solid rgba(255,255,255,0.06)" : "none",
                  background: isActive ? s.activeBg : "transparent",
                  cursor: "pointer",
                  border: "none",
                  fontFamily: "inherit",
                  borderRadius: 8,
                  transition: "all 0.15s",
                  transform: isActive ? "translateY(-1px)" : "none",
                  outline: isActive ? `1px solid ${s.color}44` : "none",
                }}
              >
                <div
                  style={{
                    fontSize: 19,
                    fontWeight: 800,
                    color: s.color,
                    lineHeight: 1,
                    background: s.bg,
                    borderRadius: 6,
                    padding: "2px 8px",
                    minWidth: 31,
                    textAlign: "center",
                    boxShadow: isActive ? `0 0 8px ${s.color}55` : "none",
                    transition: "all 0.15s",
                  }}
                >
                  {s.count}
                </div>
                <div
                  style={{
                    fontSize: 8,
                    color: isActive ? s.color : "rgba(255,255,255,0.4)",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    marginTop: 3,
                    fontWeight: isActive ? 700 : 600,
                  }}
                >
                  {s.label}
                </div>
                {isActive && (
                  <div
                    style={{
                      width: 13,
                      height: 1.5,
                      borderRadius: 1,
                      background: s.color,
                      marginTop: 2,
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
        {/* Right: Teams button */}
        <div style={{ display: "flex", alignItems: "center", paddingLeft: 8, paddingRight: 16, borderLeft: "1px solid rgba(255,255,255,0.06)" }}>
          <button
            onClick={() => { setView(view === "teams" ? "dashboard" : "teams"); setStatFilter(null); setFocusCollKey(null); }}
            style={{
              padding: "7px 14px",
              borderRadius: 8,
              border: `1px solid ${view === "teams" ? "rgba(123,131,235,0.5)" : "rgba(255,255,255,0.15)"}`,
              cursor: "pointer",
              background: view === "teams" ? `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})` : "none",
              color: view === "teams" ? "#fff" : "rgba(123,131,235,0.9)",
              fontWeight: view === "teams" ? 700 : 600,
              fontFamily: "inherit",
              fontSize: 12,
              whiteSpace: "nowrap",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 14 }}>💬</span>
            Teams
          </button>
        </div>
      </div>
    </div>
  );
}
