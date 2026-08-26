// @absolutejs/commerce/decoration-preview-react — exact product-photo preview
// with a bounded artwork overlay. This entrypoint deliberately has no Three,
// R3F, or drei dependency, so product customization remains usable when an
// optional 3D renderer is unavailable.

import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent
} from 'react';
import {
	clampPlacementTransform,
	fitDesignIn,
	type DecorationZoneSpec,
	type PlacementTransform
} from '../core/decoration';

export type NormalizedPreviewBox = {
	/** Left edge as a 0–1 fraction of the source product image. */
	x: number;
	/** Top edge as a 0–1 fraction of the source product image. */
	y: number;
	/** Width as a 0–1 fraction of the source product image. */
	width: number;
	/** Height as a 0–1 fraction of the source product image. */
	height: number;
};

export type PhotoDecorationZone = DecorationZoneSpec & {
	previewBox: NormalizedPreviewBox;
};

export type PhotoPlacedDesign = {
	/** Stable layer id when a zone carries several designs (z-order = array order). */
	id?: string;
	alt?: string;
	aspect: number;
	src: string;
	transform: PlacementTransform;
	zone: PhotoDecorationZone;
	zoneId: string;
};

export type ContainedImageRect = {
	height: number;
	left: number;
	top: number;
	width: number;
};

export type PhotoFit = 'contain' | 'cover';

/** Where the photo lands inside the stage for a given object-fit: contain
 *  letterboxes inside the container, cover fills it and overflows (the
 *  overlays follow the same rect, so a covered photo crops honestly). */
export const fittedImageRect = (
	containerWidth: number,
	containerHeight: number,
	imageWidth: number,
	imageHeight: number,
	fit: PhotoFit = 'contain'
): ContainedImageRect => {
	if (
		containerWidth <= 0 ||
		containerHeight <= 0 ||
		imageWidth <= 0 ||
		imageHeight <= 0
	)
		return { height: 0, left: 0, top: 0, width: 0 };
	const scale =
		fit === 'cover'
			? Math.max(containerWidth / imageWidth, containerHeight / imageHeight)
			: Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
	const width = imageWidth * scale;
	const height = imageHeight * scale;

	return {
		height,
		left: (containerWidth - width) / 2,
		top: (containerHeight - height) / 2,
		width
	};
};

export const containedImageRect = (
	containerWidth: number,
	containerHeight: number,
	imageWidth: number,
	imageHeight: number
): ContainedImageRect => {
	if (
		containerWidth <= 0 ||
		containerHeight <= 0 ||
		imageWidth <= 0 ||
		imageHeight <= 0
	)
		return { height: 0, left: 0, top: 0, width: 0 };
	const scale = Math.min(
		containerWidth / imageWidth,
		containerHeight / imageHeight
	);
	const width = imageWidth * scale;
	const height = imageHeight * scale;

	return {
		height,
		left: (containerWidth - width) / 2,
		top: (containerHeight - height) / 2,
		width
	};
};

const finite = (value: number, fallback: number) =>
	Number.isFinite(value) ? value : fallback;

const normalizedBox = (box: NormalizedPreviewBox) => ({
	height: Math.max(0, Math.min(1, finite(box.height, 0))),
	width: Math.max(0, Math.min(1, finite(box.width, 0))),
	x: Math.max(0, Math.min(1, finite(box.x, 0))),
	y: Math.max(0, Math.min(1, finite(box.y, 0)))
});

type PixelZone = {
	height: number;
	left: number;
	top: number;
	width: number;
};

const pixelZone = (
	image: ContainedImageRect,
	box: NormalizedPreviewBox
): PixelZone => {
	const safe = normalizedBox(box);

	return {
		height: image.height * safe.height,
		left: image.left + image.width * safe.x,
		top: image.top + image.height * safe.y,
		width: image.width * safe.width
	};
};

