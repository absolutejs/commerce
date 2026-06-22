// Money helpers. Amounts are carried as major-unit numbers (e.g. dollars);
// `*Cents` helpers convert to/from the integer minor unit payment APIs want.

const CENTS = 100;

/** Round a major-unit amount to 2 decimals (avoids float drift in pricing). */
export const roundMoney = (value: number) => Math.round(value * CENTS) / CENTS;

/** Major units → integer minor units (dollars → cents). */
export const toCents = (value: number) => Math.round(value * CENTS);

/** Integer minor units → major units (cents → dollars). */
export const fromCents = (cents: number) => cents / CENTS;

/** Format a major-unit amount, USD by default. */
export const formatPrice = (value: number, currency = 'USD') => {
	const code = currency.toUpperCase();

	return code === 'USD'
		? `$${value.toFixed(2)}`
		: `${value.toFixed(2)} ${code}`;
};
