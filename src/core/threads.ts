// Machine-embroidery thread color model. Production work orders reference
// threads by BRAND + CATALOG CODE (never RGB): DST/EXP machine files carry no
// color data, so the operator pulls cones from a color sequence sheet.
//
// All helpers take the shop's thread catalog as data — each shop stocks a
// different rack, so the catalog is app-side configuration.

export type ThreadRef = {
	/** Thread manufacturer + line, e.g. "Madeira Polyneon". */
	brand: string;
	/** Manufacturer catalog number the operator uses to pull the cone. */
	code: string;
	name: string;
	hex: string;
};

export type PantoneMatch = {
	/** What the customer asked for, e.g. "PMS 186 C" or "#c8102e". */
	requested: string;
	/** Screen-approximate color of the request. */
	requestedHex: string;
	/** Closest stocked thread — final match is confirmed at digitizing. */
	thread: ThreadRef;
};

type Rgb = [number, number, number];

const HEX_RED = 1;
const HEX_GREEN = 3;
const HEX_BLUE = 5;
const HEX_END = 7;
const HEX_BASE = 16;

export const hexToRgb = (hex: string) =>
	[
		parseInt(hex.slice(HEX_RED, HEX_GREEN), HEX_BASE),
		parseInt(hex.slice(HEX_GREEN, HEX_BLUE), HEX_BASE),
		parseInt(hex.slice(HEX_BLUE, HEX_END), HEX_BASE)
	] as Rgb;

export const isThreadRef = (value: unknown): value is ThreadRef => {
	if (!value || typeof value !== 'object') return false;
	const ref = value as Partial<ThreadRef>;

	return (
		typeof ref.brand === 'string' &&
		typeof ref.code === 'string' &&
		typeof ref.name === 'string' &&
		typeof ref.hex === 'string'
	);
};

export const isPantoneMatch = (value: unknown): value is PantoneMatch => {
	if (!value || typeof value !== 'object') return false;
	const match = value as Partial<PantoneMatch>;

	return (
		typeof match.requested === 'string' &&
		typeof match.requestedHex === 'string' &&
		isThreadRef(match.thread)
	);
};

/**
 * Nearest stocked thread by RGB distance — the same mapping a digitizer does
 * against the thread rack. Drives stitch-preview quantization and the
 * auto-extracted thread sequence on the work order.
 */
export const nearestThread = (
	catalog: ThreadRef[],
	red: number,
	green: number,
	blue: number
) => {
	let best = catalog[0] as ThreadRef;
	let bestDist = Infinity;
	for (const candidate of catalog) {
		const [candidateRed, candidateGreen, candidateBlue] = hexToRgb(
			candidate.hex
		);
		const deltaRed = red - candidateRed;
		const deltaGreen = green - candidateGreen;
		const deltaBlue = blue - candidateBlue;
		const dist =
			deltaRed * deltaRed +
			deltaGreen * deltaGreen +
			deltaBlue * deltaBlue;
		if (dist >= bestDist) continue;
		bestDist = dist;
		best = candidate;
	}

	return best;
};

export const threadByHex = (catalog: ThreadRef[], hex: string) =>
	catalog.find((thread) => thread.hex.toLowerCase() === hex.toLowerCase()) ??
	null;

// Screen-approximate sRGB values for common corporate PMS colors (coated).
// Thread matching against a physical Pantone book happens under 4100K light
// at digitizing — this table only drives the on-screen nearest-thread hint.
export const PMS_APPROX: Record<string, string> = {
	'021': '#fe5000',
	'072': '#10069f',
	'109': '#ffd100',
	'123': '#ffc72c',
	'165': '#ff671f',
	'185': '#e4002b',
	'186': '#c8102e',
	'200': '#ba0c2f',
	'219': '#da1884',
	'226': '#d0006f',
	'281': '#00205b',
	'282': '#041e42',
	'286': '#0033a0',
	'293': '#003da5',
	'300': '#005eb8',
	'347': '#009a44',
	'348': '#00843d',
	'355': '#009639',
	'429': '#a2aaad',
	'468': '#ddcba4',
	'485': '#da291c',
	'871': '#84754e',
	'877': '#8a8d8f',
	'2607': '#500778',
	'2685': '#330072',
	'2935': '#0057b8',
	'3425': '#006341',
	'4625': '#4f2c1d',
	black: '#2d2926',
	'cool gray 7': '#97999b',
	'cool gray 11': '#53565a',
	'process blue': '#0085ca',
	'reflex blue': '#001489'
};

const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;

/**
 * Resolve a customer color request — a hex value or a common PMS code —
 * to the nearest stocked thread. Returns null when the input is neither a
 * hex color nor a PMS number in the built-in table.
 */
export const resolveThreadQuery = (
	catalog: ThreadRef[],
	input: string
): PantoneMatch | null => {
	const raw = input.trim();
	if (!raw) return null;

	const hexMatch = HEX_PATTERN.exec(raw);
	if (hexMatch) {
		const requestedHex = `#${(hexMatch[1] as string).toLowerCase()}`;
		const [red, green, blue] = hexToRgb(requestedHex);

		return {
			requested: requestedHex,
			requestedHex,
			thread: nearestThread(catalog, red, green, blue)
		};
	}

	const key = raw
		.toLowerCase()
		.replace(/^pantone\s*/i, '')
		.replace(/^pms\s*/i, '')
		.replace(/\s*[cu]$/i, '')
		.trim();
	const approx = PMS_APPROX[key];
	if (!approx) return null;
	const [red, green, blue] = hexToRgb(approx);

	return {
		requested: `PMS ${key.toUpperCase()}${/^\d+$/.test(key) ? ' C' : ''}`,
		requestedHex: approx,
		thread: nearestThread(catalog, red, green, blue)
	};
};