export const photoPlacementStyle = (
	image: ContainedImageRect,
	design: PhotoPlacedDesign
): CSSProperties => {
	const zone = pixelZone(image, design.zone.previewBox);
	const transform = clampPlacementTransform(
		design.zone,
		design.aspect,
		design.transform
	);
	const fit = fitDesignIn(design.zone, design.aspect, transform.scale);
	const width = zone.width * (fit.width / design.zone.size[0]);
	const height = zone.height * (fit.height / design.zone.size[1]);
	const centerX =
		zone.left +
		zone.width / 2 +
		zone.width * (transform.offsetX / design.zone.size[0]);
	const centerY =
		zone.top +
		zone.height / 2 -
		zone.height * (transform.offsetY / design.zone.size[1]);

	return {
		height,
		left: centerX,
		position: 'absolute',
		top: centerY,
		transform: `translate(-50%, -50%) rotate(${transform.rotation}rad)`,
		transformOrigin: 'center',
		width
	};
};

/** Multiply-tints the garment photo to a target color. The layer is
 *  masked by the photo's own alpha, so a background-keyed product image
 *  tints only the garment; an opaque photo tints its whole rectangle. */
export const photoTintStyle = (
	image: ContainedImageRect,
	imageUrl: string,
	tint: string
): CSSProperties => {
	const mask = `url("${imageUrl.replace(/"/g, '%22')}")`;

	return {
		WebkitMaskImage: mask,
		WebkitMaskPosition: 'center',
		WebkitMaskRepeat: 'no-repeat',
		WebkitMaskSize: '100% 100%',
		background: tint,
		height: image.height,
		left: image.left,
		maskImage: mask,
		maskPosition: 'center',
		maskRepeat: 'no-repeat',
		maskSize: '100% 100%',
		mixBlendMode: 'multiply',
		pointerEvents: 'none',
		position: 'absolute',
		top: image.top,
		width: image.width
	};
};

const parseHexColor = (value: string): [number, number, number] | null => {
	const hex = value.trim().replace(/^#/, '');
	const full =
		hex.length === 3
			? hex
					.split('')
					.map((char) => char + char)
					.join('')
			: hex;
	if (!/^[0-9a-f]{6}$/i.test(full)) return null;

	return [
		parseInt(full.slice(0, 2), 16),
		parseInt(full.slice(2, 4), 16),
		parseInt(full.slice(4, 6), 16)
	];
};

const luminance = (r: number, g: number, b: number) =>
	0.2126 * r + 0.7152 * g + 0.0722 * b;

type GarmentMaskOptions = {
	height: number;
	width: number;
};

/** How much of a pixel is garment (1) versus studio background (0). Sampled
 *  against the photo's own corners, so a white tee on a cream sweep and a
 *  black hoodie on a white sweep both key without any pre-cut asset. The
 *  ramp is continuous — no flood fill, so no stepped edges or speckles. */
const garmentMask = (
	data: Uint8ClampedArray,
	size: GarmentMaskOptions | undefined
): Float32Array | null => {
	if (!size || size.width < 4 || size.height < 4) return null;
	const { width, height } = size;
	const seeds = [
		[0, 0],
		[width - 1, 0],
		[0, height - 1],
		[width - 1, height - 1],
		[Math.floor(width / 2), 0],
		[Math.floor(width / 2), height - 1],
		[0, Math.floor(height / 2)],
		[width - 1, Math.floor(height / 2)]
	];
	let red = 0;
	let green = 0;
	let blue = 0;
	let opaqueSeeds = 0;
	for (const [x, y] of seeds) {
		const index = ((y ?? 0) * width + (x ?? 0)) * 4;
		if ((data[index + 3] ?? 0) < 16) continue;
		red += data[index] ?? 0;
		green += data[index + 1] ?? 0;
		blue += data[index + 2] ?? 0;
		opaqueSeeds += 1;
	}
	// Transparent corners mean the photo is already cut out — alpha is the mask.
	if (opaqueSeeds === 0) return null;
	red /= opaqueSeeds;
	green /= opaqueSeeds;
	blue /= opaqueSeeds;
	const backgroundWarmth = red - blue;
	const mask = new Float32Array(width * height);
	for (let pixel = 0; pixel < mask.length; pixel += 1) {
		const index = pixel * 4;
		const r = data[index] ?? 0;
		const g = data[index + 1] ?? 0;
		const b = data[index + 2] ?? 0;
		const distance =
			Math.abs(r - red) + Math.abs(g - green) + Math.abs(b - blue);
		// Far from the background color → garment.
		const byDistance = Math.min(1, Math.max(0, (distance - 40) / 60));
		// A neutral (white / grey) pixel on a warm sweep → garment, even when
		// its brightness is within noise of the background.
		const byWarmth =
			backgroundWarmth > 5
				? Math.min(
						1,
						Math.max(
							0,
							(backgroundWarmth * 0.75 - (r - b)) /
								(backgroundWarmth * 0.45)
						)
					)
				: 0;
		mask[pixel] = Math.max(byDistance, byWarmth);
	}

	// Lossy photos are grainy: blur → firm → blur → firm straightens the
	// silhouette (drops speckle and fills notches along shadowed edges) and
	// leaves a soft two-to-three pixel anti-aliased rim.
	const firm = (values: Float32Array, low: number, high: number) => {
		for (let pixel = 0; pixel < values.length; pixel += 1) {
			const t = Math.min(
				1,
				Math.max(0, ((values[pixel] ?? 0) - low) / (high - low))
			);
			values[pixel] = t * t * (3 - 2 * t);
		}

		return values;
	};
	const scale = Math.max(1, Math.round(Math.max(width, height) / 400));
	const pass1 = firm(boxBlur(mask, width, height, 3 * scale), 0.35, 0.65);
	const pass2 = firm(boxBlur(pass1, width, height, 2 * scale), 0.3, 0.7);

	return firm(boxBlur(pass2, width, height, scale), 0.2, 0.8);
};

const boxBlur = (
	source: Float32Array,
	width: number,
	height: number,
	radius: number
) => {
	const horizontal = new Float32Array(source.length);
	const output = new Float32Array(source.length);
	const span = radius * 2 + 1;
	for (let y = 0; y < height; y += 1) {
		let sum = 0;
		for (let x = -radius; x <= radius; x += 1)
			sum += source[y * width + Math.min(width - 1, Math.max(0, x))] ?? 0;
		for (let x = 0; x < width; x += 1) {
			horizontal[y * width + x] = sum / span;
			const leaving = Math.max(0, x - radius);
			const entering = Math.min(width - 1, x + radius + 1);
			sum +=
				(source[y * width + entering] ?? 0) -
				(source[y * width + leaving] ?? 0);
		}
	}
	for (let x = 0; x < width; x += 1) {
		let sum = 0;
		for (let y = -radius; y <= radius; y += 1)
			sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x] ?? 0;
		for (let y = 0; y < height; y += 1) {
			output[y * width + x] = sum / span;
			const leaving = Math.max(0, y - radius);
			const entering = Math.min(height - 1, y + radius + 1);
			sum +=
				(horizontal[entering * width + x] ?? 0) -
				(horizontal[leaving * width + x] ?? 0);
		}
	}

	return output;
};

