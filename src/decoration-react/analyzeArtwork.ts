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
};

const SAMPLE_EDGE = 96;
const ALPHA_CUTOFF = 60;
/** Threads under this share of covered pixels are noise (anti-aliasing). */
const MIN_SHARE = 0.03;
/** Machines run a limited needle count — cap the sequence like Printful (~6). */
const MAX_THREADS = 6;

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

			const base: Omit<ArtworkAnalysis, 'coverage' | 'threads'> = {
				aspect,
				colorCount: 1,
				isVector,
				pixelWidth: width
			};

			const data = readData(context, sampleW, sampleH);
			// Tainted canvas (no CORS) — still return the aspect ratio.
			if (!data)
				return resolve({ ...base, coverage: 0.4, threads: [] });

			const counts = new Map<string, ThreadCount>();
			const buckets = new Map<number, number>();
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
				const bucket =
					((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
				buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
				const thread = nearestThread(catalog, red, green, blue);
				const entry = counts.get(thread.code);
				if (entry) entry.count += 1;
				else counts.set(thread.code, { count: 1, thread });
			}

			if (covered === 0)
				return resolve({ ...base, coverage: 0, threads: [] });

			const threads = [...counts.values()]
				.filter((entry) => entry.count / covered >= MIN_SHARE)
				.sort((left, right) => right.count - left.count)
				.slice(0, MAX_THREADS)
				.map((entry) => entry.thread);

			// Only colors with real area count as spot colors/separations.
			const colorCount = [...buckets.values()].filter(
				(count) => count / covered >= 0.02
			).length;

			return resolve({
				...base,
				colorCount: Math.max(1, colorCount),
				coverage: covered / total,
				threads
			});
		};
		image.src = src;
	});
