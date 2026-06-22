// Discount-code engine. A code carries exactly one of percentOff (0–100) or
// amountOff (minor units / cents). Validity is active + not expired + under cap.

export type Discount = {
	code: string;
	percentOff: number | null;
	/** Fixed amount off in minor units (cents). */
	amountOff: number | null;
	active: boolean;
	maxUses: number | null;
	usedCount: number;
	/** Expiry as epoch ms, or null for no expiry. */
	expiresAt: number | null;
};

/** Whether a code can be redeemed right now. */
export const isDiscountValid = (
	discount: Discount | null | undefined,
	now = 0
) => {
	if (!discount || !discount.active) return false;
	const at = now || nowMs();
	if (discount.expiresAt !== null && discount.expiresAt < at) return false;
	if (discount.maxUses !== null && discount.usedCount >= discount.maxUses)
		return false;

	return true;
};

/** The amount a code takes off a subtotal, in minor units (cents). */
export const discountAmountCents = (discount: Discount, subtotalCents: number) =>
	discount.percentOff !== null
		? Math.round((subtotalCents * discount.percentOff) / 100)
		: Math.min(subtotalCents, discount.amountOff ?? 0);

// Date.now is wrapped so it's the single impurity (and easy to stub in tests).
const nowMs = () => Date.now();
