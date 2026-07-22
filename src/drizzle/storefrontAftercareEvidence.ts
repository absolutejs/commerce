import type {
  StorefrontCaseAttachmentPurpose,
  StorefrontCaseEvidenceText,
  StorefrontCaseStatus,
  StorefrontDisputeDeadlinePolicy,
} from "../core/aftercare";
import type {
  PaymentDisputeEvidenceFile,
  PaymentDisputeEvidenceReconciliation,
  PaymentDisputeEvidenceResult,
} from "../core/payment";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
} from "drizzle-orm";
import type { CommerceDb } from "./queries";
import {
  commerceCheckoutIntents,
  commerceStorefrontAftercarePolicies,
  commerceStorefrontCaseAttachments,
  commerceStorefrontCaseEscalations,
  commerceStorefrontCaseEvidenceSubmissions,
  commerceStorefrontCaseEvents,
  commerceStorefrontCases,
  commerceStorefrontOrders,
} from "./index";
import {
  emitStorefrontCaseEvent,
  StorefrontAftercareError,
} from "./storefrontAftercare";
import { storefrontOrderAccessTokenHash } from "./storefrontOrders";

const DEFAULT_CYCLE_LIMIT = 10;
const DEFAULT_LEASE_MS = 60_000;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_DEADLINE_WARNING_HOURS = 720;
const MAX_DEADLINE_WARNINGS = 6;
const DEFAULT_DEADLINE_WINDOW_MS = MAX_DEADLINE_WARNING_HOURS * HOUR_MS;
const defaultDeadlinePolicy: StorefrontDisputeDeadlinePolicy = {
  alertsEnabled: true,
  escalationAfterMinutes: 60,
  escalationEnabled: true,
  notificationAudiences: ["owner", "admin"],
  overdueEnabled: true,
  warningHours: [72, 24],
};
const terminalStatuses: StorefrontCaseStatus[] = [
  "closed",
  "rejected",
  "resolved",
];

export type StorefrontCaseAttachmentRecord =
  typeof commerceStorefrontCaseAttachments.$inferSelect;
export type StorefrontCaseEvidenceSubmission =
  typeof commerceStorefrontCaseEvidenceSubmissions.$inferSelect;

type InspectionResult = {
  details?: string;
  scanner: string;
  signature?: string;
  verdict: "clean" | "infected" | "unavailable";
};

export const normalizeStorefrontDisputeDeadlinePolicy = (
  policy: StorefrontDisputeDeadlinePolicy,
): StorefrontDisputeDeadlinePolicy => {
  const warningHours = [...new Set(policy.warningHours)].sort(
    (left, right) => right - left,
  );
  if (
    warningHours.length === 0 ||
    warningHours.length > MAX_DEADLINE_WARNINGS ||
    warningHours.some(
      (hours) =>
        !Number.isSafeInteger(hours) ||
        hours < 1 ||
        hours > MAX_DEADLINE_WARNING_HOURS,
    )
  )
    throw new StorefrontAftercareError("deadline_policy_invalid");

  const notificationAudiences = [...new Set(policy.notificationAudiences)];
  if (
    !Number.isSafeInteger(policy.escalationAfterMinutes) ||
    policy.escalationAfterMinutes < 1 ||
    policy.escalationAfterMinutes > 10_080 ||
    notificationAudiences.length === 0 ||
    notificationAudiences.some(
      (audience) => audience !== "admin" && audience !== "owner",
    )
  )
    throw new StorefrontAftercareError("deadline_policy_invalid");

  return { ...policy, notificationAudiences, warningHours };
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;

  return JSON.stringify(value);
};

