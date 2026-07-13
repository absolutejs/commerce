import { nearestThread, type ThreadRef } from '../core/threads';

// Analyzes a design image the way a digitizer eyeballs incoming art: which
// stocked threads it maps to (dominance order ≈ needle order), how much of
// its bounding box is actually covered (drives the stitch estimate), and the
// aspect ratio (drives the physical size readout).

export type ArtworkAnalysis = {
	threads: ThreadRef[];
	/** Fraction (0-1) of the design bounding box covered by opaque art. */
	coverage: number;
	/** Width / height of the source image. */
	aspect: number;
	/** Source pixel width — drives DPI-at-print-size validation. */
	pixelWidth: number;
	/** Vector source (SVG) — resolution-independent, always print-safe. */
	isVector: boolean;
	/** Distinct color count (coarse buckets) — screen-print separations. */
	colorCount: number;
	/** Dominant art colors (largest share first) — ink PMS references. */
	palette: { hex: string; share: number }[];
};

const SAMPLE_EDGE = 96;
const ALPHA_CUTOFF = 60;
/** Threads under this share of covered pixels are noise (anti-aliasing). */
const MIN_SHARE = 0.03;
/** Machines run a limited needle count — cap the sequence like Printful (~6). */
const MAX_THREADS = 6;
/** Buckets under this share of covered pixels don't count as spot colors. */
const MIN_COLOR_SHARE = 0.02;
/** Presses top out around 6–8 heads — cap the reported ink palette. */
const MAX_PALETTE = 8;
/** Buckets closer than this (Euclidean RGB²) are one ink, not two screens. */
const MERGE_DISTANCE_SQ = 32 * 32;

type ThreadCount = { thread: ThreadRef; count: number };

const readData = (
	context: CanvasRenderingContext2D,
	width: number,
	height: number
) => {
	try {
		return context.getImageData(0, 0, width, height).data;
	} catch {
		return null;
	}
};

const isSvgSource = (src: string) =>
	src.startsWith('data:image/svg') || /\.svg(\?|$)/i.test(src);

export const analyzeArtwork = (src: string, catalog: ThreadRef[]) =>
	new Promise<ArtworkAnalysis | null>((resolve) => {
		const isVector = isSvgSource(src);
		const image = new Image();
		image.crossOrigin = 'anonymous';
		image.onerror = () => resolve(null);
		image.onload = () => {
			const width = image.naturalWidth || image.width;
			const height = image.naturalHeight || image.height;
			if (!width || !height) return resolve(null);
			const aspect = width / height;

			const factor = SAMPLE_EDGE / Math.max(width, height);
			const sampleW = Math.max(2, Math.round(width * factor));
			const sampleH = Math.max(2, Math.round(height * factor));
			const canvas = document.createElement('canvas');
			canvas.width = sampleW;
			canvas.height = sampleH;
			const context = canvas.getContext('2d');
			if (!context) return resolve(null);
			context.drawImage(image, 0, 0, sampleW, sampleH);

			const base: Omit<
				ArtworkAnalysis,
				'coverage' | 'palette' | 'threads'
			> = {
				aspect,
				colorCount: 1,
				isVector,
				pixelWidth: width
			};

			const data = readData(context, sampleW, sampleH);
			// Tainted canvas (no CORS) — still return the aspect ratio.
			if (!data)
				return resolve({
					...base,
					coverage: 0.4,
					palette: [],
					threads: []
				});

			const counts = new Map<string, ThreadCount>();
			const buckets = new Map<
				number,
				{ blue: number; count: number; green: number; red: number }
			>();
			let covered = 0;
			const total = sampleW * sampleH;
			for (let pixel = 0; pixel < total; pixel += 1) {
				const channel = pixel * 4;
				if ((data[channel + 3] as number) < ALPHA_CUTOFF) continue;
				covered += 1;
				const red = data[channel] as number;
				const green = data[channel + 1] as number;
				const blue = data[channel + 2] as number;
				// 4 bits per channel — merges anti-aliasing, keeps spot colors.
				const key =
					((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
				const bucket = buckets.get(key) ?? {
					blue: 0,
					count: 0,
					green: 0,
					red: 0
				};
				bucket.blue += blue;
				bucket.count += 1;
				bucket.green += green;
				bucket.red += red;
				buckets.set(key, bucket);
				const thread = nearestThread(catalog, red, green, blue);
				const entry = counts.get(thread.code);
				if (entry) entry.count += 1;
				else counts.set(thread.code, { count: 1, thread });
			}

			if (covered === 0)
				return resolve({
					...base,
					coverage: 0,
					palette: [],
					threads: []
				});

			const threads = [...counts.values()]
				.filter((entry) => entry.count / covered >= MIN_SHARE)
				.sort((left, right) => right.count - left.count)
				.slice(0, MAX_THREADS)
				.map((entry) => entry.thread);

			// Only colors with real area count as spot colors/separations.
			// Greedy-merge buckets that are visually the same ink — 4-bit
			// bucketing splits anti-aliased edges into near-identical
			// neighbors, which would each bill their own screen.
			const candidates = [...buckets.values()]
				.filter((bucket) => bucket.count / covered >= MIN_COLOR_SHARE)
				.sort((left, right) => right.count - left.count);
			const realColors: typeof candidates = [];
			candidates.forEach((bucket) => {
				const avg = (sum: number) => sum / bucket.count;
				const host = realColors.find((cluster) => {
					const dRed = avg(bucket.red) - cluster.red / cluster.count;
					const dGreen =
						avg(bucket.green) - cluster.green / cluster.count;
					const dBlue =
						avg(bucket.blue) - cluster.blue / cluster.count;

					return (
						dRed * dRed + dGreen * dGreen + dBlue * dBlue <=
						MERGE_DISTANCE_SQ
					);
				});
				if (!host) return realColors.push({ ...bucket });
				host.blue += bucket.blue;
				host.count += bucket.count;
				host.green += bucket.green;
				host.red += bucket.red;

				return undefined;
			});

			const toHexByte = (sum: number, count: number) =>
				Math.round(sum / count)
					.toString(16)
					.padStart(2, '0');
			// Average color of each bucket — a truer ink hex than the bucket
			// floor, since the bucket spans a 16-value range per channel.
			const palette = [...realColors]
				.sort((left, right) => right.count - left.count)
				.slice(0, MAX_PALETTE)
				.map((bucket) => ({
					hex: `#${toHexByte(bucket.red, bucket.count)}${toHexByte(bucket.green, bucket.count)}${toHexByte(bucket.blue, bucket.count)}`,
					share:
						Math.round((bucket.count / covered) * 100) / 100
				}));

			return resolve({
				...base,
				colorCount: Math.max(1, realColors.length),
				coverage: covered / total,
				palette,
				threads
			});
		};
		image.src = src;
	});
