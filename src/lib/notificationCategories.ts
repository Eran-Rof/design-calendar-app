// Internal notification categories an employee can subscribe to.
//
// Keys MUST match the server's category keys (api/_lib/internal-recipients.js
// CATEGORY_VARS / NOTIFICATION_CATEGORIES). When ticked on an employee record,
// resolveInternalRecipients routes that category's alerts to the employee's
// email alongside the INTERNAL_*_EMAILS env vars.

export interface NotificationCategory {
  key: string;
  label: string;
  description: string;
}

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  { key: "onboarding",   label: "Vendor onboarding",   description: "A vendor submits onboarding for review" },
  { key: "invoice",      label: "Invoices",            description: "Vendor invoice submitted or flagged with a discrepancy" },
  { key: "shipment",     label: "Shipments / ASN",     description: "Vendor submits an advance ship notice" },
  { key: "compliance",   label: "Compliance",          description: "Compliance / sustainability docs submitted, expiring, or escalated" },
  { key: "dispute",      label: "Disputes",            description: "A dispute is opened or gets a new message" },
  { key: "message",      label: "PO messages",         description: "A vendor sends a new message on a purchase order" },
  { key: "contract",     label: "Contracts",           description: "A contract is signed or is expiring soon" },
  { key: "procurement",  label: "Procurement / RFQ",   description: "RFQ quotes, declines, and AI procurement insights" },
  { key: "finance",      label: "Finance",             description: "Supply-chain-finance requests and accepted discount offers" },
  { key: "vendor_alert", label: "Vendor alerts",       description: "A vendor is flagged or its health score drops" },
  { key: "edi",          label: "EDI errors",          description: "An EDI / ERP-sync transaction fails processing" },
];

export const NOTIFICATION_CATEGORY_KEYS: string[] = NOTIFICATION_CATEGORIES.map((c) => c.key);
