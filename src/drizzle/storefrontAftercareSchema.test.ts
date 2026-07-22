import { describe, expect, test } from "bun:test";
import {
  commerceStorefrontCaseAttachments,
  commerceStorefrontAftercarePolicies,
  commerceStorefrontCaseEvidenceSubmissions,
  commerceStorefrontCaseEscalations,
  commerceStorefrontCaseEvents,
  commerceStorefrontCaseMessages,
  commerceStorefrontCases,
} from "./index";
import { normalizeStorefrontDisputeDeadlinePolicy } from "./storefrontAftercareEvidence";

describe("storefront aftercare timestamps", () => {
  test("preserve JavaScript Date identity for optimistic locks and leases", () => {
    const timestampColumns = [
      commerceStorefrontCases.created_at,
      commerceStorefrontCases.updated_at,
      commerceStorefrontCases.closed_at,
      commerceStorefrontCases.due_at,
      commerceStorefrontAftercarePolicies.created_at,
      commerceStorefrontAftercarePolicies.updated_at,
      commerceStorefrontCaseMessages.created_at,
      commerceStorefrontCaseEvents.created_at,
      commerceStorefrontCaseEvents.updated_at,
      commerceStorefrontCaseEvents.lease_expires_at,
      commerceStorefrontCaseEvents.next_attempt_at,
      commerceStorefrontCaseEvents.notified_at,
      commerceStorefrontCaseAttachments.created_at,
      commerceStorefrontCaseAttachments.updated_at,
      commerceStorefrontCaseAttachments.lease_expires_at,
      commerceStorefrontCaseAttachments.retention_expires_at,
      commerceStorefrontCaseAttachments.scanned_at,
      commerceStorefrontCaseEvidenceSubmissions.created_at,
      commerceStorefrontCaseEvidenceSubmissions.updated_at,
      commerceStorefrontCaseEvidenceSubmissions.lease_expires_at,
      commerceStorefrontCaseEvidenceSubmissions.next_attempt_at,
      commerceStorefrontCaseEvidenceSubmissions.reconciled_at,
      commerceStorefrontCaseEvidenceSubmissions.submitted_at,
      commerceStorefrontCaseEscalations.created_at,
      commerceStorefrontCaseEscalations.updated_at,
      commerceStorefrontCaseEscalations.acknowledged_at,
      commerceStorefrontCaseEscalations.due_at,
      commerceStorefrontCaseEscalations.lease_expires_at,
      commerceStorefrontCaseEscalations.next_promotion_at,
      commerceStorefrontCaseEscalations.promoted_at,
      commerceStorefrontCaseEscalations.resolved_at,
    ];

    expect(timestampColumns.map((column) => column.getSQLType())).toEqual(
      timestampColumns.map(() => "timestamp (3) with time zone"),
    );
  });

  test("normalizes bounded tenant deadline warnings", () => {
    expect(
      normalizeStorefrontDisputeDeadlinePolicy({
        alertsEnabled: true,
        escalationAfterMinutes: 60,
        escalationEnabled: true,
        notificationAudiences: ["owner", "admin"],
        overdueEnabled: true,
        warningHours: [24, 72, 24],
      }),
    ).toEqual({
      alertsEnabled: true,
      escalationAfterMinutes: 60,
      escalationEnabled: true,
      notificationAudiences: ["owner", "admin"],
      overdueEnabled: true,
      warningHours: [72, 24],
    });
    expect(() =>
      normalizeStorefrontDisputeDeadlinePolicy({
        alertsEnabled: true,
        escalationAfterMinutes: 60,
        escalationEnabled: true,
        notificationAudiences: ["owner", "admin"],
        overdueEnabled: true,
        warningHours: [0],
      }),
    ).toThrow("deadline_policy_invalid");
  });
});
