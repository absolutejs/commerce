// Typed query helpers over the commerce tables. Each takes your Drizzle db
// instance (Postgres) as the first arg, so they work with whatever connection
// the host app already has. drizzle-orm is a peer dependency.

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
	commerceAbandonedCarts,
	commerceCompanies,
	commerceFavorites,
	commerceGalleryItems,
	commerceGiftCards,
	commerceGroupOrders,
	commerceGroupStores,
	commerceInventory,
	commerceInvoices,
	commerceLoyalty,
	commerceOrders,
	commercePushSubscriptions,
	commerceReturnRequests,
	commerceReviews,
	commerceSavedDesigns,
	commerceSubscribers
} from './index';

// Any Postgres Drizzle database (NeonHttpDatabase, NodePgDatabase, …).
export type CommerceDb = PgDatabase<any, any, any>;

export type Review = typeof commerceReviews.$inferSelect;
export type NewReview = typeof commerceReviews.$inferInsert;
export type Favorite = typeof commerceFavorites.$inferSelect;
export type SavedDesign = typeof commerceSavedDesigns.$inferSelect;
export type NewSavedDesign = typeof commerceSavedDesigns.$inferInsert;
export type ReturnRequest = typeof commerceReturnRequests.$inferSelect;
export type NewReturnRequest = typeof commerceReturnRequests.$inferInsert;
export type GiftCard = typeof commerceGiftCards.$inferSelect;
export type GroupStore = typeof commerceGroupStores.$inferSelect;
export type NewGroupStore = typeof commerceGroupStores.$inferInsert;
export type GalleryItem = typeof commerceGalleryItems.$inferSelect;
export type NewGalleryItem = typeof commerceGalleryItems.$inferInsert;
export type InventoryItem = typeof commerceInventory.$inferSelect;
export type NewInventoryItem = typeof commerceInventory.$inferInsert;
export type Company = typeof commerceCompanies.$inferSelect;
export type NewCompany = typeof commerceCompanies.$inferInsert;
export type PushSubscription = typeof commercePushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof commercePushSubscriptions.$inferInsert;
export type Loyalty = typeof commerceLoyalty.$inferSelect;
export type NewLoyalty = typeof commerceLoyalty.$inferInsert;
export type Invoice = typeof commerceInvoices.$inferSelect;
export type NewInvoice = typeof commerceInvoices.$inferInsert;
export type GiftCardRedemption = {
	appliedCents: number;
	balanceCents: number;
};
export type RatingSummary = {
	productId: string;
	count: number;
	average: number;
};

// ---- Reviews ----

export const createReview = async (db: CommerceDb, review: NewReview) => {
	const [created] = await db
		.insert(commerceReviews)
		.values(review)
		.returning();

	return created;
};

export const listAllReviews = (db: CommerceDb) =>
	db.select().from(commerceReviews).orderBy(desc(commerceReviews.created_at));

export const listApprovedReviews = (db: CommerceDb, productId?: string) =>
	db
		.select()
		.from(commerceReviews)
		.where(
			productId
				? and(
						eq(commerceReviews.status, 'approved'),
						eq(commerceReviews.product_id, productId)
					)
				: eq(commerceReviews.status, 'approved')
		)
		.orderBy(desc(commerceReviews.created_at));

export const ratingSummaries = async (
	db: CommerceDb
): Promise<RatingSummary[]> => {
	const rows = await db
		.select({
			average: sql<number>`avg(${commerceReviews.rating})`,
			count: sql<number>`count(*)`,
			productId: commerceReviews.product_id
		})
		.from(commerceReviews)
		.where(eq(commerceReviews.status, 'approved'))
		.groupBy(commerceReviews.product_id);

	return rows.map((row) => ({
		average: Math.round(Number(row.average) * 10) / 10,
		count: Number(row.count),
		productId: row.productId
	}));
};

export const setReviewStatus = async (
	db: CommerceDb,
	id: string,
	status: string
) => {
	const [updated] = await db
		.update(commerceReviews)
		.set({ status })
		.where(eq(commerceReviews.id, id))
		.returning();

	return updated;
};

// ---- Favorites ----

export const listFavorites = async (db: CommerceDb, email: string) => {
	const rows = await db
		.select({ productId: commerceFavorites.product_id })
		.from(commerceFavorites)
		.where(eq(commerceFavorites.customer_email, email));

	return rows.map((row) => row.productId);
};

