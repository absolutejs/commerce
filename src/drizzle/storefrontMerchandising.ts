import type {
  BrandKit,
  CatalogCustomizationPolicy,
  CatalogStatus,
  ListingStatus,
} from "../core/catalog";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { CommerceDb } from "./queries";
import {
  commerceCatalogCollectionListings,
  commerceCatalogCollections,
  commerceCatalogListings,
  commerceCatalogs,
  commerceCatalogSources,
  commerceProducts,
  commerceProductVariants,
} from "./index";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type SaveStorefrontCatalogInput = {
  brandKit?: BrandKit | null;
  currency?: string;
  id?: string;
  locale?: string;
  name: string;
  settings?: Record<string, unknown>;
  slug: string;
  status?: CatalogStatus;
};

export type SaveStorefrontListingInput = {
  basePriceCents?: number | null;
  catalogId: string;
  compareAtCents?: number | null;
  customization?: CatalogCustomizationPolicy;
  customizationMode?: "approved" | "both" | "customizable" | "none";
  description?: string | null;
  id?: string;
  metadata?: Record<string, unknown>;
  position?: number;
  productId: string;
  slug: string;
  status?: ListingStatus;
  tags?: string[];
  title?: string | null;
};

export type SaveStorefrontCollectionInput = {
  catalogId: string;
  description?: string | null;
  id?: string;
  imageUrl?: string | null;
  position?: number;
  slug: string;
  status?: CatalogStatus;
  title: string;
};

export class StorefrontMerchandisingError extends Error {
  constructor(
    readonly code:
      | "catalog_not_found"
      | "collection_not_found"
      | "invalid_customization"
      | "invalid_price"
      | "invalid_slug"
      | "listing_not_found"
      | "listing_not_ready"
      | "product_not_found"
      | "storefront_not_ready",
  ) {
    super(`Storefront merchandising failed (${code})`);
    this.name = "StorefrontMerchandisingError";
  }
}

const assertSlug = (slug: string) => {
  if (!SLUG_PATTERN.test(slug))
    throw new StorefrontMerchandisingError("invalid_slug");
};

export const storefrontPriceIsValid = (
  basePriceCents?: number | null,
  compareAtCents?: number | null,
) =>
  (basePriceCents == null || basePriceCents >= 0) &&
  (compareAtCents == null || compareAtCents >= 0) &&
  (basePriceCents == null ||
    compareAtCents == null ||
    compareAtCents >= basePriceCents);

export const storefrontCustomizationIsValid = (
  mode: SaveStorefrontListingInput["customizationMode"] = "customizable",
  policy: CatalogCustomizationPolicy = {},
) => {
  const artwork = policy.approvedArtwork ?? [];
  if ((mode === "approved" || mode === "both") && artwork.length === 0)
    return false;
  if (
    artwork.some(
      ({ id, name, url }) => !id.trim() || !name.trim() || !URL.canParse(url),
    )
  )
    return false;

  return (policy.buyerFields ?? []).every(
    (field) =>
      field.id.trim() &&
      field.label.trim() &&
      (field.type !== "select" || Boolean(field.options?.length)),
  );
};

const ownerCatalog = async (
  db: CommerceDb,
  ownerKey: string,
  catalogId: string,
) => {
  const [catalog] = await db
    .select()
    .from(commerceCatalogs)
    .where(
      and(
        eq(commerceCatalogs.id, catalogId),
        eq(commerceCatalogs.owner_key, ownerKey),
      ),
    )
    .limit(1);
  if (!catalog) throw new StorefrontMerchandisingError("catalog_not_found");

  return catalog;
};

const ownerProduct = async (
  db: CommerceDb,
  ownerKey: string,
  productId: string,
) => {
  const [result] = await db
    .select({ product: commerceProducts })
    .from(commerceProducts)
    .innerJoin(
      commerceCatalogSources,
      eq(commerceProducts.source_id, commerceCatalogSources.id),
    )
    .where(
      and(
        eq(commerceProducts.id, productId),
        eq(commerceCatalogSources.owner_key, ownerKey),
      ),
    )
    .limit(1);
  if (!result) throw new StorefrontMerchandisingError("product_not_found");

  return result.product;
};

const assertListingReady = async (
  db: CommerceDb,
  ownerKey: string,
  input: SaveStorefrontListingInput,
) => {
  const product = await ownerProduct(db, ownerKey, input.productId);
  if (input.status !== "active") return product;
  const [variant] = await db
    .select({ id: commerceProductVariants.id })
    .from(commerceProductVariants)
    .where(
      and(
        eq(commerceProductVariants.product_id, input.productId),
        eq(commerceProductVariants.available, true),
      ),
    )
    .limit(1);
  if (product.status !== "active" || !variant)
    throw new StorefrontMerchandisingError("listing_not_ready");

  return product;
};

