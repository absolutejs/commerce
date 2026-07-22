import type {
  StorefrontCaseAttachment,
  StorefrontCaseKind,
  StorefrontCaseResolution,
  StorefrontCaseStatus,
} from "../core/aftercare";
import type { PaymentDispute } from "../core/payment";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { CommerceDb } from "./queries";
import {
  commerceCheckoutIntents,
  commerceStorefrontCaseEvents,
  commerceStorefrontCaseEscalations,
  commerceStorefrontCaseMessages,
  commerceStorefrontCases,
  commerceStorefrontOrders,
} from "./index";
import { storefrontOrderAccessTokenHash } from "./storefrontOrders";

const DEFAULT_CYCLE_LIMIT = 10;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_MS = 60_000;

export type StorefrontCase = typeof commerceStorefrontCases.$inferSelect;
export type StorefrontCaseMessage =
  typeof commerceStorefrontCaseMessages.$inferSelect;
export type StorefrontCaseEvent =
  typeof commerceStorefrontCaseEvents.$inferSelect;

export class StorefrontAftercareError extends Error {
  constructor(
    readonly code:
      | "aftercare_disabled"
      | "attachment_not_clean"
      | "attachment_not_found"
      | "attachments_disabled"
      | "case_access_denied"
      | "case_closed"
      | "case_conflict"
      | "case_identity_conflict"
      | "case_not_found"
      | "case_transition_invalid"
      | "customer_case_kind_invalid"
      | "evidence_disabled"
      | "evidence_identity_conflict"
      | "evidence_not_found"
      | "evidence_reconciliation_required"
      | "evidence_not_retryable"
      | "evidence_not_supported"
      | "deadline_policy_invalid"
      | "escalation_conflict"
      | "escalation_disabled"
      | "escalation_not_found"
      | "order_access_denied"
      | "order_not_found",
  ) {
    super(`Storefront aftercare operation failed (${code})`);
    this.name = "StorefrontAftercareError";
  }
}

const terminalStatuses: StorefrontCaseStatus[] = [
  "closed",
  "rejected",
  "resolved",
];

const transitions: Record<StorefrontCaseStatus, StorefrontCaseStatus[]> = {
  approved: ["awaiting_customer", "awaiting_merchant", "resolved", "closed"],
  awaiting_customer: ["awaiting_merchant", "approved", "rejected", "closed"],
  awaiting_merchant: [
    "awaiting_customer",
    "approved",
    "rejected",
    "under_review",
    "closed",
  ],
  closed: [],
  open: [
    "awaiting_customer",
    "awaiting_merchant",
    "approved",
    "rejected",
    "under_review",
    "closed",
  ],
  rejected: ["open"],
  resolved: ["open"],
  under_review: [
    "awaiting_customer",
    "awaiting_merchant",
    "resolved",
    "closed",
  ],
};

const customerCase = ({
  assigned_to: _assignedTo,
  idempotency_key: _idempotencyKey,
  owner_key: _ownerKey,
  provider_case_id: _providerCaseId,
  requested_by: _requestedBy,
  ...entry
}: StorefrontCase) => entry;

const customerMessage = ({
  author_ref: _authorRef,
  owner_key: _ownerKey,
  ...entry
}: StorefrontCaseMessage) => entry;

