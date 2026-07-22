import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import type { CommerceDb } from './queries';
import {
	commerceCatalogCollectionListings,
	commerceCatalogCollections,
	commerceCatalogListings,
	commerceCatalogSources,
	commerceCatalogs,
	commerceProducts,
	commerceProductVariants
} from './index';

export type DbCatalog = typeof commerceCatalogs.$inferSelect;
export type NewDbCatalog = typeof commerceCatalogs.$inferInsert;
export type DbCatalogSource = typeof commerceCatalogSources.$inferSelect;
export type NewDbCatalogSource = typeof commerceCatalogSources.$inferInsert;
export type DbCatalogProduct = typeof commerceProducts.$inferSelect;
export type NewDbCatalogProduct = typeof commerceProducts.$inferInsert;
export type DbProductVariant = typeof commerceProductVariants.$inferSelect;
export type NewDbProductVariant = typeof commerceProductVariants.$inferInsert;
export type DbCatalogListing = typeof commerceCatalogListings.$inferSelect;
export type NewDbCatalogListing = typeof commerceCatalogListings.$inferInsert;
export type DbCatalogCollection =
	typeof commerceCatalogCollections.$inferSelect;
export type NewDbCatalogCollection =
	typeof commerceCatalogCollections.$inferInsert;

export const createCatalog = async (db: CommerceDb, input: NewDbCatalog) => {
	const [created] = await db.insert(commerceCatalogs).values(input).returning();

	return created;
};

export const getCatalogBySlug = async (db: CommerceDb, slug: string) => {
	const [catalog] = await db
		.select()
		.from(commerceCatalogs)
		.where(eq(commerceCatalogs.slug, slug))
		.limit(1);

	return catalog ?? null;
};

export const upsertCatalogSource = async (
	db: CommerceDb,
	input: NewDbCatalogSource
) => {
	const [source] = await db
		.insert(commerceCatalogSources)
		.values(input)
		.onConflictDoUpdate({
			set: { ...input, updated_at: new Date() },
			target: commerceCatalogSources.id
		})
		.returning();

	return source;
};

export const recordCatalogSync = async (
	db: CommerceDb,
	sourceId: string,
	result: { cursor?: string | null; error?: string | null }
) => {
	const [source] = await db
		.update(commerceCatalogSources)
		.set({
			cursor: result.cursor,
			last_error: result.error ?? null,
			last_synced_at: new Date(),
			status: result.error ? 'error' : 'active',
			updated_at: new Date()
		})
		.where(eq(commerceCatalogSources.id, sourceId))
		.returning();

	return source ?? null;
};

/** Idempotently ingest supplier product truth using its stable product id. */
export const upsertCatalogProduct = async (
	db: CommerceDb,
	input: NewDbCatalogProduct
) => {
	const [product] = await db
		.insert(commerceProducts)
		.values(input)
		.onConflictDoUpdate({
			set: { ...input, updated_at: new Date() },
			target: commerceProducts.id
		})
		.returning();

	return product;
};

/** Idempotently ingest an exact supplier SKU. */
export const upsertProductVariant = async (
	db: CommerceDb,
	input: NewDbProductVariant
) => {
	const [variant] = await db
		.insert(commerceProductVariants)
		.values(input)
		.onConflictDoUpdate({
			set: { ...input, updated_at: new Date() },
			target: commerceProductVariants.id
		})
		.returning();

	return variant;
};

/** Batch form for supplier pages; one statement rather than one query per SKU. */
export const upsertProductVariants = async (
	db: CommerceDb,
	inputs: NewDbProductVariant[]
) => {
	if (inputs.length === 0) return [];

	return db
		.insert(commerceProductVariants)
		.values(inputs)
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
				media: sql`excluded.media`,
				metadata: sql`excluded.metadata`,
				options: sql`excluded.options`,
				price_cents: sql`excluded.price_cents`,
				product_id: sql`excluded.product_id`,
				sku: sql`excluded.sku`,
				supplier_sku: sql`excluded.supplier_sku`,
				updated_at: new Date()
			},
			target: commerceProductVariants.id
		})
		.returning();
};

export const listProductVariants = (db: CommerceDb, productId: string) =>
	db
		.select()
		.from(commerceProductVariants)
		.where(eq(commerceProductVariants.product_id, productId))
		.orderBy(asc(commerceProductVariants.sku));

