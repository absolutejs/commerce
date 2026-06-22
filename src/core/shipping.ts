// Provider-agnostic shipping contract. Concrete carriers (EasyPost, Shippo,
// …) implement `ShippingProvider`; the host and apps program against this
// interface so a shop can swap or connect whatever carrier account it already
// uses.

/** A postal address. `country` is an ISO-3166 alpha-2 code (e.g. "US"). */
export type Address = {
	name: string;
	company?: string | null;
	street1: string;
	street2?: string | null;
	city: string;
	state: string;
	zip: string;
	country: string;
	phone?: string | null;
	email?: string | null;
};

/** Parcel dimensions (inches) and weight (ounces). */
export type Parcel = {
	lengthIn: number;
	widthIn: number;
	heightIn: number;
	weightOz: number;
};

/** A purchasable rate quote from a carrier. */
export type ShippingRate = {
	/** Adapter-specific id, used to buy this exact rate. */
	id: string;
	carrier: string;
	service: string;
	/** Price in the smallest currency unit's major form (e.g. dollars). */
	amount: number;
	currency: string;
	estDeliveryDays: number | null;
};

/** A purchased label, ready to print, with its tracking handle. */
export type ShippingLabel = {
	trackingNumber: string;
	trackingUrl: string | null;
	/** URL of the printable label (PDF/PNG). */
	labelUrl: string;
	carrier: string;
	service: string;
	amount: number;
	currency: string;
	rateId: string;
	/** Adapter-specific shipment id (for follow-up calls). */
	shipmentId: string;
};

export type RateInput = { from: Address; to: Address; parcel: Parcel };
export type BuyInput = { shipmentId: string; rateId: string };
export type TrackResult = {
	status: string;
	estDelivery: string | null;
	trackingUrl: string | null;
};

// The contract every carrier adapter fulfills.
export type ShippingProvider = {
	/** Quote all available rates for a parcel between two addresses. */
	rates(input: RateInput): Promise<ShippingRate[]>;
	/** Quote, pick the cheapest rate, and buy a label in one call. */
	buyCheapestLabel(input: RateInput): Promise<ShippingLabel>;
	/** Buy a specific previously-quoted rate. */
	buyLabel(input: BuyInput): Promise<ShippingLabel>;
	/** Current tracking status for a shipment. */
	track(trackingNumber: string, carrier?: string): Promise<TrackResult>;
};

/** A sensible default parcel for small apparel orders (a poly mailer). */
export const DEFAULT_APPAREL_PARCEL: Parcel = {
	heightIn: 2,
	lengthIn: 12,
	weightOz: 8,
	widthIn: 9
};
