// Turnkey Drizzle (Postgres) tables for a commerce shop: orders, quotes,
// discounts, and a shared design library. Spread `commerceDrizzleSchema` into
// your own Drizzle schema (alongside your auth/users tables) so drizzle-kit and
// Drizzle Studio manage them.
//
// drizzle-orm is a peer dependency — the consuming app provides it.

import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';

import type { BrandKit, DecorationArea, ProductMedia } from '../core/catalog';

export type CommerceOrderLine = {
	amountTotal: number;
	product: string;
	quantity: number;
};

export type CommerceShippingAddress = {
	name: string | null;
	line1: string | null;
	line2: string | null;
	city: string | null;
	state: string | null;
	postalCode: string | null;
	country: string | null;
};

// Shared design library — customers can publish an uploaded design for reuse.
export const commerceDesigns = pgTable('designs', {
	created_at: timestamp().notNull().defaultNow(),
	id: uuid().defaultRandom().primaryKey(),
	image_url: varchar({ length: 600 }).notNull(),
	name: varchar({ length: 120 }).notNull(),
	public: boolean().notNull().default(true)
});

// A B2B company account: net terms, tax-exempt status, PO requirement, and a
// brand kit (saved logo URLs) for fast reorders.
export const commerceCompanies = pgTable('companies', {
	brand_kit: jsonb().$type<BrandKit>(),
	brand_logos: jsonb().$type<string[]>().default([]),
	contact_email: varchar({ length: 320 }),
	created_at: timestamp().notNull().defaultNow(),
	id: uuid().defaultRandom().primaryKey(),
	name: varchar({ length: 200 }).notNull(),
	net_terms: integer().notNull().default(0),
	notes: text(),
	po_required: boolean().notNull().default(false),
	tax_exempt: boolean().notNull().default(false),
	tax_exempt_id: varchar({ length: 80 })
});

// A storefront/tenant catalog. Canonical products may be listed in any number
// of catalogs with different copy, prices, approved art, and visibility.
export const commerceCatalogs = pgTable('commerce_catalogs', {
	brand_kit: jsonb().$type<BrandKit>(),
	created_at: timestamp().notNull().defaultNow(),
	currency: varchar({ length: 10 }).notNull().default('USD'),
	id: uuid().defaultRandom().primaryKey(),
	locale: varchar({ length: 20 }).notNull().default('en-US'),
	name: varchar({ length: 200 }).notNull(),
	owner_key: varchar({ length: 160 }),
	settings: jsonb().$type<Record<string, unknown>>().default({}),
	slug: varchar({ length: 120 }).notNull().unique(),
	status: varchar({ length: 20 }).notNull().default('draft'),
	updated_at: timestamp().notNull().defaultNow()
});

// Supplier feed checkpoint. `settings` may contain account/store identifiers,
// but credentials belong in the host's secret manager rather than this table.
export const commerceCatalogSources = pgTable('commerce_catalog_sources', {
	cursor: varchar({ length: 500 }),
	id: varchar({ length: 120 }).primaryKey(),
	last_error: text(),
	last_synced_at: timestamp(),
	name: varchar({ length: 200 }).notNull(),
	provider: varchar({ length: 120 }).notNull(),
	settings: jsonb().$type<Record<string, unknown>>().default({}),
	status: varchar({ length: 20 }).notNull().default('active'),
	updated_at: timestamp().notNull().defaultNow()
});

// Supplier/manufacturer truth shared by every catalog. IDs should be stable
// and namespaced when imported (for example `sanmar:PC54`).
export const commerceProducts = pgTable(
	'commerce_products',
	{
		attributes: jsonb()
			.$type<Record<string, string | number | boolean | string[]>>()
			.default({}),
		brand: varchar({ length: 160 }).notNull(),
		category: varchar({ length: 160 }).notNull(),
		created_at: timestamp().notNull().defaultNow(),
		decoration_areas: jsonb().$type<DecorationArea[]>().default([]),
		description: text().notNull().default(''),
		external_id: varchar({ length: 200 }),
		id: varchar({ length: 160 }).primaryKey(),
		media: jsonb().$type<ProductMedia[]>().default([]),
		metadata: jsonb().$type<Record<string, unknown>>().default({}),
		option_names: jsonb().$type<string[]>().default([]),
		product_type: varchar({ length: 120 }).notNull(),
		slug: varchar({ length: 180 }).notNull(),
		source_id: varchar({ length: 120 }),
		status: varchar({ length: 20 }).notNull().default('draft'),
		style_code: varchar({ length: 120 }).notNull(),
		tags: jsonb().$type<string[]>().default([]),
		title: varchar({ length: 240 }).notNull(),
		updated_at: timestamp().notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('commerce_products_source_external_idx').on(
			table.source_id,
			table.external_id
		)
	]
);

