import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type {
  CatalogPage,
  CatalogProduct,
  CatalogSourceProvider,
  CatalogTaxon,
  ProductVariant,
} from "../core/catalog";
import type { CommerceDb } from "./queries";
import {
  commerceCatalogSources,
  commerceCatalogSyncRuns,
  commerceCatalogTaxa,
  commerceProducts,
  commerceProductVariants,
} from "./index";

const DEFAULT_PAGE_SIZE = 250;
const MAX_PAGE_SIZE = 250;
const MAX_SYNC_PAGES = 1_000;

export type CatalogSyncTrigger = "manual" | "scheduled" | "repair";

export type CatalogSyncSourceInput = {
  id: string;
  name: string;
  ownerKey?: string;
  provider: string;
  settings?: Record<string, unknown>;
};

export type CatalogSyncReport = {
  completedAt: string;
  generation: string;
  productsSynced: number;
  runId: string;
  sourceId: string;
  status: "passed";
  taxaSynced: number;
  variantsSynced: number;
};

export class CatalogSyncError extends Error {
  constructor(
    readonly code: string,
    readonly sourceId: string,
  ) {
    super(`Catalog synchronization failed (${code})`);
    this.name = "CatalogSyncError";
  }
}

const safeErrorCode = (error: unknown) => {
  if (error instanceof CatalogSyncError) return error.code;
  if (error instanceof Error && error.name.trim())
    return `provider_${error.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`.slice(
      0,
      120,
    );

  return "provider_unknown_error";
};

export const catalogSyncIdentity = (
  sourceId: string,
  kind: "product" | "taxon" | "variant",
  id: string,
) => {
  const digest = createHash("sha256")
    .update(`${sourceId}\0${kind}\0${id}`)
    .digest("hex")
    .slice(0, 32);

  return `${sourceId.slice(0, 100)}:${kind[0]}:${digest}`;
};

const synchronizedProduct = (
  sourceId: string,
  generation: string,
  now: Date,
  product: CatalogProduct,
) => ({
  attributes: product.attributes,
  brand: product.brand,
  category: product.category,
  decoration_areas: product.decorationAreas,
  description: product.description,
  external_id: product.externalId ?? product.id,
  id: catalogSyncIdentity(
    sourceId,
    "product",
    product.externalId ?? product.id,
  ),
  last_seen_at: now,
  media: product.media,
  metadata: { ...product.metadata, providerProductId: product.id },
  option_names: product.optionNames,
  product_type: product.productType,
  slug: product.slug,
  source_id: sourceId,
  status: product.status,
  style_code: product.styleCode,
  sync_generation: generation,
  tags: product.tags,
  title: product.title,
  updated_at: now,
});

const synchronizedVariant = (
  sourceId: string,
  generation: string,
  now: Date,
  productId: string,
  variant: ProductVariant,
) => ({
  available: variant.available,
  barcode: variant.barcode,
  compare_at_cents: variant.compareAtCents,
  cost_cents: variant.costCents,
  currency: variant.currency,
  external_id: variant.externalId ?? variant.id,
  id: catalogSyncIdentity(
    sourceId,
    "variant",
    variant.externalId ?? variant.id,
  ),
  inventory_policy: variant.inventoryPolicy,
  inventory_quantity: variant.inventoryQuantity,
  last_seen_at: now,
  media: variant.media,
  metadata: { ...variant.metadata, providerVariantId: variant.id },
  options: variant.options,
  price_cents: variant.priceCents,
  product_id: productId,
  sku: variant.sku,
  source_id: sourceId,
  supplier_sku: variant.supplierSku,
  sync_generation: generation,
  updated_at: now,
});

const upsertProducts = async (
  db: CommerceDb,
  products: ReturnType<typeof synchronizedProduct>[],
) => {
  if (products.length === 0) return;
  await db
    .insert(commerceProducts)
    .values(products)
    .onConflictDoUpdate({
      set: {
        attributes: sql`excluded.attributes`,
        brand: sql`excluded.brand`,
        category: sql`excluded.category`,
        decoration_areas: sql`excluded.decoration_areas`,
        description: sql`excluded.description`,
        external_id: sql`excluded.external_id`,
        last_seen_at: sql`excluded.last_seen_at`,
        media: sql`excluded.media`,
        metadata: sql`excluded.metadata`,
        option_names: sql`excluded.option_names`,
        product_type: sql`excluded.product_type`,
        slug: sql`excluded.slug`,
        source_id: sql`excluded.source_id`,
        status: sql`excluded.status`,
        style_code: sql`excluded.style_code`,
        sync_generation: sql`excluded.sync_generation`,
        tags: sql`excluded.tags`,
        title: sql`excluded.title`,
        updated_at: sql`excluded.updated_at`,
      },
      target: commerceProducts.id,
    });
};

