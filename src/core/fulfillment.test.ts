import { describe, expect, it } from 'bun:test';
import {
	routeFulfillmentOrder,
	validateFulfillmentOrder,
	type FulfillmentOrderRequest
} from './fulfillment';

const order: FulfillmentOrderRequest = {
	externalOrderId: 'ORDER-100',
	lines: [
		{
			artwork: [{ placement: 'front', url: 'https://cdn.test/art.png' }],
			id: 'line-1',
			providerId: 'customcat',
			providerSku: '48146',
			quantity: 1,
			variantId: 'customcat:48146'
		}
	],
	recipient: {
		address1: '100 Main St',
		city: 'Detroit',
		country: 'US',
		firstName: 'Ada',
		lastName: 'Lovelace',
		postalCode: '48201',
		state: 'MI'
	}
};

describe('fulfillment routing', () => {
	it('keeps a single-provider order id unchanged', () => {
		const [routed] = routeFulfillmentOrder(order);
		expect(routed?.externalOrderId).toBe('ORDER-100');
		expect(routed?.providerId).toBe('customcat');
	});

	it('splits mixed-provider orders into stable provider jobs', () => {
		const routed = routeFulfillmentOrder({
			...order,
			lines: [
				...order.lines,
				{ ...order.lines[0]!, id: 'line-2', providerId: 'local' }
			]
		});
		expect(routed.map((job) => job.externalOrderId)).toEqual([
			'ORDER-100-customcat',
			'ORDER-100-local'
		]);
	});
});

describe('fulfillment validation', () => {
	it('accepts a complete provider order', () => {
		expect(validateFulfillmentOrder(order)).toEqual({
			errors: [],
			valid: true
		});
	});

	it('reports line and address failures together', () => {
		const result = validateFulfillmentOrder({
			...order,
			lines: [{ ...order.lines[0]!, artwork: [], quantity: 0 }],
			recipient: { ...order.recipient, postalCode: '' }
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(3);
	});
});
