import { describe, expect, test } from "bun:test";
import {
  providerJourneyCorrelationFrom,
  summarizeProviderJourney,
  withProviderJourneyCorrelation,
  type ProviderJourneyEvidence,
} from "./payment";

const correlationId = "invoice-123";

describe("provider journey evidence", () => {
  test("round-trips a host-owned correlation without replacing app metadata", () => {
    const metadata = withProviderJourneyCorrelation(
      { campaign: "summer" },
      correlationId,
    );

    expect(metadata).toEqual({
      absolute_provider_correlation: correlationId,
      campaign: "summer",
    });
    expect(providerJourneyCorrelationFrom(metadata)).toBe(correlationId);
    expect(providerJourneyCorrelationFrom(null)).toBe(null);
    expect(
      providerJourneyCorrelationFrom({
        absolute_provider_correlation: "x".repeat(201),
      }),
    ).toBe(null);
  });

  test("surfaces a hosted-page failure contradicted by a successful webhook", () => {
    const evidence: ProviderJourneyEvidence[] = [
      {
        at: 1,
        correlationId,
        operation: "invoice_payment",
        outcome: "started",
        provider: "gateway",
        source: "host",
      },
      {
        at: 2,
        correlationId,
        operation: "invoice_payment",
        outcome: "succeeded",
        provider: "gateway",
        reference: "transaction-1",
        source: "webhook",
      },
      {
        at: 3,
        correlationId,
        message: "Payment token does not exist",
        operation: "invoice_payment",
        outcome: "failed",
        provider: "gateway",
        reference: "ref-1",
        source: "hosted_page_report",
      },
    ];

    expect(summarizeProviderJourney(evidence)).toMatchObject({
      authoritativeOutcome: "succeeded",
      contradiction: true,
      correlationId,
      reportedOutcome: "failed",
      status: "succeeded",
    });
  });

  test("keeps ordinary pending and successful journeys out of contradiction", () => {
    expect(
      summarizeProviderJourney([
        {
          at: 1,
          correlationId,
          operation: "oauth_consent",
          outcome: "pending",
          provider: "identity",
          source: "host",
        },
        {
          at: 2,
          correlationId,
          operation: "oauth_consent",
          outcome: "succeeded",
          provider: "identity",
          source: "reconciliation",
        },
      ]),
    ).toMatchObject({
      authoritativeOutcome: "succeeded",
      contradiction: false,
      status: "succeeded",
    });
  });
});
