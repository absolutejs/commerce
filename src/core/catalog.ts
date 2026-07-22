// Provider-agnostic product catalog primitives. A canonical product represents
// supplier/manufacturer truth; a CatalogListing merchandises that product in a
// particular storefront. This separation lets hundreds of products be shared
// across many corporate stores without copying supplier data into every shop.

export type CatalogStatus = "draft" | "active" | "archived";
export type ProductStatus = "draft" | "active" | "archived";
export type ListingStatus = "draft" | "active" | "hidden" | "archived";
export type InventoryPolicy = "deny" | "continue" | "external";
export type ProductMediaKind = "image" | "model" | "video" | "mockup";
export type ProductMediaView =
  "front" | "back" | "left" | "right" | "detail" | "model" | "other";

export type BrandColor = {
  name: string;
  hex: string;
  pantone?: string;
};

export type BrandAsset = {
  id: string;
  name: string;
  type: "logo" | "icon" | "pattern" | "other";
  url: string;
  variant?: "primary" | "secondary" | "light" | "dark" | "other";
};

/** Store/company identity plus reusable customer-approved design assets. */
export type BrandKit = {
  name?: string;
  assets: BrandAsset[];
  colors: BrandColor[];
  fonts: { name: string; family?: string; url?: string }[];
  guidelinesUrl?: string;
  notes?: string;
};

export const emptyBrandKit = (): BrandKit => ({
  assets: [],
  colors: [],
  fonts: [],
});

export type Catalog = {
  id: string;
  /** Host-controlled tenant/company identifier. */
  ownerKey?: string | null;
  slug: string;
  name: string;
  status: CatalogStatus;
  currency: string;
  locale: string;
  brandKit: BrandKit;
  settings: Record<string, unknown>;
};

export type CatalogSource = {
  id: string;
  provider: string;
  name: string;
  status: "active" | "paused" | "error";
  /** Non-secret adapter configuration. Store credentials in the host secret store. */
  settings: Record<string, unknown>;
  cursor?: string | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
};

export type ProductMedia = {
  id?: string;
  kind: ProductMediaKind;
  url: string;
  alt?: string;
  view?: ProductMediaView;
  /** Supplier color code/name this asset depicts; absent means universal. */
  color?: string;
  position?: number;
};

export type DecorationArea = {
  id: string;
  name: string;
  methods: string[];
  widthIn?: number;
  heightIn?: number;
  metadata?: Record<string, unknown>;
};

export type CatalogProduct = {
  id: string;
  sourceId?: string | null;
  externalId?: string | null;
  brand: string;
  styleCode: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  productType: string;
  status: ProductStatus;
  tags: string[];
  /** Ordered option names, e.g. ["Color", "Size"]. */
  optionNames: string[];
  attributes: Record<string, string | number | boolean | string[]>;
  media: ProductMedia[];
  decorationAreas: DecorationArea[];
  metadata: Record<string, unknown>;
};

export type ProductVariant = {
  id: string;
  productId: string;
  externalId?: string | null;
  sku: string;
  supplierSku?: string | null;
  barcode?: string | null;
  /** Generic option map supports apparel and non-apparel catalogs alike. */
  options: Record<string, string>;
  priceCents?: number | null;
  compareAtCents?: number | null;
  costCents?: number | null;
  currency: string;
  inventoryPolicy: InventoryPolicy;
  inventoryQuantity?: number | null;
  available: boolean;
  media: ProductMedia[];
  metadata: Record<string, unknown>;
};

export type CatalogListing = {
  id: string;
  catalogId: string;
  productId: string;
  slug: string;
  status: ListingStatus;
  position: number;
  /** Store-specific merchandising overrides. */
  title?: string | null;
  description?: string | null;
  basePriceCents?: number | null;
  compareAtCents?: number | null;
  tags: string[];
  /** approved | customizable | both | none */
  customizationMode: "approved" | "customizable" | "both" | "none";
  /** Approved art/placements, decoration constraints, buyer fields, etc. */
  customization: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type ResolvedCatalogListing = {
  listing: CatalogListing;
  product: CatalogProduct;
  variants: ProductVariant[];
};

export type CatalogCollection = {
  id: string;
  catalogId: string;
  slug: string;
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  status: CatalogStatus;
  position: number;
};

export type CatalogPage<T> = {
  items: T[];
  nextCursor?: string | null;
};

export type InventoryLevel = {
  sku: string;
  available: boolean;
  quantity?: number | null;
  updatedAt?: string;
};

/** Implemented by supplier adapters such as SanMar or S&S Activewear. */
export interface CatalogSourceProvider {
  readonly id: string;
  listProducts(input?: {
    cursor?: string;
    limit?: number;
    /** Provider-neutral free-text search across product and variant identity. */
    search?: string;
    updatedAfter?: string;
  }): Promise<
    CatalogPage<{ product: CatalogProduct; variants: ProductVariant[] }>
  >;
  getProduct?(externalId: string): Promise<{
    product: CatalogProduct;
    variants: ProductVariant[];
  } | null>;
  getInventory?(skus: string[]): Promise<InventoryLevel[]>;
}

const normalizeKey = (value: string) => value.trim().toLocaleLowerCase();

/** A variant may be sold when its feed says available and policy permits stock. */
export const variantIsAvailable = (variant: ProductVariant) => {
  if (!variant.available) return false;
  if (variant.inventoryPolicy !== "deny") return true;

  return (variant.inventoryQuantity ?? 0) > 0;
};

/** Resolve an exact SKU from arbitrary product options (case-insensitive). */
export const findVariantByOptions = (
  variants: ProductVariant[],
  selected: Record<string, string>,
) => {
  const wanted = Object.entries(selected).map(
    ([key, value]) => [normalizeKey(key), normalizeKey(value)] as const,
  );

  return (
    variants.find((variant) => {
      const options = new Map(
        Object.entries(variant.options).map(
          ([key, value]) => [normalizeKey(key), normalizeKey(value)] as const,
        ),
      );

      return wanted.every(([key, value]) => options.get(key) === value);
    }) ?? null
  );
};

/** Ordered, deduplicated option values for storefront selectors. */
export const optionValues = (
  variants: ProductVariant[],
  optionName: string,
  availableOnly = false,
) => {
  const key = normalizeKey(optionName);
  const seen = new Set<string>();
  const values: string[] = [];
  variants.forEach((variant) => {
    if (availableOnly && !variantIsAvailable(variant)) return;
    const entry = Object.entries(variant.options).find(
      ([name]) => normalizeKey(name) === key,
    );
    const value = entry?.[1]?.trim();
    if (!value || seen.has(normalizeKey(value))) return;
    seen.add(normalizeKey(value));
    values.push(value);
  });

  return values;
};

/** Listing price wins; otherwise use the exact variant's supplier/base price. */
export const listingPriceCents = (
  listing: CatalogListing,
  variant?: ProductVariant | null,
) => listing.basePriceCents ?? variant?.priceCents ?? null;

/** Prefer exact-color imagery, then neutral/unscoped supplier imagery. */
export const mediaForColor = (media: ProductMedia[], color?: string) => {
  if (!color) return [...media].sort(mediaPosition);
  const wanted = normalizeKey(color);
  const exact = media.filter(
    (item) => item.color && normalizeKey(item.color) === wanted,
  );
  const universal = media.filter((item) => !item.color);

  return [...exact, ...universal].sort(mediaPosition);
};

const mediaPosition = (left: ProductMedia, right: ProductMedia) =>
  (left.position ?? Number.MAX_SAFE_INTEGER) -
  (right.position ?? Number.MAX_SAFE_INTEGER);
