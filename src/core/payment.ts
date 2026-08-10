// Provider-agnostic checkout + payment contract. A payment adapter (Stripe, …)
// implements `PaymentProvider`; apps create checkouts, mint discount coupons,
// refund, and verify webhooks without touching a specific gateway's SDK.
//
// Amounts crossing this boundary are integer minor units (cents).

import {
  handoffCorrelationFrom,
  summarizeHandoff,
  withHandoffCorrelation,
  type HandoffEvidence,
  type HandoffEvidenceSource,
  type HandoffOutcome,
} from "@absolutejs/handoff";
import type { Address } from "./shipping";
import type {
  StorefrontCaseAttachmentPurpose,
  StorefrontCaseEvidenceText,
} from "./aftercare";

export type CheckoutLineItem = {
  name: string;
  description?: string;
  /** Unit price in minor units (cents). */
  amountCents: number;
  quantity: number;
  taxBehavior?: "inclusive" | "exclusive";
};

export type CheckoutShipping =
  | { mode: "none" }
  | {
      mode: "collect";
      countries: string[];
      flatAmountCents?: number;
      label?: string;
    };

export type CreateCheckoutInput = {
  /** Stable host-owned retry identity forwarded to capable providers. */
  idempotencyKey?: string;
  uiMode: "embedded" | "hosted";
  currency?: string;
  lineItems: CheckoutLineItem[];
  metadata?: Record<string, string>;
  /** Embedded checkout return URL. */
  returnUrl?: string;
  /** Hosted checkout success/cancel URLs. */
  successUrl?: string;
  cancelUrl?: string;
  shipping?: CheckoutShipping;
  /** Ask the hosted page for a phone number; it lands on the session's
   *  shipping address as `phone` — for shops that live on the telephone. */
  collectPhone?: boolean;
  /** A coupon id from `createCoupon`, applied to the session. */
  couponId?: string;
  /** Calculate tax automatically when the provider supports it. */
  automaticTax?: boolean;
  /** One-time payment (default) or a recurring subscription. */
  mode?: "payment" | "subscription";
  /** Billing interval when `mode` is 'subscription'. */
  recurringInterval?: "day" | "week" | "month" | "year";
};

export type CheckoutResult = {
  id: string;
  /** Set for embedded checkout. */
  clientSecret: string | null;
  /** Set for hosted checkout (a pay link). */
  url: string | null;
};

export const PROVIDER_JOURNEY_CORRELATION_KEY = "absolute_provider_correlation";

export type ProviderJourneyEvidenceSource =
  "host" | "provider_api" | "hosted_page_report" | "webhook" | "reconciliation";

export type ProviderJourneyOutcome = HandoffOutcome;

/**
 * A privacy-safe observation about work handed to an external provider.
 * Keep raw provider payloads, credentials, payment details, and customer data
 * in the host's protected store; this projection is intentionally joinable
 * without containing them.
 */
export type ProviderJourneyEvidence = Omit<
  HandoffEvidence,
  "service" | "source"
> & {
  provider: string;
  source: ProviderJourneyEvidenceSource;
};

export type ProviderJourneySummary = {
  authoritativeOutcome: ProviderJourneyOutcome | null;
  contradiction: boolean;
  correlationId: string;
  latest: ProviderJourneyEvidence | null;
  reportedOutcome: ProviderJourneyOutcome | null;
  status: ProviderJourneyOutcome;
};

const handoffSource = (
  source: ProviderJourneyEvidenceSource,
): HandoffEvidenceSource =>
  ({
    host: "host",
    hosted_page_report: "external_surface_report",
    provider_api: "external_api",
    reconciliation: "reconciliation",
    webhook: "callback",
  })[source] as HandoffEvidenceSource;

const providerJourneySource = (
  source: HandoffEvidenceSource,
): ProviderJourneyEvidenceSource =>
  ({
    callback: "webhook",
    external_api: "provider_api",
    external_surface_report: "hosted_page_report",
    host: "host",
    reconciliation: "reconciliation",
  })[source] as ProviderJourneyEvidenceSource;

export const withProviderJourneyCorrelation = (
  metadata: Record<string, string> | undefined,
  correlationId: string,
  key = PROVIDER_JOURNEY_CORRELATION_KEY,
) => withHandoffCorrelation(metadata, correlationId, key);

export const providerJourneyCorrelationFrom = (
  value: unknown,
  key = PROVIDER_JOURNEY_CORRELATION_KEY,
) => handoffCorrelationFrom(value, key);

/**
 * Reduces evidence from a cross-origin provider journey without pretending the
 * host can observe the provider page directly. Provider API, webhook, and
 * reconciliation evidence are authoritative; a hosted-page report is retained
 * separately so contradictory customer experience becomes actionable.
 */
