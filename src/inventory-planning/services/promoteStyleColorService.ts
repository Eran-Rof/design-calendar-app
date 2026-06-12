// Promote a planner-created NEW style+color into the SHARED company masters
// (ip_item_master + style_master) so it shows up in Tangerine + ATS. Backs the
// per-row "Add to company DB" action on TBD rows. Idempotent server-side, so a
// re-click is safe. Mirrors tangerinePoService's call posture (POST to an
// /api/internal/planning/* handler with the x-user-email header).

import { currentUserEmail } from "../governance/services/permissionService";

export interface PromoteStyleColorArgs {
  style_code: string;
  color?: string | null;
  description?: string | null;
  group_name?: string | null;
  sub_category_name?: string | null;
}

export interface PromoteStyleColorResult {
  sku_code: string;
  style_code: string;
  item_created: boolean;
  item_existed: boolean;
  style_created: boolean;
  style_existed: boolean;
  style_id?: string;
  warnings: string[];
}

export async function promoteStyleColor(args: PromoteStyleColorArgs): Promise<PromoteStyleColorResult> {
  const res = await fetch("/api/internal/planning/promote-style-color", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-email": currentUserEmail() },
    body: JSON.stringify({
      style_code: args.style_code,
      color: args.color ?? null,
      description: args.description ?? null,
      group_name: args.group_name ?? null,
      sub_category_name: args.sub_category_name ?? null,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<PromoteStyleColorResult> & { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return {
    sku_code: json.sku_code || "",
    style_code: json.style_code || args.style_code,
    item_created: !!json.item_created,
    item_existed: !!json.item_existed,
    style_created: !!json.style_created,
    style_existed: !!json.style_existed,
    style_id: json.style_id,
    warnings: json.warnings || [],
  };
}
