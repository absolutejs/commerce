import { describe, expect, it } from "bun:test";
import {
  summarizeCheckoutAttempt,
  summarizeCheckoutFunnel,
  type CheckoutAttemptEvidence,
} from "./checkoutAttempts";

const attempt = (
  attemptId: string,
  outcome: CheckoutAttemptEvidence["outcome"],
): CheckoutAttemptEvidence[] => [
  {
    amountCents: 9_000,
    at: "2026-01-01T00:00:00.000Z",
    attemptId,
    currency: "USD",
    flow: "subscription",
    method: "unknown",
    outcome: "in_progress",
    productKey: "pro",
    provider: "example",
    source: "host",
    stage: "intent_created",
  },
  {
    amountCents: 9_000,
    at: "2026-01-01T00:00:03.000Z",
    attemptId,
    currency: "USD",
    failureCode: outcome === "completed" ? null : "authorization_not_completed",
    flow: "subscription",
    method: "apple_pay",
    outcome,
    productKey: "pro",
    provider: "example",
    source: "browser",
    stage: outcome === "completed" ? "completed" : "authorization_ended",
  },
];

describe("checkout attempt analytics", () => {
  it("reduces ordered evidence without retaining sensitive payloads", () => {
    expect(summarizeCheckoutAttempt(attempt("a", "canceled"))).toEqual({
      amountCents: 9_000,
      attemptId: "a",
      completedAt: "2026-01-01T00:00:03.000Z",
      currency: "USD",
      durationMs: 3_000,
      evidenceCount: 2,
      failureCode: "authorization_not_completed",
      firstAt: "2026-01-01T00:00:00.000Z",
      flow: "subscription",
      latestAt: "2026-01-01T00:00:03.000Z",
      latestStage: "authorization_ended",
      method: "apple_pay",
      outcome: "canceled",
      productKey: "pro",
      provider: "example",
    });
  });

  it("summarizes completed and lost attempts", () => {
    const attempts = [
      summarizeCheckoutAttempt(attempt("a", "completed")),
      summarizeCheckoutAttempt(attempt("b", "canceled")),
    ].filter((value) => value !== null);

    expect(summarizeCheckoutFunnel(attempts)).toMatchObject({
      attempts: 2,
      completed: 1,
      conversionRate: 0.5,
      lost: 1,
    });
  });
});