const assertCatalogReady = async (db: CommerceDb, catalogId: string) => {
  const [listing] = await db
    .select({ id: commerceCatalogListings.id })
    .from(commerceCatalogListings)
    .where(
      and(
        eq(commerceCatalogListings.catalog_id, catalogId),
        eq(commerceCatalogListings.status, "active"),
      ),
    )
    .limit(1);
  if (!listing) throw new StorefrontMerchandisingError("storefront_not_ready");
};

export const createStorefrontMerchandisingService = (db: CommerceDb) => {
  const posture = async (ownerKey?: string) => {
    const catalogs = await db
      .select()
      .from(commerceCatalogs)
      .where(ownerKey ? eq(commerceCatalogs.owner_key, ownerKey) : undefined)
      .orderBy(asc(commerceCatalogs.owner_key), asc(commerceCatalogs.name));
    if (catalogs.length === 0) return [];
    const catalogIds = catalogs.map(({ id }) => id);
    const listings = await db
      .select({
        catalogId: commerceCatalogListings.catalog_id,
        id: commerceCatalogListings.id,
        productId: commerceCatalogListings.product_id,
        productStatus: commerceProducts.status,
        status: commerceCatalogListings.status,
      })
      .from(commerceCatalogListings)
      .innerJoin(
        commerceProducts,
        eq(commerceCatalogListings.product_id, commerceProducts.id),
      )
      .where(inArray(commerceCatalogListings.catalog_id, catalogIds));
    const productIds = [...new Set(listings.map(({ productId }) => productId))];
    const availableProducts = new Set(
      productIds.length === 0
        ? []
        : (
            await db
              .selectDistinct({ productId: commerceProductVariants.product_id })
              .from(commerceProductVariants)
              .where(
                and(
                  inArray(commerceProductVariants.product_id, productIds),
                  eq(commerceProductVariants.available, true),
                ),
              )
          ).map(({ productId }) => productId),
    );

    return catalogs.map((catalog) => {
      const catalogListings = listings.filter(
        ({ catalogId }) => catalogId === catalog.id,
      );
      const activeListings = catalogListings.filter(
        ({ status }) => status === "active",
      );
      const readyListings = activeListings.filter(
        ({ productId, productStatus }) =>
          productStatus === "active" && availableProducts.has(productId),
      );

      return {
        activeListings: activeListings.length,
        catalog,
        healthy: catalog.status !== "active" || readyListings.length > 0,
        listings: catalogListings.length,
        publishable: readyListings.length > 0,
        readyListings: readyListings.length,
      };
    });
  };

  const listOwnerCatalogs = (ownerKey: string) => posture(ownerKey);

  const listFleetCatalogs = () => posture();

  const workspace = async (ownerKey: string, catalogId: string) => {
    const catalog = await ownerCatalog(db, ownerKey, catalogId);
    const [listings, collections, memberships] = await Promise.all([
      db
        .select({ listing: commerceCatalogListings, product: commerceProducts })
        .from(commerceCatalogListings)
        .innerJoin(
          commerceProducts,
          eq(commerceCatalogListings.product_id, commerceProducts.id),
        )
        .where(eq(commerceCatalogListings.catalog_id, catalogId))
        .orderBy(asc(commerceCatalogListings.position)),
      db
        .select()
        .from(commerceCatalogCollections)
        .where(eq(commerceCatalogCollections.catalog_id, catalogId))
        .orderBy(asc(commerceCatalogCollections.position)),
      db
        .select({
          collectionId: commerceCatalogCollectionListings.collection_id,
          listingId: commerceCatalogCollectionListings.listing_id,
          position: commerceCatalogCollectionListings.position,
        })
        .from(commerceCatalogCollectionListings)
        .innerJoin(
          commerceCatalogCollections,
          eq(
            commerceCatalogCollectionListings.collection_id,
            commerceCatalogCollections.id,
          ),
        )
        .where(eq(commerceCatalogCollections.catalog_id, catalogId))
        .orderBy(asc(commerceCatalogCollectionListings.position)),
    ]);

    const catalogPosture = (await posture(ownerKey)).find(
      (entry) => entry.catalog.id === catalogId,
    );

    return {
      catalog,
      collections,
      listings,
      memberships,
      posture: catalogPosture ?? null,
    };
  };

  const saveCatalog = async (
    ownerKey: string,
    input: SaveStorefrontCatalogInput,
  ) => {
    assertSlug(input.slug);
    if (input.id) {
      await ownerCatalog(db, ownerKey, input.id);
      if (input.status === "active") await assertCatalogReady(db, input.id);
      const [updated] = await db
        .update(commerceCatalogs)
        .set({
          ...(input.brandKit === undefined
            ? {}
            : { brand_kit: input.brandKit }),
          ...(input.currency === undefined ? {} : { currency: input.currency }),
          ...(input.locale === undefined ? {} : { locale: input.locale }),
          name: input.name,
          ...(input.settings === undefined ? {} : { settings: input.settings }),
          slug: input.slug,
          ...(input.status === undefined ? {} : { status: input.status }),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(commerceCatalogs.id, input.id),
            eq(commerceCatalogs.owner_key, ownerKey),
          ),
        )
        .returning();

      return updated;
    }
    if (input.status === "active")
      throw new StorefrontMerchandisingError("storefront_not_ready");
    const [created] = await db
      .insert(commerceCatalogs)
      .values({
        brand_kit: input.brandKit,
        currency: input.currency,
        locale: input.locale,
        name: input.name,
        owner_key: ownerKey,
        settings: input.settings,
        slug: input.slug,
        status: input.status,
      })
      .returning();

    return created;
  };

  const saveListing = async (
    ownerKey: string,
    input: SaveStorefrontListingInput,
  ) => {
    assertSlug(input.slug);
    if (!storefrontPriceIsValid(input.basePriceCents, input.compareAtCents))
      throw new StorefrontMerchandisingError("invalid_price");
    if (
      !storefrontCustomizationIsValid(
        input.customizationMode,
        input.customization,
      )
    )
      throw new StorefrontMerchandisingError("invalid_customization");
    const catalog = await ownerCatalog(db, ownerKey, input.catalogId);
    await assertListingReady(db, ownerKey, input);
    if (input.id && catalog.status === "active" && input.status !== "active") {
      const [otherActiveListing] = await db
        .select({ id: commerceCatalogListings.id })
        .from(commerceCatalogListings)
        .where(
          and(
            eq(commerceCatalogListings.catalog_id, input.catalogId),
            eq(commerceCatalogListings.status, "active"),
            ne(commerceCatalogListings.id, input.id),
          ),
        )
        .limit(1);
      if (!otherActiveListing)
        throw new StorefrontMerchandisingError("storefront_not_ready");
    }
    const values = {
      base_price_cents: input.basePriceCents,
      catalog_id: input.catalogId,
      compare_at_cents: input.compareAtCents,
      customization: input.customization,
      customization_mode: input.customizationMode,
      description: input.description,
      metadata: input.metadata,
      position: input.position,
      product_id: input.productId,
      slug: input.slug,
      status: input.status,
      tags: input.tags,
      title: input.title,
      updated_at: new Date(),
    };
    if (input.id) {
      const [updated] = await db
        .update(commerceCatalogListings)
        .set(values)
        .where(
          and(
            eq(commerceCatalogListings.id, input.id),
            eq(commerceCatalogListings.catalog_id, input.catalogId),
          ),
        )
        .returning();
      if (!updated) throw new StorefrontMerchandisingError("listing_not_found");

      return updated;
    }
    const [created] = await db
      .insert(commerceCatalogListings)
      .values(values)
      .returning();

    return created;
  };

  const saveCollection = async (
    ownerKey: string,
    input: SaveStorefrontCollectionInput,
  ) => {
    assertSlug(input.slug);
    await ownerCatalog(db, ownerKey, input.catalogId);
    const values = {
      catalog_id: input.catalogId,
      description: input.description,
      image_url: input.imageUrl,
      position: input.position,
      slug: input.slug,
      status: input.status,
      title: input.title,
      updated_at: new Date(),
    };
    if (input.id) {
      const [updated] = await db
        .update(commerceCatalogCollections)
        .set(values)
        .where(
          and(
            eq(commerceCatalogCollections.id, input.id),
            eq(commerceCatalogCollections.catalog_id, input.catalogId),
          ),
        )
        .returning();
      if (!updated)
        throw new StorefrontMerchandisingError("collection_not_found");

      return updated;
    }
    const [created] = await db
      .insert(commerceCatalogCollections)
      .values(values)
      .returning();

    return created;
  };

  const setCollectionListing = async (
    ownerKey: string,
    input: { collectionId: string; listingId: string; position?: number },
  ) => {
    const [collection] = await db
      .select({ catalogId: commerceCatalogCollections.catalog_id })
      .from(commerceCatalogCollections)
      .innerJoin(
        commerceCatalogs,
        eq(commerceCatalogCollections.catalog_id, commerceCatalogs.id),
      )
      .where(
        and(
          eq(commerceCatalogCollections.id, input.collectionId),
          eq(commerceCatalogs.owner_key, ownerKey),
        ),
      )
      .limit(1);
    if (!collection)
      throw new StorefrontMerchandisingError("collection_not_found");
    const [listing] = await db
      .select({ catalogId: commerceCatalogListings.catalog_id })
      .from(commerceCatalogListings)
      .where(eq(commerceCatalogListings.id, input.listingId))
      .limit(1);
    if (!listing || listing.catalogId !== collection.catalogId)
      throw new StorefrontMerchandisingError("listing_not_found");
    const [membership] = await db
      .insert(commerceCatalogCollectionListings)
      .values({
        collection_id: input.collectionId,
        listing_id: input.listingId,
        position: input.position,
      })
      .onConflictDoUpdate({
        set: { position: input.position ?? 0 },
        target: [
          commerceCatalogCollectionListings.collection_id,
          commerceCatalogCollectionListings.listing_id,
        ],
      })
      .returning();

    return membership;
  };

  const removeCollectionListing = async (
    ownerKey: string,
    input: { collectionId: string; listingId: string },
  ) => {
    const catalog = await db
      .select({ id: commerceCatalogs.id })
      .from(commerceCatalogCollections)
      .innerJoin(
        commerceCatalogs,
        eq(commerceCatalogCollections.catalog_id, commerceCatalogs.id),
      )
      .where(
        and(
          eq(commerceCatalogCollections.id, input.collectionId),
          eq(commerceCatalogs.owner_key, ownerKey),
        ),
      )
      .limit(1);
    if (catalog.length === 0)
      throw new StorefrontMerchandisingError("collection_not_found");

    return db
      .delete(commerceCatalogCollectionListings)
      .where(
        and(
          eq(
            commerceCatalogCollectionListings.collection_id,
            input.collectionId,
          ),
          eq(commerceCatalogCollectionListings.listing_id, input.listingId),
        ),
      )
      .returning();
  };

  const publishedStorefront = async (ownerKey: string, slug: string) => {
    const [catalog] = await db
      .select()
      .from(commerceCatalogs)
      .where(
        and(
          eq(commerceCatalogs.owner_key, ownerKey),
          eq(commerceCatalogs.slug, slug),
          eq(commerceCatalogs.status, "active"),
        ),
      )
      .limit(1);
    if (!catalog) throw new StorefrontMerchandisingError("catalog_not_found");
    const listings = await db
      .select({ listing: commerceCatalogListings, product: commerceProducts })
      .from(commerceCatalogListings)
      .innerJoin(
        commerceProducts,
        eq(commerceCatalogListings.product_id, commerceProducts.id),
      )
      .where(
        and(
          eq(commerceCatalogListings.catalog_id, catalog.id),
          eq(commerceCatalogListings.status, "active"),
          eq(commerceProducts.status, "active"),
        ),
      )
      .orderBy(asc(commerceCatalogListings.position));
    if (listings.length === 0)
      throw new StorefrontMerchandisingError("storefront_not_ready");
    const variants =
      listings.length === 0
        ? []
        : await db
            .select()
            .from(commerceProductVariants)
            .where(
              and(
                inArray(
                  commerceProductVariants.product_id,
                  listings.map(({ product }) => product.id),
                ),
                eq(commerceProductVariants.available, true),
              ),
            )
            .orderBy(asc(commerceProductVariants.sku));
    const variantsByProduct = Map.groupBy(
      variants,
      ({ product_id }) => product_id,
    );
    const collections = await db
      .select()
      .from(commerceCatalogCollections)
      .where(
        and(
          eq(commerceCatalogCollections.catalog_id, catalog.id),
          eq(commerceCatalogCollections.status, "active"),
        ),
      )
      .orderBy(asc(commerceCatalogCollections.position));
    const memberships =
      collections.length === 0
        ? []
        : await db
            .select({
              collectionId: commerceCatalogCollectionListings.collection_id,
              listingId: commerceCatalogCollectionListings.listing_id,
              position: commerceCatalogCollectionListings.position,
            })
            .from(commerceCatalogCollectionListings)
            .where(
              inArray(
                commerceCatalogCollectionListings.collection_id,
                collections.map(({ id }) => id),
              ),
            )
            .orderBy(asc(commerceCatalogCollectionListings.position));

    return {
      catalog,
      collections,
      listings: listings.map((entry) => ({
        ...entry,
        variants: variantsByProduct.get(entry.product.id) ?? [],
      })),
      memberships,
    };
  };

  return {
    listFleetCatalogs,
    listOwnerCatalogs,
    publishedStorefront,
    removeCollectionListing,
    saveCatalog,
    saveCollection,
    saveListing,
    setCollectionListing,
    workspace,
  };
};

export type StorefrontMerchandisingService = ReturnType<
  typeof createStorefrontMerchandisingService
>;
