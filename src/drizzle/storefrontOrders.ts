import { createHash } from "node:crypto";
import type { FulfillmentOrder } from "../core/fulfillment";
import type { PaymentRefund } from "../core/payment";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { CommerceDb } from "./queries";
import {
  commerceCheckoutIntents,
  commerceStorefrontCaseEvents,
  commerceStorefrontCases,
  commerceStorefrontFulfillmentJobs,
  commerceStorefrontOrderActions,
  commerceStorefrontOrderEvents,
  commerceStorefrontOrders,
} from "./index";

const DEFAULT_CYCLE_LIMIT = 10;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_MS = 60_000;

export type StorefrontOrderEventKind =
  | "cancelled_refunded"
  | "fulfillment_failed"
  | "fulfillment_submitted"
  | "payment_confirmed"
  | "returned_refunded"
  | "shipped";

export type StorefrontOrderAction =
  typeof commerceStorefrontOrderActions.$inferSelect;
export type StorefrontOrderEvent =
  typeof commerceStorefrontOrderEvents.$inferSelect;
export type StorefrontOrder = typeof commerceStorefrontOrders.$inferSelect;

export class StorefrontOrderError extends Error {
  constructor(
    readonly code:
      | "action_disabled"
      | "action_not_found"
      | "action_not_retryable"
      | "cancellation_not_allowed"
      | "order_access_denied"
      | "order_not_found"
      | "refund_not_allowed",
  ) {
    super(`Storefront order operation failed (${code})`);
    this.name = "StorefrontOrderError";
  }
}

