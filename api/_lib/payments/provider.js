// api/_lib/payments/provider.js
//
// Tangerine P7-1 — Abstract payment-provider interface (arch §3.2).
//
// Every concrete provider implementation (stripe.js, square.js, authnet.js)
// MUST export the same five functions with the same shape. Handlers in
// api/_handlers/internal/payments/* + api/webhooks/payments/* call
// `getProvider(name)` from index.js to dispatch — they never import a
// specific provider file directly.
//
// This file is the interface contract + normalized event vocabulary;
// it has no runtime behavior of its own. Stripe is the first
// implementation (lands in P7-2). Square / Authorize.net are future
// plug-ins per arch §3.6.

/**
 * Normalized webhook event types. Each provider's verifyWebhook()
 * translates its native event payload to one of these strings.
 * Downstream handlers dispatch off this single set regardless of
 * which processor produced the event.
 */
export const NORMALIZED_EVENTS = Object.freeze([
  "charge.succeeded",
  "charge.failed",
  "charge.refunded",
  "charge.disputed",
  "charge.dispute_closed",
  "payout.posted",
]);

/**
 * Supported processor identifiers. Matches the CHECK constraint on
 * entities.default_payment_processor / customers.payment_processor /
 * ar_receipts.payment_processor.
 */
export const PROCESSOR_NAMES = Object.freeze(["stripe", "square", "authnet"]);

/**
 * @typedef {Object} CreateCustomerArgs
 * @property {string} name
 * @property {string} [email]
 * @property {Object<string,string>} [metadata]
 *
 * @typedef {Object} CreateCustomerResult
 * @property {string} customerId        Provider-native opaque ID (stored on customers.processor_customer_id)
 *
 * @typedef {Object} AttachPaymentMethodArgs
 * @property {string} customerId
 * @property {string} clientToken       Provider-native token from frontend SDK (Stripe Elements SetupIntent client_secret / Square nonce / etc.)
 *
 * @typedef {Object} AttachPaymentMethodResult
 * @property {string} paymentMethodId   Opaque saved-card token (customers.processor_payment_method_id)
 * @property {string} [last4]
 * @property {string} [brand]
 *
 * @typedef {Object} CreateChargeArgs
 * @property {string} customerId
 * @property {string} paymentMethodId
 * @property {number} amount_cents      Positive integer
 * @property {string} [currency]        Default 'usd'
 * @property {string} [statement_descriptor]
 * @property {string} [idempotencyKey]
 *
 * @typedef {Object} CreateChargeResult
 * @property {string} intentId          Provider-native intent / authorization ID
 * @property {string} chargeId          Provider-native charge ID
 * @property {string} status            'requires_action' | 'succeeded' | 'failed'
 * @property {number} [feeCents]        Provider's per-transaction fee (captured for reporting)
 * @property {string} [clientToken]     Returned when status='requires_action' (3DS SCA)
 *
 * @typedef {Object} RefundChargeArgs
 * @property {string} chargeId
 * @property {number} [amount_cents]    Omit / null for full refund
 * @property {string} [reason]
 *
 * @typedef {Object} RefundChargeResult
 * @property {string} refundId
 * @property {string} status            'succeeded' | 'pending' | 'failed'
 *
 * @typedef {Object} VerifyWebhookArgs
 * @property {string|Buffer} rawBody    Raw request body (NOT JSON.parse'd) — required for signature verification
 * @property {Object<string,string>} headers
 *
 * @typedef {Object} VerifyWebhookResult
 * @property {string} eventType         One of NORMALIZED_EVENTS
 * @property {Object} payload           Provider-native event payload (handlers may inspect for processor-specific fields)
 * @property {string} providerEventId   Opaque event ID (for idempotent webhook processing)
 */

/**
 * Required contract every provider implementation must export.
 *
 * @typedef {Object} PaymentProvider
 * @property {(args: CreateCustomerArgs)         => Promise<CreateCustomerResult>}        createCustomer
 * @property {(args: AttachPaymentMethodArgs)    => Promise<AttachPaymentMethodResult>}   attachPaymentMethod
 * @property {(args: CreateChargeArgs)           => Promise<CreateChargeResult>}          createCharge
 * @property {(args: RefundChargeArgs)           => Promise<RefundChargeResult>}          refundCharge
 * @property {(args: VerifyWebhookArgs)          => Promise<VerifyWebhookResult>}         verifyWebhook
 * @property {() => boolean}                                                                isConfigured
 */

/**
 * Helper for implementations — throw a uniform PaymentProviderError so
 * handlers map provider failures to consistent HTTP status codes.
 */
export class PaymentProviderError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "PaymentProviderError";
    this.code = opts.code || null;        // provider-native code (e.g. 'card_declined')
    this.kind = opts.kind || "unknown";   // 'auth' | 'validation' | 'network' | 'card_declined' | 'unknown'
    this.status = opts.status || null;    // HTTP status from provider
  }
}