const upsertVariants = async (
  db: CommerceDb,
  variants: ReturnType<typeof synchronizedVariant>[],
) => {
  if (variants.length === 0) return;
  await db
    .insert(commerceProductVariants)
    .values(variants)
    .onConflictDoUpdate({
      set: {
        available: sql`excluded.available`,
        barcode: sql`excluded.barcode`,
        compare_at_cents: sql`excluded.compare_at_cents`,
        cost_cents: sql`excluded.cost_cents`,
        currency: sql`excluded.currency`,
        external_id: sql`excluded.external_id`,
        inventory_policy: sql`excluded.inventory_policy`,
        inventory_quantity: sql`excluded.inventory_quantity`,
        last_seen_at: sql`excluded.last_seen_at`,
        media: sql`excluded.media`,
        metadata: sql`excluded.metadata`,
        options: sql`excluded.options`,
        price_cents: sql`excluded.price_cents`,
        product_id: sql`excluded.product_id`,
        sku: sql`excluded.sku`,
        source_id: sql`excluded.source_id`,
        supplier_sku: sql`excluded.supplier_sku`,
        sync_generation: sql`excluded.sync_generation`,
        updated_at: sql`excluded.updated_at`,
      },
      target: commerceProductVariants.id,
    });
};

const upsertTaxonomy = async (
  db: CommerceDb,
  sourceId: string,
  taxa: CatalogTaxon[],
  now: Date,
) => {
  if (taxa.length === 0) return;
  await db
    .insert(commerceCatalogTaxa)
    .values(
      taxa.map((taxon) => ({
        external_id: taxon.externalId,
        id: catalogSyncIdentity(sourceId, "taxon", taxon.externalId),
        kind: taxon.kind,
        metadata: taxon.metadata,
        name: taxon.name,
        parent_external_id: taxon.parentExternalId,
        slug: taxon.slug,
        source_id: sourceId,
        updated_at: now,
      })),
    )
    .onConflictDoUpdate({
      set: {
        kind: sql`excluded.kind`,
        metadata: sql`excluded.metadata`,
        name: sql`excluded.name`,
        parent_external_id: sql`excluded.parent_external_id`,
        slug: sql`excluded.slug`,
        updated_at: sql`excluded.updated_at`,
      },
      target: commerceCatalogTaxa.id,
    });
};

