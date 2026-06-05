// GET /api/external/v1/ping
//
// Health + auth check for the external/partner API. Requires a valid API key;
// echoes back the authenticated entity_id and granted scopes so an integrator
// can confirm their key works and is read-only / entity-scoped.

import { withApiKey } from "../../../_lib/external/handlerKit.js";

export const config = { maxDuration: 10 };

export default withApiKey(async ({ res, auth }) => {
  return res.status(200).json({
    ok: true,
    entity_id: auth.entity_id,
    scopes: auth.scopes,
    api: "tangerine-external-v1",
    read_only: true,
  });
});
