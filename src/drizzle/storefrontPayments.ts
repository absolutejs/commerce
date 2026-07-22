import { createHash } from "node:crypto";
import type { PaymentProvider, WebhookEvent } from "../core/payment";
import type {
  PublishedStorefront,
  StorefrontCartLineInput,
} from "../core/storefront";
import {
  createStorefrontCheckout,
  resolveStorefrontCart,
} from "../core/storefront";
import { and, eq } from "drizzle-orm";
import type { CommerceDb } from "./queries";
import {
  commerceCheckoutIntents,
  commercePaymentEvents,
  commercePaymentInstallations,
  commerceStorefrontFulfillmentJobs,
  commerceStorefrontOrders,
} from "./index";
import {
  emitStorefrontOrderEvent,
  storefrontOrderAccessTokenHash,
} from "./storefrontOrders";

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
      const event: WebhookEvent = await (
        await options.paymentFor(installed)
      ).verifyWebhook(input.payload, input.signature);
      const intentId = event.session.metadata.checkoutIntentId;
      if (!intentId || event.session.metadata.ownerKey !== input.ownerKey)
        throw new StorefrontPaymentError("payment_event_invalid");
      const [intent] = await options.db
        .select()
        .from(commerceCheckoutIntents)
        .where(
          and(
            eq(commerceCheckoutIntents.id, intentId),
            eq(commerceCheckoutIntents.owner_key, input.ownerKey),
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
      const [known] = await options.db
        .select({ id: commercePaymentEvents.id })
        .from(commercePaymentEvents)
        .where(
          and(
            eq(commercePaymentEvents.installation_id, installed.id),
            eq(commercePaymentEvents.provider_event_id, event.id),
          ),
        )
        .limit(1);
      if (known) return { duplicate: true, status: intent.status };

      return options.db.transaction(async (transaction) => {
        const [accepted] = await transaction
          .insert(commercePaymentEvents)
          .values({
            event,
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
