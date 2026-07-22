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

`createStorefrontPaymentService()` adds the durable merchant-payment boundary.
Provider installations are tenant fenced, reference host-owned secret aliases,
and are disabled unless both the host feature gate and installation state allow
payments. Checkout intent identity is persisted before provider work. Signed
webhooks are verified before persistence, deduplicated by provider event id,
and transactionally create one paid order and one pending fulfillment job after
checking the tenant, installation, session, amount, and currency.

`createStorefrontFulfillmentService()` owns the separately gated provider-effect
boundary after payment. It leases pending jobs with compare-and-set ownership,
quarantines expired or ambiguous submissions, validates a host-prepared exact
provider request before submission, and polls retained provider order IDs until
terminal state. Retry and quarantine controls are tenant fenced; provider
credentials are resolved only after both the platform gate and installation are
enabled.

`createStorefrontOrderService()` closes the post-purchase loop. Checkout stores
only a SHA-256 digest of a browser-generated order-access token, allowing a
guest to retrieve exactly its checkout/order without exposing order inventory
by email or identifier. The service exposes redacted owner/fleet history,
transactional lifecycle events, leased idempotent notification delivery, and a
separately gated cancellation/refund coordinator. Cancellation confirms or
skips fulfillment before invoking a payment refund with the durable action ID;
ambiguous fulfillment or payment effects quarantine until an explicit
tenant-fenced retry.

`createStorefrontAftercareService()` replaces one-off return tables with a
single durable order-linked case substrate for returns, exchanges, payment
disputes, and customer support. Guest access reuses the secret checkout token;
owner and fleet views retain assignment, internal notes, public conversation,
structured resolutions, optimistic transition fencing, and stable lifecycle
events. Customer requests and notification delivery are separately gated.
Signed payment dispute events correlate through the provider payment identity
and upsert one case without exposing raw provider payloads. Approved full
returns can enqueue a distinct post-delivery refund action, so shipped-order
refunds never run through fulfillment cancellation.

`createStorefrontAftercareEvidenceService()` owns the private attachment and
payment-dispute evidence lifecycle. Uploads begin in `pending_scan`, use leased
inspection, and remain hidden from customers unless clean. Infected bytes stay
quarantined, scanner failures fail closed, and terminal-case retention cleanup
deletes through a host-supplied blob boundary. Dispute evidence jobs accept
only clean case-owned attachments, preserve stable provider idempotency, and
quarantine ambiguous submission outcomes. A retry is prohibited until a leased
provider reconciliation confirms the intended effect was not applied; applied
effects converge on the retained staged/submitted record. The same service
emits idempotent 72-hour, 24-hour, and overdue deadline events through the case
event substrate. Provider adapters implement `reconcileDisputeEvidence` and
`submitDisputeEvidence`; the host independently gates reconciliation, staging,
and final payment-network submission.

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
- Multi-provider storefront order splitting and fulfillment webhook ingestion
- Discount-code engine
- B2B quotes → deposit → fulfill
- Branded transactional emails, proof-approval, `./drizzle` schema builders,
  and a `./client` cart SDK

## License

BSL-1.1 (converts to Apache-2.0 on the Change Date in `LICENSE`).