/** Recolors garment pixels in place: each pixel keeps its shading relative
 *  to the garment's median brightness and takes the tint's hue, so a black
 *  hoodie can preview as red and a white tee as navy. Studio background is
 *  kept (soft-keyed against the photo's corners when `size` is given);
 *  transparent pixels are left untouched. */
export const recolorGarmentPixels = (
	data: Uint8ClampedArray,
	tint: [number, number, number],
	size?: GarmentMaskOptions,
	backdrop?: [number, number, number]
) => {
	const mask = garmentMask(data, size);
	// Optional: paint the studio sweep a chosen color (e.g. the dark-theme
	// canvas) so the photo blends into the stage instead of sitting on a
	// white square. Only meaningful when a mask exists (opaque photo).
	if (backdrop && mask) {
		for (let index = 0; index < data.length; index += 4) {
			const pixel = index / 4;
			if ((data[index + 3] ?? 0) < 16) continue;
			const garment = mask[pixel] ?? 0;
			const keep = garment;
			// Keep the photo's own shading of the sweep (soft shadow under the
			// garment) by scaling the backdrop with the pixel's luminance
			// relative to a white sweep.
			const shade = Math.min(1.05, luminance(data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0) / 240);
			data[index] = Math.round((data[index] ?? 0) * keep + backdrop[0] * shade * (1 - keep));
			data[index + 1] = Math.round((data[index + 1] ?? 0) * keep + backdrop[1] * shade * (1 - keep));
			data[index + 2] = Math.round((data[index + 2] ?? 0) * keep + backdrop[2] * shade * (1 - keep));
		}
	}
	const weight = (pixel: number) => {
		const alpha = data[pixel * 4 + 3] ?? 0;
		if (alpha < 16) return 0;

		return mask ? (mask[pixel] ?? 0) : 1;
	};
	const histogram = new Uint32Array(256);
	let counted = 0;
	for (let index = 0; index < data.length; index += 4) {
		if (weight(index / 4) < 0.5) continue;
		const level = Math.round(
			luminance(data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0)
		);
		histogram[level] = (histogram[level] ?? 0) + 1;
		counted += 1;
	}
	if (counted === 0) return;
	let seen = 0;
	let median = 255;
	for (let level = 0; level < 256; level += 1) {
		seen += histogram[level] ?? 0;
		if (seen >= counted / 2) {
			median = Math.max(1, level);
			break;
		}
	}
	// Photos of dark blanks hide their folds in near-black; give them a
	// little room above the median so highlights survive on light tints.
	const headroom = median < 96 ? 1.35 : 1.12;
	for (let index = 0; index < data.length; index += 4) {
		const amount = weight(index / 4);
		if (amount <= 0) continue;
		const r = data[index] ?? 0;
		const g = data[index + 1] ?? 0;
		const b = data[index + 2] ?? 0;
		const shade = Math.min(headroom, luminance(r, g, b) / median);
		const mix = (from: number, to: number) =>
			Math.round(from + (Math.min(255, to) - from) * amount);
		data[index] = mix(r, tint[0] * shade);
		data[index + 1] = mix(g, tint[1] * shade);
		data[index + 2] = mix(b, tint[2] * shade);
	}
};

