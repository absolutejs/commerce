// Volume / quantity-break pricing. A break applies its `discount` (0–1) once the
// line quantity reaches `min`; the highest qualifying break wins.

export type QuantityBreak = { min: number; discount: number };

/** The fractional discount (0–1) that applies at a given quantity. */
export const quantityDiscount = (breaks: QuantityBreak[], quantity: number) =>
	breaks.reduce(
		(best, brk) => (quantity >= brk.min ? brk.discount : best),
		0
	);

/** The next break a buyer hasn't reached yet (for "order N+ to save X%" hints). */
export const nextQuantityBreak = (
	breaks: QuantityBreak[],
	quantity: number
) => breaks.find((brk) => brk.min > quantity) ?? null;

const MAX_TIER_DISCOUNT = 0.9;
const MAX_TIERS = 12;

/**
 * Sanitize admin-entered breaks: numeric, min ≥ 1, discount clamped to
 * [0, 0.9], deduped by min (last wins), sorted ascending — the shape
 * quantityDiscount's reduce depends on. Always includes a min-1 base row.
 */
export const normalizeQuantityBreaks = (raw: unknown): QuantityBreak[] => {
	if (!Array.isArray(raw)) return [{ discount: 0, min: 1 }];
	const byMin = new Map<number, number>();
	raw.forEach((entry) => {
		if (!entry || typeof entry !== 'object') return;
		const brk = entry as Partial<QuantityBreak>;
		const min = Math.floor(Number(brk.min));
		const discount = Number(brk.discount);
		if (!Number.isFinite(min) || min < 1) return;
		if (!Number.isFinite(discount)) return;
		byMin.set(min, Math.min(MAX_TIER_DISCOUNT, Math.max(0, discount)));
	});
	if (!byMin.has(1)) byMin.set(1, 0);

	return [...byMin.entries()]
		.sort(([left], [right]) => left - right)
		.slice(0, MAX_TIERS)
		.map(([min, discount]) => ({ discount, min }));
};

export type TierRow = {
	min: number;
	discount: number;
	/** Discounted unit price for a given base unit price. */
	unitPrice: number;
	/** Per-piece savings vs the single-piece price. */
	savings: number;
};

const CENTS = 100;
const toMoney = (value: number) => Math.round(value * CENTS) / CENTS;

/** Price-table rows ("12+ → $25.20 each, save 10%") for a base unit price. */
export const tierRows = (
	breaks: QuantityBreak[],
	baseUnitPrice: number
): TierRow[] =>
	breaks.map((brk) => ({
		discount: brk.discount,
		min: brk.min,
		savings: toMoney(baseUnitPrice * brk.discount),
		unitPrice: toMoney(baseUnitPrice * (1 - brk.discount))
	}));
