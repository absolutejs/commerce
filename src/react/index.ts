// React bindings for the commerce cart store. Import from
// `@absolutejs/commerce/react`. `react` is a peer dependency.

import { useSyncExternalStore } from 'react';
import type { CartStore } from '../client/cartStore';

const EMPTY: never[] = [];

/** Live cart items for a store — re-renders on add/clear and cross-tab changes. */
export const useCart = <T>(store: CartStore<T>) =>
	useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		() => EMPTY as T[]
	);

/**
 * Live derived value over the cart (e.g. item count, subtotal). `select` runs
 * on the current items each render.
 */
export const useCartValue = <T, V>(
	store: CartStore<T>,
	select: (items: T[]) => V
) => select(useCart(store));