const recolorCache = new Map<string, string>();
const recolorFailed = new Set<string>();
const recolorPending = new Map<string, Promise<string | null>>();
const RECOLOR_CACHE_LIMIT = 48;

const recolorKey = (
	imageUrl: string,
	tint: string,
	backdrop: string | null | undefined
) => `${imageUrl}|${tint.toLowerCase()}|${(backdrop ?? '').toLowerCase()}`;

const remember = (key: string, url: string) => {
	if (recolorCache.size >= RECOLOR_CACHE_LIMIT) {
		const oldest = recolorCache.keys().next().value;
		if (oldest) {
			const stale = recolorCache.get(oldest);
			recolorCache.delete(oldest);
			if (stale) URL.revokeObjectURL(stale);
		}
	}
	recolorCache.set(key, url);
};

/** Recolor `imageUrl` in `tint` (optionally repainting the sweep with
 *  `backdrop`) and cache the result. Call ahead of time for every side of
 *  a product so switching views is instant. Resolves null when the photo
 *  is cross-origin (tainted canvas) or fails to load. */
export const prepareRecoloredPhoto = (
	imageUrl: string,
	tint: string,
	backdrop?: string | null
): Promise<string | null> => {
	const key = recolorKey(imageUrl, tint, backdrop);
	const hit = recolorCache.get(key);
	if (hit) return Promise.resolve(hit);
	const inFlight = recolorPending.get(key);
	if (inFlight) return inFlight;
	const rgb = parseHexColor(tint);
	if (!rgb) return Promise.resolve(null);
	const backdropRgb = backdrop ? parseHexColor(backdrop) : null;
	const work = new Promise<string | null>((resolve) => {
		const source = new Image();
		source.crossOrigin = 'anonymous';
		source.onload = () => {
			try {
				const canvas = document.createElement('canvas');
				canvas.width = source.naturalWidth;
				canvas.height = source.naturalHeight;
				const context = canvas.getContext('2d');
				if (!context) {
					resolve(null);

					return;
				}
				context.drawImage(source, 0, 0);
				const pixels = context.getImageData(
					0,
					0,
					canvas.width,
					canvas.height
				);
				recolorGarmentPixels(
					pixels.data,
					rgb,
					{ height: canvas.height, width: canvas.width },
					backdropRgb ?? undefined
				);
				context.putImageData(pixels, 0, 0);
				canvas.toBlob((blob) => {
					if (!blob) {
						resolve(null);

						return;
					}
					const url = URL.createObjectURL(blob);
					remember(key, url);
					resolve(url);
				}, 'image/png');
			} catch {
				// Tainted canvas (cross-origin photo without CORS) — fall back.
				recolorFailed.add(key);
				resolve(null);
			}
		};
		source.onerror = () => {
			recolorFailed.add(key);
			resolve(null);
		};
		source.src = imageUrl;
	}).finally(() => recolorPending.delete(key));
	recolorPending.set(key, work);

	return work;
};

