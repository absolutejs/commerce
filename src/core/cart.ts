// Cart aggregation over a minimal priced-line shape. Domain apps define their
// own rich line type (variants, customizations, …) and just expose these three
// numbers so the totals are computed consistently everywhere.

export type PricedLine = {
	quantity: number;
	/** Per-unit price (major units), excluding the one-time setup fee. */
	unitPrice: number;
	/** One-time fee charged once for the whole line (e.g. digitizing/setup). */
	setupFee: number;
};

/** Total units across the cart. */
export const cartCount = <T extends { quantity: number }>(lines: T[]) =>
	lines.reduce((sum, line) => sum + line.quantity, 0);

/** Cost of one line: unit × qty + the one-time setup fee. */
export const lineTotal = (line: PricedLine) =>
	line.setupFee + line.unitPrice * line.quantity;

/** Sum of every line's one-time setup fees. */
export const cartSetupTotal = <T extends PricedLine>(lines: T[]) =>
	lines.reduce((sum, line) => sum + line.setupFee, 0);

/** Cart subtotal (all lines, including setup fees). */
export const cartSubtotal = <T extends PricedLine>(lines: T[]) =>
	lines.reduce((sum, line) => sum + lineTotal(line), 0);
