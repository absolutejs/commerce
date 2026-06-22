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
	uuid,
	varchar
} from 'drizzle-orm/pg-core';

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
	carrier: varchar({ length: 80 }),
	cart_snapshot: jsonb().$type<unknown[]>().default([]),
	created_at: timestamp().notNull().defaultNow(),
	currency: varchar({ length: 10 }),
	customer_email: varchar({ length: 320 }),
	digitized_at: timestamp(),
	digitized_url: varchar({ length: 600 }),
	fulfillment: varchar({ length: 20 }),
	label_url: varchar({ length: 600 }),
	line_items: jsonb().$type<CommerceOrderLine[]>().default([]),
	payment_status: varchar({ length: 50 }),
	production_stage: varchar({ length: 20 }),
	proof_note: text(),
	proof_status: varchar({ length: 20 }),
	proof_token: varchar({ length: 64 }),
	proof_url: varchar({ length: 600 }),
	rejection_reason: text(),
	session_id: varchar({ length: 255 }).primaryKey(),
	shipped_at: timestamp(),
	shipping: jsonb().$type<CommerceShippingAddress>(),
	status: varchar({ length: 50 }).notNull(),
	tracking_number: varchar({ length: 160 })
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
export const commerceGroupStores = pgTable('group_stores', {
	active: boolean().notNull().default(true),
	created_at: timestamp().notNull().defaultNow(),
	deadline: varchar({ length: 60 }),
	id: uuid().defaultRandom().primaryKey(),
	message: text(),
	name: varchar({ length: 160 }).notNull(),
	organizer_email: varchar({ length: 320 }),
	product_id: varchar({ length: 40 }).notNull(),
	slug: varchar({ length: 80 }).notNull().unique()
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

// Newsletter subscribers. `email` is the primary key so signups are idempotent.
export const commerceSubscribers = pgTable('subscribers', {
	created_at: timestamp().notNull().defaultNow(),
	email: varchar({ length: 320 }).primaryKey()
});

// Every commerce table in one object — spread into your own Drizzle schema.
export const commerceDrizzleSchema = {
	abandonedCarts: commerceAbandonedCarts,
	designs: commerceDesigns,
	discounts: commerceDiscounts,
	favorites: commerceFavorites,
	giftCards: commerceGiftCards,
	groupOrders: commerceGroupOrders,
	groupStores: commerceGroupStores,
	orders: commerceOrders,
	quotes: commerceQuotes,
	returnRequests: commerceReturnRequests,
	reviews: commerceReviews,
	savedDesigns: commerceSavedDesigns,
	subscribers: commerceSubscribers
};

export * from './queries';