/** The recolored photo for the given tint, or null while it is being
 *  produced (or when it cannot be) — the caller then shows the raw photo.
 *  A cached result is returned synchronously, so a view that was prepared
 *  ahead of time never flashes the previous view or the raw image. */
export const useRecoloredPhoto = (
	imageUrl: string,
	tint: string | null | undefined,
	backdrop?: string | null
) => {
	const key = tint ? recolorKey(imageUrl, tint, backdrop) : null;
	const [, bump] = useState(0);
	useEffect(() => {
		if (!tint || !key || recolorCache.has(key)) return undefined;
		let cancelled = false;
		prepareRecoloredPhoto(imageUrl, tint, backdrop).then(() => {
			if (!cancelled) bump((value) => value + 1);

			return undefined;
		});

		return () => {
			cancelled = true;
		};
	}, [imageUrl, tint, backdrop, key]);

	return key ? (recolorCache.get(key) ?? null) : null;
};

/** True while a tinted photo is still being produced (nothing cached yet
 *  and no failure recorded) — the caller can hide the raw photo meanwhile. */
export const isRecolorPending = (
	imageUrl: string,
	tint: string | null | undefined,
	backdrop?: string | null
) => {
	if (!tint) return false;
	const key = recolorKey(imageUrl, tint, backdrop);

	return !recolorCache.has(key) && !recolorFailed.has(key);
};

type ProductPhotoPreviewProps = {
	activeZone: PhotoDecorationZone;
	alt: string;
	className?: string;
	dragEnabled?: boolean;
	/** How the photo fills the stage. `cover` fills edge to edge and crops. */
	fit?: PhotoFit;
	imageUrl: string;
	onDragOffset?: (offsetX: number, offsetY: number) => void;
	/** Full transform updates from the on-canvas handles (corners resize,
	 *  the top handle rotates) and drag-to-move. When given, a selection
	 *  frame with handles renders around the active design. */
	onTransformChange?: (transform: PlacementTransform) => void;
	/** Called when a placement is pressed; lets the host change which layer
	 *  is selected before the move gesture continues. */
	onSelect?: (id: string) => void;
	placements: PhotoPlacedDesign[];
	/** Which placement carries the frame/handles and receives transforms.
	 *  Defaults to the first placement in the active zone. */
	selectedId?: string;
	showZone?: boolean;
	style?: CSSProperties;
	/** Garment color hex to preview the photo in (e.g. the variant color).
	 *  Same-origin photos are recolored by luminance; cross-origin photos
	 *  fall back to a multiply layer masked by the photo's alpha. */
	tint?: string | null;
	/** Color to paint the photo's studio sweep (with `tint`), e.g. the
	 *  dark-theme stage color, so the photo blends into its container. */
	backdrop?: string | null;
};

type Gesture = {
	id: string;
	kind: 'move' | 'scale' | 'rotate';
	center: { x: number; y: number };
	start: PlacementTransform;
	startAngle: number;
	startDistance: number;
	startPoint: { x: number; y: number };
};

const HANDLE_CORNERS: Array<[number, number]> = [
	[0, 0],
	[1, 0],
	[0, 1],
	[1, 1]
];
const ROTATE_STEM = 22;
const HANDLE: CSSProperties = {
	background: '#fff',
	border: '1.5px solid currentColor',
	boxSizing: 'border-box',
	height: 14,
	pointerEvents: 'auto',
	position: 'absolute',
	touchAction: 'none',
	transform: 'translate(-50%, -50%)',
	width: 14
};

const BASE_STAGE: CSSProperties = {
	alignItems: 'center',
	display: 'flex',
	height: '100%',
	justifyContent: 'center',
	minHeight: 320,
	overflow: 'hidden',
	position: 'relative',
	touchAction: 'none',
	width: '100%'
};

const PRODUCT_IMAGE: CSSProperties = {
	height: '100%',
	inset: 0,
	objectFit: 'contain',
	position: 'absolute',
	width: '100%'
};

