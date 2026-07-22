import { createHash } from "node:crypto";
import type {
  PaymentProvider,
  PaymentWebhookEndpoint,
  PaymentWebhookEndpointManager,
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
import { and, asc, count, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { CommerceDb } from "./queries";
import {
  commerceCheckoutIntents,
  commercePaymentEvents,
  commercePaymentInstallations,
  commercePaymentWebhookConnections,
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

export type SavePaymentWebhookConnectionInput = {
  enabledEvents: string[];
  installationId: string;
  maxApplyLatencyMs?: number;
  maxFailureRateBps?: number;
  url: string;
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
      | "payments_disabled"
      | "webhook_connection_not_found"
      | "webhook_connection_invalid"
      | "webhook_canary_failed"
      | "webhook_inspection_disabled"
      | "webhook_management_disabled"
      | "webhook_management_unavailable",
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
  storeWebhookSigningSecret?: (
    ownerKey: string,
    alias: string,
    value: string,
  ) => Promise<void>;
  verifyWebhookSigningSecret?: (
    installation: PaymentInstallation,
  ) => Promise<boolean>;
  webhookEndpointFor?: (
    installation: PaymentInstallation,
  ) => Promise<PaymentWebhookEndpointManager>;
  webhookInspectionEnabled?: boolean;
  webhookManagementEnabled?: boolean;
}) => {
  const enabled = options.enabled ?? false;
  const webhookInspectionEnabled = options.webhookInspectionEnabled ?? false;
  const webhookManagementEnabled = options.webhookManagementEnabled ?? false;
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
      await options.db
        .update(commercePaymentWebhookConnections)
        .set({ last_delivery_at: new Date(), updated_at: new Date() })
        .where(
          and(
            eq(
              commercePaymentWebhookConnections.installation_id,
              claimed.installation_id,
            ),
            eq(commercePaymentWebhookConnections.owner_key, ownerKey),
          ),
        );

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
  const webhookConnection = async (
    ownerKey: string,
    installationId: string,
  ) => {
    const [connection] = await options.db
      .select()
      .from(commercePaymentWebhookConnections)
      .where(
        and(
          eq(commercePaymentWebhookConnections.owner_key, ownerKey),
          eq(commercePaymentWebhookConnections.installation_id, installationId),
        ),
      )
      .limit(1);
    if (!connection)
      throw new StorefrontPaymentError("webhook_connection_not_found");

    return connection;
  };
  const endpointManager = async (installed: PaymentInstallation) => {
    if (!options.webhookEndpointFor)
      throw new StorefrontPaymentError("webhook_management_unavailable");

    return options.webhookEndpointFor(installed);
  };
  const normalizedEvents = (events: string[]) =>
    [...new Set(events.map((event) => event.trim()).filter(Boolean))].sort();
  const validatedConnectionInput = (
    input: SavePaymentWebhookConnectionInput,
  ) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new StorefrontPaymentError("webhook_connection_invalid");
    }
    const events = normalizedEvents(input.enabledEvents);
    const maxApplyLatencyMs = input.maxApplyLatencyMs ?? 5_000;
    const maxFailureRateBps = input.maxFailureRateBps ?? 100;
    if (
      url.protocol !== "https:" ||
      events.length === 0 ||
      maxApplyLatencyMs < 1 ||
      maxFailureRateBps < 0 ||
      maxFailureRateBps > 10_000
    )
      throw new StorefrontPaymentError("webhook_connection_invalid");

    return {
      events,
      maxApplyLatencyMs,
      maxFailureRateBps,
      url: url.toString(),
    };
  };
  const endpointDrift = (
    connection: typeof commercePaymentWebhookConnections.$inferSelect,
    observed: PaymentWebhookEndpoint,
  ) => {
    const drift: string[] = [];
    if (observed.url !== connection.desired_url) drift.push("url");
    if (observed.status !== "enabled") drift.push("status");
    if (
      JSON.stringify(normalizedEvents(observed.enabledEvents)) !==
      JSON.stringify(normalizedEvents(connection.desired_events))
    )
      drift.push("enabled_events");

    return drift;
  };
  const retainEndpointObservation = async (
    connection: typeof commercePaymentWebhookConnections.$inferSelect,
    observed: PaymentWebhookEndpoint,
  ) => {
    const drift = endpointDrift(connection, observed);
    const [updated] = await options.db
      .update(commercePaymentWebhookConnections)
      .set({
        last_error:
          drift.length > 0 ? `Provider drift: ${drift.join(", ")}` : null,
        last_inspected_at: new Date(),
        livemode: observed.livemode,
        observed_events: normalizedEvents(observed.enabledEvents),
        observed_url: observed.url,
        provider_status: observed.status,
        status: drift.length > 0 ? "drift" : "healthy",
        updated_at: new Date(),
      })
      .where(
        and(
          eq(
            commercePaymentWebhookConnections.installation_id,
            connection.installation_id,
          ),
          eq(commercePaymentWebhookConnections.owner_key, connection.owner_key),
        ),
      )
      .returning();

    return { connection: updated ?? connection, drift };
  };
  const runSigningSecretCanary = async (installed: PaymentInstallation) => {
    if (!options.verifyWebhookSigningSecret)
      throw new StorefrontPaymentError("webhook_management_unavailable");
    const passed = await options.verifyWebhookSigningSecret(installed);
    await options.db
      .update(commercePaymentWebhookConnections)
      .set({
        canary_status: passed ? "passed" : "failed",
        last_canary_at: new Date(),
        last_error: passed ? null : "Signing-secret canary failed",
        status: passed ? "staged" : "failed",
        updated_at: new Date(),
      })
      .where(
        and(
          eq(commercePaymentWebhookConnections.installation_id, installed.id),
          eq(commercePaymentWebhookConnections.owner_key, installed.owner_key),
        ),
      );
    if (!passed) throw new StorefrontPaymentError("webhook_canary_failed");

    return true;
  };
  const deactivateCreatedEndpoint = async (
    manager: PaymentWebhookEndpointManager,
    endpointId: string,
  ) => {
    try {
      await manager.delete(endpointId);

      return null;
    } catch (deleteError) {
      try {
        await manager.update(endpointId, { disabled: true });

        return null;
      } catch (disableError) {
        const deleteMessage =
          deleteError instanceof Error ? deleteError.message : "delete failed";
        const disableMessage =
          disableError instanceof Error
            ? disableError.message
            : "disable failed";

        return `Provider cleanup required (${deleteMessage}; ${disableMessage})`;
      }
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
    inspectWebhookConnection: async (
      ownerKey: string,
      installationId: string,
    ) => {
      if (!webhookInspectionEnabled)
        throw new StorefrontPaymentError("webhook_inspection_disabled");
      const installed = await installation(ownerKey, installationId);
      const connection = await webhookConnection(ownerKey, installationId);
      if (!connection.provider_endpoint_id)
        throw new StorefrontPaymentError("webhook_connection_not_found");
      const manager = await endpointManager(installed);
      const observed = await manager.retrieve(connection.provider_endpoint_id);

      return retainEndpointObservation(connection, observed);
    },
    listWebhookConnections: async (ownerKey?: string) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
      const [connections, receiptRows] = await Promise.all([
        options.db
          .select()
          .from(commercePaymentWebhookConnections)
          .where(
            ownerKey
              ? eq(commercePaymentWebhookConnections.owner_key, ownerKey)
              : undefined,
          )
          .orderBy(
            commercePaymentWebhookConnections.owner_key,
            commercePaymentWebhookConnections.installation_id,
          ),
        options.db
          .select({
            applied: sql<number>`count(*) filter (where ${commercePaymentWebhookReceipts.status} = 'applied')::int`,
            failed: sql<number>`count(*) filter (where ${commercePaymentWebhookReceipts.status} in ('failed', 'quarantined'))::int`,
            installationId: commercePaymentWebhookReceipts.installation_id,
            p95ApplyLatencyMs: sql<
              number | null
            >`percentile_cont(0.95) within group (order by extract(epoch from (${commercePaymentWebhookReceipts.applied_at} - ${commercePaymentWebhookReceipts.received_at})) * 1000) filter (where ${commercePaymentWebhookReceipts.applied_at} is not null)`,
            total: sql<number>`count(*)::int`,
          })
          .from(commercePaymentWebhookReceipts)
          .where(
            and(
              gte(commercePaymentWebhookReceipts.received_at, since),
              ...(ownerKey
                ? [eq(commercePaymentWebhookReceipts.owner_key, ownerKey)]
                : []),
            ),
          )
          .groupBy(commercePaymentWebhookReceipts.installation_id),
      ]);
      const receiptsByInstallation = new Map(
        receiptRows.map((row) => [row.installationId, row]),
      );

      return connections.map((connection) => {
        const receipts = receiptsByInstallation.get(connection.installation_id);
        const total = receipts?.total ?? 0;
        const failed = receipts?.failed ?? 0;
        const failureRateBps =
          total === 0 ? 0 : Math.round((failed / total) * 10_000);
        const p95ApplyLatencyMs = receipts?.p95ApplyLatencyMs ?? null;
        const violations = [
          ...(failureRateBps > connection.max_failure_rate_bps
            ? ["failure_rate"]
            : []),
          ...(p95ApplyLatencyMs !== null &&
          p95ApplyLatencyMs > connection.max_apply_latency_ms
            ? ["apply_latency"]
            : []),
        ];

        return {
          ...connection,
          deliverySlo24h: {
            applied: receipts?.applied ?? 0,
            failed,
            failureRateBps,
            p95ApplyLatencyMs,
            total,
            violations,
          },
        };
      });
    },
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
    registerWebhookConnection: async (
      ownerKey: string,
      installationId: string,
    ) => {
      if (!webhookManagementEnabled)
        throw new StorefrontPaymentError("webhook_management_disabled");
      if (!options.storeWebhookSigningSecret)
        throw new StorefrontPaymentError("webhook_management_unavailable");
      const installed = await installation(ownerKey, installationId);
      const connection = await webhookConnection(ownerKey, installationId);
      const manager = await endpointManager(installed);
      const previousEndpointId = connection.provider_endpoint_id;
      let createdEndpointId: string | undefined;
      try {
        const created = await manager.create({
          disabled: true,
          enabledEvents: normalizedEvents(connection.desired_events),
          url: connection.desired_url,
        });
        createdEndpointId = created.id;
        await options.db
          .update(commercePaymentWebhookConnections)
          .set({
            last_error: null,
            livemode: created.livemode,
            observed_events: normalizedEvents(created.enabledEvents),
            observed_url: created.url,
            provider_endpoint_id: created.id,
            provider_status: created.status,
            status: "staged",
            updated_at: new Date(),
          })
          .where(
            and(
              eq(
                commercePaymentWebhookConnections.installation_id,
                installationId,
              ),
              eq(commercePaymentWebhookConnections.owner_key, ownerKey),
            ),
          );
        await options.storeWebhookSigningSecret(
          ownerKey,
          installed.webhook_secret_alias,
          created.signingSecret,
        );
        await runSigningSecretCanary(installed);
        const enabledEndpoint = await manager.update(created.id, {
          disabled: false,
          enabledEvents: normalizedEvents(connection.desired_events),
          url: connection.desired_url,
        });
        const retained = await retainEndpointObservation(
          { ...connection, provider_endpoint_id: created.id },
          enabledEndpoint,
        );
        if (previousEndpointId && previousEndpointId !== created.id)
          await manager.update(previousEndpointId, { disabled: true });

        return retained;
      } catch (error) {
        const cleanupError = createdEndpointId
          ? await deactivateCreatedEndpoint(manager, createdEndpointId)
          : null;
        const registrationError =
          error instanceof Error ? error.message : "Registration failed";
        await options.db
          .update(commercePaymentWebhookConnections)
          .set({
            last_error: cleanupError
              ? `${registrationError}. ${cleanupError}`
              : registrationError,
            status: "failed",
            updated_at: new Date(),
          })
          .where(
            and(
              eq(
                commercePaymentWebhookConnections.installation_id,
                installationId,
              ),
              eq(commercePaymentWebhookConnections.owner_key, ownerKey),
            ),
          );
        throw error;
      }
    },
    runWebhookSigningSecretCanary: async (
      ownerKey: string,
      installationId: string,
    ) => {
      if (!webhookManagementEnabled)
        throw new StorefrontPaymentError("webhook_management_disabled");
      const installed = await installation(ownerKey, installationId);
      await webhookConnection(ownerKey, installationId);
      await runSigningSecretCanary(installed);

      return webhookConnection(ownerKey, installationId);
    },
    saveWebhookConnection: async (
      ownerKey: string,
      input: SavePaymentWebhookConnectionInput,
    ) => {
      await installation(ownerKey, input.installationId);
      const validated = validatedConnectionInput(input);
      const [saved] = await options.db
        .insert(commercePaymentWebhookConnections)
        .values({
          desired_events: validated.events,
          desired_url: validated.url,
          installation_id: input.installationId,
          max_apply_latency_ms: validated.maxApplyLatencyMs,
          max_failure_rate_bps: validated.maxFailureRateBps,
          owner_key: ownerKey,
        })
        .onConflictDoUpdate({
          set: {
            desired_events: validated.events,
            desired_url: validated.url,
            max_apply_latency_ms: validated.maxApplyLatencyMs,
            max_failure_rate_bps: validated.maxFailureRateBps,
            status: "draft",
            updated_at: new Date(),
          },
          target: commercePaymentWebhookConnections.installation_id,
        })
        .returning();

      return saved;
    },
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
