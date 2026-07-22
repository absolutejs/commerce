import { describe, expect, it } from "bun:test";
import type { PublishedStorefront } from "./storefront";
import {
  createStorefrontCheckout,
  resolveStorefrontCart,
  StorefrontCartError,
  upsertStorefrontCartLine,
} from "./storefront";

const storefront = (): PublishedStorefront => ({
  catalog: {
    brandKit: { assets: [], colors: [], fonts: [] },
    currency: "USD",
    id: "catalog-a",
    locale: "en-US",
    name: "Team store",
    ownerKey: "tenant-a",
    settings: {},
    slug: "team-store",
    status: "active",
  },
  collections: [],
  listings: [
    {
      listing: {
        basePriceCents: 2_400,
        catalogId: "catalog-a",
        customization: {
          approvedArtwork: [
            { id: "logo-a", name: "Logo", url: "https://cdn.test/logo.png" },
          ],
          buyerFields: [
            { id: "name", label: "Name", required: true, type: "text" },
          ],
        },
        customizationMode: "approved",
        id: "listing-a",
        metadata: {},
        position: 0,
        productId: "product-a",
        slug: "team-tee",
        status: "active",
        tags: [],
        title: "Team tee",
      },
      product: {
        attributes: {},
        brand: "Absolute",
        category: "shirts",
        decorationAreas: [],
        description: "A tee",
        id: "product-a",
        media: [],
        metadata: {},
        optionNames: ["Size"],
        productType: "tee",
        slug: "tee",
        status: "active",
        styleCode: "TEE",
        tags: [],
        title: "Tee",
      },
      variants: [
        {
          available: true,
          currency: "USD",
          id: "variant-a",
          inventoryPolicy: "external",
          media: [],
          metadata: {},
          options: { Size: "M" },
          priceCents: 1,
          productId: "product-a",
          sku: "TEE-M",
        },
      ],
    },
  ],
  memberships: [],
});

const line = {
  customization: {
    approvedArtworkId: "logo-a",
    buyerFields: { name: "Alex" },
  },
  listingId: "listing-a",
  quantity: 2,
  variantId: "variant-a",
};

describe("storefront cart", () => {
  it("reprices untrusted cart identity from the published storefront", () => {
    const quote = resolveStorefrontCart(storefront(), [line]);
    expect(quote.subtotalCents).toBe(4_800);
    expect(quote.lines[0]?.unitAmountCents).toBe(2_400);
  });

  it("rejects stale variants and invalid customization", () => {
    expect(() =>
      resolveStorefrontCart(storefront(), [{ ...line, variantId: "foreign" }]),
    ).toThrow(StorefrontCartError);
    expect(() =>
      resolveStorefrontCart(storefront(), [
        { ...line, customization: { approvedArtworkId: "foreign" } },
      ]),
    ).toThrow(StorefrontCartError);
  });

  it("merges identical browser lines without exceeding the line cap", () => {
    expect(upsertStorefrontCartLine([line], line)[0]?.quantity).toBe(4);
  });

  it("passes only server-resolved prices and retry identity to checkout", async () => {
    let received: unknown;
    const result = await createStorefrontCheckout({
      cancelUrl: "https://shop.test/cancel",
      idempotencyKey: "checkout-a",
      input: [line],
      payment: {
        createCheckout: async (input) => {
          received = input;

          return {
            clientSecret: null,
            id: "session-a",
            url: "https://pay.test/a",
          };
        },
      },
      storefront: storefront(),
      successUrl: "https://shop.test/success",
    });
    expect(result.checkout.id).toBe("session-a");
    expect(received).toMatchObject({
      idempotencyKey: "checkout-a",
      lineItems: [{ amountCents: 2_400, quantity: 2 }],
    });
  });
});
