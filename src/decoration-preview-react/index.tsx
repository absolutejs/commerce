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

/** Recolors garment pixels in place: each pixel keeps its shading relative
 *  to the garment's median brightness and takes the tint's hue, so a black
 *  hoodie can preview as red and a white tee as navy. Transparent pixels
 *  (a background-keyed product photo) are left untouched. */
export const recolorGarmentPixels = (
	data: Uint8ClampedArray,
	tint: [number, number, number]
) => {
	const histogram = new Uint32Array(256);
	let counted = 0;
	for (let index = 0; index < data.length; index += 4) {
		if ((data[index + 3] ?? 0) < 16) continue;
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
		if ((data[index + 3] ?? 0) < 16) continue;
		const level = luminance(
			data[index] ?? 0,
			data[index + 1] ?? 0,
			data[index + 2] ?? 0
		);
		const shade = Math.min(headroom, level / median);
		data[index] = Math.min(255, Math.round(tint[0] * shade));
		data[index + 1] = Math.min(255, Math.round(tint[1] * shade));
		data[index + 2] = Math.min(255, Math.round(tint[2] * shade));
	}
};

/** Renders a recolored copy of the product photo for the given tint, or
 *  null while loading / when the photo is cross-origin (canvas tainted) —
 *  the caller falls back to the CSS multiply layer in that case. */
export const useRecoloredPhoto = (
	imageUrl: string,
	tint: string | null | undefined
) => {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		const rgb = tint ? parseHexColor(tint) : null;
		if (!rgb) {
			setUrl(null);

			return undefined;
		}
		let cancelled = false;
		let objectUrl: string | null = null;
		const source = new Image();
		source.crossOrigin = 'anonymous';
		source.onload = () => {
			if (cancelled) return;
			try {
				const canvas = document.createElement('canvas');
				canvas.width = source.naturalWidth;
				canvas.height = source.naturalHeight;
				const context = canvas.getContext('2d');
				if (!context) return;
				context.drawImage(source, 0, 0);
				const pixels = context.getImageData(
					0,
					0,
					canvas.width,
					canvas.height
				);
				recolorGarmentPixels(pixels.data, rgb);
				context.putImageData(pixels, 0, 0);
				canvas.toBlob((blob) => {
					if (!blob || cancelled) return;
					objectUrl = URL.createObjectURL(blob);
					setUrl(objectUrl);
				}, 'image/png');
			} catch {
				// Tainted canvas (cross-origin photo without CORS) — fall back.
				setUrl(null);
			}
		};
		source.onerror = () => {
			if (!cancelled) setUrl(null);
		};
		source.src = imageUrl;

		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [imageUrl, tint]);

	return url;
};

type ProductPhotoPreviewProps = {
	activeZone: PhotoDecorationZone;
	alt: string;
	className?: string;
	dragEnabled?: boolean;
	imageUrl: string;
	onDragOffset?: (offsetX: number, offsetY: number) => void;
	placements: PhotoPlacedDesign[];
	showZone?: boolean;
	style?: CSSProperties;
	/** Garment color hex to preview the photo in (e.g. the variant color).
	 *  Same-origin photos are recolored by luminance; cross-origin photos
	 *  fall back to a multiply layer masked by the photo's alpha. */
	tint?: string | null;
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
	imageUrl,
	onDragOffset,
	placements,
	showZone = true,
	style,
	tint
}: ProductPhotoPreviewProps) => {
	const stageRef = useRef<HTMLDivElement>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const recolored = useRecoloredPhoto(imageUrl, tint);
	const shownUrl = recolored ?? imageUrl;
	const [container, setContainer] = useState({ height: 0, width: 0 });
	const [imageSize, setImageSize] = useState({ height: 0, width: 0 });
	const [dragging, setDragging] = useState(false);

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
			containedImageRect(
				container.width,
				container.height,
				imageSize.width,
				imageSize.height
			),
		[container, imageSize]
	);
	const activePixelZone = pixelZone(image, activeZone.previewBox);
	const activeDesign = placements.find(
		(placement) => placement.zoneId === activeZone.id
	);

	const move = (event: ReactPointerEvent<HTMLImageElement>) => {
		if (!(dragging && activeDesign && onDragOffset)) return;
		const bounds = stageRef.current?.getBoundingClientRect();
		if (!bounds || activePixelZone.width <= 0 || activePixelZone.height <= 0)
			return;
		const localX = event.clientX - bounds.left;
		const localY = event.clientY - bounds.top;
		const offsetX =
			((localX - activePixelZone.left - activePixelZone.width / 2) /
				activePixelZone.width) *
			activeZone.size[0];
		const offsetY =
			-(
				(localY - activePixelZone.top - activePixelZone.height / 2) /
				activePixelZone.height
			) * activeZone.size[1];
		const normalized = clampPlacementTransform(
			activeZone,
			activeDesign.aspect,
			{ ...activeDesign.transform, offsetX, offsetY }
		);
		onDragOffset(normalized.offsetX, normalized.offsetY);
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
				style={PRODUCT_IMAGE}
			/>
			{tint && !recolored && image.width > 0 && (
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
			{placements.map((design) => (
				<img
					alt={design.alt ?? ''}
					data-decoration-art={design.zoneId}
					draggable={false}
					key={design.zoneId}
					onPointerCancel={() => setDragging(false)}
					onPointerDown={(event) => {
						if (
							!dragEnabled ||
							design.zoneId !== activeZone.id ||
							!onDragOffset
						)
							return;
						try {
							event.currentTarget.setPointerCapture(event.pointerId);
						} catch {
							// Synthetic or already-released pointers can't be
							// captured; dragging still tracks moves on the image.
						}
						setDragging(true);
					}}
					onPointerMove={move}
					onPointerUp={(event) => {
						setDragging(false);
						if (event.currentTarget.hasPointerCapture(event.pointerId))
							event.currentTarget.releasePointerCapture(
								event.pointerId
							);
					}}
					src={design.src}
					style={{
						...photoPlacementStyle(image, design),
						cursor:
							dragEnabled && design.zoneId === activeZone.id
								? dragging
									? 'grabbing'
									: 'move'
								: 'default',
						objectFit: 'contain'
					}}
				/>
			))}
		</div>
	);
};
