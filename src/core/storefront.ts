import type {
  Catalog,
  CatalogCollection,
  ResolvedCatalogListing,
} from "./catalog";
import { listingPriceCents, variantIsAvailable } from "./catalog";
import type { CheckoutResult, PaymentProvider } from "./payment";

const MAX_CART_LINES = 100;
const MAX_LINE_QUANTITY = 1_000;

export type PublishedStorefront = {
  catalog: Catalog;
  collections: CatalogCollection[];
  listings: ResolvedCatalogListing[];
  memberships: Array<{
    collectionId: string;
    listingId: string;
    position: number;
  }>;
};

export type StorefrontCartCustomization = {
  approvedArtworkId?: string;
  artworkAssetId?: string;
  buyerFields?: Record<string, string>;
  placement?: string;
};

export type StorefrontCartLineInput = {
  customization?: StorefrontCartCustomization;
  listingId: string;
  quantity: number;
  variantId: string;
};

export type ResolvedStorefrontCartLine = {
  amountCents: number;
  customization: StorefrontCartCustomization;
  description?: string;
  listingId: string;
  name: string;
  quantity: number;
  unitAmountCents: number;
  variantId: string;
};

export type StorefrontCartQuote = {
  catalogId: string;
  currency: string;
  lines: ResolvedStorefrontCartLine[];
  storefrontSlug: string;
  subtotalCents: number;
};

export type StorefrontCartErrorCode =
  | "cart_empty"
  | "cart_too_large"
  | "customization_invalid"
  | "listing_unavailable"
  | "price_unavailable"
  | "quantity_invalid"
  | "storefront_unavailable"
  | "variant_unavailable";

export class StorefrontCartError extends Error {
  constructor(readonly code: StorefrontCartErrorCode) {
    super(`Storefront cart failed (${code})`);
    this.name = "StorefrontCartError";
  }
}

const normalizedCustomization = (
  listing: ResolvedCatalogListing["listing"],
  input: StorefrontCartCustomization = {},
) => {
  const policy = listing.customization;
  const mode = listing.customizationMode;
  const approvedArtwork = input.approvedArtworkId
    ? policy.approvedArtwork?.find(({ id }) => id === input.approvedArtworkId)
    : undefined;
  const buyerFields = input.buyerFields ?? {};
  const knownFields = new Set((policy.buyerFields ?? []).map(({ id }) => id));
  const invalidField = Object.keys(buyerFields).some(
    (fieldId) => !knownFields.has(fieldId),
  );
  const invalidValue = (policy.buyerFields ?? []).some((field) => {
    const value = buyerFields[field.id]?.trim() ?? "";
    if (field.required && !value) return true;

    return field.type === "select" && value
      ? !field.options?.includes(value)
      : false;
  });
  const placementAllowed =
    !input.placement ||
    !policy.allowedPlacements?.length ||
    policy.allowedPlacements.includes(input.placement);
  const artworkPlacementAllowed =
    !input.placement ||
    !approvedArtwork?.placements?.length ||
    approvedArtwork.placements.includes(input.placement);
  const hasApproved = Boolean(approvedArtwork);
  const hasCustom = Boolean(input.artworkAssetId?.trim());
  const modeIsValid =
    (mode === "none" && !hasApproved && !hasCustom && !input.placement) ||
    (mode === "approved" && hasApproved && !hasCustom) ||
    (mode === "customizable" && !hasApproved) ||
    (mode === "both" && !(hasApproved && hasCustom));
  if (
    (input.approvedArtworkId && !approvedArtwork) ||
    invalidField ||
    invalidValue ||
    !placementAllowed ||
    !artworkPlacementAllowed ||
    !modeIsValid
  )
    throw new StorefrontCartError("customization_invalid");

  return {
    ...(hasApproved ? { approvedArtworkId: approvedArtwork!.id } : {}),
    ...(hasCustom ? { artworkAssetId: input.artworkAssetId!.trim() } : {}),
    ...(Object.keys(buyerFields).length > 0 ? { buyerFields } : {}),
    ...(input.placement ? { placement: input.placement } : {}),
  };
};

export const normalizeStorefrontCart = (
  raw: unknown,
): StorefrontCartLineInput[] => {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const line = candidate as Record<string, unknown>;
    if (
      typeof line.listingId !== "string" ||
      typeof line.variantId !== "string" ||
      typeof line.quantity !== "number"
    )
      return [];

    return [candidate as StorefrontCartLineInput];
  });
};