// An exact purchasable SKU, normally one color/size combination.
export const commerceProductVariants = pgTable(
	'commerce_product_variants',
	{
		available: boolean().notNull().default(true),
		barcode: varchar({ length: 120 }),
		compare_at_cents: integer(),
		cost_cents: integer(),
		created_at: timestamp().notNull().defaultNow(),
		currency: varchar({ length: 10 }).notNull().default('USD'),
		external_id: varchar({ length: 200 }),
		id: varchar({ length: 200 }).primaryKey(),
		inventory_policy: varchar({ length: 20 }).notNull().default('external'),
		inventory_quantity: integer(),
		media: jsonb().$type<ProductMedia[]>().default([]),
		metadata: jsonb().$type<Record<string, unknown>>().default({}),
		options: jsonb().$type<Record<string, string>>().notNull(),
		price_cents: integer(),
		product_id: varchar({ length: 160 }).notNull(),
		sku: varchar({ length: 200 }).notNull().unique(),
		supplier_sku: varchar({ length: 200 }),
		updated_at: timestamp().notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('commerce_variants_product_external_idx').on(
			table.product_id,
			table.external_id
		)
	]
);

// Store-specific merchandising and customization rules for a product.
export const commerceCatalogListings = pgTable(
	'commerce_catalog_listings',
	{
		base_price_cents: integer(),
		catalog_id: uuid().notNull(),
		compare_at_cents: integer(),
		created_at: timestamp().notNull().defaultNow(),
		customization: jsonb().$type<Record<string, unknown>>().default({}),
		customization_mode: varchar({ length: 20 })
			.notNull()
			.default('customizable'),
		description: text(),
		id: uuid().defaultRandom().primaryKey(),
		metadata: jsonb().$type<Record<string, unknown>>().default({}),
		position: integer().notNull().default(0),
		product_id: varchar({ length: 160 }).notNull(),
		slug: varchar({ length: 180 }).notNull(),
		status: varchar({ length: 20 }).notNull().default('draft'),
		tags: jsonb().$type<string[]>().default([]),
		title: varchar({ length: 240 }),
		updated_at: timestamp().notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('commerce_listings_catalog_product_idx').on(
			table.catalog_id,
			table.product_id
		),
		uniqueIndex('commerce_listings_catalog_slug_idx').on(
			table.catalog_id,
			table.slug
		)
	]
);

export const commerceCatalogCollections = pgTable(
	'commerce_catalog_collections',
	{
		catalog_id: uuid().notNull(),
		created_at: timestamp().notNull().defaultNow(),
		description: text(),
		id: uuid().defaultRandom().primaryKey(),
		image_url: varchar({ length: 600 }),
		position: integer().notNull().default(0),
		slug: varchar({ length: 180 }).notNull(),
		status: varchar({ length: 20 }).notNull().default('draft'),
		title: varchar({ length: 200 }).notNull(),
		updated_at: timestamp().notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('commerce_collections_catalog_slug_idx').on(
			table.catalog_id,
			table.slug
		)
	]
);

export const commerceCatalogCollectionListings = pgTable(
	'commerce_catalog_collection_listings',
	{
		collection_id: uuid().notNull(),
		id: uuid().defaultRandom().primaryKey(),
		listing_id: uuid().notNull(),
		position: integer().notNull().default(0)
	},
	(table) => [
		uniqueIndex('commerce_collection_listing_idx').on(
			table.collection_id,
			table.listing_id
		)
	]
);

// Merchant-scoped fulfillment connection. Secrets stay in the host secret
// store; config only contains non-secret routing/default settings.
export const commerceFulfillmentAccounts = pgTable('fulfillment_accounts', {
	config: jsonb().$type<Record<string, unknown>>().default({}),
	created_at: timestamp().notNull().defaultNow(),
	id: uuid().defaultRandom().primaryKey(),
	label: varchar({ length: 160 }).notNull(),
	owner_key: varchar({ length: 160 }),
	provider: varchar({ length: 120 }).notNull(),
	status: varchar({ length: 20 }).notNull().default('active'),
	updated_at: timestamp().notNull().defaultNow()
});

