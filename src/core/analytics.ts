// Pure order analytics — no DB, no deps. Feed it order rows (from any source)
// and get back the numbers an owner dashboard / light CRM needs.
//
// Amounts are integer minor units (cents), matching the order/payment layer.

export type AnalyticsOrderLine = {
	product: string;
	quantity: number;
	amountTotal: number;
};

export type AnalyticsOrder = {
	amount_total: number | null;
	created_at: Date | string;
	status: string;
	customer_email?: string | null;
	line_items?: AnalyticsOrderLine[] | null;
};

export type DayRevenue = { date: string; revenueCents: number; orders: number };
export type ProductRevenue = {
	product: string;
	quantity: number;
	revenueCents: number;
};

export type SalesSummary = {
	paidOrders: number;
	revenueCents: number;
	averageOrderCents: number;
	statusCounts: Record<string, number>;
	revenueByDay: DayRevenue[];
	topProducts: ProductRevenue[];
};

// Orders in these states count as realized revenue.
const REVENUE_STATES = new Set(['paid', 'shipped']);

const isoDay = (value: Date | string) => {
	const text = typeof value === 'string' ? value : value.toISOString();

	return text.slice(0, 10);
};

/** Aggregate revenue, AOV, status mix, revenue-by-day, and top products. */
export const salesSummary = (orders: AnalyticsOrder[]): SalesSummary => {
	const statusCounts: Record<string, number> = {};
	const byDay = new Map<string, DayRevenue>();
	const byProduct = new Map<string, ProductRevenue>();
	let revenueCents = 0;
	let paidOrders = 0;

	for (const order of orders) {
		statusCounts[order.status] = (statusCounts[order.status] ?? 0) + 1;
		if (!REVENUE_STATES.has(order.status)) continue;

		const amount = order.amount_total ?? 0;
		revenueCents += amount;
		paidOrders += 1;

		const day = isoDay(order.created_at);
		const existing = byDay.get(day) ?? { date: day, orders: 0, revenueCents: 0 };
		existing.orders += 1;
		existing.revenueCents += amount;
		byDay.set(day, existing);

		for (const line of order.line_items ?? []) {
			const row = byProduct.get(line.product) ?? {
				product: line.product,
				quantity: 0,
				revenueCents: 0
			};
			row.quantity += line.quantity;
			row.revenueCents += line.amountTotal;
			byProduct.set(line.product, row);
		}
	}

	return {
		averageOrderCents: paidOrders ? Math.round(revenueCents / paidOrders) : 0,
		paidOrders,
		revenueByDay: [...byDay.values()].sort((left, right) =>
			left.date < right.date ? -1 : 1
		),
		revenueCents,
		statusCounts,
		topProducts: [...byProduct.values()]
			.sort((left, right) => right.revenueCents - left.revenueCents)
			.slice(0, 8)
	};
};

export type CustomerSummary = {
	email: string;
	orders: number;
	totalSpentCents: number;
	firstOrderAt: string;
	lastOrderAt: string;
};

/** Per-customer rollup (realized-revenue orders), newest activity first. */
export const customerSummaries = (
	orders: AnalyticsOrder[]
): CustomerSummary[] => {
	const byEmail = new Map<string, CustomerSummary>();

	for (const order of orders) {
		if (!order.customer_email || !REVENUE_STATES.has(order.status)) continue;
		const email = order.customer_email.toLowerCase();
		const at = isoDay(order.created_at);
		const existing = byEmail.get(email) ?? {
			email,
			firstOrderAt: at,
			lastOrderAt: at,
			orders: 0,
			totalSpentCents: 0
		};
		existing.orders += 1;
		existing.totalSpentCents += order.amount_total ?? 0;
		if (at < existing.firstOrderAt) existing.firstOrderAt = at;
		if (at > existing.lastOrderAt) existing.lastOrderAt = at;
		byEmail.set(email, existing);
	}

	return [...byEmail.values()].sort((left, right) =>
		left.lastOrderAt < right.lastOrderAt ? 1 : -1
	);
};
