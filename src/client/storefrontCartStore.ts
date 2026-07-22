import type { StorefrontCartLineInput } from "../core/storefront";
import { normalizeStorefrontCart } from "../core/storefront";
import { createCartStore } from "./cartStore";

export const createStorefrontCartStore = (storefrontId: string) =>
  createCartStore<StorefrontCartLineInput>(
    `absolute-commerce:storefront:${storefrontId}`,
    normalizeStorefrontCart,
  );
