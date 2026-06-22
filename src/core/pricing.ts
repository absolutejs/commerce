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