// Maps a canonical commerce variant to an exact provider-side SKU.
export const commerceFulfillmentVariantMappings = pgTable(
	'fulfillment_variant_mappings',
	{
		account_id: uuid().notNull(),
		id: uuid().defaultRandom().primaryKey(),
		metadata: jsonb().$type<Record<string, unknown>>().default({}),
		provider_sku: varchar({ length: 200 }).notNull(),
		variant_id: varchar({ length: 200 }).notNull()
	},
	(table) => [
		uniqueIndex('fulfillment_mapping_account_variant_idx').on(
			table.account_id,
			table.variant_id
		)
	]
);

// One idempotent provider submission. Mixed-provider checkouts create one job
// per provider account through core routeFulfillmentOrder.
export const commerceFulfillmentJobs = pgTable('fulfillment_jobs', {
	account_id: uuid().notNull(),
	cost_cents: integer(),
	created_at: timestamp().notNull().defaultNow(),
	currency: varchar({ length: 10 }),
	error: text(),
	id: uuid().defaultRandom().primaryKey(),
	idempotency_key: varchar({ length: 255 }).notNull().unique(),
	order_session_id: varchar({ length: 255 }).notNull(),
	provider: varchar({ length: 120 }).notNull(),
	provider_order_id: varchar({ length: 255 }),
	request: jsonb().$type<Record<string, unknown>>().notNull(),
	response: jsonb().$type<Record<string, unknown>>(),
	status: varchar({ length: 30 }).notNull().default('pending'),
	updated_at: timestamp().notNull().defaultNow()
});

export const commerceFulfillmentEvents = pgTable(
	'fulfillment_events',
	{
		created_at: timestamp().notNull().defaultNow(),
		id: uuid().defaultRandom().primaryKey(),
		job_id: uuid().notNull(),
		occurred_at: timestamp(),
		payload: jsonb().$type<Record<string, unknown>>().notNull(),
		provider_event_id: varchar({ length: 255 }),
		type: varchar({ length: 60 }).notNull()
	},
	(table) => [
		uniqueIndex('fulfillment_events_job_provider_event_idx').on(
			table.job_id,
			table.provider_event_id
		)
	]
);

export type CommerceInvoiceLine = {
	description: string;
	quantity: number;
	amountCents: number;
};

// A B2B invoice (net terms / PO / tax-exempt). `status` is draft | sent | paid.
export const commerceInvoices = pgTable('invoices', {
	amount_cents: integer().notNull().default(0),
	company_id: uuid(),
	created_at: timestamp().notNull().defaultNow(),
	customer_email: varchar({ length: 320 }),
	due_date: timestamp(),
	id: uuid().defaultRandom().primaryKey(),
	line_items: jsonb().$type<CommerceInvoiceLine[]>().default([]),
	notes: text(),
	number: varchar({ length: 40 }).notNull(),
	order_session: varchar({ length: 255 }),
	po_number: varchar({ length: 80 }),
	status: varchar({ length: 20 }).notNull().default('draft'),
	tax_exempt: boolean().notNull().default(false)
});

// Discount codes. Exactly one of percent_off / amount_off (cents) is set.
export const commerceDiscounts = pgTable('discounts', {
	active: boolean().notNull().default(true),
	amount_off: integer(),
	code: varchar({ length: 60 }).primaryKey(),
	created_at: timestamp().notNull().defaultNow(),
	expires_at: timestamp(),
	max_uses: integer(),
	percent_off: integer(),
	used_count: integer().notNull().default(0)
});