export const createCatalogListing = async (
	db: CommerceDb,
	input: NewDbCatalogListing
) => {
	const [listing] = await db
		.insert(commerceCatalogListings)
		.values(input)
		.returning();

	return listing;
};

export type CatalogListingFilters = {
	status?: string;
	brand?: string;
	category?: string;
	productType?: string;
	search?: string;
	limit?: number;
	offset?: number;
};

export const listCatalogListings = (
	db: CommerceDb,
	catalogId: string,
	options: CatalogListingFilters = {}
) => {
	const filters = [eq(commerceCatalogListings.catalog_id, catalogId)];
	if (options.status)
		filters.push(eq(commerceCatalogListings.status, options.status));
	if (options.brand) filters.push(eq(commerceProducts.brand, options.brand));
	if (options.category)
		filters.push(eq(commerceProducts.category, options.category));
	if (options.productType)
		filters.push(eq(commerceProducts.product_type, options.productType));
	const search = options.search?.trim();
	if (search) {
		const term = `%${search}%`;
		const match = or(
			ilike(commerceCatalogListings.title, term),
			ilike(commerceProducts.title, term),
			ilike(commerceProducts.brand, term),
			ilike(commerceProducts.style_code, term)
		);
		if (match) filters.push(match);
	}

	return db
		.select({ listing: commerceCatalogListings, product: commerceProducts })
		.from(commerceCatalogListings)
		.innerJoin(
			commerceProducts,
			eq(commerceCatalogListings.product_id, commerceProducts.id)
		)
		.where(and(...filters))
		.orderBy(asc(commerceCatalogListings.position))
		.limit(Math.min(250, Math.max(1, options.limit ?? 50)))
		.offset(Math.max(0, options.offset ?? 0));
};

export const getCatalogListingBySlug = async (
	db: CommerceDb,
	catalogId: string,
	slug: string
) => {
	const [result] = await db
		.select({ listing: commerceCatalogListings, product: commerceProducts })
		.from(commerceCatalogListings)
		.innerJoin(
			commerceProducts,
			eq(commerceCatalogListings.product_id, commerceProducts.id)
		)
		.where(
			and(
				eq(commerceCatalogListings.catalog_id, catalogId),
				eq(commerceCatalogListings.slug, slug)
			)
		)
		.limit(1);
	if (!result) return null;

	return {
		...result,
		variants: await listProductVariants(db, result.product.id)
	};
};

export const createCatalogCollection = async (
	db: CommerceDb,
	input: NewDbCatalogCollection
) => {
	const [collection] = await db
		.insert(commerceCatalogCollections)
		.values(input)
		.returning();

	return collection;
};

export const listCatalogCollections = (db: CommerceDb, catalogId: string) =>
	db
		.select()
		.from(commerceCatalogCollections)
		.where(eq(commerceCatalogCollections.catalog_id, catalogId))
		.orderBy(asc(commerceCatalogCollections.position));

export const addListingToCollection = async (
	db: CommerceDb,
	input: { collectionId: string; listingId: string; position?: number }
) => {
	const [membership] = await db
		.insert(commerceCatalogCollectionListings)
		.values({
			collection_id: input.collectionId,
			listing_id: input.listingId,
			position: input.position ?? 0
		})
		.onConflictDoUpdate({
			set: { position: input.position ?? 0 },
			target: [
				commerceCatalogCollectionListings.collection_id,
				commerceCatalogCollectionListings.listing_id
			]
		})
		.returning();

	return membership;
};

export const listCollectionListings = (db: CommerceDb, collectionId: string) =>
	db
		.select({ listing: commerceCatalogListings, product: commerceProducts })
		.from(commerceCatalogCollectionListings)
		.innerJoin(
			commerceCatalogListings,
			eq(
				commerceCatalogCollectionListings.listing_id,
				commerceCatalogListings.id
			)
		)
		.innerJoin(
			commerceProducts,
			eq(commerceCatalogListings.product_id, commerceProducts.id)
		)
		.where(eq(commerceCatalogCollectionListings.collection_id, collectionId))
		.orderBy(asc(commerceCatalogCollectionListings.position));