export const emitStorefrontCaseEvent = (
  db: CommerceDb,
  input: {
    caseId: string;
    eventKey: string;
    kind: string;
    orderId: string;
    ownerKey: string;
    payload?: Record<string, unknown>;
  },
) =>
  db
    .insert(commerceStorefrontCaseEvents)
    .values({
      case_id: input.caseId,
      event_key: input.eventKey,
      kind: input.kind,
      order_id: input.orderId,
      owner_key: input.ownerKey,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing();

export const createStorefrontAftercareService = (options: {
  db: CommerceDb;
  enabled?: boolean;
  leaseMs?: number;
  notificationsEnabled?: boolean;
  notify: (input: {
    case: StorefrontCase;
    event: StorefrontCaseEvent;
    idempotencyKey: string;
    order: typeof commerceStorefrontOrders.$inferSelect;
  }) => Promise<void>;
  now?: () => Date;
  retryMs?: number;
}) => {
  const enabled = options.enabled ?? false;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const notificationsEnabled = options.notificationsEnabled ?? false;
  const now = options.now ?? (() => new Date());
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;

  const orderFor = async (ownerKey: string, orderId: string) => {
    const [order] = await options.db
      .select()
      .from(commerceStorefrontOrders)
      .where(
        and(
          eq(commerceStorefrontOrders.id, orderId),
          eq(commerceStorefrontOrders.owner_key, ownerKey),
        ),
      )
      .limit(1);
    if (!order) throw new StorefrontAftercareError("order_not_found");

    return order;
  };

  const customerOrder = async (
    ownerKey: string,
    access: { accessToken: string; checkoutIntentId: string },
  ) => {
    const accessTokenHash = storefrontOrderAccessTokenHash(access.accessToken);
    const [entry] = await options.db
      .select({
        intent: commerceCheckoutIntents,
        order: commerceStorefrontOrders,
      })
      .from(commerceCheckoutIntents)
      .innerJoin(
        commerceStorefrontOrders,
        eq(commerceStorefrontOrders.intent_id, commerceCheckoutIntents.id),
      )
      .where(
        and(
          eq(commerceCheckoutIntents.id, access.checkoutIntentId),
          eq(commerceCheckoutIntents.owner_key, ownerKey),
          eq(commerceCheckoutIntents.access_token_hash, accessTokenHash),
          eq(commerceStorefrontOrders.access_token_hash, accessTokenHash),
        ),
      )
      .limit(1);
    if (!entry) throw new StorefrontAftercareError("order_access_denied");

    return entry.order;
  };

  const caseFor = async (ownerKey: string, caseId: string) => {
    const [entry] = await options.db
      .select()
      .from(commerceStorefrontCases)
      .where(
        and(
          eq(commerceStorefrontCases.id, caseId),
          eq(commerceStorefrontCases.owner_key, ownerKey),
        ),
      )
      .limit(1);
    if (!entry) throw new StorefrontAftercareError("case_not_found");

    return entry;
  };

  const insertMessage = async (
    db: CommerceDb,
    input: {
      attachments?: StorefrontCaseAttachment[];
      authorKind: string;
      authorRef: string;
      body: string;
      caseEntry: StorefrontCase;
      idempotencyKey: string;
      internal?: boolean;
    },
  ) => {
    const [created] = await db
      .insert(commerceStorefrontCaseMessages)
      .values({
        attachments: input.attachments ?? [],
        author_kind: input.authorKind,
        author_ref: input.authorRef,
        body: input.body,
        case_id: input.caseEntry.id,
        idempotency_key: input.idempotencyKey,
        internal: input.internal ?? false,
        owner_key: input.caseEntry.owner_key,
      })
      .onConflictDoNothing()
      .returning();
    const [known] = created
      ? []
      : await db
          .select()
          .from(commerceStorefrontCaseMessages)
          .where(
            and(
              eq(commerceStorefrontCaseMessages.case_id, input.caseEntry.id),
              eq(
                commerceStorefrontCaseMessages.idempotency_key,
                input.idempotencyKey,
              ),
            ),
          )
          .limit(1);
    const message = created ?? known;
    if (!message) throw new StorefrontAftercareError("case_not_found");
    if (
      !created &&
      (message.author_kind !== input.authorKind ||
        message.author_ref !== input.authorRef ||
        message.body !== input.body ||
        message.internal !== (input.internal ?? false) ||
        JSON.stringify(message.attachments) !==
          JSON.stringify(input.attachments ?? []))
    )
      throw new StorefrontAftercareError("case_identity_conflict");

    return { created: Boolean(created), message };
  };

  const claimEvent = async (workerId: string) => {
    const timestamp = now();
    await options.db
      .update(commerceStorefrontCaseEvents)
      .set({
        last_error: "Aftercare notification lease expired",
        lease_expires_at: null,
        next_attempt_at: timestamp,
        status: "retry",
        updated_at: timestamp,
        worker_id: null,
      })
      .where(
        and(
          eq(commerceStorefrontCaseEvents.status, "sending"),
          lte(commerceStorefrontCaseEvents.lease_expires_at, timestamp),
        ),
      );
    const candidates = await options.db
      .select()
      .from(commerceStorefrontCaseEvents)
      .where(
        and(
          inArray(commerceStorefrontCaseEvents.status, ["pending", "retry"]),
          or(
            isNull(commerceStorefrontCaseEvents.next_attempt_at),
            lte(commerceStorefrontCaseEvents.next_attempt_at, timestamp),
          ),
        ),
      )
      .orderBy(asc(commerceStorefrontCaseEvents.created_at))
      .limit(DEFAULT_CYCLE_LIMIT);
    for (const candidate of candidates) {
      const [claimed] = await options.db
        .update(commerceStorefrontCaseEvents)
        .set({
          attempts: candidate.attempts + 1,
          lease_expires_at: new Date(timestamp.getTime() + leaseMs),
          status: "sending",
          updated_at: timestamp,
          worker_id: workerId,
        })
        .where(
          and(
            eq(commerceStorefrontCaseEvents.id, candidate.id),
            eq(commerceStorefrontCaseEvents.status, candidate.status),
          ),
        )
        .returning();
      if (claimed) return claimed;
    }

    return null;
  };

  return {
    addCustomerMessage: async (input: {
      accessToken: string;
      attachments?: StorefrontCaseAttachment[];
      body: string;
      caseId: string;
      checkoutIntentId: string;
      idempotencyKey: string;
      ownerKey: string;
    }) => {
      if (!enabled) throw new StorefrontAftercareError("aftercare_disabled");
      const order = await customerOrder(input.ownerKey, input);
      const caseEntry = await caseFor(input.ownerKey, input.caseId);
      if (caseEntry.order_id !== order.id)
        throw new StorefrontAftercareError("case_access_denied");
      if (terminalStatuses.includes(caseEntry.status as StorefrontCaseStatus))
        throw new StorefrontAftercareError("case_closed");
      const message = await options.db.transaction(async (transaction) => {
        const result = await insertMessage(transaction, {
          attachments: input.attachments,
          authorKind: "customer",
          authorRef: `customer:${input.checkoutIntentId}`,
          body: input.body,
          caseEntry,
          idempotencyKey: input.idempotencyKey,
        });
        if (result.created) {
          await transaction
            .update(commerceStorefrontCases)
            .set({ status: "awaiting_merchant", updated_at: now() })
            .where(eq(commerceStorefrontCases.id, caseEntry.id));
          await emitStorefrontCaseEvent(transaction, {
            caseId: caseEntry.id,
            eventKey: `message:${result.message.id}`,
            kind: "customer_message",
            orderId: order.id,
            ownerKey: input.ownerKey,
          });
        }

        return result.message;
      });

      return customerMessage(message);
    },
    addOperatorMessage: async (input: {
      attachments?: StorefrontCaseAttachment[];
      authorKind: "admin" | "owner";
      authorRef: string;
      body: string;
      caseId: string;
      idempotencyKey: string;
      internal?: boolean;
      ownerKey: string;
    }) => {
      if (!enabled) throw new StorefrontAftercareError("aftercare_disabled");
      const caseEntry = await caseFor(input.ownerKey, input.caseId);
      if (terminalStatuses.includes(caseEntry.status as StorefrontCaseStatus))
        throw new StorefrontAftercareError("case_closed");
      return options.db.transaction(async (transaction) => {
        const { created, message } = await insertMessage(transaction, {
          attachments: input.attachments,
          authorKind: input.authorKind,
          authorRef: input.authorRef,
          body: input.body,
          caseEntry,
          idempotencyKey: input.idempotencyKey,
          internal: input.internal,
        });
        if (created && !message.internal) {
          await transaction
            .update(commerceStorefrontCases)
            .set({ status: "awaiting_customer", updated_at: now() })
            .where(eq(commerceStorefrontCases.id, caseEntry.id));
          await emitStorefrontCaseEvent(transaction, {
            caseId: caseEntry.id,
            eventKey: `message:${message.id}`,
            kind: "merchant_message",
            orderId: caseEntry.order_id,
            ownerKey: input.ownerKey,
          });
        }

        return message;
      });
    },
    getOwnerCase: (ownerKey: string, caseId: string) =>
      caseFor(ownerKey, caseId),
    listCustomer: async (
      ownerKey: string,
      access: { accessToken: string; checkoutIntentId: string },
    ) => {
      const order = await customerOrder(ownerKey, access);
      const cases = await options.db
        .select()
        .from(commerceStorefrontCases)
        .where(eq(commerceStorefrontCases.order_id, order.id))
        .orderBy(desc(commerceStorefrontCases.updated_at));
      const caseIds = cases.map(({ id }) => id);
      const messages = caseIds.length
        ? await options.db
            .select()
            .from(commerceStorefrontCaseMessages)
            .where(
              and(
                inArray(commerceStorefrontCaseMessages.case_id, caseIds),
                eq(commerceStorefrontCaseMessages.internal, false),
              ),
            )
            .orderBy(asc(commerceStorefrontCaseMessages.created_at))
        : [];

      return {
        cases: cases.map(customerCase),
        messages: messages.map(customerMessage),
        orderId: order.id,
      };
    },
    listFleet: async () => ({
      cases: await options.db
        .select()
        .from(commerceStorefrontCases)
        .orderBy(desc(commerceStorefrontCases.updated_at)),
      events: await options.db
        .select()
        .from(commerceStorefrontCaseEvents)
        .orderBy(desc(commerceStorefrontCaseEvents.created_at)),
      messages: await options.db
        .select()
        .from(commerceStorefrontCaseMessages)
        .orderBy(desc(commerceStorefrontCaseMessages.created_at)),
    }),
    listOwner: async (ownerKey: string) => ({
      cases: await options.db
        .select()
        .from(commerceStorefrontCases)
        .where(eq(commerceStorefrontCases.owner_key, ownerKey))
        .orderBy(desc(commerceStorefrontCases.updated_at)),
      events: await options.db
        .select()
        .from(commerceStorefrontCaseEvents)
        .where(eq(commerceStorefrontCaseEvents.owner_key, ownerKey))
        .orderBy(desc(commerceStorefrontCaseEvents.created_at)),
      messages: await options.db
        .select()
        .from(commerceStorefrontCaseMessages)
        .where(eq(commerceStorefrontCaseMessages.owner_key, ownerKey))
        .orderBy(desc(commerceStorefrontCaseMessages.created_at)),
    }),
    openCustomerCase: async (input: {
      accessToken: string;
      attachments?: StorefrontCaseAttachment[];
      checkoutIntentId: string;
      idempotencyKey: string;
      kind: Exclude<StorefrontCaseKind, "dispute">;
      ownerKey: string;
      reason: string;
      subject: string;
    }) => {
      if (!enabled) throw new StorefrontAftercareError("aftercare_disabled");
      if (!(["exchange", "return", "support"] as string[]).includes(input.kind))
        throw new StorefrontAftercareError("customer_case_kind_invalid");
      const order = await customerOrder(input.ownerKey, input);
      const caseEntry = await options.db.transaction(async (transaction) => {
        const [created] = await transaction
          .insert(commerceStorefrontCases)
          .values({
            idempotency_key: input.idempotencyKey,
            kind: input.kind,
            order_id: order.id,
            owner_key: input.ownerKey,
            reason: input.reason,
            requested_by: `customer:${input.checkoutIntentId}`,
            status: "awaiting_merchant",
            subject: input.subject,
          })
          .onConflictDoNothing()
          .returning();
        const [known] = created
          ? []
          : await transaction
              .select()
              .from(commerceStorefrontCases)
              .where(
                and(
                  eq(commerceStorefrontCases.owner_key, input.ownerKey),
                  eq(
                    commerceStorefrontCases.idempotency_key,
                    input.idempotencyKey,
                  ),
                ),
              )
              .limit(1);
        const entry = created ?? known;
        if (created && entry) {
          await transaction.insert(commerceStorefrontCaseMessages).values({
            attachments: input.attachments ?? [],
            author_kind: "customer",
            author_ref: `customer:${input.checkoutIntentId}`,
            body: input.reason,
            case_id: entry.id,
            idempotency_key: `${input.idempotencyKey}:opening-message`,
            owner_key: input.ownerKey,
          });
          await emitStorefrontCaseEvent(transaction, {
            caseId: entry.id,
            eventKey: "opened",
            kind: "case_opened",
            orderId: order.id,
            ownerKey: input.ownerKey,
            payload: { caseKind: input.kind },
          });
        }

        return entry;
      });
      if (!caseEntry) throw new StorefrontAftercareError("case_not_found");
      if (
        caseEntry.order_id !== order.id ||
        caseEntry.kind !== input.kind ||
        caseEntry.reason !== input.reason ||
        caseEntry.subject !== input.subject
      )
        throw new StorefrontAftercareError("case_identity_conflict");

      return customerCase(caseEntry);
    },
    runNotificationCycle: async (
      workerId: string,
      limit = DEFAULT_CYCLE_LIMIT,
    ) => {
      if (!notificationsEnabled)
        throw new StorefrontAftercareError("aftercare_disabled");
      const results: Array<{ eventId: string; status: string }> = [];
      for (let index = 0; index < limit; index += 1) {
        const event = await claimEvent(workerId);
        if (!event) break;
        const caseEntry = await caseFor(event.owner_key, event.case_id);
        const order = await orderFor(event.owner_key, event.order_id);
        try {
          await options.notify({
            case: caseEntry,
            event,
            idempotencyKey: event.id,
            order,
          });
          await options.db
            .update(commerceStorefrontCaseEvents)
            .set({
              last_error: null,
              lease_expires_at: null,
              notified_at: now(),
              status: "sent",
              updated_at: now(),
              worker_id: null,
            })
            .where(eq(commerceStorefrontCaseEvents.id, event.id));
          results.push({ eventId: event.id, status: "sent" });
        } catch (error) {
          await options.db
            .update(commerceStorefrontCaseEvents)
            .set({
              last_error:
                error instanceof Error
                  ? error.message
                  : "Aftercare notification failed",
              lease_expires_at: null,
              next_attempt_at: new Date(now().getTime() + retryMs),
              status: "retry",
              updated_at: now(),
              worker_id: null,
            })
            .where(eq(commerceStorefrontCaseEvents.id, event.id));
          results.push({ eventId: event.id, status: "retry" });
        }
      }

      return results;
    },
    transition: async (input: {
      assignedTo?: string | null;
      caseId: string;
      expectedUpdatedAt: Date;
      idempotencyKey: string;
      ownerKey: string;
      resolution?: StorefrontCaseResolution | null;
      status: StorefrontCaseStatus;
    }) => {
      if (!enabled) throw new StorefrontAftercareError("aftercare_disabled");
      const current = await caseFor(input.ownerKey, input.caseId);
      const eventKey = `transition:${input.idempotencyKey}`;
      const [knownEvent] = await options.db
        .select({ id: commerceStorefrontCaseEvents.id })
        .from(commerceStorefrontCaseEvents)
        .where(
          and(
            eq(commerceStorefrontCaseEvents.case_id, current.id),
            eq(commerceStorefrontCaseEvents.event_key, eventKey),
          ),
        )
        .limit(1);
      if (knownEvent) return current;
      const currentStatus = current.status as StorefrontCaseStatus;
      if (!transitions[currentStatus].includes(input.status))
        throw new StorefrontAftercareError("case_transition_invalid");
      if (["rejected", "resolved"].includes(input.status) && !input.resolution)
        throw new StorefrontAftercareError("case_transition_invalid");
      const timestamp = now();
      return options.db.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(commerceStorefrontCases)
          .set({
            ...(input.assignedTo !== undefined
              ? { assigned_to: input.assignedTo }
              : {}),
            closed_at: terminalStatuses.includes(input.status)
              ? timestamp
              : null,
            ...(input.resolution !== undefined
              ? { resolution: input.resolution }
              : {}),
            status: input.status,
            updated_at: timestamp,
          })
          .where(
            and(
              eq(commerceStorefrontCases.id, current.id),
              eq(commerceStorefrontCases.owner_key, input.ownerKey),
              eq(commerceStorefrontCases.updated_at, input.expectedUpdatedAt),
            ),
          )
          .returning();
        if (!updated) throw new StorefrontAftercareError("case_conflict");
        await emitStorefrontCaseEvent(transaction, {
          caseId: updated.id,
          eventKey,
          kind: "status_changed",
          orderId: updated.order_id,
          ownerKey: updated.owner_key,
          payload: { from: current.status, to: updated.status },
        });
        if (terminalStatuses.includes(input.status))
          await transaction
            .update(commerceStorefrontCaseEscalations)
            .set({
              lease_expires_at: null,
              next_promotion_at: null,
              resolved_at: timestamp,
              status: "resolved",
              updated_at: timestamp,
              worker_id: null,
            })
            .where(
              and(
                eq(commerceStorefrontCaseEscalations.case_id, updated.id),
                inArray(commerceStorefrontCaseEscalations.status, [
                  "open",
                  "promoted",
                ]),
              ),
            );

        return updated;
      });
    },
  };
};