export const createStorefrontAftercareEvidenceService = (options: {
  attachmentsEnabled?: boolean;
  db: CommerceDb;
  deadlinesEnabled?: boolean;
  deadlineWindowMs?: number;
  evidenceEnabled?: boolean;
  inspectAttachment: (
    attachment: StorefrontCaseAttachmentRecord,
  ) => Promise<InspectionResult>;
  leaseMs?: number;
  now?: () => Date;
  removeAttachment: (
    attachment: StorefrontCaseAttachmentRecord,
  ) => Promise<void>;
  reconcileEvidence?: (input: {
    attachments: StorefrontCaseAttachmentRecord[];
    caseEntry: typeof commerceStorefrontCases.$inferSelect;
    submission: StorefrontCaseEvidenceSubmission;
  }) => Promise<PaymentDisputeEvidenceReconciliation>;
  submitEvidence: (input: {
    attachments: StorefrontCaseAttachmentRecord[];
    caseEntry: typeof commerceStorefrontCases.$inferSelect;
    idempotencyKey: string;
    submission: StorefrontCaseEvidenceSubmission;
  }) => Promise<PaymentDisputeEvidenceResult>;
}) => {
  const attachmentsEnabled = options.attachmentsEnabled ?? false;
  const deadlinesEnabled = options.deadlinesEnabled ?? false;
  const deadlineWindowMs =
    options.deadlineWindowMs ?? DEFAULT_DEADLINE_WINDOW_MS;
  const evidenceEnabled = options.evidenceEnabled ?? false;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? (() => new Date());

  const deadlinePolicyFor = async (ownerKey: string) => {
    const [record] = await options.db
      .select({ policy: commerceStorefrontAftercarePolicies.deadline_policy })
      .from(commerceStorefrontAftercarePolicies)
      .where(eq(commerceStorefrontAftercarePolicies.owner_key, ownerKey))
      .limit(1);

    return normalizeStorefrontDisputeDeadlinePolicy({
      ...defaultDeadlinePolicy,
      ...record?.policy,
    });
  };

  const caseFor = async (ownerKey: string, caseId: string) => {
    const [entry] = await options.db
      .select()
      .from(commerceStorefrontCases)
      .where(
        and(
          eq(commerceStorefrontCases.owner_key, ownerKey),
          eq(commerceStorefrontCases.id, caseId),
        ),
      )
      .limit(1);
    if (!entry) throw new StorefrontAftercareError("case_not_found");

    return entry;
  };

  const customerOrder = async (
    ownerKey: string,
    access: { accessToken: string; checkoutIntentId: string },
  ) => {
    const digest = storefrontOrderAccessTokenHash(access.accessToken);
    const [entry] = await options.db
      .select({ order: commerceStorefrontOrders })
      .from(commerceCheckoutIntents)
      .innerJoin(
        commerceStorefrontOrders,
        eq(commerceStorefrontOrders.intent_id, commerceCheckoutIntents.id),
      )
      .where(
        and(
          eq(commerceCheckoutIntents.id, access.checkoutIntentId),
          eq(commerceCheckoutIntents.owner_key, ownerKey),
          eq(commerceCheckoutIntents.access_token_hash, digest),
          eq(commerceStorefrontOrders.access_token_hash, digest),
        ),
      )
      .limit(1);
    if (!entry) throw new StorefrontAftercareError("order_access_denied");

    return entry.order;
  };

  const attachmentFor = async (ownerKey: string, attachmentId: string) => {
    const [entry] = await options.db
      .select()
      .from(commerceStorefrontCaseAttachments)
      .where(
        and(
          eq(commerceStorefrontCaseAttachments.owner_key, ownerKey),
          eq(commerceStorefrontCaseAttachments.id, attachmentId),
        ),
      )
      .limit(1);
    if (!entry) throw new StorefrontAftercareError("attachment_not_found");

    return entry;
  };

  const retain = async (input: {
    blobKey: string;
    byteCount: number;
    caseEntry: typeof commerceStorefrontCases.$inferSelect;
    contentType: string;
    internal?: boolean;
    label: string;
    purpose?: StorefrontCaseAttachmentPurpose;
    retentionExpiresAt?: Date | null;
    sha256: string;
  }) => {
    const [created] = await options.db
      .insert(commerceStorefrontCaseAttachments)
      .values({
        blob_key: input.blobKey,
        byte_count: input.byteCount,
        case_id: input.caseEntry.id,
        content_type: input.contentType,
        internal: input.internal ?? false,
        label: input.label,
        owner_key: input.caseEntry.owner_key,
        purpose: input.purpose ?? "uncategorized_file",
        retention_expires_at: input.retentionExpiresAt,
        sha256: input.sha256,
      })
      .onConflictDoNothing()
      .returning();
    const [known] = created
      ? []
      : await options.db
          .select()
          .from(commerceStorefrontCaseAttachments)
          .where(
            and(
              eq(
                commerceStorefrontCaseAttachments.owner_key,
                input.caseEntry.owner_key,
              ),
              eq(commerceStorefrontCaseAttachments.blob_key, input.blobKey),
            ),
          )
          .limit(1);
    const attachment = created ?? known;
    if (!attachment) throw new StorefrontAftercareError("attachment_not_found");
    if (
      attachment.case_id !== input.caseEntry.id ||
      attachment.byte_count !== input.byteCount ||
      attachment.content_type !== input.contentType ||
      attachment.internal !== (input.internal ?? false) ||
      attachment.label !== input.label ||
      attachment.purpose !== (input.purpose ?? "uncategorized_file") ||
      attachment.sha256 !== input.sha256
    )
      throw new StorefrontAftercareError("case_identity_conflict");

    return attachment;
  };

  const claimAttachment = async (workerId: string) => {
    const timestamp = now();
    await options.db
      .update(commerceStorefrontCaseAttachments)
      .set({
        last_error: "Attachment inspection lease expired",
        lease_expires_at: null,
        status: "quarantined",
        updated_at: timestamp,
        worker_id: null,
      })
      .where(
        and(
          eq(commerceStorefrontCaseAttachments.status, "scanning"),
          lte(commerceStorefrontCaseAttachments.lease_expires_at, timestamp),
        ),
      );
    const candidates = await options.db
      .select()
      .from(commerceStorefrontCaseAttachments)
      .where(eq(commerceStorefrontCaseAttachments.status, "pending_scan"))
      .orderBy(asc(commerceStorefrontCaseAttachments.created_at))
      .limit(DEFAULT_CYCLE_LIMIT);
    for (const candidate of candidates) {
      const [claimed] = await options.db
        .update(commerceStorefrontCaseAttachments)
        .set({
          lease_expires_at: new Date(timestamp.getTime() + leaseMs),
          status: "scanning",
          updated_at: timestamp,
          worker_id: workerId,
        })
        .where(
          and(
            eq(commerceStorefrontCaseAttachments.id, candidate.id),
            eq(commerceStorefrontCaseAttachments.status, "pending_scan"),
          ),
        )
        .returning();
      if (claimed) return claimed;
    }

    return null;
  };

  const claimEvidence = async (workerId: string) => {
    const timestamp = now();
    await options.db
      .update(commerceStorefrontCaseEvidenceSubmissions)
      .set({
        last_error: "Evidence submission lease expired with unknown outcome",
        lease_expires_at: null,
        status: "quarantined",
        updated_at: timestamp,
        worker_id: null,
      })
      .where(
        and(
          eq(commerceStorefrontCaseEvidenceSubmissions.status, "processing"),
          lte(
            commerceStorefrontCaseEvidenceSubmissions.lease_expires_at,
            timestamp,
          ),
        ),
      );
    const candidates = await options.db
      .select()
      .from(commerceStorefrontCaseEvidenceSubmissions)
      .where(
        and(
          inArray(commerceStorefrontCaseEvidenceSubmissions.status, [
            "pending",
            "retry",
          ]),
          or(
            isNull(commerceStorefrontCaseEvidenceSubmissions.next_attempt_at),
            lte(
              commerceStorefrontCaseEvidenceSubmissions.next_attempt_at,
              timestamp,
            ),
          ),
        ),
      )
      .orderBy(asc(commerceStorefrontCaseEvidenceSubmissions.created_at))
      .limit(DEFAULT_CYCLE_LIMIT);
    for (const candidate of candidates) {
      const [claimed] = await options.db
        .update(commerceStorefrontCaseEvidenceSubmissions)
        .set({
          attempts: candidate.attempts + 1,
          lease_expires_at: new Date(timestamp.getTime() + leaseMs),
          status: "processing",
          updated_at: timestamp,
          worker_id: workerId,
        })
        .where(
          and(
            eq(commerceStorefrontCaseEvidenceSubmissions.id, candidate.id),
            eq(
              commerceStorefrontCaseEvidenceSubmissions.status,
              candidate.status,
            ),
          ),
        )
        .returning();
      if (claimed) return claimed;
    }

    return null;
  };

  const claimReconciliation = async (workerId: string) => {
    const timestamp = now();
    await options.db
      .update(commerceStorefrontCaseEvidenceSubmissions)
      .set({
        last_error: "Evidence reconciliation lease expired",
        lease_expires_at: null,
        reconciled_at: null,
        status: "quarantined",
        updated_at: timestamp,
        worker_id: null,
      })
      .where(
        and(
          eq(commerceStorefrontCaseEvidenceSubmissions.status, "reconciling"),
          lte(
            commerceStorefrontCaseEvidenceSubmissions.lease_expires_at,
            timestamp,
          ),
        ),
      );
    const candidates = await options.db
      .select()
      .from(commerceStorefrontCaseEvidenceSubmissions)
      .where(
        eq(
          commerceStorefrontCaseEvidenceSubmissions.status,
          "reconciliation_pending",
        ),
      )
      .orderBy(asc(commerceStorefrontCaseEvidenceSubmissions.updated_at))
      .limit(DEFAULT_CYCLE_LIMIT);
    for (const candidate of candidates) {
      const [claimed] = await options.db
        .update(commerceStorefrontCaseEvidenceSubmissions)
        .set({
          lease_expires_at: new Date(timestamp.getTime() + leaseMs),
          status: "reconciling",
          updated_at: timestamp,
          worker_id: workerId,
        })
        .where(
          and(
            eq(commerceStorefrontCaseEvidenceSubmissions.id, candidate.id),
            eq(
              commerceStorefrontCaseEvidenceSubmissions.status,
              "reconciliation_pending",
            ),
          ),
        )
        .returning();
      if (claimed) return claimed;
    }

    return null;
  };

  return {
    deleteAttachment: async (ownerKey: string, attachmentId: string) => {
      if (!attachmentsEnabled)
        throw new StorefrontAftercareError("attachments_disabled");
      const attachment = await attachmentFor(ownerKey, attachmentId);
      if (attachment.status === "deleted") return attachment;
      await options.removeAttachment(attachment);
      const [deleted] = await options.db
        .update(commerceStorefrontCaseAttachments)
        .set({ status: "deleted", updated_at: now() })
        .where(eq(commerceStorefrontCaseAttachments.id, attachment.id))
        .returning();

      return deleted!;
    },
    getCustomerAttachment: async (
      ownerKey: string,
      access: { accessToken: string; checkoutIntentId: string },
      attachmentId: string,
    ) => {
      const order = await customerOrder(ownerKey, access);
      const attachment = await attachmentFor(ownerKey, attachmentId);
      const caseEntry = await caseFor(ownerKey, attachment.case_id);
      if (
        caseEntry.order_id !== order.id ||
        attachment.internal ||
        attachment.status !== "clean"
      )
        throw new StorefrontAftercareError("attachment_not_found");

      return attachment;
    },
    getOwnerAttachment: (ownerKey: string, attachmentId: string) =>
      attachmentFor(ownerKey, attachmentId),
    listCustomer: async (
      ownerKey: string,
      access: { accessToken: string; checkoutIntentId: string },
    ) => {
      const order = await customerOrder(ownerKey, access);
      const cases = await options.db
        .select({ id: commerceStorefrontCases.id })
        .from(commerceStorefrontCases)
        .where(eq(commerceStorefrontCases.order_id, order.id));
      const ids = cases.map(({ id }) => id);

      return ids.length
        ? options.db
            .select({
              byte_count: commerceStorefrontCaseAttachments.byte_count,
              case_id: commerceStorefrontCaseAttachments.case_id,
              content_type: commerceStorefrontCaseAttachments.content_type,
              created_at: commerceStorefrontCaseAttachments.created_at,
              id: commerceStorefrontCaseAttachments.id,
              label: commerceStorefrontCaseAttachments.label,
              purpose: commerceStorefrontCaseAttachments.purpose,
              scanned_at: commerceStorefrontCaseAttachments.scanned_at,
              status: commerceStorefrontCaseAttachments.status,
            })
            .from(commerceStorefrontCaseAttachments)
            .where(
              and(
                inArray(commerceStorefrontCaseAttachments.case_id, ids),
                eq(commerceStorefrontCaseAttachments.internal, false),
                eq(commerceStorefrontCaseAttachments.status, "clean"),
              ),
            )
            .orderBy(desc(commerceStorefrontCaseAttachments.created_at))
        : [];
    },
    listFleet: async () => ({
      attachments: await options.db
        .select()
        .from(commerceStorefrontCaseAttachments)
        .orderBy(desc(commerceStorefrontCaseAttachments.created_at)),
      submissions: await options.db
        .select()
        .from(commerceStorefrontCaseEvidenceSubmissions)
        .orderBy(desc(commerceStorefrontCaseEvidenceSubmissions.created_at)),
      deadlinePolicies: await options.db
        .select()
        .from(commerceStorefrontAftercarePolicies)
        .orderBy(asc(commerceStorefrontAftercarePolicies.owner_key)),
    }),
    listOwner: async (ownerKey: string) => ({
      attachments: await options.db
        .select()
        .from(commerceStorefrontCaseAttachments)
        .where(eq(commerceStorefrontCaseAttachments.owner_key, ownerKey))
        .orderBy(desc(commerceStorefrontCaseAttachments.created_at)),
      submissions: await options.db
        .select()
        .from(commerceStorefrontCaseEvidenceSubmissions)
        .where(
          eq(commerceStorefrontCaseEvidenceSubmissions.owner_key, ownerKey),
        )
        .orderBy(desc(commerceStorefrontCaseEvidenceSubmissions.created_at)),
      deadlinePolicy: await deadlinePolicyFor(ownerKey),
    }),
    setDeadlinePolicy: async (
      ownerKey: string,
      policy: StorefrontDisputeDeadlinePolicy,
    ) => {
      const deadlinePolicy = normalizeStorefrontDisputeDeadlinePolicy(policy);
      const [record] = await options.db
        .insert(commerceStorefrontAftercarePolicies)
        .values({ deadline_policy: deadlinePolicy, owner_key: ownerKey })
        .onConflictDoUpdate({
          set: { deadline_policy: deadlinePolicy, updated_at: now() },
          target: commerceStorefrontAftercarePolicies.owner_key,
        })
        .returning();

      return record!;
    },
    queueEvidence: async (input: {
      attachmentIds: string[];
      caseId: string;
      evidence: StorefrontCaseEvidenceText;
      idempotencyKey: string;
      ownerKey: string;
      submit: boolean;
    }) => {
      if (!evidenceEnabled)
        throw new StorefrontAftercareError("evidence_disabled");
      const caseEntry = await caseFor(input.ownerKey, input.caseId);
      if (caseEntry.kind !== "dispute" || !caseEntry.provider_case_id)
        throw new StorefrontAftercareError("evidence_not_supported");
      const attachmentIds = [...new Set(input.attachmentIds)].sort();
      const attachments = attachmentIds.length
        ? await options.db
            .select()
            .from(commerceStorefrontCaseAttachments)
            .where(
              and(
                eq(commerceStorefrontCaseAttachments.owner_key, input.ownerKey),
                eq(commerceStorefrontCaseAttachments.case_id, caseEntry.id),
                inArray(commerceStorefrontCaseAttachments.id, attachmentIds),
              ),
            )
        : [];
      if (
        attachments.length !== attachmentIds.length ||
        attachments.some(({ status }) => status !== "clean")
      )
        throw new StorefrontAftercareError("attachment_not_clean");
      if (!attachmentIds.length && !Object.keys(input.evidence).length)
        throw new StorefrontAftercareError("evidence_not_supported");
      const [created] = await options.db
        .insert(commerceStorefrontCaseEvidenceSubmissions)
        .values({
          attachment_ids: attachmentIds,
          case_id: caseEntry.id,
          evidence: input.evidence,
          idempotency_key: input.idempotencyKey,
          owner_key: input.ownerKey,
          submit: input.submit,
        })
        .onConflictDoNothing()
        .returning();
      const [known] = created
        ? []
        : await options.db
            .select()
            .from(commerceStorefrontCaseEvidenceSubmissions)
            .where(
              and(
                eq(
                  commerceStorefrontCaseEvidenceSubmissions.owner_key,
                  input.ownerKey,
                ),
                eq(
                  commerceStorefrontCaseEvidenceSubmissions.case_id,
                  caseEntry.id,
                ),
                eq(
                  commerceStorefrontCaseEvidenceSubmissions.idempotency_key,
                  input.idempotencyKey,
                ),
              ),
            )
            .limit(1);
      const submission = created ?? known;
      if (!submission) throw new StorefrontAftercareError("evidence_not_found");
      if (
        !created &&
        (canonical(submission.attachment_ids) !== canonical(attachmentIds) ||
          canonical(submission.evidence) !== canonical(input.evidence) ||
          submission.submit !== input.submit)
      )
        throw new StorefrontAftercareError("evidence_identity_conflict");

      return submission;
    },
    retainCustomerAttachment: async (input: {
      accessToken: string;
      blobKey: string;
      byteCount: number;
      caseId: string;
      checkoutIntentId: string;
      contentType: string;
      label: string;
      ownerKey: string;
      purpose?: StorefrontCaseAttachmentPurpose;
      retentionExpiresAt?: Date | null;
      sha256: string;
    }) => {
      if (!attachmentsEnabled)
        throw new StorefrontAftercareError("attachments_disabled");
      const order = await customerOrder(input.ownerKey, input);
      const caseEntry = await caseFor(input.ownerKey, input.caseId);
      if (caseEntry.order_id !== order.id)
        throw new StorefrontAftercareError("case_access_denied");
      if (terminalStatuses.includes(caseEntry.status as StorefrontCaseStatus))
        throw new StorefrontAftercareError("case_closed");

      return retain({ ...input, caseEntry, internal: false });
    },
    retainOperatorAttachment: async (input: {
      blobKey: string;
      byteCount: number;
      caseId: string;
      contentType: string;
      internal?: boolean;
      label: string;
      ownerKey: string;
      purpose?: StorefrontCaseAttachmentPurpose;
      retentionExpiresAt?: Date | null;
      sha256: string;
    }) => {
      if (!attachmentsEnabled)
        throw new StorefrontAftercareError("attachments_disabled");
      const caseEntry = await caseFor(input.ownerKey, input.caseId);
      if (terminalStatuses.includes(caseEntry.status as StorefrontCaseStatus))
        throw new StorefrontAftercareError("case_closed");

      return retain({ ...input, caseEntry });
    },
    retryAttachment: async (ownerKey: string, attachmentId: string) => {
      if (!attachmentsEnabled)
        throw new StorefrontAftercareError("attachments_disabled");
      const attachment = await attachmentFor(ownerKey, attachmentId);
      if (attachment.status !== "quarantined")
        throw new StorefrontAftercareError("evidence_not_retryable");
      const [retried] = await options.db
        .update(commerceStorefrontCaseAttachments)
        .set({
          last_error: null,
          scan_details: null,
          status: "pending_scan",
          updated_at: now(),
        })
        .where(eq(commerceStorefrontCaseAttachments.id, attachment.id))
        .returning();

      return retried!;
    },
    queueEvidenceReconciliation: async (
      ownerKey: string,
      submissionId: string,
    ) => {
      if (!evidenceEnabled)
        throw new StorefrontAftercareError("evidence_disabled");
      if (!options.reconcileEvidence)
        throw new StorefrontAftercareError("evidence_not_supported");
      const [queued] = await options.db
        .update(commerceStorefrontCaseEvidenceSubmissions)
        .set({
          last_error: null,
          lease_expires_at: null,
          reconciliation_diagnostics: null,
          reconciled_at: null,
          status: "reconciliation_pending",
          updated_at: now(),
          worker_id: null,
        })
        .where(
          and(
            eq(commerceStorefrontCaseEvidenceSubmissions.owner_key, ownerKey),
            eq(commerceStorefrontCaseEvidenceSubmissions.id, submissionId),
            eq(commerceStorefrontCaseEvidenceSubmissions.status, "quarantined"),
          ),
        )
        .returning();
      if (!queued) throw new StorefrontAftercareError("evidence_not_retryable");

      return queued;
    },
    retryEvidence: async (ownerKey: string, submissionId: string) => {
      if (!evidenceEnabled)
        throw new StorefrontAftercareError("evidence_disabled");
      const [submission] = await options.db
        .select()
        .from(commerceStorefrontCaseEvidenceSubmissions)
        .where(
          and(
            eq(commerceStorefrontCaseEvidenceSubmissions.owner_key, ownerKey),
            eq(commerceStorefrontCaseEvidenceSubmissions.id, submissionId),
          ),
        )
        .limit(1);
      if (!submission) throw new StorefrontAftercareError("evidence_not_found");
      if (submission.status !== "quarantined")
        throw new StorefrontAftercareError("evidence_not_retryable");
      if (!submission.reconciled_at)
        throw new StorefrontAftercareError("evidence_reconciliation_required");
      const [retried] = await options.db
        .update(commerceStorefrontCaseEvidenceSubmissions)
        .set({
          last_error: null,
          next_attempt_at: now(),
          reconciliation_diagnostics: null,
          reconciled_at: null,
          status: "retry",
          updated_at: now(),
        })
        .where(
          and(
            eq(commerceStorefrontCaseEvidenceSubmissions.owner_key, ownerKey),
            eq(commerceStorefrontCaseEvidenceSubmissions.id, submissionId),
            eq(commerceStorefrontCaseEvidenceSubmissions.status, "quarantined"),
            isNotNull(commerceStorefrontCaseEvidenceSubmissions.reconciled_at),
          ),
        )
        .returning();
      if (!retried)
        throw new StorefrontAftercareError("evidence_not_retryable");

      return retried;
    },
    runDeadlineCycle: async (limit = DEFAULT_CYCLE_LIMIT) => {
      if (!deadlinesEnabled)
        throw new StorefrontAftercareError("aftercare_disabled");
      const timestamp = now();
      const results: Array<{ bucket: string; caseId: string }> = [];
      const policies = new Map<string, StorefrontDisputeDeadlinePolicy>();
      const pageSize = Math.max(limit, DEFAULT_CYCLE_LIMIT);
      for (let offset = 0; results.length < limit; offset += pageSize) {
        const cases = await options.db
          .select()
          .from(commerceStorefrontCases)
          .where(
            and(
              eq(commerceStorefrontCases.kind, "dispute"),
              isNotNull(commerceStorefrontCases.due_at),
              lte(
                commerceStorefrontCases.due_at,
                new Date(timestamp.getTime() + deadlineWindowMs),
              ),
              notInArray(commerceStorefrontCases.status, terminalStatuses),
            ),
          )
          .orderBy(
            asc(commerceStorefrontCases.due_at),
            asc(commerceStorefrontCases.id),
          )
          .limit(pageSize)
          .offset(offset);
        for (const caseEntry of cases) {
          let policy = policies.get(caseEntry.owner_key);
          if (!policy) {
            policy = await deadlinePolicyFor(caseEntry.owner_key);
            policies.set(caseEntry.owner_key, policy);
          }
          if (!policy.alertsEnabled) continue;
          const remaining = caseEntry.due_at!.getTime() - timestamp.getTime();
          const warning = policy.warningHours
            .filter((hours) => remaining <= hours * HOUR_MS)
            .at(-1);
          const bucket =
            remaining <= 0
              ? policy.overdueEnabled
                ? "overdue"
                : undefined
              : warning
                ? `${warning}h`
                : undefined;
          if (!bucket) continue;
          const eventKey = `evidence-deadline:${caseEntry.due_at!.toISOString()}:${bucket}`;
          const [existing] = await options.db
            .select({ id: commerceStorefrontCaseEvents.id })
            .from(commerceStorefrontCaseEvents)
            .where(
              and(
                eq(commerceStorefrontCaseEvents.case_id, caseEntry.id),
                eq(commerceStorefrontCaseEvents.event_key, eventKey),
              ),
            )
            .limit(1);
          if (existing) continue;
          await options.db.transaction(async (transaction) => {
            await emitStorefrontCaseEvent(transaction, {
              caseId: caseEntry.id,
              eventKey,
              kind: "evidence_deadline",
              orderId: caseEntry.order_id,
              ownerKey: caseEntry.owner_key,
              payload: {
                bucket,
                dueAt: caseEntry.due_at!.toISOString(),
                notificationAudiences: policy.notificationAudiences,
                providerStatus: caseEntry.provider_status,
              },
            });
            if (policy.escalationEnabled)
              await transaction
                .insert(commerceStorefrontCaseEscalations)
                .values({
                  bucket,
                  case_id: caseEntry.id,
                  due_at: caseEntry.due_at!,
                  event_key: eventKey,
                  next_promotion_at: new Date(
                    timestamp.getTime() +
                      policy.escalationAfterMinutes * 60 * 1_000,
                  ),
                  notification_audiences: policy.notificationAudiences,
                  owner_key: caseEntry.owner_key,
                })
                .onConflictDoNothing();
          });
          results.push({ bucket, caseId: caseEntry.id });
          if (results.length >= limit) break;
        }
        if (cases.length < pageSize) break;
      }

      return results;
    },
    runReconciliationCycle: async (
      workerId: string,
      limit = DEFAULT_CYCLE_LIMIT,
    ) => {
      if (!evidenceEnabled)
        throw new StorefrontAftercareError("evidence_disabled");
      if (!options.reconcileEvidence)
        throw new StorefrontAftercareError("evidence_not_supported");
      const results: Array<{ status: string; submissionId: string }> = [];
      for (let index = 0; index < limit; index += 1) {
        const submission = await claimReconciliation(workerId);
        if (!submission) break;
        const caseEntry = await caseFor(
          submission.owner_key,
          submission.case_id,
        );
        const attachments = submission.attachment_ids.length
          ? await options.db
              .select()
              .from(commerceStorefrontCaseAttachments)
              .where(
                and(
                  eq(
                    commerceStorefrontCaseAttachments.owner_key,
                    submission.owner_key,
                  ),
                  eq(
                    commerceStorefrontCaseAttachments.case_id,
                    submission.case_id,
                  ),
                  inArray(
                    commerceStorefrontCaseAttachments.id,
                    submission.attachment_ids,
                  ),
                ),
              )
          : [];
        try {
          const result = await options.reconcileEvidence({
            attachments,
            caseEntry,
            submission,
          });
          if (result.applied) {
            const status = result.submitted ? "submitted" : "staged";
            await options.db
              .update(commerceStorefrontCaseEvidenceSubmissions)
              .set({
                last_error: null,
                lease_expires_at: null,
                provider_file_ids: result.providerFileIds,
                provider_status: result.providerStatus,
                reconciliation_diagnostics: result.diagnostics,
                reconciled_at: now(),
                status,
                submission_count: result.submissionCount,
                submitted_at: now(),
                updated_at: now(),
                worker_id: null,
              })
              .where(
                eq(commerceStorefrontCaseEvidenceSubmissions.id, submission.id),
              );
            await emitStorefrontCaseEvent(options.db, {
              caseId: caseEntry.id,
              eventKey: `evidence-reconciled:${submission.id}`,
              kind: "evidence_reconciled",
              orderId: caseEntry.order_id,
              ownerKey: caseEntry.owner_key,
              payload: { status },
            });
            results.push({ status, submissionId: submission.id });
          } else {
            await options.db
              .update(commerceStorefrontCaseEvidenceSubmissions)
              .set({
                last_error:
                  "Provider reconciliation confirmed the evidence effect was not applied",
                lease_expires_at: null,
                provider_status: result.providerStatus,
                reconciliation_diagnostics: result.diagnostics,
                reconciled_at: now(),
                status: "quarantined",
                submission_count: result.submissionCount,
                updated_at: now(),
                worker_id: null,
              })
              .where(
                eq(commerceStorefrontCaseEvidenceSubmissions.id, submission.id),
              );
            results.push({
              status: "not_applied",
              submissionId: submission.id,
            });
          }
        } catch (error) {
          await options.db
            .update(commerceStorefrontCaseEvidenceSubmissions)
            .set({
              last_error:
                error instanceof Error
                  ? error.message
                  : "Evidence reconciliation failed",
              lease_expires_at: null,
              reconciliation_diagnostics: null,
              reconciled_at: null,
              status: "quarantined",
              updated_at: now(),
              worker_id: null,
            })
            .where(
              eq(commerceStorefrontCaseEvidenceSubmissions.id, submission.id),
            );
          results.push({
            status: "quarantined",
            submissionId: submission.id,
          });
        }
      }

      return results;
    },
    runEvidenceCycle: async (workerId: string, limit = DEFAULT_CYCLE_LIMIT) => {
      if (!evidenceEnabled)
        throw new StorefrontAftercareError("evidence_disabled");
      const results: Array<{ status: string; submissionId: string }> = [];
      for (let index = 0; index < limit; index += 1) {
        const submission = await claimEvidence(workerId);
        if (!submission) break;
        const caseEntry = await caseFor(
          submission.owner_key,
          submission.case_id,
        );
        const attachments = submission.attachment_ids.length
          ? await options.db
              .select()
              .from(commerceStorefrontCaseAttachments)
              .where(
                and(
                  eq(
                    commerceStorefrontCaseAttachments.owner_key,
                    submission.owner_key,
                  ),
                  eq(
                    commerceStorefrontCaseAttachments.case_id,
                    submission.case_id,
                  ),
                  inArray(
                    commerceStorefrontCaseAttachments.id,
                    submission.attachment_ids,
                  ),
                  eq(commerceStorefrontCaseAttachments.status, "clean"),
                ),
              )
          : [];
        if (attachments.length !== submission.attachment_ids.length) {
          await options.db
            .update(commerceStorefrontCaseEvidenceSubmissions)
            .set({
              last_error: "A retained evidence attachment is no longer clean",
              lease_expires_at: null,
              status: "quarantined",
              updated_at: now(),
              worker_id: null,
            })
            .where(
              eq(commerceStorefrontCaseEvidenceSubmissions.id, submission.id),
            );
          results.push({ status: "quarantined", submissionId: submission.id });
          continue;
        }
        try {
          const result = await options.submitEvidence({
            attachments,
            caseEntry,
            idempotencyKey: submission.id,
            submission,
          });
          const status = result.submitted ? "submitted" : "staged";
          await options.db
            .update(commerceStorefrontCaseEvidenceSubmissions)
            .set({
              last_error: null,
              lease_expires_at: null,
              provider_file_ids: result.providerFileIds,
              provider_status: result.providerStatus,
              status,
              submission_count: result.submissionCount,
              submitted_at: now(),
              updated_at: now(),
              worker_id: null,
            })
            .where(
              eq(commerceStorefrontCaseEvidenceSubmissions.id, submission.id),
            );
          await emitStorefrontCaseEvent(options.db, {
            caseId: caseEntry.id,
            eventKey: `evidence:${submission.id}`,
            kind: result.submitted ? "evidence_submitted" : "evidence_staged",
            orderId: caseEntry.order_id,
            ownerKey: caseEntry.owner_key,
            payload: { attachmentCount: attachments.length },
          });
          results.push({ status, submissionId: submission.id });
        } catch (error) {
          await options.db
            .update(commerceStorefrontCaseEvidenceSubmissions)
            .set({
              last_error:
                error instanceof Error
                  ? error.message
                  : "Evidence submission failed with unknown outcome",
              lease_expires_at: null,
              reconciled_at: null,
              status: "quarantined",
              updated_at: now(),
              worker_id: null,
            })
            .where(
              eq(commerceStorefrontCaseEvidenceSubmissions.id, submission.id),
            );
          results.push({ status: "quarantined", submissionId: submission.id });
        }
      }

      return results;
    },
    runInspectionCycle: async (
      workerId: string,
      limit = DEFAULT_CYCLE_LIMIT,
    ) => {
      if (!attachmentsEnabled)
        throw new StorefrontAftercareError("attachments_disabled");
      const results: Array<{ attachmentId: string; status: string }> = [];
      for (let index = 0; index < limit; index += 1) {
        const attachment = await claimAttachment(workerId);
        if (!attachment) break;
        let inspection: InspectionResult;
        try {
          inspection = await options.inspectAttachment(attachment);
        } catch (error) {
          inspection = {
            details:
              error instanceof Error ? error.message : "Inspection failed",
            scanner: "unavailable",
            verdict: "unavailable",
          };
        }
        const status =
          inspection.verdict === "clean"
            ? "clean"
            : inspection.verdict === "infected"
              ? "infected"
              : "quarantined";
        await options.db
          .update(commerceStorefrontCaseAttachments)
          .set({
            last_error:
              inspection.verdict === "unavailable"
                ? (inspection.details ?? "Inspection unavailable")
                : null,
            lease_expires_at: null,
            scan_details:
              inspection.signature ?? inspection.details ?? inspection.verdict,
            scan_provider: inspection.scanner,
            scanned_at: now(),
            status,
            updated_at: now(),
            worker_id: null,
          })
          .where(eq(commerceStorefrontCaseAttachments.id, attachment.id));
        results.push({ attachmentId: attachment.id, status });
      }

      return results;
    },
    runRetentionCycle: async (limit = DEFAULT_CYCLE_LIMIT) => {
      if (!attachmentsEnabled)
        throw new StorefrontAftercareError("attachments_disabled");
      const candidates = await options.db
        .select({
          attachment: commerceStorefrontCaseAttachments,
          caseEntry: commerceStorefrontCases,
        })
        .from(commerceStorefrontCaseAttachments)
        .innerJoin(
          commerceStorefrontCases,
          eq(
            commerceStorefrontCases.id,
            commerceStorefrontCaseAttachments.case_id,
          ),
        )
        .where(
          and(
            lte(commerceStorefrontCaseAttachments.retention_expires_at, now()),
            inArray(commerceStorefrontCases.status, terminalStatuses),
            inArray(commerceStorefrontCaseAttachments.status, [
              "clean",
              "infected",
              "quarantined",
            ]),
          ),
        )
        .orderBy(asc(commerceStorefrontCaseAttachments.retention_expires_at))
        .limit(limit);
      for (const { attachment } of candidates) {
        await options.removeAttachment(attachment);
        await options.db
          .update(commerceStorefrontCaseAttachments)
          .set({ status: "deleted", updated_at: now() })
          .where(eq(commerceStorefrontCaseAttachments.id, attachment.id));
      }

      return candidates.length;
    },
  };
};

export const storefrontEvidenceFiles = async (input: {
  attachments: StorefrontCaseAttachmentRecord[];
  read: (attachment: StorefrontCaseAttachmentRecord) => Promise<Uint8Array>;
}): Promise<PaymentDisputeEvidenceFile[]> =>
  Promise.all(
    input.attachments.map(async (attachment) => ({
      bytes: await input.read(attachment),
      contentType: attachment.content_type,
      id: attachment.id,
      name: attachment.label,
      purpose: attachment.purpose as StorefrontCaseAttachmentPurpose,
      sha256: attachment.sha256,
    })),
  );