// One checkout, keyed by the payment session id so the webhook can upsert
// idempotently. `status` is paid | failed | shipped | rejected | refunded.
export const commerceOrders = pgTable('orders', {
	amount_total: integer(),
	artwork_urls: jsonb().$type<string[]>().default([]),
	assignee: varchar({ length: 120 }),
	carrier: varchar({ length: 80 }),
	cart_snapshot: jsonb().$type<unknown[]>().default([]),
	created_at: timestamp().notNull().defaultNow(),
	currency: varchar({ length: 10 }),
	customer_email: varchar({ length: 320 }),
	digitized_at: timestamp(),
	digitized_url: varchar({ length: 600 }),
	due_date: timestamp(),
	fulfillment: varchar({ length: 20 }),
	label_url: varchar({ length: 600 }),
	pickup_at: timestamp(),
	line_items: jsonb().$type<CommerceOrderLine[]>().default([]),
	payment_status: varchar({ length: 50 }),
	/** Digitized stitch files + cut files, one per design (digitized_url is the legacy single slot). */
	production_files:
		jsonb().$type<
			{ url: string; filename?: string | null; artworkUrl?: string | null }[]
		>(),
	production_stage: varchar({ length: 20 }),
	proof_note: text(),
	proof_status: varchar({ length: 20 }),
	proof_token: varchar({ length: 64 }),
	proof_url: varchar({ length: 600 }),
	rejection_reason: text(),
	rush: boolean().notNull().default(false),
	/** Stitched-sample sign-off for first-run designs: none|sent|approved|changes. */
	sewout_status: varchar({ length: 20 }),
	sewout_url: varchar({ length: 600 }),
	session_id: varchar({ length: 255 }).primaryKey(),
	shipped_at: timestamp(),
	shipping: jsonb().$type<CommerceShippingAddress>(),
	spoilage: integer().notNull().default(0),
	status: varchar({ length: 50 }).notNull(),
	tracking_number: varchar({ length: 160 })
});

// On-hand blank-garment stock, keyed by product + size + color.
export const commerceInventory = pgTable('inventory', {
	color: varchar({ length: 60 }).notNull(),
	created_at: timestamp().notNull().defaultNow(),
	id: uuid().defaultRandom().primaryKey(),
	low_threshold: integer().notNull().default(0),
	product_id: varchar({ length: 40 }).notNull(),
	quantity: integer().notNull().default(0),
	size: varchar({ length: 20 }).notNull()
});

// A bulk / B2B quote request. Not a paid order; the shop replies with a price.
// `status` is new | priced | won | lost.
export const commerceQuotes = pgTable('quotes', {
	artwork_urls: jsonb().$type<string[]>().default([]),
	company: varchar({ length: 200 }),
	created_at: timestamp().notNull().defaultNow(),
	customer_email: varchar({ length: 320 }).notNull(),
	deadline: varchar({ length: 120 }),
	deposit_amount: integer(),
	deposit_status: varchar({ length: 20 }),
	id: uuid().defaultRandom().primaryKey(),
	locations: text(),
	name: varchar({ length: 200 }).notNull(),
	notes: text(),
	phone: varchar({ length: 60 }),
	product: varchar({ length: 120 }),
	quantity: integer(),
	quote_message: text(),
	quoted_amount: integer(),
	quoted_at: timestamp(),
	status: varchar({ length: 20 }).notNull().default('new')
});

// A started-but-unpaid checkout, for abandoned-cart recovery reminders.
export const commerceAbandonedCarts = pgTable('abandoned_carts', {
	cart: jsonb().$type<unknown[]>().notNull(),
	created_at: timestamp().notNull().defaultNow(),
	customer_email: varchar({ length: 320 }).notNull(),
	id: uuid().defaultRandom().primaryKey(),
	recovered: boolean().notNull().default(false),
	reminded: boolean().notNull().default(false)
});

// Store gift cards. `code` is the redeemable handle; balance decrements as it's
// applied to orders.
export const commerceGiftCards = pgTable('gift_cards', {
	balance_cents: integer().notNull(),
	code: varchar({ length: 40 }).primaryKey(),
	created_at: timestamp().notNull().defaultNow(),
	initial_cents: integer().notNull(),
	recipient_email: varchar({ length: 320 })
});

// A shared team/group store: members order their own size + name under one
// store with a deadline, and the shop batches them. `slug` is the public handle.
// `cause` + `fundraise_cents` turn it into a fundraiser (a per-item markup that
// goes to the named cause).
export const commerceGroupStores = pgTable('group_stores', {
	active: boolean().notNull().default(true),
	cause: varchar({ length: 160 }),
	created_at: timestamp().notNull().defaultNow(),
	deadline: varchar({ length: 60 }),
	fundraise_cents: integer().notNull().default(0),
	id: uuid().defaultRandom().primaryKey(),
	message: text(),
	name: varchar({ length: 160 }).notNull(),
	organizer_email: varchar({ length: 320 }),
	product_id: varchar({ length: 40 }).notNull(),
	slug: varchar({ length: 80 }).notNull().unique()
});