export const storefrontOrderAccessTokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const emitStorefrontOrderEvent = (
  db: CommerceDb,
  input: {
    kind: StorefrontOrderEventKind;
    orderId: string;
    ownerKey: string;
    payload?: Record<string, unknown>;
  },
) =>
  db
    .insert(commerceStorefrontOrderEvents)
    .values({
      kind: input.kind,
      order_id: input.orderId,
      owner_key: input.ownerKey,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing();

const publicOrder = (
  order: StorefrontOrder,
  fulfillment: typeof commerceStorefrontFulfillmentJobs.$inferSelect | null,
) => ({
  amountCents: order.amount_cents,
  createdAt: order.created_at,
  currency: order.currency,
  customerEmail: order.customer_email,
  customerName: order.customer_name,
  id: order.id,
  lines: order.lines,
  shipping: order.shipping,
  status: order.status,
  tracking: fulfillment?.result?.tracking ?? [],
  updatedAt: order.updated_at,
});

const operatorOrder = ({
  access_token_hash: _accessTokenHash,
  ...order
}: StorefrontOrder) => order;

export const createStorefrontOrderService = (options: {
  actionsEnabled?: boolean;
  cancelFulfillment: (input: {
    installationId: string;
    ownerKey: string;
    providerOrderId: string;
  }) => Promise<FulfillmentOrder>;
  db: CommerceDb;
  leaseMs?: number;
  notificationsEnabled?: boolean;
  notify: (input: {
    event: StorefrontOrderEvent;
    idempotencyKey: string;
    order: StorefrontOrder;
  }) => Promise<void>;
  now?: () => Date;
  refundPayment: (input: {
    idempotencyKey: string;
    installationId: string;
    ownerKey: string;
    providerRefundId?: string;
    providerSessionId: string;
  }) => Promise<PaymentRefund>;
  retryMs?: number;
}) => {
  const actionsEnabled = options.actionsEnabled ?? false;
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
    if (!order) throw new StorefrontOrderError("order_not_found");

    return order;
  };

  const claimAction = async (workerId: string) => {
    const timestamp = now();
    await options.db
      .update(commerceStorefrontOrderActions)
      .set({
        last_error: "Worker lease expired during an ambiguous operation",
        lease_expires_at: null,
        status: "quarantined",
        updated_at: timestamp,
        worker_id: null,
      })
      .where(
        and(
          eq(commerceStorefrontOrderActions.status, "processing"),
          lte(commerceStorefrontOrderActions.lease_expires_at, timestamp),
        ),
      );
    const candidates = await options.db
      .select()
      .from(commerceStorefrontOrderActions)
      .where(
        and(
          inArray(commerceStorefrontOrderActions.status, ["pending", "retry"]),
          or(
            isNull(commerceStorefrontOrderActions.next_attempt_at),
            lte(commerceStorefrontOrderActions.next_attempt_at, timestamp),
          ),
        ),
      )
      .orderBy(asc(commerceStorefrontOrderActions.created_at))
      .limit(DEFAULT_CYCLE_LIMIT);
    for (const candidate of candidates) {
      const [claimed] = await options.db
        .update(commerceStorefrontOrderActions)
        .set({
          attempts: candidate.attempts + 1,
          lease_expires_at: new Date(timestamp.getTime() + leaseMs),
          status: "processing",
          updated_at: timestamp,
          worker_id: workerId,
        })
        .where(
          and(
            eq(commerceStorefrontOrderActions.id, candidate.id),
            eq(commerceStorefrontOrderActions.status, candidate.status),
          ),
        )
        .returning();
      if (claimed) return claimed;
    }

    return null;
  };

  const releaseAction = (
    actionId: string,
    values: Partial<StorefrontOrderAction>,
  ) =>
    options.db
      .update(commerceStorefrontOrderActions)
      .set({
        ...values,
        lease_expires_at: null,
        updated_at: now(),
        worker_id: null,
      })
      .where(eq(commerceStorefrontOrderActions.id, actionId));

  const rejectAction = async (
    action: StorefrontOrderAction,
    orderStatus: string,
    reason: string,
  ) => {
    await options.db.transaction(async (transaction) => {
      await transaction
        .update(commerceStorefrontOrderActions)
        .set({
          completed_at: now(),
          last_error: reason,
          lease_expires_at: null,
          status: "rejected",
          updated_at: now(),
          worker_id: null,
        })
        .where(eq(commerceStorefrontOrderActions.id, action.id));
      await transaction
        .update(commerceStorefrontOrders)
        .set({ status: orderStatus, updated_at: now() })
        .where(eq(commerceStorefrontOrders.id, action.order_id));
    });

    return { actionId: action.id, status: "rejected" as const };
  };

  const completeRefund = async (
    action: StorefrontOrderAction,
    refund: PaymentRefund,
  ) => {
    const returned = action.type === "post_delivery_refund";
    await options.db.transaction(async (transaction) => {
      await transaction
        .update(commerceStorefrontOrderActions)
        .set({
          completed_at: now(),
          last_error: null,
          lease_expires_at: null,
          payment_refund: refund,
          phase: "complete",
          status: "complete",
          updated_at: now(),
          worker_id: null,
        })
        .where(eq(commerceStorefrontOrderActions.id, action.id));
      await transaction
        .update(commerceStorefrontOrders)
        .set({
          status: returned ? "refunded" : "cancelled_refunded",
          updated_at: now(),
        })
        .where(eq(commerceStorefrontOrders.id, action.order_id));
      await emitStorefrontOrderEvent(transaction, {
        kind: returned ? "returned_refunded" : "cancelled_refunded",
        orderId: action.order_id,
        ownerKey: action.owner_key,
      });
      if (returned && action.case_id) {
        await transaction
          .update(commerceStorefrontCases)
          .set({ closed_at: now(), status: "resolved", updated_at: now() })
          .where(
            and(
              eq(commerceStorefrontCases.id, action.case_id),
              eq(commerceStorefrontCases.owner_key, action.owner_key),
            ),
          );
        await transaction
          .insert(commerceStorefrontCaseEvents)
          .values({
            case_id: action.case_id,
            event_key: `refund:${action.id}`,
            kind: "refund_completed",
            order_id: action.order_id,
            owner_key: action.owner_key,
            payload: { orderActionId: action.id },
          })
          .onConflictDoNothing();
      }
    });

    return { actionId: action.id, status: "complete" as const };
  };

  const refund = async (
    action: StorefrontOrderAction,
    order: StorefrontOrder,
  ) => {
    const retained = action.payment_refund as PaymentRefund | null;
    try {
      const result = await options.refundPayment({
        idempotencyKey: action.id,
        installationId: order.installation_id,
        ownerKey: order.owner_key,
        ...(retained?.providerRefundId
          ? { providerRefundId: retained.providerRefundId }
          : {}),
        providerSessionId: order.provider_session_id,
      });
      if (result.status === "succeeded") return completeRefund(action, result);
      if (result.status === "failed")
        return rejectAction(action, "refund_failed", "Payment refund failed");
      await releaseAction(action.id, {
        last_error: null,
        next_attempt_at: new Date(now().getTime() + retryMs),
        payment_refund: result,
        phase: "refund_pending",
        status: "pending",
      });

      return { actionId: action.id, status: "pending" as const };
    } catch (error) {
      await releaseAction(action.id, {
        last_error:
          error instanceof Error ? error.message : "Ambiguous payment refund",
        phase: "refunding",
        status: "quarantined",
      });

      return { actionId: action.id, status: "quarantined" as const };
    }
  };

  const runAction = async (action: StorefrontOrderAction) => {
    const order = await orderFor(action.owner_key, action.order_id);
    if (action.type === "post_delivery_refund") return refund(action, order);
    if (
      action.phase === "fulfillment_cancelled" ||
      action.phase === "refund_pending" ||
      action.phase === "refunding"
    )
      return refund(action, order);
    const [job] = await options.db
      .select()
      .from(commerceStorefrontFulfillmentJobs)
      .where(eq(commerceStorefrontFulfillmentJobs.order_id, order.id))
      .limit(1);
    if (!job)
      return rejectAction(action, order.status, "Fulfillment job missing");
    if (job.status === "complete" || job.result?.status === "shipped")
      return rejectAction(
        action,
        "fulfilled",
        "Shipped orders cannot be cancelled",
      );
    let fulfillmentResult: FulfillmentOrder | null = null;
    if (job.provider_order_id && job.installation_id) {
      try {
        fulfillmentResult = await options.cancelFulfillment({
          installationId: job.installation_id,
          ownerKey: order.owner_key,
          providerOrderId: job.provider_order_id,
        });
      } catch (error) {
        await releaseAction(action.id, {
          last_error:
            error instanceof Error
              ? error.message
              : "Ambiguous fulfillment cancellation",
          phase: "cancelling_fulfillment",
          status: "quarantined",
        });

        return { actionId: action.id, status: "quarantined" as const };
      }
      if (fulfillmentResult.status !== "cancelled")
        return rejectAction(
          action,
          order.status,
          `Provider reported ${fulfillmentResult.status}`,
        );
    }
    await options.db.transaction(async (transaction) => {
      await transaction
        .update(commerceStorefrontFulfillmentJobs)
        .set({
          completed_at: now(),
          lease_expires_at: null,
          result: fulfillmentResult ?? job.result,
          status: "cancelled",
          updated_at: now(),
          worker_id: null,
        })
        .where(eq(commerceStorefrontFulfillmentJobs.id, job.id));
      await transaction
        .update(commerceStorefrontOrderActions)
        .set({
          fulfillment_result: fulfillmentResult,
          phase: "fulfillment_cancelled",
          updated_at: now(),
        })
        .where(eq(commerceStorefrontOrderActions.id, action.id));
    });

    return refund(
      {
        ...action,
        fulfillment_result: fulfillmentResult,
        phase: "fulfillment_cancelled",
      },
      order,
    );
  };

  const claimEvent = async (workerId: string) => {
    const timestamp = now();
    await options.db
      .update(commerceStorefrontOrderEvents)
      .set({
        last_error: "Notification lease expired",
        lease_expires_at: null,
        next_attempt_at: timestamp,
        status: "retry",
        updated_at: timestamp,
        worker_id: null,
      })
      .where(
        and(
          eq(commerceStorefrontOrderEvents.status, "sending"),
          lte(commerceStorefrontOrderEvents.lease_expires_at, timestamp),
        ),
      );
    const candidates = await options.db
      .select()
      .from(commerceStorefrontOrderEvents)
      .where(
        and(
          inArray(commerceStorefrontOrderEvents.status, ["pending", "retry"]),
          or(
            isNull(commerceStorefrontOrderEvents.next_attempt_at),
            lte(commerceStorefrontOrderEvents.next_attempt_at, timestamp),
          ),
        ),
      )
      .orderBy(asc(commerceStorefrontOrderEvents.created_at))
      .limit(DEFAULT_CYCLE_LIMIT);
    for (const candidate of candidates) {
      const [claimed] = await options.db
        .update(commerceStorefrontOrderEvents)
        .set({
          attempts: candidate.attempts + 1,
          lease_expires_at: new Date(timestamp.getTime() + leaseMs),
          status: "sending",
          updated_at: timestamp,
          worker_id: workerId,
        })
        .where(
          and(
            eq(commerceStorefrontOrderEvents.id, candidate.id),
            eq(commerceStorefrontOrderEvents.status, candidate.status),
          ),
        )
        .returning();
      if (claimed) return claimed;
    }

    return null;
  };

  return {
    listFleet: async () => ({
      actions: await options.db
        .select()
        .from(commerceStorefrontOrderActions)
        .orderBy(desc(commerceStorefrontOrderActions.created_at)),
      events: await options.db
        .select()
        .from(commerceStorefrontOrderEvents)
        .orderBy(desc(commerceStorefrontOrderEvents.created_at)),
      orders: (
        await options.db
          .select()
          .from(commerceStorefrontOrders)
          .orderBy(desc(commerceStorefrontOrders.created_at))
      ).map(operatorOrder),
    }),
    listOwner: async (ownerKey: string) => ({
      actions: await options.db
        .select()
        .from(commerceStorefrontOrderActions)
        .where(eq(commerceStorefrontOrderActions.owner_key, ownerKey))
        .orderBy(desc(commerceStorefrontOrderActions.created_at)),
      events: await options.db
        .select()
        .from(commerceStorefrontOrderEvents)
        .where(eq(commerceStorefrontOrderEvents.owner_key, ownerKey))
        .orderBy(desc(commerceStorefrontOrderEvents.created_at)),
      orders: (
        await options.db
          .select()
          .from(commerceStorefrontOrders)
          .where(eq(commerceStorefrontOrders.owner_key, ownerKey))
          .orderBy(desc(commerceStorefrontOrders.created_at))
      ).map(operatorOrder),
    }),
    lookup: async (
      ownerKey: string,
      input: { accessToken: string; checkoutIntentId: string },
    ) => {
      const accessTokenHash = storefrontOrderAccessTokenHash(input.accessToken);
      const [intent] = await options.db
        .select()
        .from(commerceCheckoutIntents)
        .where(
          and(
            eq(commerceCheckoutIntents.id, input.checkoutIntentId),
            eq(commerceCheckoutIntents.owner_key, ownerKey),
            eq(commerceCheckoutIntents.access_token_hash, accessTokenHash),
          ),
        )
        .limit(1);
      if (!intent) throw new StorefrontOrderError("order_access_denied");
      const [entry] = await options.db
        .select({
          fulfillment: commerceStorefrontFulfillmentJobs,
          order: commerceStorefrontOrders,
        })
        .from(commerceStorefrontOrders)
        .leftJoin(
          commerceStorefrontFulfillmentJobs,
          eq(
            commerceStorefrontFulfillmentJobs.order_id,
            commerceStorefrontOrders.id,
          ),
        )
        .where(
          and(
            eq(commerceStorefrontOrders.intent_id, intent.id),
            eq(commerceStorefrontOrders.access_token_hash, accessTokenHash),
          ),
        )
        .limit(1);

      return {
        checkoutStatus: intent.status,
        order: entry ? publicOrder(entry.order, entry.fulfillment) : null,
      };
    },
    quarantineAction: async (
      ownerKey: string,
      actionId: string,
      reason: string,
    ) => {
      const [updated] = await options.db
        .update(commerceStorefrontOrderActions)
        .set({
          last_error: reason,
          lease_expires_at: null,
          next_attempt_at: null,
          status: "quarantined",
          updated_at: now(),
          worker_id: null,
        })
        .where(
          and(
            eq(commerceStorefrontOrderActions.id, actionId),
            eq(commerceStorefrontOrderActions.owner_key, ownerKey),
          ),
        )
        .returning();
      if (!updated) throw new StorefrontOrderError("action_not_found");

      return updated;
    },
    requestCancellation: async (input: {
      idempotencyKey: string;
      orderId: string;
      ownerKey: string;
      reason: string;
      requestedBy: string;
    }) => {
      if (!actionsEnabled) throw new StorefrontOrderError("action_disabled");
      const order = await orderFor(input.ownerKey, input.orderId);
      if (["cancelled_refunded", "fulfilled"].includes(order.status))
        throw new StorefrontOrderError("cancellation_not_allowed");
      const [created] = await options.db
        .insert(commerceStorefrontOrderActions)
        .values({
          idempotency_key: input.idempotencyKey,
          order_id: order.id,
          owner_key: input.ownerKey,
          reason: input.reason,
          requested_by: input.requestedBy,
        })
        .onConflictDoNothing()
        .returning();
      const [known] = created
        ? []
        : await options.db
            .select()
            .from(commerceStorefrontOrderActions)
            .where(
              and(
                eq(commerceStorefrontOrderActions.owner_key, input.ownerKey),
                or(
                  eq(
                    commerceStorefrontOrderActions.idempotency_key,
                    input.idempotencyKey,
                  ),
                  and(
                    eq(commerceStorefrontOrderActions.order_id, order.id),
                    eq(commerceStorefrontOrderActions.type, "cancel_refund"),
                  ),
                ),
              ),
            )
            .limit(1);
      const action = created ?? known;
      if (!action) throw new StorefrontOrderError("action_not_found");
      if (created)
        await options.db
          .update(commerceStorefrontOrders)
          .set({ status: "cancellation_requested", updated_at: now() })
          .where(eq(commerceStorefrontOrders.id, order.id));

      return action;
    },
    requestRefund: async (input: {
      caseId: string;
      idempotencyKey: string;
      orderId: string;
      ownerKey: string;
      reason: string;
      requestedBy: string;
    }) => {
      if (!actionsEnabled) throw new StorefrontOrderError("action_disabled");
      const order = await orderFor(input.ownerKey, input.orderId);
      if (["cancelled_refunded", "refunded"].includes(order.status))
        throw new StorefrontOrderError("refund_not_allowed");
      const [caseEntry] = await options.db
        .select({ id: commerceStorefrontCases.id })
        .from(commerceStorefrontCases)
        .where(
          and(
            eq(commerceStorefrontCases.id, input.caseId),
            eq(commerceStorefrontCases.owner_key, input.ownerKey),
            eq(commerceStorefrontCases.order_id, order.id),
            eq(commerceStorefrontCases.kind, "return"),
            eq(commerceStorefrontCases.status, "approved"),
          ),
        )
        .limit(1);
      if (!caseEntry) throw new StorefrontOrderError("refund_not_allowed");
      const [created] = await options.db
        .insert(commerceStorefrontOrderActions)
        .values({
          case_id: input.caseId,
          idempotency_key: input.idempotencyKey,
          order_id: order.id,
          owner_key: input.ownerKey,
          reason: input.reason,
          requested_by: input.requestedBy,
          type: "post_delivery_refund",
        })
        .onConflictDoNothing()
        .returning();
      const [known] = created
        ? []
        : await options.db
            .select()
            .from(commerceStorefrontOrderActions)
            .where(
              and(
                eq(commerceStorefrontOrderActions.owner_key, input.ownerKey),
                or(
                  eq(
                    commerceStorefrontOrderActions.idempotency_key,
                    input.idempotencyKey,
                  ),
                  and(
                    eq(commerceStorefrontOrderActions.order_id, order.id),
                    eq(
                      commerceStorefrontOrderActions.type,
                      "post_delivery_refund",
                    ),
                  ),
                ),
              ),
            )
            .limit(1);
      const action = created ?? known;
      if (!action) throw new StorefrontOrderError("action_not_found");
      if (action.case_id !== input.caseId)
        throw new StorefrontOrderError("refund_not_allowed");

      return action;
    },
    retryAction: async (ownerKey: string, actionId: string) => {
      const [updated] = await options.db
        .update(commerceStorefrontOrderActions)
        .set({
          last_error: null,
          next_attempt_at: now(),
          status: "retry",
          updated_at: now(),
        })
        .where(
          and(
            eq(commerceStorefrontOrderActions.id, actionId),
            eq(commerceStorefrontOrderActions.owner_key, ownerKey),
            inArray(commerceStorefrontOrderActions.status, [
              "failed",
              "quarantined",
            ]),
          ),
        )
        .returning();
      if (!updated) throw new StorefrontOrderError("action_not_retryable");

      return updated;
    },
    runActionCycle: async (workerId: string, limit = DEFAULT_CYCLE_LIMIT) => {
      if (!actionsEnabled) throw new StorefrontOrderError("action_disabled");
      const results: Array<Awaited<ReturnType<typeof runAction>>> = [];
      for (let index = 0; index < limit; index += 1) {
        const action = await claimAction(workerId);
        if (!action) break;
        results.push(await runAction(action));
      }

      return results;
    },
    runNotificationCycle: async (
      workerId: string,
      limit = DEFAULT_CYCLE_LIMIT,
    ) => {
      if (!notificationsEnabled)
        throw new StorefrontOrderError("action_disabled");
      const results: Array<{ eventId: string; status: string }> = [];
      for (let index = 0; index < limit; index += 1) {
        const event = await claimEvent(workerId);
        if (!event) break;
        const order = await orderFor(event.owner_key, event.order_id);
        try {
          await options.notify({
            event,
            idempotencyKey: event.id,
            order,
          });
          await options.db
            .update(commerceStorefrontOrderEvents)
            .set({
              last_error: null,
              lease_expires_at: null,
              notified_at: now(),
              status: "sent",
              updated_at: now(),
              worker_id: null,
            })
            .where(eq(commerceStorefrontOrderEvents.id, event.id));
          results.push({ eventId: event.id, status: "sent" });
        } catch (error) {
          await options.db
            .update(commerceStorefrontOrderEvents)
            .set({
              last_error:
                error instanceof Error
                  ? error.message
                  : "Notification delivery failed",
              lease_expires_at: null,
              next_attempt_at: new Date(now().getTime() + retryMs),
              status: "retry",
              updated_at: now(),
              worker_id: null,
            })
            .where(eq(commerceStorefrontOrderEvents.id, event.id));
          results.push({ eventId: event.id, status: "retry" });
        }
      }

      return results;
    },
  };
};

export type StorefrontOrderService = ReturnType<
  typeof createStorefrontOrderService
>;
