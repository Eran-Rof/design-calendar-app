// api/_lib/payments/index.js
//
// Tangerine P7-1 — Payment provider resolver (arch §3.2).
//
// Single entry point for handlers to get the active provider. Handlers
// call `resolveProviderForCustomer(customer, entity)` to figure out
// which processor to use (per-customer override → entity default →
// 'stripe' fallback), then `getProvider(name)` to load that
// implementation.
//
// Only Stripe ships in P7. Square / Authorize.net throw at getProvider()
// until their stub files exist (added by a future PR per arch §3.6
// future-provider plug-in checklist).

import { PROCESSOR_NAMES } from "./provider.js";
// Stripe lands in P7-2 — uncomment when the file is added:
// import * as stripe from "./stripe.js";

const PROVIDERS = Object.freeze({
  // stripe,
  // square:  null,   // not yet implemented
  // authnet: null,   // not yet implemented
});

/**
 * Look up a provider by name. Throws if the provider isn't implemented
 * (e.g. operator selected 'square' but Square plug-in hasn't shipped).
 *
 * @param {string} name  one of PROCESSOR_NAMES
 * @returns {import("./provider.js").PaymentProvider}
 */
export function getProvider(name) {
  if (!PROCESSOR_NAMES.includes(name)) {
    throw new Error(`Unknown payment provider: ${name} (allowed: ${PROCESSOR_NAMES.join(", ")})`);
  }
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error(`Payment provider '${name}' is not yet implemented in this Tangerine build. See docs/tangerine/P7-revenue-ops-architecture.md §3.6 for the plug-in checklist.`);
  }
  return p;
}

/**
 * Decide which processor a given customer should use:
 *   1. customer.payment_processor (per-customer override)
 *   2. entity.default_payment_processor
 *   3. 'stripe' as the single-tenant ROF fallback
 *
 * @param {{payment_processor?: string|null}} customer
 * @param {{default_payment_processor?: string|null}} entity
 * @returns {string}
 */
export function resolveProviderForCustomer(customer, entity) {
  if (customer?.payment_processor && PROCESSOR_NAMES.includes(customer.payment_processor)) {
    return customer.payment_processor;
  }
  if (entity?.default_payment_processor && PROCESSOR_NAMES.includes(entity.default_payment_processor)) {
    return entity.default_payment_processor;
  }
  return "stripe";
}

/**
 * For health / status endpoints — returns the list of provider names
 * with a boolean indicating whether each is wired AND configured.
 */
export function listProviderStatus() {
  return PROCESSOR_NAMES.map((name) => {
    const impl = PROVIDERS[name];
    return {
      name,
      implemented: !!impl,
      configured: !!impl && typeof impl.isConfigured === "function" && impl.isConfigured(),
    };
  });
}

export { PROCESSOR_NAMES, NORMALIZED_EVENTS } from "./provider.js";