export const storefrontCartLineKey = (line: StorefrontCartLineInput) =>
  JSON.stringify([
    line.listingId,
    line.variantId,
    line.customization?.approvedArtworkId ?? "",
    line.customization?.artworkAssetId ?? "",
    line.customization?.placement ?? "",
    Object.entries(line.customization?.buyerFields ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    ),
  ]);

export const upsertStorefrontCartLine = (
  lines: StorefrontCartLineInput[],
  line: StorefrontCartLineInput,
) => {
  const key = storefrontCartLineKey(line);
  const existing = lines.findIndex(
    (candidate) => storefrontCartLineKey(candidate) === key,
  );
  if (existing < 0) return [...lines, line];

  return lines.map((candidate, index) =>
    index === existing
      ? {
          ...candidate,
          quantity: Math.min(
            MAX_LINE_QUANTITY,
            candidate.quantity + line.quantity,
          ),
        }
      : candidate,
  );
};

export const removeStorefrontCartLine = (
  lines: StorefrontCartLineInput[],
  key: string,
) => lines.filter((line) => storefrontCartLineKey(line) !== key);

export const resolveStorefrontCart = (
  storefront: PublishedStorefront,
  input: StorefrontCartLineInput[],
): StorefrontCartQuote => {
  if (storefront.catalog.status !== "active")
    throw new StorefrontCartError("storefront_unavailable");
  if (input.length === 0) throw new StorefrontCartError("cart_empty");
  if (input.length > MAX_CART_LINES)
    throw new StorefrontCartError("cart_too_large");

  const lines = input.map((requested): ResolvedStorefrontCartLine => {
    if (
      !Number.isSafeInteger(requested.quantity) ||
      requested.quantity < 1 ||
      requested.quantity > MAX_LINE_QUANTITY
    )
      throw new StorefrontCartError("quantity_invalid");
    const entry = storefront.listings.find(
      ({ listing }) => listing.id === requested.listingId,
    );
    if (!entry || entry.listing.status !== "active")
      throw new StorefrontCartError("listing_unavailable");
    const variant = entry.variants.find(({ id }) => id === requested.variantId);
    if (!variant || !variantIsAvailable(variant))
      throw new StorefrontCartError("variant_unavailable");
    const unitAmountCents = listingPriceCents(entry.listing, variant);
    if (
      unitAmountCents == null ||
      !Number.isSafeInteger(unitAmountCents) ||
      unitAmountCents < 0 ||
      (entry.listing.basePriceCents == null &&
        variant.currency.toUpperCase() !==
          storefront.catalog.currency.toUpperCase())
    )
      throw new StorefrontCartError("price_unavailable");
    const amountCents = unitAmountCents * requested.quantity;
    if (!Number.isSafeInteger(amountCents))
      throw new StorefrontCartError("price_unavailable");

    return {
      amountCents,
      customization: normalizedCustomization(
        entry.listing,
        requested.customization,
      ),
      description: entry.listing.description ?? entry.product.description,
      listingId: entry.listing.id,
      name: entry.listing.title ?? entry.product.title,
      quantity: requested.quantity,
      unitAmountCents,
      variantId: variant.id,
    };
  });
  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (!Number.isSafeInteger(subtotalCents))
    throw new StorefrontCartError("price_unavailable");

  return {
    catalogId: storefront.catalog.id,
    currency: storefront.catalog.currency,
    lines,
    storefrontSlug: storefront.catalog.slug,
    subtotalCents,
  };
};

export const createStorefrontCheckout = async (options: {
  cancelUrl: string;
  idempotencyKey: string;
  input: StorefrontCartLineInput[];
  metadata?: Record<string, string>;
  payment: Pick<PaymentProvider, "createCheckout">;
  storefront: PublishedStorefront;
  successUrl: string;
}): Promise<{ checkout: CheckoutResult; quote: StorefrontCartQuote }> => {
  const quote = resolveStorefrontCart(options.storefront, options.input);
  const checkout = await options.payment.createCheckout({
    cancelUrl: options.cancelUrl,
    currency: quote.currency,
    idempotencyKey: options.idempotencyKey,
    lineItems: quote.lines.map((line) => ({
      amountCents: line.unitAmountCents,
      description: line.description,
      name: line.name,
      quantity: line.quantity,
    })),
    metadata: {
      ...options.metadata,
      catalogId: quote.catalogId,
      storefrontSlug: quote.storefrontSlug,
    },
    shipping: { countries: ["US"], mode: "collect" },
    successUrl: options.successUrl,
    uiMode: "hosted",
  });

  return { checkout, quote };
};