export const summarizeProviderJourney = (
  evidence: ProviderJourneyEvidence[],
): ProviderJourneySummary => {
  const summary = summarizeHandoff(
    evidence.map(({ provider, source, ...item }) => ({
      ...item,
      service: provider,
      source: handoffSource(source),
    })),
  );
  const latest = (() => {
    if (summary.latest === null) return null;
    const { service, source, ...item } = summary.latest;

    return {
      ...item,
      provider: service,
      source: providerJourneySource(source),
    };
  })();

  return {
    authoritativeOutcome: summary.authoritativeOutcome,
    contradiction: summary.contradiction,
    correlationId: summary.correlationId,
    latest,
    reportedOutcome: summary.reportedOutcome,
    status: summary.status,
  };
};

export type CreateCouponInput = {
  percentOff?: number;
  amountOffCents?: number;
  currency?: string;
};

export type CheckoutSession = {
  id: string;
  /** Session lifecycle status (e.g. 'complete' | 'open' | 'expired'). */
  status: string | null;
  paymentStatus: string | null;
  amountTotalCents: number | null;
  currency: string | null;
  customerEmail: string | null;
  customerName: string | null;
  shippingAddress: Address | null;
  metadata: Record<string, string>;
  lineItems: { name: string; quantity: number; amountTotalCents: number }[];
  /** Provider payment identity used to correlate disputes without retaining raw events. */
  paymentReferenceId?: string | null;
};

export type WebhookEvent = {
  /** Provider-stable delivery/event identity used for replay protection. */
  id: string;
  type: string;
  /** A checkout that completed successfully (sync or async). */
  isComplete: boolean;
  /** A checkout that failed or expired. */
  isFailed: boolean;
  session: CheckoutSession;
};

export type PaymentRefund = {
  providerRefundId: string;
  status: "failed" | "pending" | "succeeded";
};

export type PaymentDispute = {
  amountCents: number;
  currency: string;
  evidenceDueAt: Date | null;
  providerDisputeId: string;
  providerPaymentId: string;
  reason: string;
  status: string;
};

export type PaymentDisputeEvidenceFile = {
  bytes: Uint8Array;
  contentType: string;
  id: string;
  name: string;
  purpose: StorefrontCaseAttachmentPurpose;
  sha256: string;
};

export type PaymentDisputeEvidenceResult = {
  providerFileIds: Record<string, string>;
  providerStatus: string;
  submissionCount: number | null;
  submitted: boolean;
};

export type PaymentDisputeEvidenceReconciliationDiagnostics = {
  hasEvidence: boolean;
  mismatches: Array<{
    field: string;
    reason: "different" | "missing";
    scope: "file" | "text";
  }>;
};

export type PaymentDisputeEvidenceReconciliation =
  PaymentDisputeEvidenceResult & {
    applied: boolean;
    diagnostics: PaymentDisputeEvidenceReconciliationDiagnostics;
  };

export type PaymentWebhookEvent =
  | { checkout: WebhookEvent; kind: "checkout" }
  | {
      dispute: PaymentDispute;
      id: string;
      kind: "dispute";
      type: string;
    };

export type PaymentWebhookEndpoint = {
  enabledEvents: string[];
  id: string;
  livemode: boolean;
  status: "disabled" | "enabled";
  url: string;
};

export type CreatedPaymentWebhookEndpoint = PaymentWebhookEndpoint & {
  signingSecret: string;
};

export type PaymentWebhookEndpointManager = {
  create(input: {
    disabled: boolean;
    enabledEvents: string[];
    url: string;
  }): Promise<CreatedPaymentWebhookEndpoint>;
  delete(endpointId: string): Promise<void>;
  retrieve(endpointId: string): Promise<PaymentWebhookEndpoint>;
  update(
    endpointId: string,
    input: {
      disabled?: boolean;
      enabledEvents?: string[];
      url?: string;
    },
  ): Promise<PaymentWebhookEndpoint>;
};

export type PaymentProvider = {
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;
  createCoupon(input: CreateCouponInput): Promise<string>;
  /** Fetch a session's current state (for return pages). */
  retrieveCheckout(sessionId: string): Promise<CheckoutSession>;
  /** Refund with a stable host identity so retries cannot double-refund. */
  refundBySession(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<PaymentRefund>;
  retrieveRefund(providerRefundId: string): Promise<PaymentRefund>;
  /** Read provider state and determine whether an ambiguous evidence effect applied. */
  reconcileDisputeEvidence?(input: {
    evidence: StorefrontCaseEvidenceText;
    files: Array<Pick<PaymentDisputeEvidenceFile, "id" | "purpose">>;
    providerDisputeId: string;
    submit: boolean;
  }): Promise<PaymentDisputeEvidenceReconciliation>;
  /** Stage or submit normalized dispute evidence with stable retry identity. */
  submitDisputeEvidence?(input: {
    evidence: StorefrontCaseEvidenceText;
    files: PaymentDisputeEvidenceFile[];
    idempotencyKey: string;
    providerDisputeId: string;
    submit: boolean;
  }): Promise<PaymentDisputeEvidenceResult>;
  /** Full signed event projection. Older providers may expose checkout-only verification. */
  verifyEvent?(
    payload: string,
    signature: string,
  ): Promise<PaymentWebhookEvent>;
  verifyWebhook(payload: string, signature: string): Promise<WebhookEvent>;
};
