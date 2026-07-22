// Provider-agnostic checkout + payment contract. A payment adapter (Stripe, …)
// implements `PaymentProvider`; apps create checkouts, mint discount coupons,
// refund, and verify webhooks without touching a specific gateway's SDK.
//
// Amounts crossing this boundary are integer minor units (cents).

import type { Address } from "./shipping";

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

export type PaymentProvider = {
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;
  createCoupon(input: CreateCouponInput): Promise<string>;
  /** Fetch a session's current state (for return pages). */
  retrieveCheckout(sessionId: string): Promise<CheckoutSession>;
  refundBySession(sessionId: string): Promise<void>;
  verifyWebhook(payload: string, signature: string): Promise<WebhookEvent>;
};
