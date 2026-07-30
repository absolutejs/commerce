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
	style
}: ProductPhotoPreviewProps) => {
	const stageRef = useRef<HTMLDivElement>(null);
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
				src={imageUrl}
				style={PRODUCT_IMAGE}
			/>
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
						event.currentTarget.setPointerCapture(event.pointerId);
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
