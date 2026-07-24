// api/_handlers/internal/planning/promote-style-color.js — Vercel Node fn
//
// Promote a planner-created NEW style+color from the Inventory Planning app
// into the SHARED company masters so it shows up in Tangerine + ATS, after
// which someone completes the details. Writes idempotently:
//   • ip_item_master — one row at style+color grain (sku_code = STYLE-COLOR)
//   • style_master   — the style header (entity_id, style_code, description),
//     flagged attributes.source='planning_promoted' + needs_review=true so a
//     merchandiser can find + finish it (brand, category, size scale, HTS, …).
// Both are no-ops if the row already exists (the planner can re-click safely).
// App-gated like the other /api/internal/planning/* handlers (x-user-email).
//
// POST body: { style_code, color, description?, group_name?, sub_category_name? }
// 2c will hook the "newly promoted → notify designated reviewers" logic here.

import { createClient } from "@supabase/supabase-js";
import { resolveInternalRecipientsDetailed } from "../../../_lib/internal-recipients.js";
import { colorMatchKey } from "../../../_lib/xoroLineMatch.js";

export const config = { maxDuration: 30 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-email");
}

const clean = (s) => String(s ?? "").trim();

// sku_code = STYLE-COLOR, uppercased, non-alnum runs → single dash. Matches
// the planner's "STYLE-COLOR" grain used across the grid + the xoro item sync.
function skuFor(style, color) {
  const s = clean(style).toUpperCase();
  const c = clean(color).toUpperCase();
  const base = c && c !== "TBD" ? `${s}-${c}` : s;
  return base.replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id ?? null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};

  const styleCode = clean(body.style_code).toUpperCase();
  const colorRaw = clean(body.color);
  const color = colorRaw && colorRaw.toUpperCase() !== "TBD" ? colorRaw : null;
  if (!styleCode || styleCode === "TBD") {
    return res.status(400).json({ error: "style_code required (and not TBD)" });
  }

  const groupName = clean(body.group_name) || null;
  const subCat = clean(body.sub_category_name) || null;
  const description = clean(body.description) || (color ? `${styleCode} ${color}` : styleCode);
  let skuCode = skuFor(styleCode, color);
  let colorVal = color;

  const result = {
    sku_code: skuCode,
    style_code: styleCode,
    item_created: false,
    item_existed: false,
    style_created: false,
    style_existed: false,
    warnings: [],
  };

  // 1. ip_item_master — idempotent on sku_code (UNIQUE). entity_id / brand_id /
  // uom / active / pack_size all default server-side, so sku_code is enough.
  //
  // ⚠️ sku_code alone is NOT enough to decide "already exists". skuFor() derives
  // the code from the RAW colour, so promoting "Blck Paradise" onto a style that
  // already carries "Black Paradise" produced a different code and therefore a
  // SECOND SKU for one physical colourway — ATS then shows two lines and splits
  // on-hand/sales between them. Match the style's existing colours on the full
  // COLOR_ABBR dictionary first, and if one is the same colour, reuse that row's
  // spelling (and its sku_code) rather than minting a variant.
  try {
    if (color) {
      const wantKey = colorMatchKey(color);
      const { data: sibs } = await admin
        .from("ip_item_master").select("id, sku_code, color, created_at")
        .eq("style_code", styleCode).not("color", "is", null)
        .order("created_at", { ascending: true }).limit(500);
      const sib = (sibs || []).find((r) => colorMatchKey(r.color) === wantKey);
      if (sib?.color) {
        // Adopt the ESTABLISHED spelling (oldest row wins) so downstream grouping
        // by `color` sees one colourway, and re-derive the code from it.
        colorVal = String(sib.color).trim();
        skuCode = skuFor(styleCode, colorVal);
        result.sku_code = skuCode;
        if (colorMatchKey(colorVal) !== colorMatchKey(color)) result.warnings.push("colour spelling normalized");
      }
    }
    const { data: existingItem } = await admin
      .from("ip_item_master").select("id").eq("sku_code", skuCode).maybeSingle();
    if (existingItem?.id) {
      result.item_existed = true;
    } else {
      const attrs = { source: "planning_promoted" };
      if (groupName) attrs.group_name = groupName;
      if (subCat) attrs.category_name = subCat;
      const { error } = await admin.from("ip_item_master").upsert(
        [{
          sku_code: skuCode,
          style_code: styleCode,
          color: colorVal,
          description,
          active: true,
          attributes: attrs,
          external_refs: { planning_promoted: "1" },
        }],
        { onConflict: "sku_code", ignoreDuplicates: true },
      );
      if (error) result.warnings.push(`item_master: ${error.message}`);
      else result.item_created = true;
    }
  } catch (e) {
    result.warnings.push(`item_master: ${e?.message ?? String(e)}`);
  }

  // 2. style_master — idempotent on (entity_id, style_code) WHERE deleted_at IS
  // NULL. Flagged needs_review so a merchandiser can find + finish the details.
  try {
    const entityId = await resolveDefaultEntityId(admin);
    if (!entityId) {
      result.warnings.push("style_master: default entity (ROF) not found");
    } else {
      const { data: existingStyle } = await admin
        .from("style_master").select("id")
        .eq("entity_id", entityId).eq("style_code", styleCode).is("deleted_at", null)
        .maybeSingle();
      if (existingStyle?.id) {
        result.style_existed = true;
        result.style_id = existingStyle.id;
      } else {
        const { data, error } = await admin.from("style_master").insert({
          entity_id: entityId,
          style_code: styleCode,
          description,
          group_name: groupName,
          sub_category_name: subCat,
          lifecycle_status: "active",
          attributes: { source: "planning_promoted", needs_review: true },
        }).select("id").single();
        if (error) {
          if (error.code === "23505") result.style_existed = true;
          else result.warnings.push(`style_master: ${error.message}`);
        } else {
          result.style_created = true;
          result.style_id = data.id;
        }
      }
    }
  } catch (e) {
    result.warnings.push(`style_master: ${e?.message ?? String(e)}`);
  }

  // Notify the designated reviewers (admins pick them via the "Style Master
  // review" notification subscription on each employee). Only fires when a
  // NEW style row was created — re-promoting an existing style is a no-op.
  // Bell + email via the shared /api/send-notification fan-out; links to the
  // Style Master "needs review" list. Best-effort: never fail the promote.
  result.notified = 0;
  if (result.style_created) {
    try {
      const { recipients } = await resolveInternalRecipientsDetailed(
        admin, "style_review", { event: "style_master_promoted" },
      );
      if (recipients.length > 0) {
        const origin = `https://${req.headers.host}`;
        const label = color ? `${styleCode} / ${color}` : styleCode;
        await Promise.all(recipients.map((rcp) => {
          const hasInApp = typeof rcp.plm_user_id === "string" && rcp.plm_user_id;
          return fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: "style_master_promoted",
              title: `New style needs review: ${label}`,
              body: `Inventory Planning promoted "${label}" into the Style Master. Please complete its details (brand, category, size scale, HTS, …). Open the list of styles awaiting review.`,
              link: "/tangerine?m=style_master&review=1",
              metadata: {
                style_id: result.style_id,
                style_code: styleCode,
                sku_code: skuCode,
                ...(rcp.apps ? { target_apps: rcp.apps } : {}),
              },
              recipient: { internal_id: hasInApp ? rcp.plm_user_id : "style_reviewer", email: rcp.email },
              dedupe_key: `style_promoted_${result.style_id}_${rcp.email}`,
              email: true,
            }),
          }).catch(() => {});
        }));
        result.notified = recipients.length;
      }
    } catch (e) {
      result.warnings.push(`notify: ${e?.message ?? String(e)}`);
    }
  }

  return res.status(200).json(result);
}
