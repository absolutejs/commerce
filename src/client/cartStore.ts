// A tiny localStorage-backed cart store, framework-agnostic. All reads are
// defensive: a malformed or absent value yields an empty cart, never throws.
// SSR-safe: every method no-ops / returns empty when there's no `window`.
//
// `subscribe` + `getSnapshot` make it directly usable with React's
// useSyncExternalStore (see `@absolutejs/commerce/react`); getSnapshot returns a
// stable reference until localStorage actually changes, so it won't loop.

export type CartStore<T> = {
	read(): T[];
	write(items: T[]): void;
	add(item: T): void;
	clear(): void;
	subscribe(listener: () => void): () => void;
	getSnapshot(): T[];
};

const EMPTY: never[] = [];

/**
 * Create a cart store for a localStorage key. Pass `normalize` to migrate or
 * validate persisted items on read (e.g. drop legacy shapes, re-price).
 */
export const createCartStore = <T>(
	key: string,
	normalize?: (raw: unknown) => T[]
): CartStore<T> => {
	const eventName = `commerce-cart:${key}`;

	const parse = (raw: string | null): T[] => {
		try {
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			if (normalize) return normalize(parsed);

			return Array.isArray(parsed) ? (parsed as T[]) : [];
		} catch {
			return [];
		}
	};

	const read = () => {
		if (typeof window === 'undefined') return [];

		return parse(window.localStorage.getItem(key));
	};

	// Cached snapshot, recomputed only when the stored string changes.
	let lastRaw: string | null = null;
	let cache: T[] = EMPTY;
	const getSnapshot = () => {
		if (typeof window === 'undefined') return EMPTY;
		const raw = window.localStorage.getItem(key) ?? '';
		if (raw !== lastRaw) {
			lastRaw = raw;
			cache = parse(raw);
		}

		return cache;
	};

	const announce = () => {
		if (typeof window !== 'undefined')
			window.dispatchEvent(new Event(eventName));
	};

	const write = (items: T[]) => {
		if (typeof window === 'undefined') return;
		window.localStorage.setItem(key, JSON.stringify(items));
		announce();
	};

	return {
		add(item: T) {
			write([...read(), item]);
		},
		clear() {
			if (typeof window === 'undefined') return;
			window.localStorage.removeItem(key);
			announce();
		},
		getSnapshot,
		read,
		subscribe(listener: () => void) {
			if (typeof window === 'undefined') return () => undefined;
			// Same-tab writes fire `eventName`; other tabs fire `storage`.
			const onStorage = (event: StorageEvent) => {
				if (event.key === key) listener();
			};
			window.addEventListener(eventName, listener);
			window.addEventListener('storage', onStorage);

			return () => {
				window.removeEventListener(eventName, listener);
				window.removeEventListener('storage', onStorage);
			};
		},
		write
	};
};
