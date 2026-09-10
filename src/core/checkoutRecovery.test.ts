import { expect, test } from "bun:test";
import {
  canAdvanceCheckoutAttempt,
  summarizeCheckoutAttempt,
  summarizeCheckoutJourneys,
  summarizeCheckoutStages,
  type CheckoutAttemptEvidence,
} from "./checkoutAttempts";
const event = (
  outcome: CheckoutAttemptEvidence["outcome"],
  stage: string,
  at: string,
  source: CheckoutAttemptEvidence["source"] = "host",
): CheckoutAttemptEvidence => ({
  attemptId: "a",
  amountCents: 100,
  currency: "USD",
  flow: "subscription",
  method: "card",
  provider: "example",
  outcome,
  stage,
  at,
  source,
});
const paid = event(
  "completed",
  "provider_approved",
  "2026-09-09T12:00:01Z",
  "webhook",
);
const browser = event(
  "in_progress",
  "method_selected",
  "2026-09-09T12:00:02Z",
  "browser",
);
test("late browser observation cannot undo payment success regardless of arrival order", () => {
  expect(canAdvanceCheckoutAttempt(paid, browser)).toBe(false);
  expect(canAdvanceCheckoutAttempt(browser, paid)).toBe(true);
  expect(summarizeCheckoutAttempt([paid, browser])?.outcome).toBe("completed");
  expect(summarizeCheckoutAttempt([browser, paid])?.latestStage).toBe(
    "provider_approved",
  );
});
test("confirmed failure survives browser progress but can be recovered by success", () => {
  const declined = event(
    "declined",
    "provider_declined",
    "2026-09-09T12:00:00Z",
    "provider_api",
  );
  expect(canAdvanceCheckoutAttempt(declined, browser)).toBe(false);
  expect(canAdvanceCheckoutAttempt(declined, paid)).toBe(true);
});
test("groups only host-correlated journeys and suppresses earlier losses after conversion", () => {
  const failed = summarizeCheckoutAttempt([
    event("declined", "provider_declined", "2026-09-09T12:00:00Z"),
  ])!;
  const completed = summarizeCheckoutAttempt([{ ...paid, attemptId: "b" }])!;
  const groups = summarizeCheckoutJourneys([
    { ...failed, journeyKey: "user1" },
    { ...completed, journeyKey: "user1" },
    { ...failed, journeyKey: "user2" },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0].attemptCount).toBe(2);
  expect(groups[0].latest.outcome).toBe("completed");
  expect(groups[0].recovered).toBe(true);
});
test("stage report deduplicates observations and does not assume skipped steps", () => {
  const report = summarizeCheckoutStages([paid, paid]);
  expect(report.provider_approved.reached).toBe(1);
  expect(report.tokenized).toBeUndefined();
});