export const recordStorefrontDispute = async (
  db: CommerceDb,
  input: {
    dispute: PaymentDispute;
    eventId: string;
    orderId: string;
    ownerKey: string;
  },
) => {
  const status: StorefrontCaseStatus = [
    "closed",
    "lost",
    "prevented",
    "warning_closed",
    "won",
  ].includes(input.dispute.status)
    ? "resolved"
    : input.dispute.status.includes("review")
      ? "under_review"
      : "awaiting_merchant";
  const [created] = await db
    .insert(commerceStorefrontCases)
    .values({
      due_at: input.dispute.evidenceDueAt,
      idempotency_key: `dispute:${input.dispute.providerDisputeId}`,
      kind: "dispute",
      order_id: input.orderId,
      owner_key: input.ownerKey,
      provider_case_id: input.dispute.providerDisputeId,
      provider_status: input.dispute.status,
      reason: input.dispute.reason,
      requested_by: "payment-provider",
      status,
      subject: `Payment dispute: ${input.dispute.reason}`,
    })
    .onConflictDoNothing()
    .returning();
  const [known] = created
    ? []
    : await db
        .select()
        .from(commerceStorefrontCases)
        .where(
          and(
            eq(commerceStorefrontCases.owner_key, input.ownerKey),
            eq(commerceStorefrontCases.kind, "dispute"),
            eq(
              commerceStorefrontCases.provider_case_id,
              input.dispute.providerDisputeId,
            ),
          ),
        )
        .limit(1);
  const caseEntry = created ?? known;
  if (!caseEntry) throw new StorefrontAftercareError("case_not_found");
  const [updated] = created
    ? [created]
    : await db
        .update(commerceStorefrontCases)
        .set({
          due_at: input.dispute.evidenceDueAt,
          provider_status: input.dispute.status,
          status,
          updated_at: new Date(),
        })
        .where(eq(commerceStorefrontCases.id, caseEntry.id))
        .returning();
  const result = updated ?? caseEntry;
  await emitStorefrontCaseEvent(db, {
    caseId: result.id,
    eventKey: `provider:${input.eventId}`,
    kind: created ? "dispute_opened" : "dispute_updated",
    orderId: input.orderId,
    ownerKey: input.ownerKey,
    payload: {
      amountCents: input.dispute.amountCents,
      currency: input.dispute.currency,
      providerStatus: input.dispute.status,
    },
  });
  if (terminalStatuses.includes(status))
    await db
      .update(commerceStorefrontCaseEscalations)
      .set({
        lease_expires_at: null,
        next_promotion_at: null,
        resolved_at: new Date(),
        status: "resolved",
        updated_at: new Date(),
        worker_id: null,
      })
      .where(
        and(
          eq(commerceStorefrontCaseEscalations.case_id, result.id),
          inArray(commerceStorefrontCaseEscalations.status, [
            "open",
            "promoted",
          ]),
        ),
      );

  return result;
};
