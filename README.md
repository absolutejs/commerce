# @absolutejs/commerce

Provider-agnostic commerce primitives for [AbsoluteJS](https://absolutejs.ai)
apps — so every shop isn't rebuilding cart, checkout, orders, and fulfillment
from scratch.

Follows the same shape as `@absolutejs/voice`: a host package holds the
**agnostic logic + adapter contracts**, and provider implementations live in
the [`commerce-adapters`](https://github.com/absolutejs/commerce-adapters)
monorepo (Apache-2.0).

## v0 — shipping contract

The first slice is the carrier-agnostic shipping interface. Apps program against
`ShippingProvider`; a carrier adapter (e.g. `@absolutejs/commerce-easypost`)
implements it, so a shop can plug in whatever carrier account it already uses.

```ts
import type { ShippingProvider } from '@absolutejs/commerce';
import { createEasyPostProvider } from '@absolutejs/commerce-easypost';

const shipping: ShippingProvider = createEasyPostProvider({
	apiKey: process.env.EASYPOST_API_KEY!
});

const label = await shipping.buyCheapestLabel({ from, to, parcel });
// → { trackingNumber, labelUrl, carrier, service, amount, … }
```

## Roadmap

Being lifted from real AbsoluteJS shops next, against the same adapter pattern:

- Cart + pricing engine (variants, options, quantity breaks, setup fees)
- Order lifecycle + production-stage state machine
- `PaymentProvider` contract (Stripe adapter) + server-side re-pricing + webhook
  fulfillment
- Discount-code engine
- B2B quotes → deposit → fulfill
- Branded transactional emails, proof-approval, `./drizzle` schema builders,
  and a `./client` cart SDK

## License

BSL-1.1 (converts to Apache-2.0 on the Change Date in `LICENSE`).
