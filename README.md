# @absolutejs/commerce

Provider-agnostic commerce primitives for [AbsoluteJS](https://absolutejs.ai)
apps — so every shop isn't rebuilding cart, checkout, orders, and fulfillment
from scratch.

## Multi-store product catalogs

The catalog domain separates canonical supplier truth from storefront
merchandising:

- `CatalogProduct` is a branded style such as SanMar `PC54`.
- `ProductVariant` is one exact purchasable supplier SKU (color/size/options).
- `CatalogListing` exposes that product in a particular corporate store with
  store-specific copy, pricing, approved artwork, and customization rules.
- `CatalogCollection` organizes large assortments without duplicating products.
- `CatalogSourceProvider` is the adapter contract for supplier feeds and live
  inventory.
- Optional provider taxonomy discovery feeds durable categories and
  subcategories without hardcoded provider lists.
- Supplier sync checkpoints and batch variant upserts make large feed imports
  resumable and efficient; listing queries filter by search, brand, category,
  and product type.

That model supports one supplier product being reused across hundreds of
tenant catalogs while every store remains independently merchandised.

```ts
import {
  findVariantByOptions,
  listingPriceCents,
  type CatalogSourceProvider,
} from "@absolutejs/commerce";

const variant = findVariantByOptions(product.variants, {
  Color: "Navy",
  Size: "XL",
});
const price = listingPriceCents(product.listing, variant);
```

The `@absolutejs/commerce/drizzle` export includes normalized catalog,
products, variants, listings, collections, and collection-membership tables,
plus idempotent supplier-ingestion and storefront query helpers.
`synchronizeCatalogSource()` adds generation-fenced full synchronization,
source-namespaced product/SKU identity for account-scoped costs, missing-item
archival, durable run evidence, safe failure codes, and indexed database-backed
search. The schema uses a portable JSON codec compatible with Bun SQL and other
Postgres drivers.

`createStorefrontMerchandisingService()` is the tenant-fenced authoring and
publication boundary. It owns draft/active/archive workflows for catalogs,
listings, collections, membership ordering, price overrides, approved artwork,
allowed placements, and buyer fields. A listing cannot publish unless its
owner-scoped supplier product is active with an available variant; a storefront
cannot publish without a ready listing. Published projections contain only
active product truth and available variants, while fleet posture identifies an
active storefront that later became unhealthy after a supplier sync.

`resolveStorefrontCart()` is the checkout trust boundary. Browser carts retain
only listing, variant, quantity, and customization identities; the server
resolves those identities against the current ready-only storefront projection,
rechecks availability and buyer-field/artwork policy, and calculates every
price from canonical data. `createStorefrontCheckout()` forwards only that
resolved quote plus a host-owned idempotency key to a `PaymentProvider`.

The `./react` export includes a reusable `StorefrontRenderer` and listing/card
controls, while `./client` includes a storefront-scoped persistent cart store.
Both remain provider-neutral and can be styled by the host without replacing
the cart or checkout contracts.

`FulfillmentCostQuoteProvider` is the read-only preflight seam for providers
that can price an exact set of fulfillment lines and destination. Quotes expose
normalized item, shipping, and adjustment costs, but deliberately do not claim
to reserve provider inventory or pricing. Spending applications refresh the
quote immediately before authorization and bind final settlement to the
provider's accepted cost.

Follows the same shape as `@absolutejs/voice`: a host package holds the
**agnostic logic + adapter contracts**, and provider implementations live in
the [`commerce-adapters`](https://github.com/absolutejs/commerce-adapters)
monorepo (Apache-2.0).

## v0 — shipping contract

The first slice is the carrier-agnostic shipping interface. Apps program against
`ShippingProvider`; a carrier adapter (e.g. `@absolutejs/commerce-easypost`)
implements it, so a shop can plug in whatever carrier account it already uses.

```ts
import type { ShippingProvider } from "@absolutejs/commerce";
import { createEasyPostProvider } from "@absolutejs/commerce-easypost";

const shipping: ShippingProvider = createEasyPostProvider({
  apiKey: process.env.EASYPOST_API_KEY!,
});

const label = await shipping.buyCheapestLabel({ from, to, parcel });
// → { trackingNumber, labelUrl, carrier, service, amount, … }
```

## Roadmap

Being lifted from real AbsoluteJS shops next, against the same adapter pattern:

- Additional supplier adapters and incremental catalog synchronization
- Order lifecycle + production-stage state machine
- Durable provider-webhook order orchestration over the server-repriced checkout
- Discount-code engine
- B2B quotes → deposit → fulfill
- Branded transactional emails, proof-approval, `./drizzle` schema builders,
  and a `./client` cart SDK

## License

BSL-1.1 (converts to Apache-2.0 on the Change Date in `LICENSE`).
