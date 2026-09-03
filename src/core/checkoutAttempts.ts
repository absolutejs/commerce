/**
 * Privacy-safe, provider-agnostic evidence for a checkout attempt.
 *
 * Hosts persist these projections beside their own user/order records. Never
 * place payment tokens, card data, wallet payloads, addresses, or arbitrary
 * provider responses in `metadata`.
 */
export const CHECKOUT_ATTEMPT_OUTCOMES = [
  "in_progress",
  "completed",
  "canceled",
  "abandoned",
  "declined",
  "failed",
] as const;

export type CheckoutAttemptOutcome = (typeof CHECKOUT_ATTEMPT_OUTCOMES)[number];

export const CHECKOUT_ATTEMPT_FLOWS = [
  "subscription",
  "renewal",
  "plan_change",
  "payment_method_replacement",
  "credit_purchase",
  "invoice",
  "refund",
  "void",
  "chargeback",
] as const;

export type CheckoutAttemptFlow = (typeof CHECKOUT_ATTEMPT_FLOWS)[number];

export const CHECKOUT_ATTEMPT_METHODS = [
  "apple_pay",
  "card",
  "saved_card",
  "hosted_invoice",
  "unknown",
] as const;

export type CheckoutAttemptMethod = (typeof CHECKOUT_ATTEMPT_METHODS)[number];

export const CHECKOUT_ATTEMPT_SOURCES = [
  "browser",
  "host",
  "provider_api",
  "webhook",
  "reconciliation",
  "scheduler",
  "admin",
] as const;

export type CheckoutAttemptSource = (typeof CHECKOUT_ATTEMPT_SOURCES)[number];

export type CheckoutAttemptEvidence = {
  /** Stable, host-minted identity shared by every observation in one attempt. */
  attemptId: string;
  /** Integer minor units; null when no amount was known at this stage. */
  amountCents: number | null;
  at: Date | string;
  currency: string;
  flow: CheckoutAttemptFlow;
  /** Constrained failure family, not a raw exception or provider response. */
  failureCode?: string | null;
  method: CheckoutAttemptMethod;
  outcome: CheckoutAttemptOutcome;
  provider: string;
  /** A stable product/plan/offer key; never customer data. */
  productKey?: string | null;
  source: CheckoutAttemptSource;
  /** A constrained lifecycle label such as `intent_created` or `authorized`. */
  stage: string;
};

export type CheckoutAttemptSummary = {
  amountCents: number | null;
  attemptId: string;
  completedAt: string | null;
  currency: string;
  durationMs: number;
  evidenceCount: number;
  failureCode: string | null;
  firstAt: string;
  flow: CheckoutAttemptFlow;
  latestAt: string;
  latestStage: string;
  method: CheckoutAttemptMethod;
  outcome: CheckoutAttemptOutcome;
  productKey: string | null;
  provider: string;
};

export type CheckoutFunnelSummary = {
  attempts: number;
  byFlow: Record<string, number>;
  byMethod: Record<string, number>;
  byOutcome: Record<CheckoutAttemptOutcome, number>;
  completed: number;
  conversionRate: number;
  lost: number;
};

const terminalOutcomes = new Set<CheckoutAttemptOutcome>([
  "abandoned",
  "canceled",
  "completed",
  "declined",
  "failed",
]);

const dateText = (value: Date | string) =>
  (typeof value === "string" ? new Date(value) : value).toISOString();

/** Reduce one attempt's observations into the current operator-facing state. */
export const summarizeCheckoutAttempt = (
  evidence: CheckoutAttemptEvidence[],
): CheckoutAttemptSummary | null => {
  if (evidence.length === 0) return null;
  const ordered = evidence
    .map((item) => ({ ...item, at: dateText(item.at) }))
    .sort((left, right) => left.at.localeCompare(right.at));
  const first = ordered[0];
  const latest = ordered.at(-1);
  if (!first || !latest) return null;
  const completed = [...ordered]
    .reverse()
    .find((item) => terminalOutcomes.has(item.outcome));

  return {
    amountCents: latest.amountCents,
    attemptId: latest.attemptId,
    completedAt: completed?.at ?? null,
    currency: latest.currency,
    durationMs: new Date(latest.at).getTime() - new Date(first.at).getTime(),
    evidenceCount: ordered.length,
    failureCode: latest.failureCode ?? null,
    firstAt: first.at,
    flow: latest.flow,
    latestAt: latest.at,
    latestStage: latest.stage,
    method: latest.method,
    outcome: latest.outcome,
    productKey: latest.productKey ?? null,
    provider: latest.provider,
  };
};

/** Aggregate already-deduplicated attempts into a conversion/loss funnel. */
export const summarizeCheckoutFunnel = (
  attempts: CheckoutAttemptSummary[],
): CheckoutFunnelSummary => {
  const byOutcome = Object.fromEntries(
    CHECKOUT_ATTEMPT_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<CheckoutAttemptOutcome, number>;
  const byFlow: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  for (const attempt of attempts) {
    byOutcome[attempt.outcome] += 1;
    byFlow[attempt.flow] = (byFlow[attempt.flow] ?? 0) + 1;
    byMethod[attempt.method] = (byMethod[attempt.method] ?? 0) + 1;
  }
  const completed = byOutcome.completed;
  const lost =
    byOutcome.abandoned +
    byOutcome.canceled +
    byOutcome.declined +
    byOutcome.failed;

  return {
    attempts: attempts.length,
    byFlow,
    byMethod,
    byOutcome,
    completed,
    conversionRate: attempts.length === 0 ? 0 : completed / attempts.length,
    lost,
  };
};