export const synchronizeCatalogSource = async (input: {
  db: CommerceDb;
  maxPages?: number;
  now?: () => Date;
  pageSize?: number;
  provider: CatalogSourceProvider;
  source: CatalogSyncSourceInput;
  trigger?: CatalogSyncTrigger;
}): Promise<CatalogSyncReport> => {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const generation = randomUUID();
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, input.pageSize ?? DEFAULT_PAGE_SIZE),
  );
  const maxPages = Math.min(
    MAX_SYNC_PAGES,
    Math.max(1, input.maxPages ?? MAX_SYNC_PAGES),
  );
  await input.db
    .insert(commerceCatalogSources)
    .values({
      id: input.source.id,
      last_error: null,
      name: input.source.name,
      owner_key: input.source.ownerKey,
      provider: input.source.provider,
      settings: input.source.settings ?? {},
      status: "syncing",
      sync_generation: generation,
      sync_started_at: startedAt,
      updated_at: startedAt,
    })
    .onConflictDoUpdate({
      set: {
        last_error: null,
        name: input.source.name,
        owner_key: input.source.ownerKey,
        provider: input.source.provider,
        settings: input.source.settings ?? {},
        status: "syncing",
        sync_generation: generation,
        sync_started_at: startedAt,
        updated_at: startedAt,
      },
      target: commerceCatalogSources.id,
    });
  const [run] = await input.db
    .insert(commerceCatalogSyncRuns)
    .values({
      generation,
      source_id: input.source.id,
      started_at: startedAt,
      trigger: input.trigger ?? "scheduled",
    })
    .returning();
  if (!run) throw new CatalogSyncError("run_not_created", input.source.id);
  let cursor: string | undefined;
  let productsSynced = 0;
  let variantsSynced = 0;
  let taxaSynced = 0;
  const seenCursors = new Set<string>();

  try {
    if (input.provider.listTaxonomy) {
      const taxa = await input.provider.listTaxonomy();
      await upsertTaxonomy(input.db, input.source.id, taxa, now());
      taxaSynced = taxa.length;
    }
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await input.provider.listProducts({
        cursor,
        limit: pageSize,
      });
      const seenAt = now();
      const products = page.items.map(({ product }) =>
        synchronizedProduct(input.source.id, generation, seenAt, product),
      );
      const productIds = new Map(
        page.items.map(({ product }) => [
          product.id,
          catalogSyncIdentity(
            input.source.id,
            "product",
            product.externalId ?? product.id,
          ),
        ]),
      );
      const variants = page.items.flatMap(({ product, variants: items }) =>
        items.map((variant) =>
          synchronizedVariant(
            input.source.id,
            generation,
            seenAt,
            productIds.get(product.id)!,
            variant,
          ),
        ),
      );
      await upsertProducts(input.db, products);
      await upsertVariants(input.db, variants);
      productsSynced += products.length;
      variantsSynced += variants.length;
      const nextCursor = page.nextCursor?.trim() || undefined;
      await input.db
        .update(commerceCatalogSources)
        .set({
          cursor: nextCursor,
          products_synced: productsSynced,
          updated_at: now(),
          variants_synced: variantsSynced,
        })
        .where(eq(commerceCatalogSources.id, input.source.id));
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor))
        throw new CatalogSyncError("cursor_repeated", input.source.id);
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === maxPages)
        throw new CatalogSyncError("page_limit_exceeded", input.source.id);
    }
    const completedAt = now();
    await Promise.all([
      input.db
        .update(commerceProducts)
        .set({ status: "archived", updated_at: completedAt })
        .where(
          and(
            eq(commerceProducts.source_id, input.source.id),
            or(
              isNull(commerceProducts.sync_generation),
              ne(commerceProducts.sync_generation, generation),
            ),
          ),
        ),
      input.db
        .update(commerceProductVariants)
        .set({ available: false, updated_at: completedAt })
        .where(
          and(
            eq(commerceProductVariants.source_id, input.source.id),
            or(
              isNull(commerceProductVariants.sync_generation),
              ne(commerceProductVariants.sync_generation, generation),
            ),
          ),
        ),
      input.db
        .update(commerceCatalogSources)
        .set({
          cursor: null,
          last_error: null,
          last_synced_at: completedAt,
          products_synced: productsSynced,
          status: "active",
          sync_started_at: null,
          updated_at: completedAt,
          variants_synced: variantsSynced,
        })
        .where(eq(commerceCatalogSources.id, input.source.id)),
      input.db
        .update(commerceCatalogSyncRuns)
        .set({
          completed_at: completedAt,
          cursor: null,
          products_synced: productsSynced,
          status: "passed",
          variants_synced: variantsSynced,
        })
        .where(eq(commerceCatalogSyncRuns.id, run.id)),
    ]);

    return {
      completedAt: completedAt.toISOString(),
      generation,
      productsSynced,
      runId: run.id,
      sourceId: input.source.id,
      status: "passed",
      taxaSynced,
      variantsSynced,
    };
  } catch (error) {
    const code = safeErrorCode(error);
    const completedAt = now();
    await Promise.all([
      input.db
        .update(commerceCatalogSources)
        .set({
          cursor,
          last_error: code,
          status: "error",
          sync_started_at: null,
          updated_at: completedAt,
        })
        .where(eq(commerceCatalogSources.id, input.source.id)),
      input.db
        .update(commerceCatalogSyncRuns)
        .set({
          completed_at: completedAt,
          cursor,
          error_code: code,
          products_synced: productsSynced,
          status: "failed",
          variants_synced: variantsSynced,
        })
        .where(eq(commerceCatalogSyncRuns.id, run.id)),
    ]);
    throw new CatalogSyncError(code, input.source.id);
  }
};

const catalogProduct = (
  row: typeof commerceProducts.$inferSelect,
): CatalogProduct => ({
  attributes: row.attributes ?? {},
  brand: row.brand,
  category: row.category,
  decorationAreas: row.decoration_areas ?? [],
  description: row.description,
  externalId: row.external_id,
  id: row.id,
  media: row.media ?? [],
  metadata: row.metadata ?? {},
  optionNames: row.option_names ?? [],
  productType: row.product_type,
  slug: row.slug,
  sourceId: row.source_id,
  status: row.status as CatalogProduct["status"],
  styleCode: row.style_code,
  tags: row.tags ?? [],
  title: row.title,
});

