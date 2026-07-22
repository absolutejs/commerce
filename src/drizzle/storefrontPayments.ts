import { createHash } from "node:crypto";
import type {
  PaymentProvider,
  PaymentWebhookEvent,
  WebhookEvent,
} from "../core/payment";
import type {
  PublishedStorefront,
  StorefrontCartLineInput,
} from "../core/storefront";
import {
  createStorefrontCheckout,
  resolveStorefrontCart,
} from "../core/storefront";
import { and, asc, count, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { CommerceDb } from "./queries";
import {
  commerceCheckoutIntents,
  commercePaymentEvents,
  commercePaymentInstallations,
  commercePaymentWebhookReceipts,
  commerceStorefrontFulfillmentJobs,
  commerceStorefrontOrders,
} from "./index";
import {
  emitStorefrontOrderEvent,
  storefrontOrderAccessTokenHash,
} from "./storefrontOrders";
import { recordStorefrontDispute } from "./storefrontAftercare";

export type SavePaymentInstallationInput = {
  config?: Record<string, unknown>;
  id?: string;
  label: string;
  provider: string;
  secretAlias: string;
  webhookSecretAlias: string;
};

export type PaymentInstallation = {
  config: Record<string, unknown>;
  created_at: Date;
  id: string;
  label: string;
  owner_key: string;
  provider: string;
  secret_alias: string;
  status: string;
  updated_at: Date;
  webhook_secret_alias: string;
};

export type PaymentInstallationPosture = PaymentInstallation & {
  platformEnabled: boolean;
  ready: boolean;
  secretAvailable: boolean;
  webhookSecretAvailable: boolean;
};

export type PaymentWebhookReceipt = {
  appliedAt: Date | null;
  attemptCount: number;
  eventType: string;
  id: string;
  installationId: string;
  lastError: string | null;
  ownerKey: string;
  providerEventId: string;
  receivedAt: Date;
  resultStatus: string | null;
  status: string;
  updatedAt: Date;
};

export const storefrontPaymentWebhookReceiptSelection = () => ({
  appliedAt: commercePaymentWebhookReceipts.applied_at,
  attemptCount: commercePaymentWebhookReceipts.attempt_count,
  eventType: commercePaymentWebhookReceipts.event_type,
  id: commercePaymentWebhookReceipts.id,
  installationId: commercePaymentWebhookReceipts.installation_id,
  lastError: commercePaymentWebhookReceipts.last_error,
  ownerKey: commercePaymentWebhookReceipts.owner_key,
  providerEventId: commercePaymentWebhookReceipts.provider_event_id,
  receivedAt: commercePaymentWebhookReceipts.received_at,
  resultStatus: commercePaymentWebhookReceipts.result_status,
  status: commercePaymentWebhookReceipts.status,
  updatedAt: commercePaymentWebhookReceipts.updated_at,
});

export class StorefrontPaymentError extends Error {
  constructor(
    readonly code:
      | "checkout_identity_conflict"
      | "checkout_not_found"
      | "checkout_provider_mismatch"
      | "credential_unavailable"
      | "installation_disabled"
      | "installation_not_found"
      | "payment_amount_mismatch"
      | "payment_event_invalid"
      | "payments_disabled",
  ) {
    super(`Storefront payment failed (${code})`);
    this.name = "StorefrontPaymentError";
  }
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value.map((candidate) => stableJson(candidate)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, candidate]) => `${JSON.stringify(key)}:${stableJson(candidate)}`,
      )
      .join(",")}}`;

  return JSON.stringify(value);
};

export const storefrontCheckoutRequestDigest = (value: unknown) =>
  createHash("sha256").update(stableJson(value)).digest("hex");

export const createStorefrontPaymentService = (options: {
  credentialAvailable: (ownerKey: string, alias: string) => Promise<boolean>;
  db: CommerceDb;
  enabled?: boolean;
  paymentFor: (installation: PaymentInstallation) => Promise<PaymentProvider>;
}) => {
  const enabled = options.enabled ?? false;
  const WEBHOOK_PROCESSING_STALE_MS = 60_000;
  const installation = async (ownerKey: string, installationId?: string) => {
    const [row] = await options.db
      .select()
      .from(commercePaymentInstallations)
      .where(
        and(
          eq(commercePaymentInstallations.owner_key, ownerKey),
          ...(installationId
            ? [eq(commercePaymentInstallations.id, installationId)]
            : []),
        ),
      )
      .limit(1);
    if (!row) throw new StorefrontPaymentError("installation_not_found");

    return row;
  };
  const requireEnabled = async (ownerKey: string, installationId?: string) => {
    if (!enabled) throw new StorefrontPaymentError("payments_disabled");
    const row = await installation(ownerKey, installationId);
    if (row.status !== "enabled")
      throw new StorefrontPaymentError("installation_disabled");

    return row;
  };
  const processVerifiedWebhook = async (
    installed: PaymentInstallation,
    ownerKey: string,
    verified: PaymentWebhookEvent,
  ) => {
    const providerEventId =
      verified.kind === "checkout" ? verified.checkout.id : verified.id;
    const [known] = await options.db
      .select({ id: commercePaymentEvents.id })
      .from(commercePaymentEvents)
      .where(
        and(
          eq(commercePaymentEvents.installation_id, installed.id),
          eq(commercePaymentEvents.provider_event_id, providerEventId),
        ),
      )
      .limit(1);
    if (known && verified.kind === "dispute")
      return { duplicate: true, status: "retained" };
    if (verified.kind === "dispute") {
      const [order] = await options.db
        .select()
        .from(commerceStorefrontOrders)
        .where(
          and(
            eq(commerceStorefrontOrders.owner_key, ownerKey),
            eq(commerceStorefrontOrders.installation_id, installed.id),
            eq(
              commerceStorefrontOrders.provider_payment_id,
              verified.dispute.providerPaymentId,
            ),
          ),
        )
        .limit(1);
      if (!order) throw new StorefrontPaymentError("payment_event_invalid");

      return options.db.transaction(async (transaction) => {
        const [accepted] = await transaction
          .insert(commercePaymentEvents)
          .values({
            event: verified,
            event_type: verified.type,
            installation_id: installed.id,
            intent_id: order.intent_id,
            provider_event_id: verified.id,
          })
          .onConflictDoNothing()
          .returning({ id: commercePaymentEvents.id });
        if (!accepted) return { duplicate: true, status: "retained" };
        const dispute = await recordStorefrontDispute(transaction, {
          dispute: verified.dispute,
          eventId: verified.id,
          orderId: order.id,
          ownerKey: order.owner_key,
        });

        return { duplicate: false, status: dispute.status };
      });
    }
    const event: WebhookEvent = verified.checkout;
    const intentId = event.session.metadata.checkoutIntentId;
    if (!intentId || event.session.metadata.ownerKey !== ownerKey)
      throw new StorefrontPaymentError("payment_event_invalid");
    const [intent] = await options.db
      .select()
      .from(commerceCheckoutIntents)
      .where(
        and(
          eq(commerceCheckoutIntents.id, intentId),
          eq(commerceCheckoutIntents.owner_key, ownerKey),
          eq(commerceCheckoutIntents.installation_id, installed.id),
        ),
      )
      .limit(1);
    if (!intent) throw new StorefrontPaymentError("checkout_not_found");
    if (intent.provider_session_id !== event.session.id)
      throw new StorefrontPaymentError("checkout_provider_mismatch");
    if (
      event.isComplete &&
      (event.session.amountTotalCents !== intent.quote.subtotalCents ||
        event.session.currency?.toUpperCase() !==
          intent.quote.currency.toUpperCase())
    )
      throw new StorefrontPaymentError("payment_amount_mismatch");
    if (known) return { duplicate: true, status: intent.status };
    return options.db.transaction(async (transaction) => {
      const [accepted] = await transaction
        .insert(commercePaymentEvents)
        .values({
          event: verified,
          event_type: event.type,
          installation_id: installed.id,
          intent_id: intent.id,
          provider_event_id: event.id,
        })
        .onConflictDoNothing()
        .returning({ id: commercePaymentEvents.id });
      if (!accepted) return { duplicate: true, status: intent.status };
      const status = event.isComplete
        ? "paid"
        : event.isFailed
          ? "failed"
          : intent.status;
      await transaction
        .update(commerceCheckoutIntents)
        .set({ status, updated_at: new Date() })
        .where(eq(commerceCheckoutIntents.id, intent.id));
      if (!event.isComplete) return { duplicate: false, status };
      const [order] = await transaction
        .insert(commerceStorefrontOrders)
        .values({
          access_token_hash: intent.access_token_hash,
          amount_cents: intent.quote.subtotalCents,
          catalog_id: intent.catalog_id,
          currency: intent.quote.currency,
          customer_email: event.session.customerEmail,
          customer_name: event.session.customerName,
          intent_id: intent.id,
          installation_id: installed.id,
          lines: intent.quote.lines,
          owner_key: intent.owner_key,
          provider_session_id: event.session.id,
          provider_payment_id: event.session.paymentReferenceId ?? null,
          shipping: event.session.shippingAddress,
          status: "paid",
        })
        .onConflictDoNothing()
        .returning();
      if (order)
        await transaction
          .insert(commerceStorefrontFulfillmentJobs)
          .values({
            order_id: order.id,
            payload: {
              cart: intent.cart,
              customerEmail: event.session.customerEmail,
              quote: intent.quote,
              shipping: event.session.shippingAddress,
            },
          })
          .onConflictDoNothing();
      if (order)
        await emitStorefrontOrderEvent(transaction, {
          kind: "payment_confirmed",
          orderId: order.id,
          ownerKey: order.owner_key,
        });

      return { duplicate: false, status };
    });
  };
  const applyReceipt = async (ownerKey: string, receiptId: string) => {
    const [receipt] = await options.db
      .select()
      .from(commercePaymentWebhookReceipts)
      .where(
        and(
          eq(commercePaymentWebhookReceipts.id, receiptId),
          eq(commercePaymentWebhookReceipts.owner_key, ownerKey),
        ),
      )
      .limit(1);
    if (!receipt) throw new StorefrontPaymentError("payment_event_invalid");
    const installed = await requireEnabled(ownerKey, receipt.installation_id);
    const staleBefore = new Date(Date.now() - WEBHOOK_PROCESSING_STALE_MS);
    const [claimed] = await options.db
      .update(commercePaymentWebhookReceipts)
      .set({
        attempt_count: sql`${commercePaymentWebhookReceipts.attempt_count} + 1`,
        last_error: null,
        status: "processing",
        updated_at: new Date(),
      })
      .where(
        and(
          eq(commercePaymentWebhookReceipts.id, receiptId),
          eq(commercePaymentWebhookReceipts.owner_key, ownerKey),
          eq(commercePaymentWebhookReceipts.installation_id, installed.id),
          or(
            inArray(commercePaymentWebhookReceipts.status, [
              "failed",
              "quarantined",
              "received",
              "retry",
            ]),
            and(
              eq(commercePaymentWebhookReceipts.status, "processing"),
              lte(commercePaymentWebhookReceipts.updated_at, staleBefore),
            ),
          ),
        ),
      )
      .returning();
    if (!claimed) {
      const [current] = await options.db
        .select()
        .from(commercePaymentWebhookReceipts)
        .where(
          and(
            eq(commercePaymentWebhookReceipts.id, receiptId),
            eq(commercePaymentWebhookReceipts.owner_key, ownerKey),
          ),
        )
        .limit(1);
      if (!current) throw new StorefrontPaymentError("payment_event_invalid");

      return {
        duplicate: true,
        status: current.result_status ?? current.status,
      };
    }
    try {
      const result = await processVerifiedWebhook(
        installed,
        ownerKey,
        claimed.event,
      );
      await options.db
        .update(commercePaymentWebhookReceipts)
        .set({
          applied_at: new Date(),
          last_error: null,
          result_status: result.status,
          status: "applied",
          updated_at: new Date(),
        })
        .where(eq(commercePaymentWebhookReceipts.id, claimed.id));

      return result;
    } catch (error) {
      await options.db
        .update(commercePaymentWebhookReceipts)
        .set({
          last_error:
            error instanceof Error ? error.message : "Webhook apply failed",
          status:
            error instanceof StorefrontPaymentError ? "quarantined" : "failed",
          updated_at: new Date(),
        })
        .where(eq(commercePaymentWebhookReceipts.id, claimed.id));
      throw error;
    }
  };

  return {
    checkout: async (input: {
      cancelUrl: string;
      idempotencyKey: string;
      installationId: string;
      lines: StorefrontCartLineInput[];
      orderAccessToken: string;
      ownerKey: string;
      storefront: PublishedStorefront;
      successUrl: string;
    }) => {
      const installed = await requireEnabled(
        input.ownerKey,
        input.installationId,
      );
      const requestDigest = storefrontCheckoutRequestDigest({
        catalogId: input.storefront.catalog.id,
        lines: input.lines,
      });
      const accessTokenHash = storefrontOrderAccessTokenHash(
        input.orderAccessToken,
      );
      const [existing] = await options.db
        .select()
        .from(commerceCheckoutIntents)
        .where(
          and(
            eq(commerceCheckoutIntents.owner_key, input.ownerKey),
            eq(commerceCheckoutIntents.idempotency_key, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.request_digest !== requestDigest)
          throw new StorefrontPaymentError("checkout_identity_conflict");
        if (existing.access_token_hash !== accessTokenHash)
          throw new StorefrontPaymentError("checkout_identity_conflict");
        if (existing.checkout_result)
          return {
            checkout: existing.checkout_result,
            checkoutIntentId: existing.id,
            quote: existing.quote,
          };
      }
      const quote =
        existing?.quote ?? resolveStorefrontCart(input.storefront, input.lines);
      const [created] = existing
        ? []
        : await options.db
            .insert(commerceCheckoutIntents)
            .values({
              access_token_hash: accessTokenHash,
              cart: input.lines,
              catalog_id: quote.catalogId,
              idempotency_key: input.idempotencyKey,
              installation_id: installed.id,
              owner_key: input.ownerKey,
              quote,
              request_digest: requestDigest,
            })
            .onConflictDoNothing()
            .returning();
      const [raced] =
        existing || created
          ? []
          : await options.db
              .select()
              .from(commerceCheckoutIntents)
              .where(
                and(
                  eq(commerceCheckoutIntents.owner_key, input.ownerKey),
                  eq(
                    commerceCheckoutIntents.idempotency_key,
                    input.idempotencyKey,
                  ),
                ),
              )
              .limit(1);
      const intent = existing ?? created ?? raced;
      if (!intent) throw new StorefrontPaymentError("checkout_not_found");
      if (intent.request_digest !== requestDigest)
        throw new StorefrontPaymentError("checkout_identity_conflict");
      if (intent.access_token_hash !== accessTokenHash)
        throw new StorefrontPaymentError("checkout_identity_conflict");
      if (intent.checkout_result)
        return {
          checkout: intent.checkout_result,
          checkoutIntentId: intent.id,
          quote: intent.quote,
        };
      try {
        const result = await createStorefrontCheckout({
          cancelUrl: input.cancelUrl,
          idempotencyKey: intent.id,
          input: input.lines,
          metadata: {
            checkoutIntentId: intent.id,
            ownerKey: input.ownerKey,
          },
          payment: await options.paymentFor(installed),
          storefront: input.storefront,
          successUrl: input.successUrl,
        });
        await options.db
          .update(commerceCheckoutIntents)
          .set({
            checkout_result: result.checkout,
            last_error: null,
            provider_session_id: result.checkout.id,
            status: "open",
            updated_at: new Date(),
          })
          .where(eq(commerceCheckoutIntents.id, intent.id));

        return { ...result, checkoutIntentId: intent.id };
      } catch (error) {
        await options.db
          .update(commerceCheckoutIntents)
          .set({
            last_error:
              error instanceof Error ? error.message : "Checkout failed",
            updated_at: new Date(),
          })
          .where(eq(commerceCheckoutIntents.id, intent.id));
        throw error;
      }
    },
    installationEnabled: async (ownerKey: string, installationId?: string) => {
      if (!enabled) return false;
      try {
        await requireEnabled(ownerKey, installationId);

        return true;
      } catch {
        return false;
      }
    },
    listFleet: async (): Promise<PaymentInstallation[]> =>
      await options.db
        .select()
        .from(commercePaymentInstallations)
        .orderBy(
          commercePaymentInstallations.owner_key,
          commercePaymentInstallations.label,
        ),
    listOwner: async (ownerKey: string): Promise<PaymentInstallation[]> =>
      await options.db
        .select()
        .from(commercePaymentInstallations)
        .where(eq(commercePaymentInstallations.owner_key, ownerKey)),
    processWebhook: async (input: {
      installationId: string;
      ownerKey: string;
      payload: string;
      signature: string;
    }) => {
      const installed = await requireEnabled(
        input.ownerKey,
        input.installationId,
      );
      const payment = await options.paymentFor(installed);
      const verified: PaymentWebhookEvent = payment.verifyEvent
        ? await payment.verifyEvent(input.payload, input.signature)
        : {
            checkout: await payment.verifyWebhook(
              input.payload,
              input.signature,
            ),
            kind: "checkout",
          };
      const providerEventId =
        verified.kind === "checkout" ? verified.checkout.id : verified.id;
      const [receipt] = await options.db
        .insert(commercePaymentWebhookReceipts)
        .values({
          event: verified,
          event_type:
            verified.kind === "checkout"
              ? verified.checkout.type
              : verified.type,
          installation_id: installed.id,
          owner_key: input.ownerKey,
          provider_event_id: providerEventId,
        })
        .onConflictDoNothing()
        .returning({ id: commercePaymentWebhookReceipts.id });
      const [retained] = receipt
        ? [{ id: receipt.id }]
        : await options.db
            .select({ id: commercePaymentWebhookReceipts.id })
            .from(commercePaymentWebhookReceipts)
            .where(
              and(
                eq(
                  commercePaymentWebhookReceipts.installation_id,
                  installed.id,
                ),
                eq(
                  commercePaymentWebhookReceipts.provider_event_id,
                  providerEventId,
                ),
              ),
            )
            .limit(1);
      if (!retained) throw new StorefrontPaymentError("payment_event_invalid");

      return applyReceipt(input.ownerKey, retained.id);
    },
    listWebhookReceipts: async (
      ownerKey?: string,
      limit = 100,
    ): Promise<PaymentWebhookReceipt[]> => {
      const rows = await options.db
        .select(storefrontPaymentWebhookReceiptSelection())
        .from(commercePaymentWebhookReceipts)
        .where(
          ownerKey
            ? eq(commercePaymentWebhookReceipts.owner_key, ownerKey)
            : undefined,
        )
        .orderBy(
          asc(commercePaymentWebhookReceipts.status),
          asc(commercePaymentWebhookReceipts.received_at),
        )
        .limit(Math.max(1, Math.min(limit, 200)));

      return rows;
    },
    paymentWebhookReceiptTotals: async (ownerKey?: string) => {
      const rows = await options.db
        .select({
          count: count(),
          status: commercePaymentWebhookReceipts.status,
        })
        .from(commercePaymentWebhookReceipts)
        .where(
          ownerKey
            ? eq(commercePaymentWebhookReceipts.owner_key, ownerKey)
            : undefined,
        )
        .groupBy(commercePaymentWebhookReceipts.status);

      return rows.reduce<Record<string, number> & { total: number }>(
        (totals, row) => ({
          ...totals,
          [row.status]: row.count,
          total: totals.total + row.count,
        }),
        { total: 0 },
      );
    },
    paymentInstallationPosture: async (
      ownerKey?: string,
    ): Promise<PaymentInstallationPosture[]> => {
      const rows = ownerKey
        ? await options.db
            .select()
            .from(commercePaymentInstallations)
            .where(eq(commercePaymentInstallations.owner_key, ownerKey))
        : await options.db.select().from(commercePaymentInstallations);

      return Promise.all(
        rows.map(async (candidate) => {
          const [secretAvailable, webhookSecretAvailable] = await Promise.all([
            options.credentialAvailable(
              candidate.owner_key,
              candidate.secret_alias,
            ),
            options.credentialAvailable(
              candidate.owner_key,
              candidate.webhook_secret_alias,
            ),
          ]);
          const platformEnabled = enabled;

          return {
            ...candidate,
            platformEnabled,
            ready:
              platformEnabled &&
              candidate.status === "enabled" &&
              secretAvailable &&
              webhookSecretAvailable,
            secretAvailable,
            webhookSecretAvailable,
          };
        }),
      );
    },
    retryWebhookReceipt: applyReceipt,
    saveInstallation: async (
      ownerKey: string,
      input: SavePaymentInstallationInput,
    ) => {
      const values = {
        config: input.config ?? {},
        label: input.label,
        owner_key: ownerKey,
        provider: input.provider,
        secret_alias: input.secretAlias,
        status: "disabled",
        updated_at: new Date(),
        webhook_secret_alias: input.webhookSecretAlias,
      };
      if (!input.id) {
        const [created] = await options.db
          .insert(commercePaymentInstallations)
          .values(values)
          .returning();

        return created;
      }
      const [updated] = await options.db
        .update(commercePaymentInstallations)
        .set(values)
        .where(
          and(
            eq(commercePaymentInstallations.id, input.id),
            eq(commercePaymentInstallations.owner_key, ownerKey),
          ),
        )
        .returning();
      if (!updated) throw new StorefrontPaymentError("installation_not_found");

      return updated;
    },
    setInstallationEnabled: async (
      ownerKey: string,
      installationId: string,
      active: boolean,
    ) => {
      if (active && !enabled)
        throw new StorefrontPaymentError("payments_disabled");
      const current = await installation(ownerKey, installationId);
      if (active) {
        const ready = await Promise.all([
          options.credentialAvailable(ownerKey, current.secret_alias),
          options.credentialAvailable(ownerKey, current.webhook_secret_alias),
        ]);
        if (ready.some((candidate) => !candidate))
          throw new StorefrontPaymentError("credential_unavailable");
      }
      const [updated] = await options.db
        .update(commercePaymentInstallations)
        .set({
          status: active ? "enabled" : "disabled",
          updated_at: new Date(),
        })
        .where(eq(commercePaymentInstallations.id, current.id))
        .returning();

      return updated;
    },
  };
};

export type StorefrontPaymentService = ReturnType<
  typeof createStorefrontPaymentService
>;
