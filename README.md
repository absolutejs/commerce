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

- Supplier adapters and scheduled catalog synchronization
- Order lifecycle + production-stage state machine
- `PaymentProvider` contract (Stripe adapter) + server-side re-pricing + webhook
  fulfillment
- Discount-code engine
- B2B quotes → deposit → fulfill
- Branded transactional emails, proof-approval, `./drizzle` schema builders,
  and a `./client` cart SDK

## License

BSL-1.1 (converts to Apache-2.0 on the Change Date in `LICENSE`).
