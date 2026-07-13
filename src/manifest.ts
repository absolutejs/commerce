import { defineManifest, toolFactory } from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import { desc, eq, lte } from 'drizzle-orm';
import type { CommerceDb } from './drizzle';
import { commerceInventory, commerceOrders } from './drizzle';

const tool = toolFactory<CommerceDb>();

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/* Commerce has no factory config: it is a library of primitives (cart math,
 * order lifecycle, pricing, email building blocks), three provider contracts
 * (payment, shipping, email — each a standalone instance the app wires, hence
 * `$self` slots), and a Drizzle schema. Tools run against the app's commerce
 * database (`CommerceDb`). */
export const manifest = defineManifest<Record<never, never>, CommerceDb>()({
	contract: 1,
	identity: {
		accent: '#10b981',
		category: 'commerce',
		description:
			'Provider-agnostic commerce primitives: cart and pricing math, order + fulfillment lifecycle, discount codes, branded transactional-email building blocks, and a ready-made Drizzle schema (orders, inventory, quotes, gift cards, loyalty, reviews). Payments, shipping, and email ride pluggable vendor adapters (`@absolutejs/commerce-*`), so a shop keeps the gateway and carrier accounts it already has.',
		docsUrl: 'https://github.com/absolutejs/commerce',
		name: '@absolutejs/commerce',
		tagline: 'Sell products — cart, checkout, and shipping.'
	},
	requires: {
		peers: [
			{
				name: 'drizzle-orm',
				range: '>=0.30.0',
				reason: 'order/inventory tables and queries (the ./drizzle subpath)'
			}
		],
		services: [
			{
				description:
					'Orders, inventory, quotes, gift cards, and loyalty tables live here',
				id: 'postgres',
				optional: true
			}
		]
	},
	lifecycle: [
		{
			// v1 has no code-change steps: merge `commerceDrizzleSchema` into the
			// app's Drizzle schema, then push with drizzle-kit (see docsUrl).
			docsUrl: 'https://github.com/absolutejs/commerce#readme',
			id: 'drizzle-schema',
			idempotent: true,
			kind: 'migration',
			title: 'Add the commerce tables to your Drizzle schema and run `drizzle-kit push`',
			when: 'before-first-run'
		}
	],
	settings: Type.Object({}),
	slots: {
		email: {
			configPath: '$self',
			contract: 'commerce/email-provider',
			description: 'Who delivers your order and receipt emails',
			known: ['@absolutejs/commerce-resend']
		},
		payment: {
			configPath: '$self',
			contract: 'commerce/payment-provider',
			description: 'Who processes payments and hosts checkout',
			known: ['@absolutejs/commerce-stripe']
		},
		shipping: {
			configPath: '$self',
			contract: 'commerce/shipping-provider',
			description: 'Who quotes rates and prints shipping labels',
			known: ['@absolutejs/commerce-easypost']
		}
	},
	tools: {
		inventory_levels: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'Current blank-stock inventory (product, size, color, quantity on hand). Set lowOnly to list only items at or below their restock threshold.',
			handler: async ({ lowOnly }, db) => {
				const rows = await db
					.select()
					.from(commerceInventory)
					.where(
						lowOnly === true
							? lte(
									commerceInventory.quantity,
									commerceInventory.low_threshold
								)
							: undefined
					)
					.orderBy(
						commerceInventory.product_id,
						commerceInventory.size
					);

				return rows.length === 0
					? lowOnly === true
						? 'no items are at or below their restock threshold'
						: 'no inventory items recorded'
					: JSON.stringify(rows);
			},
			input: Type.Object({
				lowOnly: Type.Optional(
					Type.Boolean({
						description:
							'Only items at or below their low-stock threshold.'
					})
				)
			})
		}),
		list_orders: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'List recent orders (newest first) with status, production stage, total, and tracking. Filter by status: paid, shipped, rejected, failed, or refunded.',
			handler: async ({ limit, status }, db) => {
				const rows = await db
					.select({
						amount_total: commerceOrders.amount_total,
						created_at: commerceOrders.created_at,
						currency: commerceOrders.currency,
						customer_email: commerceOrders.customer_email,
						production_stage: commerceOrders.production_stage,
						session_id: commerceOrders.session_id,
						status: commerceOrders.status,
						tracking_number: commerceOrders.tracking_number
					})
					.from(commerceOrders)
					.where(
						status === undefined
							? undefined
							: eq(commerceOrders.status, status)
					)
					.orderBy(desc(commerceOrders.created_at))
					.limit(limit ?? DEFAULT_LIST_LIMIT);

				return rows.length === 0
					? 'no orders found'
					: JSON.stringify(rows);
			},
			input: Type.Object({
				limit: Type.Optional(
					Type.Integer({ maximum: MAX_LIST_LIMIT, minimum: 1 })
				),
				status: Type.Optional(
					Type.Union([
						Type.Literal('paid'),
						Type.Literal('shipped'),
						Type.Literal('rejected'),
						Type.Literal('failed'),
						Type.Literal('refunded')
					])
				)
			})
		}),
		order_detail: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'Full detail for one order by its checkout session id: line items, shipping address, production stage, proof status, and tracking.',
			handler: async ({ sessionId }, db) => {
				const [order] = await db
					.select()
					.from(commerceOrders)
					.where(eq(commerceOrders.session_id, sessionId))
					.limit(1);

				return order === undefined
					? `no order found for session "${sessionId}"`
					: JSON.stringify(order);
			},
			input: Type.Object({
				sessionId: Type.String({ minLength: 1 })
			})
		})
	},
	wiring: [
		{
			description:
				'Each surface is independent — wire only the providers your shop uses.',
			id: 'default',
			server: {
				code: [
					'const payments = ${slot.payment};',
					'const shipping = ${slot.shipping};',
					'const receipts = ${slot.email};'
				].join('\n'),
				imports: [],
				placement: 'module-scope'
			},
			title: 'Wire the payment, shipping, and email providers'
		}
	]
});
