import type {
  FulfillmentOrder,
  FulfillmentOrderRequest,
  FulfillmentProvider,
} from "../core/fulfillment";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { CommerceDb } from "./queries";
import {
  commerceFulfillmentAccounts,
  commerceStorefrontFulfillmentJobs,
  commerceStorefrontOrders,
} from "./index";
import { emitStorefrontOrderEvent } from "./storefrontOrders";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RECONCILE_MS = 60_000;
const DEFAULT_CYCLE_LIMIT = 10;

export type StorefrontFulfillmentInstallation = {
  config: Record<string, unknown>;
  created_at: Date;
  id: string;
  label: string;
  owner_key: string | null;
  provider: string;
  secret_alias: string | null;
  status: string;
  updated_at: Date;
};

export type StorefrontFulfillmentJob = {
  attempts: number;
  completed_at: Date | null;
  created_at: Date;
  id: string;
  installation_id: string | null;
  last_attempt_at: Date | null;
  last_error: string | null;
  lease_expires_at: Date | null;
  next_attempt_at: Date | null;
  order_id: string;
  payload: Record<string, unknown>;
  provider_order_id: string | null;
  request: FulfillmentOrderRequest | null;
  result: FulfillmentOrder | null;
  status: string;
  updated_at: Date;
  worker_id: string | null;
};

export type StorefrontFulfillmentFleetJob = {
  job: StorefrontFulfillmentJob;
  ownerKey: string;
};

export type StorefrontFulfillmentOrder = {
  amount_cents: number;
  catalog_id: string;
  created_at: Date;
  currency: string;
  customer_email: string | null;
  customer_name: string | null;
  id: string;
  installation_id: string;
  intent_id: string;
  lines: Array<Record<string, unknown>>;
  owner_key: string;
  provider_session_id: string;
  shipping: Record<string, unknown> | null;
  status: string;
  updated_at: Date;
};

