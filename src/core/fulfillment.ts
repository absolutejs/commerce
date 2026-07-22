// Manufacturing/drop-ship fulfillment contract. This is intentionally
// separate from ShippingProvider: a POD provider produces the item and ships
// it, while a carrier adapter only transports an already-produced parcel.

export type FulfillmentStatus =
	| "pending"
	| "accepted"
	| "in_production"
	| "partially_shipped"
	| "shipped"
	| "cancelled"
	| "failed";

export type FulfillmentAddress = {
	firstName: string;
	lastName: string;
	company?: string;
	address1: string;
	address2?: string;
	city: string;
	state?: string;
	postalCode: string;
	country: string;
	email?: string;
	phone?: string;
};

export type FulfillmentArtwork = {
	url: string;
	placement: string;
	presetId?: string;
	exactArtwork?: boolean;
};

export type FulfillmentLine = {
	id: string;
	variantId: string;
	/** The provider account/route selected for this line. */
	providerId: string;
	/** Exact provider-side catalog SKU. */
	providerSku: string;
	quantity: number;
	artwork: FulfillmentArtwork[];
	metadata?: Record<string, unknown>;
};

export type FulfillmentOrderRequest = {
	/** Stable merchant order id; providers use this as the idempotency key. */
	externalOrderId: string;
	recipient: FulfillmentAddress;
	shippingMethod?: string;
	lines: FulfillmentLine[];
	sandbox?: boolean;
	metadata?: Record<string, unknown>;
};

export type FulfillmentTracking = {
	carrier?: string;
	trackingNumber: string;
	trackingUrl?: string;
	shippedAt?: string;
};

export type FulfillmentOrder = {
	providerOrderId: string;
	externalOrderId: string;
	status: FulfillmentStatus;
	costCents?: number;
	currency?: string;
	tracking: FulfillmentTracking[];
	raw?: unknown;
};

export type FulfillmentValidation = {
	valid: boolean;
	errors: { lineId?: string; message: string }[];
};

export type FulfillmentCostQuote = {
	/** Provider-calculated item production cost before shipping. */
	itemsCents: number;
	/** Provider-calculated shipping cost for the selected destination/method. */
	shippingCents: number;
	/** Provider-specific production additions such as a second decoration side. */
	adjustmentsCents: number;
	totalCents: number;
	currency: string;
	quotedAt: string;
	/** Human-readable normalized assumptions; never put credentials here. */
	assumptions: string[];
};

export type FulfillmentCostQuoteRequest = Omit<
	FulfillmentOrderRequest,
	"externalOrderId"
>;

/**
 * Read-only pricing preflight. A quote does not reserve provider inventory or
 * price: spending callers must refresh it immediately before authorization and
 * still bind settlement to the provider's final accepted cost.
 */
export interface FulfillmentCostQuoteProvider {
	quoteOrder(order: FulfillmentCostQuoteRequest): Promise<FulfillmentCostQuote>;
}

export type FulfillmentEvent = {
	id?: string;
	providerOrderId: string;
	externalOrderId?: string;
	type: "accepted" | "production" | "shipped" | "cancelled" | "failed";
	status: FulfillmentStatus;
	tracking?: FulfillmentTracking[];
	occurredAt?: string;
	raw?: unknown;
};

export interface FulfillmentProvider {
	readonly id: string;
	validateOrder(
		order: FulfillmentOrderRequest,
	): FulfillmentValidation | Promise<FulfillmentValidation>;
	submitOrder(order: FulfillmentOrderRequest): Promise<FulfillmentOrder>;
	getOrder(providerOrderId: string): Promise<FulfillmentOrder>;
	cancelOrder?(providerOrderId: string): Promise<FulfillmentOrder>;
	parseWebhook?(request: Request): Promise<FulfillmentEvent>;
}

/** One provider-scoped job produced from a possibly mixed-provider order. */
export type RoutedFulfillmentOrder = FulfillmentOrderRequest & {
	providerId: string;
};

/** Split a checkout into idempotent provider jobs without losing line data. */
export const routeFulfillmentOrder = (
	order: FulfillmentOrderRequest,
): RoutedFulfillmentOrder[] => {
	const byProvider = new Map<string, FulfillmentLine[]>();
	for (const line of order.lines) {
		const providerId = line.providerId.trim();
		if (!providerId)
			throw new Error(`Line ${line.id} has no fulfillment provider`);
		const existing = byProvider.get(providerId) ?? [];
		existing.push(line);
		byProvider.set(providerId, existing);
	}

	return [...byProvider.entries()].map(([providerId, lines]) => ({
		...order,
		externalOrderId:
			byProvider.size === 1
				? order.externalOrderId
				: `${order.externalOrderId}-${providerId}`,
		lines,
		providerId,
	}));
};

export const validateFulfillmentOrder = (
	order: FulfillmentOrderRequest,
): FulfillmentValidation => {
	const errors: FulfillmentValidation["errors"] = [];
	if (!order.externalOrderId.trim())
		errors.push({ message: "Order id is required" });
	if (order.lines.length === 0)
		errors.push({ message: "At least one fulfillment line is required" });
	for (const line of order.lines) {
		if (!line.providerSku.trim())
			errors.push({ lineId: line.id, message: "Provider SKU is required" });
		if (!Number.isInteger(line.quantity) || line.quantity < 1)
			errors.push({
				lineId: line.id,
				message: "Quantity must be a positive integer",
			});
		if (line.artwork.length === 0)
			errors.push({ lineId: line.id, message: "Artwork is required" });
	}
	const address = order.recipient;
	if (
		![
			address.firstName,
			address.lastName,
			address.address1,
			address.city,
			address.postalCode,
			address.country,
		].every((value) => value.trim())
	)
		errors.push({ message: "A complete recipient address is required" });

	return { errors, valid: errors.length === 0 };
};