// A group-gift "chip-in" pool: many contributors fund one custom order. `slug`
// is the public handle; `raised_cents` accrues as contributions clear.
export const commerceGiftPools = pgTable('gift_pools', {
	created_at: timestamp().notNull().defaultNow(),
	deadline: varchar({ length: 60 }),
	id: uuid().defaultRandom().primaryKey(),
	message: text(),
	organizer_email: varchar({ length: 320 }),
	product_id: varchar({ length: 40 }),
	raised_cents: integer().notNull().default(0),
	slug: varchar({ length: 80 }).notNull().unique(),
	status: varchar({ length: 20 }).notNull().default('open'),
	target_cents: integer().notNull().default(0),
	title: varchar({ length: 160 }).notNull()
});

// One contribution toward a gift pool.
export const commerceGiftContributions = pgTable('gift_contributions', {
	amount_cents: integer().notNull().default(0),
	contributor_email: varchar({ length: 320 }),
	contributor_name: varchar({ length: 160 }),
	created_at: timestamp().notNull().defaultNow(),
	id: uuid().defaultRandom().primaryKey(),
	message: text(),
	pool_id: uuid().notNull()
});

// A recurring membership (e.g. "Stitch Club"), keyed by email. `subscription_id`
// is the provider's subscription handle; `status` is active | canceled.
export const commerceMemberships = pgTable('memberships', {
	created_at: timestamp().notNull().defaultNow(),
	email: varchar({ length: 320 }).primaryKey(),
	started_at: timestamp(),
	status: varchar({ length: 20 }).notNull().default('active'),
	subscription_id: varchar({ length: 255 })
});

// A customer's loyalty record (one per email): points balance + a shareable
// referral code. Store credit is delivered as gift cards, so it rides the
// existing gift-card rails rather than a separate ledger.
export const commerceLoyalty = pgTable('loyalty', {
	created_at: timestamp().notNull().defaultNow(),
	email: varchar({ length: 320 }).primaryKey(),
	points: integer().notNull().default(0),
	referral_code: varchar({ length: 20 }).notNull().unique(),
	referred_by: varchar({ length: 20 })
});

// A Web Push subscription (one per browser/device). `role`/`email` let the app
// target the owner's devices vs a specific customer's. `endpoint` is unique.
export const commercePushSubscriptions = pgTable('push_subscriptions', {
	auth: varchar({ length: 255 }).notNull(),
	created_at: timestamp().notNull().defaultNow(),
	email: varchar({ length: 320 }),
	endpoint: varchar({ length: 600 }).notNull().unique(),
	id: uuid().defaultRandom().primaryKey(),
	p256dh: varchar({ length: 255 }).notNull(),
	role: varchar({ length: 20 })
});

// A finished-work portfolio item for the shop's "our work" gallery.
export const commerceGalleryItems = pgTable('gallery_items', {
	created_at: timestamp().notNull().defaultNow(),
	featured: boolean().notNull().default(false),
	id: uuid().defaultRandom().primaryKey(),
	image_url: varchar({ length: 600 }).notNull(),
	method: varchar({ length: 40 }),
	product_id: varchar({ length: 40 }),
	tags: jsonb().$type<string[]>().default([]),
	title: varchar({ length: 160 }).notNull()
});

// Links a placed order to a group store (written when its checkout clears).
export const commerceGroupOrders = pgTable('group_orders', {
	created_at: timestamp().notNull().defaultNow(),
	group_slug: varchar({ length: 80 }).notNull(),
	id: uuid().defaultRandom().primaryKey(),
	order_session_id: varchar({ length: 255 }).notNull()
});

// A signed-in customer's favorited products (one row per email+product).
export const commerceFavorites = pgTable('favorites', {
	created_at: timestamp().notNull().defaultNow(),
	customer_email: varchar({ length: 320 }).notNull(),
	id: uuid().defaultRandom().primaryKey(),
	product_id: varchar({ length: 40 }).notNull()
});

// Return / exchange requests. `kind` is return | exchange; `status` is
// pending | approved | denied | done.
export const commerceReturnRequests = pgTable('return_requests', {
	created_at: timestamp().notNull().defaultNow(),
	customer_email: varchar({ length: 320 }).notNull(),
	id: uuid().defaultRandom().primaryKey(),
	kind: varchar({ length: 20 }).notNull(),
	order_session_id: varchar({ length: 255 }).notNull(),
	reason: text().notNull(),
	status: varchar({ length: 20 }).notNull().default('pending')
});

