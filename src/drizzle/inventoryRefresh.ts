import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { CatalogSourceProvider } from "../core/catalog";
import {
  refreshSupplierInventory,
  type InventoryRefreshReport,
} from "../core/inventoryRefresh";
import type { CommerceDb } from "./queries";
import {
  commerceCatalogSources,
  commerceProducts,
  commerceProductVariants,
} from "./index";
import { CatalogSyncInProgressError, CatalogSyncError } from "./catalogSync";

const LEASE_MS = 15 * 60 * 1000;
/** Inventory refresh shares the source's catalog lease; observations never touch
 * listings, product content, store selections, prices or merchant permissions. */
export const refreshCatalogInventory = async (input: {
  db: CommerceDb;
  provider: CatalogSourceProvider;
  sourceId: string;
  productIds?: string[];
  concurrency?: number;
  signal?: AbortSignal;
}) => {
  if (!input.provider.getInventory && !input.provider.getProductInventory)
    return {
      status: "unsupported" as const,
      productsChecked: 0,
      variantsUpdated: 0,
      variantsFailed: 0,
      failures: [],
    };
  const reportKey = input.productIds
    ? "inventoryProductRefresh"
    : "inventoryRefresh";
  const generation = randomUUID(),
    startedAt = new Date();
  const [source] = await input.db
    .select()
    .from(commerceCatalogSources)
    .where(eq(commerceCatalogSources.id, input.sourceId))
    .limit(1);
  if (!source) throw new CatalogSyncError("source_not_found", input.sourceId);
  if (source.provider !== input.provider.id)
    throw new CatalogSyncError("provider_mismatch", input.sourceId);
  const [claimed] = await input.db
    .update(commerceCatalogSources)
    .set({
      status: "syncing",
      sync_generation: generation,
      sync_started_at: startedAt,
      sync_lease_expires_at: new Date(startedAt.getTime() + LEASE_MS),
      settings: sql`coalesce(${commerceCatalogSources.settings},'{}'::jsonb) || jsonb_build_object(${reportKey}::text, ${JSON.stringify({ status: "running", runId: generation, startedAt: startedAt.toISOString() })}::jsonb)`,
    })
    .where(
      and(
        eq(commerceCatalogSources.id, input.sourceId),
        or(
          ne(commerceCatalogSources.status, "syncing"),
          isNull(commerceCatalogSources.sync_lease_expires_at),
          lte(commerceCatalogSources.sync_lease_expires_at, startedAt),
        ),
      ),
    )
    .returning({ id: commerceCatalogSources.id });
  if (!claimed) throw new CatalogSyncInProgressError(input.sourceId);
  try {
    const rows = await input.db
      .select({
        id: commerceProducts.id,
        externalId: commerceProducts.external_id,
      })
      .from(commerceProducts)
      .where(
        and(
          eq(commerceProducts.source_id, input.sourceId),
          eq(commerceProducts.status, "active"),
          input.productIds
            ? inArray(commerceProducts.id, input.productIds)
            : undefined,
        ),
      );
    const variants = rows.length
      ? await input.db
          .select({
            id: commerceProductVariants.id,
            productId: commerceProductVariants.product_id,
            sku: commerceProductVariants.supplier_sku,
          })
          .from(commerceProductVariants)
          .where(
            and(
              eq(commerceProductVariants.source_id, input.sourceId),
              inArray(
                commerceProductVariants.product_id,
                rows.map((p) => p.id),
              ),
              sql`coalesce(${commerceProductVariants.metadata}->>'catalogRetired','false') <> 'true'`,
            ),
          )
      : [];
    const products = rows
      .filter((p) => p.externalId)
      .map((p) => ({
        externalId: p.externalId!,
        skus: variants
          .filter((v) => v.productId === p.id)
          .flatMap((v) => (v.sku ? [v.sku] : [])),
      }))
      .filter((p) => p.skus.length);
    const owner = () =>
      and(
        eq(commerceCatalogSources.id, input.sourceId),
        eq(commerceCatalogSources.sync_generation, generation),
        eq(commerceCatalogSources.status, "syncing"),
      );
    const assertLease = async (tx: CommerceDb) => {
      const [lease] = await tx
        .select({ id: commerceCatalogSources.id })
        .from(commerceCatalogSources)
        .where(owner())
        .for("update");
      if (!lease) throw new CatalogSyncError("sync_lease_lost", input.sourceId);
    };
    const report = await refreshSupplierInventory({
      provider: input.provider,
      sourceId: input.sourceId,
      products,
      concurrency: input.concurrency,
      signal: input.signal,
      persist: async (externalId, observations) =>
        input.db.transaction(async (tx) => {
          await assertLease(tx);
          const product = rows.find((p) => p.externalId === externalId)!;
          const values = observations.flatMap((observation) =>
            variants
              .filter(
                (v) =>
                  v.productId === product.id &&
                  v.sku === observation.supplierSku,
              )
              .map(
                (variant) =>
                  sql`(${variant.id}::text,${observation.available}::boolean,${observation.quantity ?? null}::integer,${JSON.stringify(observation)}::jsonb)`,
              ),
          );
          if (values.length)
            await tx.execute(
              sql`update ${commerceProductVariants} set available=incoming.available, inventory_quantity=incoming.quantity, inventory_policy='external', metadata=jsonb_set(coalesce(${commerceProductVariants.metadata},'{}'::jsonb),'{supplierStock}',incoming.observation), updated_at=now() from (values ${sql.join(values, sql`,`)}) as incoming(id,available,quantity,observation) where ${commerceProductVariants.id}=incoming.id and ${commerceProductVariants.source_id}=${input.sourceId} and ${commerceProductVariants.supplier_sku}=incoming.observation->>'supplierSku' and (coalesce(${commerceProductVariants.metadata}->'supplierStock'->>'observedAt','') <= coalesce(incoming.observation->>'observedAt',''))`,
            );
          await tx
            .update(commerceCatalogSources)
            .set({ sync_lease_expires_at: new Date(Date.now() + LEASE_MS) })
            .where(owner());
        }),
      progress: async (progress) => {
        await input.db
          .update(commerceCatalogSources)
          .set({
            settings: sql`coalesce(${commerceCatalogSources.settings},'{}'::jsonb) || jsonb_build_object(${reportKey}::text,${JSON.stringify({ status: "running", runId: generation, startedAt: startedAt.toISOString(), productsChecked: progress.productsChecked, variantsUpdated: progress.variantsUpdated, variantsFailed: progress.variantsFailed })}::jsonb)`,
          })
          .where(owner());
      },
    });
    const completedAt = new Date().toISOString();
    await input.db
      .update(commerceCatalogSources)
      .set({
        status: source.status === "syncing" ? "active" : source.status,
        sync_lease_expires_at: null,
        sync_started_at: null,
        settings: sql`coalesce(${commerceCatalogSources.settings},'{}'::jsonb) || jsonb_build_object(${reportKey}::text,${JSON.stringify({ ...report, failures: report.failures.slice(0, 20), runId: generation, startedAt: startedAt.toISOString(), completedAt })}::jsonb)`,
      })
      .where(owner());
    return { ...report, completedAt };
  } catch (error) {
    await input.db
      .update(commerceCatalogSources)
      .set({
        status: source.status === "syncing" ? "active" : source.status,
        sync_lease_expires_at: null,
        sync_started_at: null,
        settings: sql`coalesce(${commerceCatalogSources.settings},'{}'::jsonb) || jsonb_build_object(${reportKey}::text,${JSON.stringify({ status: "failed", runId: generation, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), code: error instanceof CatalogSyncError ? error.code : "inventory_refresh_failed" })}::jsonb)`,
      })
      .where(
        and(
          eq(commerceCatalogSources.id, input.sourceId),
          eq(commerceCatalogSources.sync_generation, generation),
        ),
      );
    throw new CatalogSyncError(
      error instanceof CatalogSyncError
        ? error.code
        : "inventory_refresh_failed",
      input.sourceId,
    );
  }
};