export const toggleFavorite = async (
	db: CommerceDb,
	email: string,
	productId: string
) => {
	const existing = await db
		.select({ id: commerceFavorites.id })
		.from(commerceFavorites)
		.where(
			and(
				eq(commerceFavorites.customer_email, email),
				eq(commerceFavorites.product_id, productId)
			)
		)
		.limit(1);

	if (existing.length > 0) {
		await db
			.delete(commerceFavorites)
			.where(eq(commerceFavorites.id, existing[0]!.id));

		return false;
	}

	await db
		.insert(commerceFavorites)
		.values({ customer_email: email, product_id: productId });

	return true;
};

// ---- Saved designs ----

export const deleteSavedDesign = async (
	db: CommerceDb,
	id: string,
	email: string
) => {
	const [deleted] = await db
		.delete(commerceSavedDesigns)
		.where(
			and(
				eq(commerceSavedDesigns.id, id),
				eq(commerceSavedDesigns.customer_email, email)
			)
		)
		.returning();

	return deleted;
};

export const listSavedDesigns = (db: CommerceDb, email: string) =>
	db
		.select()
		.from(commerceSavedDesigns)
		.where(eq(commerceSavedDesigns.customer_email, email))
		.orderBy(desc(commerceSavedDesigns.created_at));

export const saveDesign = async (db: CommerceDb, design: NewSavedDesign) => {
	const [created] = await db
		.insert(commerceSavedDesigns)
		.values(design)
		.returning();

	return created;
};

// ---- Gift cards ----

export const issueGiftCard = async (
	db: CommerceDb,
	input: { code: string; cents: number; recipientEmail?: string | null }
) => {
	const [created] = await db
		.insert(commerceGiftCards)
		.values({
			balance_cents: input.cents,
			code: input.code.trim().toUpperCase(),
			initial_cents: input.cents,
			recipient_email: input.recipientEmail ?? null
		})
		.returning();

	return created;
};

export const getGiftCard = async (db: CommerceDb, code: string) => {
	const [card] = await db
		.select()
		.from(commerceGiftCards)
		.where(eq(commerceGiftCards.code, code.trim().toUpperCase()))
		.limit(1);

	return card ?? null;
};

// Apply up to `amountCents` from a card; returns how much was applied + the new
// balance, or null if the code is unknown. Applying 0 (empty card) is a no-op.
export const redeemGiftCard = async (
	db: CommerceDb,
	code: string,
	amountCents: number
): Promise<GiftCardRedemption | null> => {
	const card = await getGiftCard(db, code);
	if (!card) return null;
	const applied = Math.max(0, Math.min(card.balance_cents, amountCents));
	const balance = card.balance_cents - applied;
	if (applied > 0)
		await db
			.update(commerceGiftCards)
			.set({ balance_cents: balance })
			.where(eq(commerceGiftCards.code, card.code));

	return { appliedCents: applied, balanceCents: balance };
};

// ---- B2B companies ----

export const createCompany = async (db: CommerceDb, company: NewCompany) => {
	const [created] = await db
		.insert(commerceCompanies)
		.values(company)
		.returning();

	return created;
};

export const listCompanies = (db: CommerceDb) =>
	db.select().from(commerceCompanies).orderBy(desc(commerceCompanies.created_at));

export const getCompany = async (db: CommerceDb, id: string) => {
	const [company] = await db
		.select()
		.from(commerceCompanies)
		.where(eq(commerceCompanies.id, id))
		.limit(1);

	return company ?? null;
};

export const updateCompany = async (
	db: CommerceDb,
	id: string,
	patch: Partial<NewCompany>
) => {
	const [updated] = await db
		.update(commerceCompanies)
		.set(patch)
		.where(eq(commerceCompanies.id, id))
		.returning();

	return updated;
};

// ---- B2B invoices ----

export const createInvoice = async (db: CommerceDb, invoice: NewInvoice) => {
	const [created] = await db
		.insert(commerceInvoices)
		.values(invoice)
		.returning();

	return created;
};

export const listInvoices = (db: CommerceDb) =>
	db.select().from(commerceInvoices).orderBy(desc(commerceInvoices.created_at));

export const getInvoice = async (db: CommerceDb, id: string) => {
	const [invoice] = await db
		.select()
		.from(commerceInvoices)
		.where(eq(commerceInvoices.id, id))
		.limit(1);

	return invoice ?? null;
};

export const getInvoiceByOrder = async (
	db: CommerceDb,
	orderSession: string
) => {
	const [invoice] = await db
		.select()
		.from(commerceInvoices)
		.where(eq(commerceInvoices.order_session, orderSession))
		.limit(1);

	return invoice ?? null;
};

export const setInvoiceStatus = async (
	db: CommerceDb,
	id: string,
	status: string
) => {
	const [updated] = await db
		.update(commerceInvoices)
		.set({ status })
		.where(eq(commerceInvoices.id, id))
		.returning();

	return updated;
};

// ---- Loyalty + referrals ----

