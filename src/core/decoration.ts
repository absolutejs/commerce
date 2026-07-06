// Digital → physical decoration specs. Converts a customer's configured
// design into the numbers a real operator needs: design dimensions, placement
// measurements from garment landmarks, thread color sequence (brand + catalog
// code), stitch estimates, per-1k-stitch pricing, print validation
// (DPI-at-size, separations, underbase), and printable work-order sheets.
//
// Everything is data-in: the app resolves its own product/method catalogs and
// hands plain inputs — no shop-specific lookups live here.

import { hexToRgb, type PantoneMatch, type ThreadRef } from './threads';

export type EmbroideryType = 'flat' | 'puff';

/** Real-world size of a decoration zone + the landmark it's measured from. */
export type ZonePhysical = {
	widthIn: number;
	heightIn: number;
	/** Where the zone center sits, e.g. "5″ below collar seam, centered". */
	anchor: string;
};

/** A decoratable region: 3D size (scene units) + physical size (inches). */
export type DecorationZoneSpec = {
	id: string;
	label: string;
	size: [number, number];
	physical: ZonePhysical;
};

export type PlacementTransform = {
	offsetX: number;
	offsetY: number;
	rotation: number;
	scale: number;
};

/** Source-art facts for print-method validation (DPI, separations). */
export type ArtFacts = {
	pixelWidth: number;
	isVector: boolean;
	colorCount: number;
};

const MM_PER_INCH = 25.4;
/** Fill-stitch density heuristic (~2.8 stitches per mm² of covered area). */
const STITCHES_PER_MM2 = 2.8;
/** Round stitch estimates to the nearest hundred — a quote, not a count. */
const STITCH_ROUND = 100;

const clamp = (value: number, low: number, high: number) =>
	Math.max(low, Math.min(high, value));

// Mirrors the 3D decal fit: design fits inside the zone preserving aspect,
// then scales by the customer's size setting.
export const fitDesignIn = (
	zone: DecorationZoneSpec,
	aspect: number,
	scale: number
) => {
	const [zoneW, zoneH] = zone.size;
	let width = zoneW;
	let height = zoneW / aspect;
	if (height > zoneH) {
		height = zoneH;
		width = zoneH * aspect;
	}
	const factor = clamp(scale, 0.2, 1);

	return { height: height * factor, width: width * factor };
};

