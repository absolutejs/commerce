import { createCartStore, type CartStore } from "./cartStore";

const ORDER_REFERENCE_LIMIT = 50;

export type StorefrontOrderAccessReference = {
  checkoutIntentId: string;
  createdAt: string;
  orderAccessToken: string;
};

export const normalizeStorefrontOrderAccess = (
  raw: unknown,
): StorefrontOrderAccessReference[] => {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(
      (candidate): candidate is StorefrontOrderAccessReference =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        typeof candidate.checkoutIntentId === "string" &&
        typeof candidate.createdAt === "string" &&
        typeof candidate.orderAccessToken === "string" &&
        candidate.orderAccessToken.length >= 32,
    )
    .slice(-ORDER_REFERENCE_LIMIT);
};

export type StorefrontOrderAccessStore =
  CartStore<StorefrontOrderAccessReference> & {
    retain(reference: StorefrontOrderAccessReference): void;
  };

export const createStorefrontOrderAccessStore = (
  storefrontId: string,
): StorefrontOrderAccessStore => {
  const store = createCartStore<StorefrontOrderAccessReference>(
    `absolute-commerce:storefront-orders:${storefrontId}`,
    normalizeStorefrontOrderAccess,
  );

  return {
    ...store,
    retain(reference) {
      store.write(
        normalizeStorefrontOrderAccess([
          ...store
            .read()
            .filter(
              (candidate) =>
                candidate.checkoutIntentId !== reference.checkoutIntentId,
            ),
          reference,
        ]),
      );
    },
  };
};
