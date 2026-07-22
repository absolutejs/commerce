import { describe, expect, it } from 'bun:test';
import {
	findVariantByOptions,
	listingPriceCents,
	mediaForColor,
	optionValues,
	variantIsAvailable,
	type CatalogListing,
	type ProductVariant
} from './catalog';

const variant = (
	id: string,
	color: string,
	size: string,
	quantity: number | null = 4
): ProductVariant => ({
	available: true,
	currency: 'USD',
	id,
	inventoryPolicy: 'deny',
	inventoryQuantity: quantity,
	media: [],
	metadata: {},
	options: { Color: color, Size: size },
	priceCents: 1299,
	productId: 'sanmar:pc54',
	sku: `PC54-${color}-${size}`
});

const variants = [
	variant('black-s', 'Black', 'S'),
	variant('black-m', 'Black', 'M'),
	variant('navy-s', 'Navy', 'S', 0)
];

describe('catalog variants', () => {
	it('resolves arbitrary options without depending on case', () => {
		expect(
			findVariantByOptions(variants, { color: 'black', SIZE: 'm' })?.id
		).toBe('black-m');
	});

	it('returns ordered unique values and can exclude unavailable variants', () => {
		expect(optionValues(variants, 'Color')).toEqual(['Black', 'Navy']);
		expect(optionValues(variants, 'color', true)).toEqual(['Black']);
	});

	it('honors inventory policy', () => {
		expect(variantIsAvailable(variants[0]!)).toBe(true);
		expect(variantIsAvailable(variants[2]!)).toBe(false);
		expect(
			variantIsAvailable({ ...variants[2]!, inventoryPolicy: 'external' })
		).toBe(true);
	});
});

describe('catalog merchandising', () => {
	it('uses a store override before a supplier variant price', () => {
		const listing = { basePriceCents: 2400 } as CatalogListing;
		expect(listingPriceCents(listing, variants[0])).toBe(2400);
		expect(
			listingPriceCents({ ...listing, basePriceCents: null }, variants[0])
		).toBe(1299);
	});

	it('puts color-specific media before universal fallbacks', () => {
		const result = mediaForColor(
			[
				{ kind: 'image', url: '/generic.jpg', view: 'front' },
				{ color: 'Navy', kind: 'image', url: '/navy.jpg', view: 'front' },
				{ color: 'Black', kind: 'image', url: '/black.jpg', view: 'front' }
			],
			'navy'
		);
		expect(result.map((item) => item.url)).toEqual([
			'/navy.jpg',
			'/generic.jpg'
		]);
	});
});