// Fetch a customer's loyalty row, creating it with `referralCode` if absent.
// The caller supplies the code (generated app-side) so this stays deterministic.
export const ensureLoyalty = async (
	db: CommerceDb,
	email: string,
	referralCode: string
) => {
	const [row] = await db
		.insert(commerceLoyalty)
		.values({ email, referral_code: referralCode })
		.onConflictDoNothing({ target: commerceLoyalty.email })
		.returning();
	if (row) return row;
	const [existing] = await db
		.select()
		.from(commerceLoyalty)
		.where(eq(commerceLoyalty.email, email))
		.limit(1);

	return existing;
};

export const getLoyalty = async (db: CommerceDb, email: string) => {
	const [row] = await db
		.select()
		.from(commerceLoyalty)
		.where(eq(commerceLoyalty.email, email))
		.limit(1);

	return row ?? null;
};

export const getLoyaltyByReferralCode = async (
	db: CommerceDb,
	code: string
) => {
	const [row] = await db
		.select()
		.from(commerceLoyalty)
		.where(eq(commerceLoyalty.referral_code, code))
		.limit(1);

	return row ?? null;
};

export const addLoyaltyPoints = async (
	db: CommerceDb,
	email: string,
	points: number
) => {
	const [row] = await db
		.update(commerceLoyalty)
		.set({ points: sql`${commerceLoyalty.points} + ${points}` })
		.where(eq(commerceLoyalty.email, email))
		.returning();

	return row;
};

export const spendLoyaltyPoints = async (
	db: CommerceDb,
	email: string,
	points: number
) => {
	const [row] = await db
		.update(commerceLoyalty)
		.set({ points: sql`GREATEST(${commerceLoyalty.points} - ${points}, 0)` })
		.where(eq(commerceLoyalty.email, email))
		.returning();

	return row;
};

export const setReferredBy = async (
	db: CommerceDb,
	email: string,
	code: string
) => {
	const [row] = await db
		.update(commerceLoyalty)
		.set({ referred_by: code })
		.where(eq(commerceLoyalty.email, email))
		.returning();

	return row;
};

// ---- Web Push subscriptions ----

export const savePushSubscription = async (
	db: CommerceDb,
	sub: NewPushSubscription
) => {
	const [saved] = await db
		.insert(commercePushSubscriptions)
		.values(sub)
		.onConflictDoUpdate({
			set: { auth: sub.auth, email: sub.email, p256dh: sub.p256dh, role: sub.role },
			target: commercePushSubscriptions.endpoint
		})
		.returning();

	return saved;
};

export const listPushSubscriptions = (db: CommerceDb) =>
	db.select().from(commercePushSubscriptions);

export const listPushSubscriptionsByEmail = (db: CommerceDb, email: string) =>
	db
		.select()
		.from(commercePushSubscriptions)
		.where(eq(commercePushSubscriptions.email, email));

export const listPushSubscriptionsByRole = (db: CommerceDb, role: string) =>
	db
		.select()
		.from(commercePushSubscriptions)
		.where(eq(commercePushSubscriptions.role, role));

export const deletePushSubscription = async (db: CommerceDb, endpoint: string) => {
	await db
		.delete(commercePushSubscriptions)
		.where(eq(commercePushSubscriptions.endpoint, endpoint));
};

export const prunePushSubscriptions = async (
	db: CommerceDb,
	endpoints: string[]
) => {
	if (endpoints.length === 0) return;
	await db
		.delete(commercePushSubscriptions)
		.where(inArray(commercePushSubscriptions.endpoint, endpoints));
};

// ---- Inventory (blank stock) ----

export const listInventory = (db: CommerceDb) =>
	db.select().from(commerceInventory).orderBy(desc(commerceInventory.created_at));

export const addInventoryItem = async (
	db: CommerceDb,
	item: NewInventoryItem
) => {
	const [created] = await db
		.insert(commerceInventory)
		.values(item)
		.returning();

	return created;
};

export const setInventoryQuantity = async (
	db: CommerceDb,
	id: string,
	quantity: number
) => {
	const [updated] = await db
		.update(commerceInventory)
		.set({ quantity })
		.where(eq(commerceInventory.id, id))
		.returning();

	return updated;
};

export const deleteInventoryItem = async (db: CommerceDb, id: string) => {
	await db.delete(commerceInventory).where(eq(commerceInventory.id, id));
};

// ---- Portfolio gallery ----

export const createGalleryItem = async (
	db: CommerceDb,
	item: NewGalleryItem
) => {
	const [created] = await db
		.insert(commerceGalleryItems)
		.values(item)
		.returning();

	return created;
};