const productVariant = (
  row: typeof commerceProductVariants.$inferSelect,
): ProductVariant => ({
  available: row.available,
  barcode: row.barcode,
  compareAtCents: row.compare_at_cents,
  costCents: row.cost_cents,
  currency: row.currency,
  externalId: row.external_id,
  id: row.id,
  inventoryPolicy: row.inventory_policy as ProductVariant["inventoryPolicy"],
  inventoryQuantity: row.inventory_quantity,
  media: row.media ?? [],
  metadata: row.metadata ?? {},
  options: row.options,
  priceCents: row.price_cents,
  productId: row.product_id,
  sku: row.sku,
  supplierSku: row.supplier_sku,
});

export const listSynchronizedCatalogProducts = async (
  db: CommerceDb,
  input: {
    category?: string;
    cursor?: string;
    limit?: number;
    search?: string;
    sourceId: string;
  },
): Promise<
  CatalogPage<{ product: CatalogProduct; variants: ProductVariant[] }>
> => {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, input.limit ?? 50));
  const offset = Math.max(0, Number(input.cursor ?? "0") || 0);
  const filters = [
    eq(commerceProducts.source_id, input.sourceId),
    eq(commerceProducts.status, "active"),
  ];
  if (input.category)
    filters.push(eq(commerceProducts.category, input.category));
  const search = input.search?.trim();
  if (search) {
    const term = `%${search}%`;
    const match = or(
      sql<boolean>`to_tsvector('simple', ${commerceProducts.title} || ' ' || ${commerceProducts.brand} || ' ' || ${commerceProducts.style_code} || ' ' || ${commerceProducts.category} || ' ' || ${commerceProducts.product_type}) @@ websearch_to_tsquery('simple', ${search})`,
      ilike(commerceProducts.style_code, term),
      sql<boolean>`exists (select 1 from ${commerceProductVariants} variant where variant.product_id = ${commerceProducts.id} and (variant.sku ilike ${term} or variant.supplier_sku ilike ${term}))`,
    );
    if (match) filters.push(match);
  }
  const rows = await db
    .select()
    .from(commerceProducts)
    .where(and(...filters))
    .orderBy(asc(commerceProducts.title), asc(commerceProducts.id))
    .limit(limit + 1)
    .offset(offset);
  const selected = rows.slice(0, limit);
  const variants =
    selected.length === 0
      ? []
      : await db
          .select()
          .from(commerceProductVariants)
          .where(
            inArray(
              commerceProductVariants.product_id,
              selected.map(({ id }) => id),
            ),
          )
          .orderBy(asc(commerceProductVariants.sku));
  const byProduct = Map.groupBy(variants, ({ product_id }) => product_id);

  return {
    items: selected.map((product) => ({
      product: catalogProduct(product),
      variants: (byProduct.get(product.id) ?? []).map(productVariant),
    })),
    ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
  };
};

export const listCatalogTaxonomy = async (db: CommerceDb, sourceId: string) =>
  (
    await db
      .select()
      .from(commerceCatalogTaxa)
      .where(eq(commerceCatalogTaxa.source_id, sourceId))
      .orderBy(asc(commerceCatalogTaxa.kind), asc(commerceCatalogTaxa.name))
  ).map((row): CatalogTaxon => ({
    externalId: row.external_id,
    kind: row.kind as CatalogTaxon["kind"],
    metadata: row.metadata ?? {},
    name: row.name,
    parentExternalId: row.parent_external_id,
    slug: row.slug,
  }));

export const listCatalogSyncSources = (db: CommerceDb, ownerKey?: string) =>
  db
    .select()
    .from(commerceCatalogSources)
    .where(
      ownerKey ? eq(commerceCatalogSources.owner_key, ownerKey) : undefined,
    )
    .orderBy(
      asc(commerceCatalogSources.owner_key),
      asc(commerceCatalogSources.name),
    );

export const listCatalogSyncRuns = (
  db: CommerceDb,
  input: { limit?: number; sourceId?: string } = {},
) =>
  db
    .select()
    .from(commerceCatalogSyncRuns)
    .where(
      input.sourceId
        ? eq(commerceCatalogSyncRuns.source_id, input.sourceId)
        : undefined,
    )
    .orderBy(desc(commerceCatalogSyncRuns.started_at))
    .limit(Math.min(250, Math.max(1, input.limit ?? 50)));