export class StorefrontFulfillmentError extends Error {
  constructor(
    readonly code:
      | "credential_unavailable"
      | "fulfillment_disabled"
      | "installation_disabled"
      | "installation_not_found"
      | "job_not_found"
      | "job_not_retryable"
      | "order_invalid",
  ) {
    super(`Storefront fulfillment failed (${code})`);
    this.name = "StorefrontFulfillmentError";
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown fulfillment failure";

export const createStorefrontFulfillmentService = (options: {
  credentialAvailable: (ownerKey: string, alias: string) => Promise<boolean>;
  db: CommerceDb;
  enabled?: boolean;
  leaseMs?: number;
  now?: () => Date;
  prepare: (input: {
    installation: StorefrontFulfillmentInstallation;
    job: StorefrontFulfillmentJob;
    order: StorefrontFulfillmentOrder;
  }) => Promise<FulfillmentOrderRequest>;
  providerFor: (
    installation: StorefrontFulfillmentInstallation,
  ) => Promise<FulfillmentProvider>;
  reconcileMs?: number;
}) => {
  const enabled = options.enabled ?? false;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? (() => new Date());
  const reconcileMs = options.reconcileMs ?? DEFAULT_RECONCILE_MS;
  const installation = async (ownerKey: string, installationId?: string) => {
    const [row] = await options.db
      .select()
      .from(commerceFulfillmentAccounts)
      .where(
        and(
          eq(commerceFulfillmentAccounts.owner_key, ownerKey),
          ...(installationId
            ? [eq(commerceFulfillmentAccounts.id, installationId)]
            : []),
        ),
      )
      .limit(1);
    if (!row) throw new StorefrontFulfillmentError("installation_not_found");

    return row satisfies StorefrontFulfillmentInstallation;
  };
  const enabledInstallation = async (
    ownerKey: string,
    installationId?: string,
  ) => {
    if (!enabled) throw new StorefrontFulfillmentError("fulfillment_disabled");
    const row = await installation(ownerKey, installationId);
    if (row.status !== "enabled")
      throw new StorefrontFulfillmentError("installation_disabled");

    return row;
  };
  const release = (jobId: string, values: Record<string, unknown>) =>
    options.db
      .update(commerceStorefrontFulfillmentJobs)
      .set({
        ...values,
        lease_expires_at: null,
        updated_at: now(),
        worker_id: null,
      })
      .where(eq(commerceStorefrontFulfillmentJobs.id, jobId));
  const claim = async (workerId: string) => {
    const timestamp = now();
    await options.db
      .update(commerceStorefrontFulfillmentJobs)
      .set({
        last_error: "Worker lease expired during an ambiguous operation",
        lease_expires_at: null,
        status: "quarantined",
        updated_at: timestamp,
        worker_id: null,
      })
      .where(
        and(
          eq(commerceStorefrontFulfillmentJobs.status, "processing"),
          lte(commerceStorefrontFulfillmentJobs.lease_expires_at, timestamp),
        ),
      );
    const candidates = await options.db
      .select()
      .from(commerceStorefrontFulfillmentJobs)
      .where(
        and(
          inArray(commerceStorefrontFulfillmentJobs.status, [
            "pending",
            "retry",
            "submitted",
          ]),
          or(
            isNull(commerceStorefrontFulfillmentJobs.next_attempt_at),
            lte(commerceStorefrontFulfillmentJobs.next_attempt_at, timestamp),
          ),
          or(
            isNull(commerceStorefrontFulfillmentJobs.lease_expires_at),
            lte(commerceStorefrontFulfillmentJobs.lease_expires_at, timestamp),
          ),
        ),
      )
      .orderBy(asc(commerceStorefrontFulfillmentJobs.created_at))
      .limit(DEFAULT_CYCLE_LIMIT);
    for (const candidate of candidates) {
      const [claimed] = await options.db
        .update(commerceStorefrontFulfillmentJobs)
        .set({
          attempts: candidate.attempts + 1,
          last_attempt_at: timestamp,
          lease_expires_at: new Date(timestamp.getTime() + leaseMs),
          status: "processing",
          updated_at: timestamp,
          worker_id: workerId,
        })
        .where(
          and(
            eq(commerceStorefrontFulfillmentJobs.id, candidate.id),
            eq(commerceStorefrontFulfillmentJobs.status, candidate.status),
          ),
        )
        .returning();
      if (claimed) return { job: claimed, previousStatus: candidate.status };
    }

    return null;
  };
  const orderFor = async (orderId: string) => {
    const [row] = await options.db
      .select()
      .from(commerceStorefrontOrders)
      .where(eq(commerceStorefrontOrders.id, orderId))
      .limit(1);
    if (!row) throw new StorefrontFulfillmentError("order_invalid");

    return row as StorefrontFulfillmentOrder;
  };
  const retainResult = async (
    job: StorefrontFulfillmentJob,
    result: FulfillmentOrder,
    ownerKey: string,
  ) => {
    const terminal = ["cancelled", "failed", "shipped"].includes(result.status);
    const status =
      result.status === "cancelled"
        ? "cancelled"
        : result.status === "failed"
          ? "failed"
          : result.status === "shipped"
            ? "complete"
            : "submitted";
    await options.db.transaction(async (transaction) => {
      await transaction
        .update(commerceStorefrontFulfillmentJobs)
        .set({
          completed_at: terminal ? now() : null,
          last_error: null,
          lease_expires_at: null,
          next_attempt_at: terminal
            ? null
            : new Date(now().getTime() + reconcileMs),
          provider_order_id: result.providerOrderId,
          result,
          status,
          updated_at: now(),
          worker_id: null,
        })
        .where(eq(commerceStorefrontFulfillmentJobs.id, job.id));
      await transaction
        .update(commerceStorefrontOrders)
        .set({
          status:
            status === "complete"
              ? "fulfilled"
              : status === "failed" || status === "cancelled"
                ? "fulfillment_failed"
                : "fulfillment_submitted",
          updated_at: now(),
        })
        .where(eq(commerceStorefrontOrders.id, job.order_id));
      const kind =
        status === "complete"
          ? "shipped"
          : status === "failed" || status === "cancelled"
            ? "fulfillment_failed"
            : "fulfillment_submitted";
      await emitStorefrontOrderEvent(transaction, {
        kind,
        orderId: job.order_id,
        ownerKey,
        ...(result.tracking.length > 0
          ? { payload: { tracking: result.tracking } }
          : {}),
      });
    });

    return { jobId: job.id, result, status };
  };

  return {
    installationEnabled: async (ownerKey: string, installationId?: string) => {
      try {
        await enabledInstallation(ownerKey, installationId);

        return true;
      } catch {
        return false;
      }
    },
    listFleet: async () => ({
      installations: (await options.db
        .select()
        .from(commerceFulfillmentAccounts)
        .orderBy(
          commerceFulfillmentAccounts.owner_key,
          commerceFulfillmentAccounts.label,
        )) satisfies StorefrontFulfillmentInstallation[],
      jobs: (await options.db
        .select({
          job: commerceStorefrontFulfillmentJobs,
          ownerKey: commerceStorefrontOrders.owner_key,
        })
        .from(commerceStorefrontFulfillmentJobs)
        .innerJoin(
          commerceStorefrontOrders,
          eq(
            commerceStorefrontOrders.id,
            commerceStorefrontFulfillmentJobs.order_id,
          ),
        )
        .orderBy(
          asc(commerceStorefrontFulfillmentJobs.created_at),
        )) satisfies StorefrontFulfillmentFleetJob[],
    }),
    listOwner: async (ownerKey: string) => ({
      installations: (await options.db
        .select()
        .from(commerceFulfillmentAccounts)
        .where(
          eq(commerceFulfillmentAccounts.owner_key, ownerKey),
        )) satisfies StorefrontFulfillmentInstallation[],
      jobs: (
        await options.db
          .select({ job: commerceStorefrontFulfillmentJobs })
          .from(commerceStorefrontFulfillmentJobs)
          .innerJoin(
            commerceStorefrontOrders,
            eq(
              commerceStorefrontOrders.id,
              commerceStorefrontFulfillmentJobs.order_id,
            ),
          )
          .where(eq(commerceStorefrontOrders.owner_key, ownerKey))
          .orderBy(asc(commerceStorefrontFulfillmentJobs.created_at))
      ).map(({ job }) => job) satisfies StorefrontFulfillmentJob[],
    }),
    quarantine: async (ownerKey: string, jobId: string, reason: string) => {
      const order = await orderForJob(options.db, ownerKey, jobId);
      if (!order) throw new StorefrontFulfillmentError("job_not_found");
      const [updated] = await options.db
        .update(commerceStorefrontFulfillmentJobs)
        .set({
          last_error: reason,
          lease_expires_at: null,
          next_attempt_at: null,
          status: "quarantined",
          updated_at: now(),
          worker_id: null,
        })
        .where(eq(commerceStorefrontFulfillmentJobs.id, jobId))
        .returning();

      return updated as StorefrontFulfillmentJob;
    },
    retry: async (ownerKey: string, jobId: string) => {
      const order = await orderForJob(options.db, ownerKey, jobId);
      if (!order) throw new StorefrontFulfillmentError("job_not_found");
      const [updated] = await options.db
        .update(commerceStorefrontFulfillmentJobs)
        .set({
          last_error: null,
          lease_expires_at: null,
          next_attempt_at: now(),
          status: "retry",
          updated_at: now(),
          worker_id: null,
        })
        .where(
          and(
            eq(commerceStorefrontFulfillmentJobs.id, jobId),
            inArray(commerceStorefrontFulfillmentJobs.status, [
              "failed",
              "quarantined",
            ]),
          ),
        )
        .returning();
      if (!updated) throw new StorefrontFulfillmentError("job_not_retryable");

      return updated as StorefrontFulfillmentJob;
    },
    runCycle: async (workerId: string, limit = DEFAULT_CYCLE_LIMIT) => {
      if (!enabled)
        throw new StorefrontFulfillmentError("fulfillment_disabled");
      const results: Array<Awaited<ReturnType<typeof runOne>>> = [];
      for (let index = 0; index < limit; index += 1) {
        const result = await runOne(workerId);
        if (!result) break;
        results.push(result);
      }

      return results;
    },
    saveInstallation: async (
      ownerKey: string,
      input: {
        config?: Record<string, unknown>;
        id?: string;
        label: string;
        provider: string;
        secretAlias: string;
      },
    ) => {
      const values = {
        config: input.config ?? {},
        label: input.label,
        owner_key: ownerKey,
        provider: input.provider,
        secret_alias: input.secretAlias,
        status: "disabled",
        updated_at: now(),
      };
      const [saved] = input.id
        ? await options.db
            .update(commerceFulfillmentAccounts)
            .set(values)
            .where(
              and(
                eq(commerceFulfillmentAccounts.id, input.id),
                eq(commerceFulfillmentAccounts.owner_key, ownerKey),
              ),
            )
            .returning()
        : await options.db
            .insert(commerceFulfillmentAccounts)
            .values(values)
            .returning();
      if (!saved)
        throw new StorefrontFulfillmentError("installation_not_found");

      return saved satisfies StorefrontFulfillmentInstallation;
    },
    setInstallationEnabled: async (
      ownerKey: string,
      installationId: string,
      active: boolean,
    ) => {
      if (active && !enabled)
        throw new StorefrontFulfillmentError("fulfillment_disabled");
      const current = await installation(ownerKey, installationId);
      if (
        active &&
        (!current.secret_alias ||
          !(await options.credentialAvailable(ownerKey, current.secret_alias)))
      )
        throw new StorefrontFulfillmentError("credential_unavailable");
      const [updated] = await options.db
        .update(commerceFulfillmentAccounts)
        .set({
          status: active ? "enabled" : "disabled",
          updated_at: now(),
        })
        .where(eq(commerceFulfillmentAccounts.id, current.id))
        .returning();
      if (!updated)
        throw new StorefrontFulfillmentError("installation_not_found");

      return updated satisfies StorefrontFulfillmentInstallation;
    },
  };

  async function runOne(workerId: string) {
    const claimed = await claim(workerId);
    if (!claimed) return null;
    const job = claimed.job as StorefrontFulfillmentJob;
    const order = await orderFor(job.order_id);
    let installed: StorefrontFulfillmentInstallation;
    try {
      installed = await enabledInstallation(
        order.owner_key,
        job.installation_id ?? undefined,
      );
      const provider = await options.providerFor(installed);
      if (claimed.previousStatus === "submitted" && job.provider_order_id) {
        try {
          return await retainResult(
            job,
            await provider.getOrder(job.provider_order_id),
            order.owner_key,
          );
        } catch (error) {
          await release(job.id, {
            last_error: errorMessage(error),
            next_attempt_at: new Date(now().getTime() + reconcileMs),
            status: "submitted",
          });

          return { jobId: job.id, status: "submitted" };
        }
      }
      const request =
        job.request ??
        (await options.prepare({ installation: installed, job, order }));
      const validation = await provider.validateOrder(request);
      if (!validation.valid) {
        await release(job.id, {
          last_error: validation.errors
            .map(({ message }) => message)
            .join("; "),
          request,
          status: "failed",
        });

        return { jobId: job.id, status: "failed" };
      }
      await options.db
        .update(commerceStorefrontFulfillmentJobs)
        .set({ installation_id: installed.id, request, updated_at: now() })
        .where(eq(commerceStorefrontFulfillmentJobs.id, job.id));
      try {
        return await retainResult(
          job,
          await provider.submitOrder(request),
          order.owner_key,
        );
      } catch (error) {
        await release(job.id, {
          last_error: errorMessage(error),
          request,
          status: "quarantined",
        });

        return { jobId: job.id, status: "quarantined" };
      }
    } catch (error) {
      await release(job.id, {
        last_error: errorMessage(error),
        status: "failed",
      });

      return { jobId: job.id, status: "failed" };
    }
  }
};

const orderForJob = async (db: CommerceDb, ownerKey: string, jobId: string) => {
  const [row] = await db
    .select({ id: commerceStorefrontOrders.id })
    .from(commerceStorefrontFulfillmentJobs)
    .innerJoin(
      commerceStorefrontOrders,
      eq(
        commerceStorefrontOrders.id,
        commerceStorefrontFulfillmentJobs.order_id,
      ),
    )
    .where(
      and(
        eq(commerceStorefrontFulfillmentJobs.id, jobId),
        eq(commerceStorefrontOrders.owner_key, ownerKey),
      ),
    )
    .limit(1);

  return row;
};