export const listGalleryItems = (db: CommerceDb) =>
	db
		.select()
		.from(commerceGalleryItems)
		.orderBy(desc(commerceGalleryItems.created_at));

export const deleteGalleryItem = async (db: CommerceDb, id: string) => {
	await db.delete(commerceGalleryItems).where(eq(commerceGalleryItems.id, id));
};

// ---- Group / team stores ----

export const createGroupStore = async (
	db: CommerceDb,
	store: NewGroupStore
) => {
	const [created] = await db
		.insert(commerceGroupStores)
		.values(store)
		.returning();

	return created;
};

export const listGroupStores = (db: CommerceDb) =>
	db
		.select()
		.from(commerceGroupStores)
		.orderBy(desc(commerceGroupStores.created_at));

export const getGroupStoreBySlug = async (db: CommerceDb, slug: string) => {
	const [store] = await db
		.select()
		.from(commerceGroupStores)
		.where(eq(commerceGroupStores.slug, slug))
		.limit(1);

	return store ?? null;
};

export const recordGroupOrder = async (
	db: CommerceDb,
	slug: string,
	orderSessionId: string
) => {
	await db
		.insert(commerceGroupOrders)
		.values({ group_slug: slug, order_session_id: orderSessionId });
};

export const listGroupOrders = (db: CommerceDb, slug: string) =>
	db
		.select()
		.from(commerceGroupOrders)
		.where(eq(commerceGroupOrders.group_slug, slug))
		.orderBy(desc(commerceGroupOrders.created_at));

// ---- Tracking + returns ----

export const createReturnRequest = async (
	db: CommerceDb,
	request: NewReturnRequest
) => {
	const [created] = await db
		.insert(commerceReturnRequests)
		.values(request)
		.returning();

	return created;
};

// Look up an order by its short number (last 8 of the session id) + email.
// The email gate keeps order details private without requiring sign-in.
export const findOrderForTracking = async (
	db: CommerceDb,
	orderNumber: string,
	email: string
) => {
	const tail = orderNumber.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
	if (tail.length < 4) return null;

	const [order] = await db
		.select({
			amount_total: commerceOrders.amount_total,
			carrier: commerceOrders.carrier,
			created_at: commerceOrders.created_at,
			production_stage: commerceOrders.production_stage,
			session_id: commerceOrders.session_id,
			status: commerceOrders.status,
			tracking_number: commerceOrders.tracking_number
		})
		.from(commerceOrders)
		.where(
			and(
				sql`lower(right(${commerceOrders.session_id}, 8)) = ${tail}`,
				sql`lower(${commerceOrders.customer_email}) = ${email.trim().toLowerCase()}`
			)
		)
		.limit(1);

	return order ?? null;
};

export const listReturnRequests = (db: CommerceDb) =>
	db
		.select()
		.from(commerceReturnRequests)
		.orderBy(desc(commerceReturnRequests.created_at));

export const setReturnStatus = async (
	db: CommerceDb,
	id: string,
	status: string
) => {
	const [updated] = await db
		.update(commerceReturnRequests)
		.set({ status })
		.where(eq(commerceReturnRequests.id, id))
		.returning();

	return updated;
};

// ---- Newsletter ----

export const listSubscribers = (db: CommerceDb) =>
	db
		.select()
		.from(commerceSubscribers)
		.orderBy(desc(commerceSubscribers.created_at));

export const subscribe = async (db: CommerceDb, email: string) => {
	await db
		.insert(commerceSubscribers)
		.values({ email: email.trim().toLowerCase() })
		.onConflictDoNothing();
};

// ---- Abandoned carts ----

export const dueForReminder = (db: CommerceDb, before: Date) =>
	db
		.select()
		.from(commerceAbandonedCarts)
		.where(
			and(
				eq(commerceAbandonedCarts.recovered, false),
				eq(commerceAbandonedCarts.reminded, false),
				lt(commerceAbandonedCarts.created_at, before)
			)
		);

export const markCartsRecovered = (db: CommerceDb, email: string) =>
	db
		.update(commerceAbandonedCarts)
		.set({ recovered: true })
		.where(
			and(
				sql`lower(${commerceAbandonedCarts.customer_email}) = ${email.trim().toLowerCase()}`,
				eq(commerceAbandonedCarts.recovered, false)
			)
		);

export const markReminded = (db: CommerceDb, id: string) =>
	db
		.update(commerceAbandonedCarts)
		.set({ reminded: true })
		.where(eq(commerceAbandonedCarts.id, id));

export const recordAbandonedCart = async (
	db: CommerceDb,
	email: string,
	cart: unknown[]
) => {
	await db
		.insert(commerceAbandonedCarts)
		.values({ cart, customer_email: email.trim().toLowerCase() });
};