export const ProductPhotoPreview = ({
	activeZone,
	alt,
	className,
	dragEnabled = false,
	fit = 'contain',
	imageUrl,
	onDragOffset,
	onTransformChange,
	onSelect,
	placements,
	selectedId,
	showZone = true,
	style,
	tint,
	backdrop
}: ProductPhotoPreviewProps) => {
	const stageRef = useRef<HTMLDivElement>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const recolored = useRecoloredPhoto(imageUrl, tint, backdrop);
	const shownUrl = recolored ?? imageUrl;
	// Until the tinted version exists, keep the raw photo invisible (it still
	// loads so the stage can measure it) instead of flashing the untinted one.
	const pending = !recolored && isRecolorPending(imageUrl, tint, backdrop);
	const [container, setContainer] = useState({ height: 0, width: 0 });
	const [imageSize, setImageSize] = useState({ height: 0, width: 0 });
	const [gesture, setGesture] = useState<Gesture | null>(null);

	useEffect(() => {
		const node = stageRef.current;
		if (!node) return undefined;
		const update = () =>
			setContainer({ height: node.clientHeight, width: node.clientWidth });
		update();
		const observer = new ResizeObserver(update);
		observer.observe(node);

		return () => observer.disconnect();
	}, []);

	// A cached (or server-rendered) photo can finish loading before React
	// attaches onLoad — read its size directly so overlays never stay 0×0.
	useEffect(() => {
		const node = imageRef.current;
		if (node?.complete && node.naturalWidth > 0)
			setImageSize({
				height: node.naturalHeight,
				width: node.naturalWidth
			});
		else setImageSize({ height: 0, width: 0 });
	}, [shownUrl]);

	const image = useMemo(
		() =>
			fittedImageRect(
				container.width,
				container.height,
				imageSize.width,
				imageSize.height,
				fit
			),
		[container, imageSize, fit]
	);
	const activePixelZone = pixelZone(image, activeZone.previewBox);
	const keyOf = (placement: PhotoPlacedDesign) =>
		placement.id ?? placement.zoneId;
	const inZone = placements.filter(
		(placement) => placement.zoneId === activeZone.id
	);
	const activeDesign =
		(selectedId
			? inZone.find((placement) => keyOf(placement) === selectedId)
			: undefined) ?? inZone[inZone.length - 1];
	const editable = dragEnabled && Boolean(activeDesign);

	const localPoint = (event: { clientX: number; clientY: number }) => {
		const bounds = stageRef.current?.getBoundingClientRect();

		return {
			x: event.clientX - (bounds?.left ?? 0),
			y: event.clientY - (bounds?.top ?? 0)
		};
	};

	const begin =
		(kind: Gesture['kind'], target = activeDesign) =>
		(event: ReactPointerEvent<HTMLElement>) => {
			if (!dragEnabled || !target) return;
			event.preventDefault();
			event.stopPropagation();
			if (target !== activeDesign) onSelect?.(keyOf(target));
			const box = photoPlacementStyle(image, target);
			const center = { x: Number(box.left), y: Number(box.top) };
			const point = localPoint(event);
			setGesture({
				center,
				id: keyOf(target),
				kind,
				start: target.transform,
				startAngle: Math.atan2(point.y - center.y, point.x - center.x),
				startDistance: Math.hypot(
					point.x - center.x,
					point.y - center.y
				),
				startPoint: point
			});
		};

	// Window-level listeners so a fast drag that leaves the handle (or the
	// stage) keeps tracking until the pointer is released.
	useEffect(() => {
		if (!gesture) return undefined;
		const target = placements.find(
			(placement) => keyOf(placement) === gesture.id
		);
		if (!target) return undefined;
		const emit = (transform: PlacementTransform) => {
			const normalized = clampPlacementTransform(
				activeZone,
				target.aspect,
				transform
			);
			if (onTransformChange) onTransformChange(normalized);
			else onDragOffset?.(normalized.offsetX, normalized.offsetY);
		};
		const move = (event: PointerEvent) => {
			const point = localPoint(event);
			if (gesture.kind === 'move') {
				if (activePixelZone.width <= 0 || activePixelZone.height <= 0)
					return;
				emit({
					...gesture.start,
					offsetX:
						gesture.start.offsetX +
						((point.x - gesture.startPoint.x) /
							activePixelZone.width) *
							activeZone.size[0],
					offsetY:
						gesture.start.offsetY -
						((point.y - gesture.startPoint.y) /
							activePixelZone.height) *
							activeZone.size[1]
				});
			} else if (gesture.kind === 'scale') {
				const distance = Math.hypot(
					point.x - gesture.center.x,
					point.y - gesture.center.y
				);
				const ratio =
					gesture.startDistance > 0
						? distance / gesture.startDistance
						: 1;
				emit({ ...gesture.start, scale: gesture.start.scale * ratio });
			} else {
				const angle = Math.atan2(
					point.y - gesture.center.y,
					point.x - gesture.center.x
				);
				emit({
					...gesture.start,
					rotation:
						gesture.start.rotation + (angle - gesture.startAngle)
				});
			}
		};
		const end = () => setGesture(null);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', end);
		window.addEventListener('pointercancel', end);

		return () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
			window.removeEventListener('pointercancel', end);
		};
	}, [
		gesture,
		placements,
		activePixelZone,
		activeZone,
		onDragOffset,
		onTransformChange
	]);

	const frameStyle = activeDesign
		? photoPlacementStyle(image, activeDesign)
		: null;
	const cursorFor = (kind: Gesture['kind']) => {
		if (gesture?.kind === kind) return 'grabbing';

		return kind === 'rotate' ? 'grab' : 'nwse-resize';
	};

	return (
		<div
			className={className}
			data-preview-kind="exact-product-photo"
			ref={stageRef}
			style={{ ...BASE_STAGE, ...style }}
		>
			<img
				alt={alt}
				draggable={false}
				onLoad={(event) =>
					setImageSize({
						height: event.currentTarget.naturalHeight,
						width: event.currentTarget.naturalWidth
					})
				}
				ref={imageRef}
				src={shownUrl}
				style={{
					...PRODUCT_IMAGE,
					objectFit: fit,
					visibility: pending ? 'hidden' : 'visible'
				}}
			/>
			{tint && !recolored && !pending && image.width > 0 && (
				<div
					aria-hidden
					data-preview-tint={tint}
					style={photoTintStyle(image, imageUrl, tint)}
				/>
			)}
			{showZone && image.width > 0 && (
				<div
					aria-hidden
					data-decoration-zone={activeZone.id}
					style={{
						border: '1.5px dashed currentColor',
						height: activePixelZone.height,
						left: activePixelZone.left,
						opacity: 0.7,
						pointerEvents: 'none',
						position: 'absolute',
						top: activePixelZone.top,
						width: activePixelZone.width
					}}
				/>
			)}
			{!pending && placements.map((design) => (
				<img
					alt={design.alt ?? ''}
					data-decoration-art={design.zoneId}
					draggable={false}
					key={keyOf(design)}
					onPointerDown={
						design.zoneId === activeZone.id
							? begin('move', design)
							: undefined
					}
					src={design.src}
					style={{
						...photoPlacementStyle(image, design),
						cursor:
							dragEnabled && design.zoneId === activeZone.id
								? gesture?.kind === 'move' &&
									gesture.id === keyOf(design)
									? 'grabbing'
									: 'move'
								: 'default',
						objectFit: 'contain',
						touchAction: 'none'
					}}
				/>
			))}
			{editable && frameStyle && image.width > 0 && (
				<div
					aria-hidden
					data-decoration-frame={activeZone.id}
					style={{
						...frameStyle,
						outline: '1.5px solid currentColor',
						outlineOffset: 2,
						pointerEvents: 'none'
					}}
				>
					{HANDLE_CORNERS.map(([left, top]) => (
						<span
							data-decoration-handle="scale"
							key={`${left}-${top}`}
							onPointerDown={begin('scale')}
							style={{
								...HANDLE,
								cursor: cursorFor('scale'),
								left: `${left * 100}%`,
								top: `${top * 100}%`
							}}
						/>
					))}
					<span
						style={{
							background: 'currentColor',
							height: ROTATE_STEM,
							left: '50%',
							pointerEvents: 'none',
							position: 'absolute',
							top: -ROTATE_STEM - 2,
							width: 1.5
						}}
					/>
					<span
						data-decoration-handle="rotate"
						onPointerDown={begin('rotate')}
						style={{
							...HANDLE,
							borderRadius: '50%',
							cursor: cursorFor('rotate'),
							left: '50%',
							top: -ROTATE_STEM - 2
						}}
					/>
				</div>
			)}
		</div>
	);
};