export type DesignDimensions = {
	widthIn: number;
	heightIn: number;
	widthMm: number;
	heightMm: number;
	/** Offset of design center from zone center, inches (right/up positive). */
	offsetXIn: number;
	offsetYIn: number;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

export const designDimensions = (
	zone: DecorationZoneSpec,
	aspect: number,
	scale: number,
	offsetX: number,
	offsetY: number
): DesignDimensions => {
	const fit = fitDesignIn(zone, aspect, scale);
	const inchesPerUnitX = zone.physical.widthIn / zone.size[0];
	const inchesPerUnitY = zone.physical.heightIn / zone.size[1];
	const widthIn = fit.width * inchesPerUnitX;
	const heightIn = fit.height * inchesPerUnitY;

	return {
		heightIn: round1(heightIn),
		heightMm: Math.round(heightIn * MM_PER_INCH),
		offsetXIn: round1(offsetX * inchesPerUnitX),
		offsetYIn: round1(offsetY * inchesPerUnitY),
		widthIn: round1(widthIn),
		widthMm: Math.round(widthIn * MM_PER_INCH)
	};
};

/**
 * Coverage-based stitch estimate for quoting. Real counts come from
 * digitizing — this mirrors how estimator tools quote from raw art.
 */
export const estimateStitches = (
	dims: Pick<DesignDimensions, 'widthMm' | 'heightMm'>,
	coverage: number
) => {
	const area = dims.widthMm * dims.heightMm * clamp(coverage, 0.02, 1);
	const raw = area * STITCHES_PER_MM2;

	return Math.max(STITCH_ROUND, Math.round(raw / STITCH_ROUND) * STITCH_ROUND);
};

export const formatInches = (dims: DesignDimensions) =>
	`${dims.widthIn}″ × ${dims.heightIn}″`;

export const formatStitches = (count: number) =>
	count >= 1000
		? `~${(count / 1000).toFixed(1).replace(/\.0$/, '')}k stitches`
		: `~${count} stitches`;

/* -------------------------- per-1k-stitch pricing ------------------------- */

export type EmbroideryRates = {
	/** Handling base per piece. */
	base: number;
	/** Price per 1,000 estimated stitches. */
	per1k: number;
};

export const DEFAULT_EMBROIDERY_RATES: EmbroideryRates = {
	base: 3,
	per1k: 0.5
};

/** Per-piece embroidery price for an estimated stitch count. */
export const embroideryUnitPrice = (
	estimatedStitches: number,
	rates: EmbroideryRates = DEFAULT_EMBROIDERY_RATES
) => rates.base + (rates.per1k * estimatedStitches) / 1000;

/** Coarse tier from the physical design size (widest edge), for labeling. */
export const stitchTierFor = (
	dims: Pick<DesignDimensions, 'widthIn' | 'heightIn'>
) => {
	const edge = Math.max(dims.widthIn, dims.heightIn);
	if (edge <= 4) return 'left-chest' as const;
	if (edge <= 7) return 'standard' as const;

	return 'large' as const;
};

type EstimateInput = {
	zone: DecorationZoneSpec;
	aspect: number;
	coverage: number;
	transform: { offsetX: number; offsetY: number; scale: number };
};

/** Dimensions + stitch estimate for one placement (pricing + specs). */
export const placementEstimate = ({
	zone,
	aspect,
	coverage,
	transform
}: EstimateInput) => {
	const dims = designDimensions(
		zone,
		aspect,
		transform.scale,
		transform.offsetX,
		transform.offsetY
	);

	return { dims, stitches: estimateStitches(dims, coverage) };
};

/* ------------------------------ hoop sizing ------------------------------ */

type Hoop = { name: string; maxIn: number };

// Common commercial round hoops; a design needs ~1″ of stabilizer margin.
const HOOPS: Hoop[] = [
	{ maxIn: 2.5, name: '9cm (3.5″) round' },
	{ maxIn: 3.7, name: '12cm (4.7″) round' },
	{ maxIn: 4.9, name: '15cm (5.9″) round' },
	{ maxIn: 6, name: '18cm (7″) round' },
	{ maxIn: 8.4, name: '24cm (9.4″) round' },
	{ maxIn: 10.8, name: '30cm (11.8″) round' }
];

/** Smallest round hoop that fits the design with margin. */
export const suggestHoop = (
	dims: Pick<DesignDimensions, 'widthIn' | 'heightIn'>
) => {
	const edge = Math.max(dims.widthIn, dims.heightIn);
	const hoop = HOOPS.find((entry) => edge <= entry.maxIn);

	return hoop ? hoop.name : 'Split into multiple hoopings (oversize)';
};

/* --------------------------- print-method specs --------------------------- */

/** Print-method production facts (screen print / DTG / vinyl). */
export type PrintSpec = {
	/** Effective raster DPI at the printed size (null for vector art). */
	dpiAtSize: number | null;
	isVector: boolean;
	/** Distinct spot colors detected in the art. */
	colorCount: number;
	/** Screen count for screen print (colors + underbase screen). */
	screens: number | null;
	/** Light ink on a dark garment needs an underbase (screen print). */
	underbase: boolean;
	warnings: string[];
};

/** DTG/raster quality bar: 300 DPI ideal, under 150 visibly degrades. */
const DPI_GOOD = 300;
const DPI_MIN = 150;
/** Screen-print economics degrade past this many spot colors. */
const MAX_SPOT_COLORS = 6;

const luminance = (hex: string) => {
	const [red, green, blue] = hexToRgb(hex);

	return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
};

// Print-method validation the shop would otherwise do by eye: DPI at the
// actual printed size, separation counts, underbase need, vinyl color limit.
export const buildPrintSpec = (
	method: string,
	art: ArtFacts | undefined,
	dims: DesignDimensions,
	garmentHex: string
): PrintSpec | null => {
	if (method === 'embroidery') return null;
	const facts = art ?? { colorCount: 1, isVector: false, pixelWidth: 0 };
	const dpiAtSize =
		facts.isVector || !facts.pixelWidth || dims.widthIn <= 0
			? null
			: Math.round(facts.pixelWidth / dims.widthIn);
	const darkGarment = luminance(garmentHex) < 0.45;
	const underbase = method === 'screen-print' && darkGarment;
	const screens =
		method === 'screen-print'
			? facts.colorCount + (underbase ? 1 : 0)
			: null;

	const warnings: string[] = [];
	if (dpiAtSize !== null && dpiAtSize < DPI_MIN)
		warnings.push(
			`Low resolution: ${dpiAtSize} DPI at print size (${DPI_GOOD} recommended) — request larger art or shrink the print.`
		);
	else if (dpiAtSize !== null && dpiAtSize < DPI_GOOD && method === 'dtg')
		warnings.push(
			`${dpiAtSize} DPI at print size — acceptable, ${DPI_GOOD} recommended for DTG.`
		);
	if (method === 'screen-print' && facts.colorCount > MAX_SPOT_COLORS)
		warnings.push(
			`${facts.colorCount} spot colors → ${screens} screens — consider DTG or simplifying the art.`
		);
	if (method === 'vinyl' && facts.colorCount > 2)
		warnings.push(
			`Vinyl cuts solid colors — ${facts.colorCount} colors detected; art will need layered vinyl or a different method.`
		);
	if (method === 'vinyl' && !facts.isVector)
		warnings.push(
			'Vinyl needs a cut path — raster art must be vectorized before cutting.'
		);

	return {
		colorCount: facts.colorCount,
		dpiAtSize,
		isVector: facts.isVector,
		screens,
		underbase,
		warnings
	};
};

/* ------------------------------ order spec ------------------------------ */

export type PlacementSpec = {
	zoneId: string;
	zoneLabel: string;
	artwork: string;
	artworkUrl: string | null;
	anchor: string;
	dimensions: DesignDimensions;
	rotationDeg: number;
	embroideryType: EmbroideryType;
	stitchTier: string | null;
	estimatedStitches: number | null;
	threads: ThreadRef[];
	hoop: string | null;
	note: string | null;
	pantone: PantoneMatch | null;
	print: PrintSpec | null;
};

export type ItemSpec = {
	product: string;
	productId: string;
	method: string;
	methodLabel: string;
	garmentColor: { name: string; hex: string };
	size: string;
	quantity: number;
	names: string[];
	fabric: string;
	backing: string;
	placements: PlacementSpec[];
};

/** Ground truth read from the digitized machine file (vs our estimates). */
export type MachineFileFacts = {
	stitches: number;
	colorChanges: number;
	widthMm: number;
	heightMm: number;
	label: string;
	filename: string;
};

export type OrderProductionSpec = {
	version: 1;
	generatedAt: string;
	items: ItemSpec[];
	notes: string[];
	/** Set when a digitized machine file is attached and parsed. */
	machineFile?: MachineFileFacts;
};

/** Total estimated stitches across all embroidery placements. */
export const totalEstimatedStitches = (spec: OrderProductionSpec) =>
	spec.items
		.flatMap((item) => item.placements)
		.reduce((sum, place) => sum + (place.estimatedStitches ?? 0), 0);

/* ------------------------- data-in spec building ------------------------- */

export type DecorationPlacementInput = {
	zone: DecorationZoneSpec;
	zoneId: string;
	zoneLabel: string;
	artwork: string;
	artworkUrl: string | null;
	transform?: PlacementTransform;
	aspect?: number;
	coverage?: number;
	threads?: ThreadRef[];
	embroideryType?: EmbroideryType;
	note?: string;
	pantone?: PantoneMatch | null;
	art?: ArtFacts;
	/** App-resolved tier label (e.g. "Left chest"); null for print methods. */
	stitchTierLabel?: string | null;
	/** Override the round-hoop suggestion (e.g. "Cap frame"). */
	hoopOverride?: string;
};

export type DecorationItemInput = {
	product: string;
	productId: string;
	method: string;
	methodLabel: string;
	usesStitchSize: boolean;
	garmentColor: { name: string; hex: string };
	size: string;
	quantity: number;
	names: string[];
	fabric: string;
	backing: string;
	placements: DecorationPlacementInput[];
};

const DEG = 180 / Math.PI;

const IDENTITY: PlacementTransform = {
	offsetX: 0,
	offsetY: 0,
	rotation: 0,
	scale: 1
};

const placementSpec = (
	item: DecorationItemInput,
	place: DecorationPlacementInput
): PlacementSpec => {
	const transform = place.transform ?? IDENTITY;
	const dims = designDimensions(
		place.zone,
		place.aspect ?? 1,
		transform.scale,
		transform.offsetX,
		transform.offsetY
	);

	return {
		anchor: place.zone.physical.anchor,
		artwork: place.artwork,
		artworkUrl: place.artworkUrl,
		dimensions: dims,
		embroideryType: place.embroideryType ?? 'flat',
		estimatedStitches: item.usesStitchSize
			? estimateStitches(dims, place.coverage ?? 0.4)
			: null,
		hoop: item.usesStitchSize
			? (place.hoopOverride ?? suggestHoop(dims))
			: null,
		note: place.note ?? null,
		pantone: place.pantone ?? null,
		print: buildPrintSpec(item.method, place.art, dims, item.garmentColor.hex),
		rotationDeg: Math.round(transform.rotation * DEG),
		stitchTier: item.usesStitchSize ? (place.stitchTierLabel ?? null) : null,
		threads: place.threads ?? [],
		zoneId: place.zoneId,
		zoneLabel: place.zoneLabel
	};
};

export const buildOrderProductionSpec = (
	items: DecorationItemInput[],
	generatedAt: string
): OrderProductionSpec => ({
	generatedAt,
	items: items.map((item) => ({
		backing: item.backing,
		fabric: item.fabric,
		garmentColor: item.garmentColor,
		method: item.method,
		methodLabel: item.methodLabel,
		names: item.names,
		placements: item.placements.map((place) => placementSpec(item, place)),
		product: item.product,
		productId: item.productId,
		quantity: item.quantity,
		size: item.size
	})),
	notes: [
		'Stitch counts are quoting estimates — final counts come from digitizing.',
		'DST/EXP machine files carry no thread colors; pull cones from the thread sequence below.',
		'Placement measurements assume adult sizing — adjust per the size column (youth back placement: 3″ below collar).',
		'Thread codes must match the cones on the rack — confirm brand/line before running.'
	],
	version: 1
});

/* -------------------------- text sheet renderers ------------------------- */

const placementSequenceLines = (item: ItemSpec, place: PlacementSpec) => {
	const header = `${item.product} — ${place.zoneLabel} (${item.garmentColor.name} garment, ${item.methodLabel})`;
	const threadLines =
		place.threads.length === 0
			? ['  (no thread data — assign at digitizing)']
			: place.threads.map(
					(thread, index) =>
						`  Needle ${index + 1}: ${thread.brand} ${thread.code} — ${thread.name} (${thread.hex})`
				);

	return [header, ...threadLines, ''];
};

// Operator-facing color sequence: DST files have color-change stops only, so
// this sheet is what tells the operator which cone goes on which needle.
export const threadSequenceText = (spec: OrderProductionSpec) => {
	const lines = [
		'THREAD COLOR SEQUENCE',
		'=====================',
		'Machine files (DST/EXP) do not carry color. Load needles in this order.',
		'',
		...spec.items.flatMap((item) =>
			item.placements.flatMap((place) =>
				placementSequenceLines(item, place)
			)
		)
	];

	return lines.join('\n');
};

export const workOrderMarkdown = (
	spec: OrderProductionSpec,
	orderRef: string
) => {
	const lines: string[] = [
		`# Work order ${orderRef}`,
		'',
		`Generated ${spec.generatedAt}`,
		''
	];

	spec.items.forEach((item, itemIndex) => {
		lines.push(
			`## ${itemIndex + 1}. ${item.product} — ${item.methodLabel}`,
			'',
			`- Garment: ${item.garmentColor.name} (${item.garmentColor.hex}) · size ${item.size} · qty ${item.quantity}`,
			`- Fabric: ${item.fabric} · Backing: ${item.backing}`
		);
		if (item.names.length > 0)
			lines.push(`- Names & numbers: ${item.names.join(', ')}`);
		lines.push('');
		item.placements.forEach((place) => {
			const dims = place.dimensions;
			lines.push(
				`### ${place.zoneLabel} — ${place.artwork}`,
				'',
				`- Design size: ${dims.widthIn}″ × ${dims.heightIn}″ (${dims.widthMm} × ${dims.heightMm} mm)`,
				`- Placement: ${place.anchor}`,
				`- Offset from zone center: ${dims.offsetXIn}″ horizontal, ${dims.offsetYIn}″ vertical${place.rotationDeg ? ` · rotated ${place.rotationDeg}°` : ''}`
			);
			if (place.stitchTier)
				lines.push(
					`- Stitch tier: ${place.stitchTier}${place.estimatedStitches ? ` · est. ${place.estimatedStitches.toLocaleString()} stitches` : ''}`,
					`- Embroidery type: ${place.embroideryType === 'puff' ? '3D puff' : 'Flat'}`
				);
			if (place.hoop) lines.push(`- Hoop: ${place.hoop}`);
			if (place.print) {
				lines.push(
					`- Art: ${place.print.isVector ? 'vector (resolution-independent)' : `raster · ${place.print.dpiAtSize ?? '?'} DPI at print size`} · ${place.print.colorCount} color(s)${place.print.screens ? ` · ${place.print.screens} screens${place.print.underbase ? ' (incl. underbase)' : ''}` : ''}`
				);
				place.print.warnings.forEach((warning) =>
					lines.push(`- ⚠ ${warning}`)
				);
			}
			if (place.threads.length > 0)
				lines.push(
					`- Threads: ${place.threads.map((thread) => `${thread.brand} ${thread.code} (${thread.name})`).join(', ')}`
				);
			if (place.pantone)
				lines.push(
					`- Color match request: ${place.pantone.requested} → closest stocked ${place.pantone.thread.brand} ${place.pantone.thread.code} (${place.pantone.thread.name}) — confirm against Pantone book at digitizing`
				);
			if (place.note) lines.push(`- Customer note: ${place.note}`);
			if (place.artworkUrl) lines.push(`- Artwork: ${place.artworkUrl}`);
			lines.push('');
		});
	});

	lines.push('---', '');
	spec.notes.forEach((note) => lines.push(`- ${note}`));

	return lines.join('\n');
};