// Product reviews. `status` is pending | approved | hidden; `order_session_id`
// links a review to a real order (verified buyer).
export const commerceReviews = pgTable('reviews', {
	author_name: varchar({ length: 120 }).notNull(),
	body: text().notNull(),
	created_at: timestamp().notNull().defaultNow(),
	id: uuid().defaultRandom().primaryKey(),
	order_session_id: varchar({ length: 255 }),
	product_id: varchar({ length: 40 }).notNull(),
	rating: integer().notNull(),
	status: varchar({ length: 20 }).notNull().default('pending'),
	title: varchar({ length: 160 })
});

// A saved customizer design — a re-addable configured cart item.
export const commerceSavedDesigns = pgTable('saved_designs', {
	created_at: timestamp().notNull().defaultNow(),
	customer_email: varchar({ length: 320 }).notNull(),
	id: uuid().defaultRandom().primaryKey(),
	label: varchar({ length: 120 }),
	product_id: varchar({ length: 40 }).notNull(),
	snapshot: jsonb().$type<Record<string, unknown>>().notNull()
});

// Admin-editable quantity-break pricing, keyed by whatever grouping the shop
// prices with (product category, collection, SKU…). Breaks are applied by
// core/pricing quantityDiscount after normalizeQuantityBreaks.
export const commercePricingTiers = pgTable('pricing_tiers', {
	breaks: jsonb().$type<{ min: number; discount: number }[]>().notNull(),
	tier_key: varchar({ length: 80 }).primaryKey(),
	updated_at: timestamp().notNull().defaultNow()
});

// Newsletter subscribers. `email` is the primary key so signups are idempotent.
export const commerceSubscribers = pgTable('subscribers', {
	created_at: timestamp().notNull().defaultNow(),
	email: varchar({ length: 320 }).primaryKey()
});

// Full machine-readable production spec per checkout (decoration shops) —
// checkout metadata is tiny, so the real spec (dimensions, thread sequence,
// placement measurements, puff flags) lives here, written at checkout-session
// creation and linked to the order by the payment webhook via its spec id.
export const commerceProductionSpecs = pgTable('production_specs', {
	created_at: timestamp().notNull().defaultNow(),
	payload: jsonb().$type<Record<string, unknown>>().notNull(),
	session_id: varchar({ length: 255 }),
	spec_id: varchar({ length: 64 }).primaryKey()
});

// Every commerce table in one object — spread into your own Drizzle schema.
export const commerceDrizzleSchema = {
	abandonedCarts: commerceAbandonedCarts,
	catalogCollectionListings: commerceCatalogCollectionListings,
	catalogCollections: commerceCatalogCollections,
	catalogListings: commerceCatalogListings,
	catalogSources: commerceCatalogSources,
	catalogs: commerceCatalogs,
	companies: commerceCompanies,
	designs: commerceDesigns,
	discounts: commerceDiscounts,
	fulfillmentAccounts: commerceFulfillmentAccounts,
	fulfillmentEvents: commerceFulfillmentEvents,
	fulfillmentJobs: commerceFulfillmentJobs,
	fulfillmentVariantMappings: commerceFulfillmentVariantMappings,
	invoices: commerceInvoices,
	favorites: commerceFavorites,
	galleryItems: commerceGalleryItems,
	giftCards: commerceGiftCards,
	giftContributions: commerceGiftContributions,
	giftPools: commerceGiftPools,
	memberships: commerceMemberships,
	groupOrders: commerceGroupOrders,
	groupStores: commerceGroupStores,
	inventory: commerceInventory,
	loyalty: commerceLoyalty,
	orders: commerceOrders,
	products: commerceProducts,
	productVariants: commerceProductVariants,
	productionSpecs: commerceProductionSpecs,
	pushSubscriptions: commercePushSubscriptions,
	quotes: commerceQuotes,
	returnRequests: commerceReturnRequests,
	reviews: commerceReviews,
	savedDesigns: commerceSavedDesigns,
	pricingTiers: commercePricingTiers,
	subscribers: commerceSubscribers
};

export * from './queries';
export * from './catalogQueries';
