// React bindings for the commerce cart store. Import from
// `@absolutejs/commerce/react`. `react` is a peer dependency.

import { useState, useSyncExternalStore, type FormEvent } from "react";
import type { CartStore } from "../client/cartStore";
import type {
  PublishedStorefront,
  StorefrontCartLineInput,
  StorefrontCartQuote,
} from "../core/storefront";
import { storefrontCartLineKey } from "../core/storefront";

const EMPTY: never[] = [];

/** Live cart items for a store — re-renders on add/clear and cross-tab changes. */
export const useCart = <T,>(store: CartStore<T>) =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY as T[]);

/**
 * Live derived value over the cart (e.g. item count, subtotal). `select` runs
 * on the current items each render.
 */
export const useCartValue = <T, V>(
  store: CartStore<T>,
  select: (items: T[]) => V,
) => select(useCart(store));

const price = (amountCents: number, currency: string, locale: string) =>
  new Intl.NumberFormat(locale, {
    currency,
    style: "currency",
  }).format(amountCents / 100);

type Listing = PublishedStorefront["listings"][number];

export type StorefrontListingCardProps = {
  currency: string;
  entry: Listing;
  locale: string;
  onAdd: (line: StorefrontCartLineInput) => void;
};

export const StorefrontListingCard = ({
  currency,
  entry,
  locale,
  onAdd,
}: StorefrontListingCardProps) => {
  const [variantId, setVariantId] = useState(entry.variants[0]?.id ?? "");
  const variant = entry.variants.find(({ id }) => id === variantId);
  const amountCents = entry.listing.basePriceCents ?? variant?.priceCents;
  const image =
    variant?.media.find(({ kind }) => kind === "image") ??
    entry.product.media.find(({ kind }) => kind === "image");
  const policy = entry.listing.customization;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const buyerFields = Object.fromEntries(
      (policy.buyerFields ?? []).flatMap(({ id }) => {
        const value = String(data.get(`buyer:${id}`) ?? "").trim();

        return value ? [[id, value]] : [];
      }),
    );
    const approvedArtworkId = String(
      data.get("approvedArtworkId") ?? "",
    ).trim();
    const placement = String(data.get("placement") ?? "").trim();
    onAdd({
      customization: {
        ...(approvedArtworkId ? { approvedArtworkId } : {}),
        ...(Object.keys(buyerFields).length > 0 ? { buyerFields } : {}),
        ...(placement ? { placement } : {}),
      },
      listingId: entry.listing.id,
      quantity: Number(data.get("quantity")),
      variantId,
    });
  };

  return (
    <article className="absolute-storefront-product">
      {image ? (
        <img alt={image.alt ?? entry.product.title} src={image.url} />
      ) : (
        <div
          aria-hidden="true"
          className="absolute-storefront-product-placeholder"
        />
      )}
      <header>
        <span>{entry.product.brand}</span>
        <h3>{entry.listing.title ?? entry.product.title}</h3>
        {amountCents == null ? null : (
          <strong>{price(amountCents, currency, locale)}</strong>
        )}
      </header>
      <p>{entry.listing.description ?? entry.product.description}</p>
      <form onSubmit={submit}>
        <label>
          Variant
          <select
            onChange={(event) => setVariantId(event.currentTarget.value)}
            value={variantId}
          >
            {entry.variants.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {Object.values(candidate.options).join(" · ") || candidate.sku}
              </option>
            ))}
          </select>
        </label>
        {policy.approvedArtwork?.length ? (
          <label>
            Artwork
            <select
              name="approvedArtworkId"
              required={entry.listing.customizationMode === "approved"}
            >
              <option value="">No approved artwork</option>
              {policy.approvedArtwork.map((artwork) => (
                <option key={artwork.id} value={artwork.id}>
                  {artwork.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {policy.allowedPlacements?.length ? (
          <label>
            Placement
            <select name="placement">
              <option value="">Default placement</option>
              {policy.allowedPlacements.map((placement) => (
                <option key={placement} value={placement}>
                  {placement}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {policy.buyerFields?.map((field) => (
          <label key={field.id}>
            {field.label}
            {field.type === "select" ? (
              <select name={`buyer:${field.id}`} required={field.required}>
                <option value="">Select</option>
                {field.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input name={`buyer:${field.id}`} required={field.required} />
            )}
          </label>
        ))}
        <label>
          Quantity
          <input
            defaultValue="1"
            max="1000"
            min="1"
            name="quantity"
            type="number"
          />
        </label>
        <button disabled={!variant || amountCents == null} type="submit">
          Add to cart
        </button>
      </form>
    </article>
  );
};

export type StorefrontRendererProps = {
  cart: StorefrontCartLineInput[];
  checkoutDisabledReason?: string;
  checkoutPending?: boolean;
  onAdd: (line: StorefrontCartLineInput) => void;
  onCheckout: () => void;
  onRemove: (key: string) => void;
  quote?: StorefrontCartQuote | null;
  storefront: PublishedStorefront;
};

export const StorefrontRenderer = ({
  cart,
  checkoutDisabledReason,
  checkoutPending = false,
  onAdd,
  onCheckout,
  onRemove,
  quote,
  storefront,
}: StorefrontRendererProps) => (
  <section className="absolute-storefront">
    <header className="absolute-storefront-header">
      <p>{storefront.catalog.brandKit.name ?? "Storefront"}</p>
      <h2>{storefront.catalog.name}</h2>
      {storefront.collections.length ? (
        <nav aria-label="Storefront collections">
          {storefront.collections.map((collection) => (
            <a href={`#collection-${collection.slug}`} key={collection.id}>
              {collection.title}
            </a>
          ))}
        </nav>
      ) : null}
    </header>
    <div className="absolute-storefront-grid">
      {storefront.listings.map((entry) => (
        <StorefrontListingCard
          currency={storefront.catalog.currency}
          entry={entry}
          key={entry.listing.id}
          locale={storefront.catalog.locale}
          onAdd={onAdd}
        />
      ))}
    </div>
    <aside className="absolute-storefront-cart">
      <h3>Cart</h3>
      {cart.length === 0 ? <p>Your cart is empty.</p> : null}
      {cart.map((line) => {
        const key = storefrontCartLineKey(line);
        const resolved = quote?.lines.find(
          (candidate) =>
            candidate.listingId === line.listingId &&
            candidate.variantId === line.variantId,
        );

        return (
          <div className="absolute-storefront-cart-line" key={key}>
            <span>{resolved?.name ?? "Product"}</span>
            <span>× {line.quantity}</span>
            <button onClick={() => onRemove(key)} type="button">
              Remove
            </button>
          </div>
        );
      })}
      {quote ? (
        <strong>
          Subtotal{" "}
          {price(
            quote.subtotalCents,
            quote.currency,
            storefront.catalog.locale,
          )}
        </strong>
      ) : null}
      {checkoutDisabledReason ? <p>{checkoutDisabledReason}</p> : null}
      <button
        disabled={
          cart.length === 0 ||
          !quote ||
          checkoutPending ||
          Boolean(checkoutDisabledReason)
        }
        onClick={onCheckout}
        type="button"
      >
        {checkoutPending ? "Starting checkout…" : "Checkout"}
      </button>
    </aside>
  </section>
);
