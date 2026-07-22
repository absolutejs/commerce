import { describe, expect, test } from "bun:test";
import {
  commerceStorefrontCaseAttachments,
  commerceStorefrontCaseEvidenceSubmissions,
  commerceStorefrontCaseEvents,
  commerceStorefrontCaseMessages,
  commerceStorefrontCases,
} from "./index";

describe("storefront aftercare timestamps", () => {
  test("preserve JavaScript Date identity for optimistic locks and leases", () => {
    const timestampColumns = [
      commerceStorefrontCases.created_at,
      commerceStorefrontCases.updated_at,
      commerceStorefrontCases.closed_at,
      commerceStorefrontCases.due_at,
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
    ];

    expect(timestampColumns.map((column) => column.getSQLType())).toEqual(
      timestampColumns.map(() => "timestamp (3) with time zone"),
    );
  });
});
