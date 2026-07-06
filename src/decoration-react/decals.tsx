// 3D decoration layer: projects method-aware design textures onto garment
// meshes (drei Decal), draws the active zone outline, and lets the customer
// drag the design around the zone on the garment itself.
// Peer deps: react, three, @react-three/fiber, @react-three/drei.

import { Decal } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
	fitDesignIn,
	type DecorationZoneSpec,
	type EmbroideryType
} from '../core/decoration';
import type { ThreadRef } from '../core/threads';
import {
	METHOD_SURFACE,
	normalScaleFor,
	useDecorationTexture,
	type DecorationMaps,
	type DecorationMethodId
} from './decorationTexture';

/** A decoratable zone placed in 3D on the garment mesh (local space). */
export type DecorationZone3D = DecorationZoneSpec & {
	position: [number, number, number];
	rotation: [number, number, number];
};

export type DesignTransform = {
	offsetX: number;
	offsetY: number;
	scale: number;
	rotation: number;
};

// One design placed on one zone of the product.
export type PlacedDesign = {
	zoneId: string;
	zone: DecorationZone3D;
	src: string;
	method: DecorationMethodId;
	embroideryType: EmbroideryType;
	transform: DesignTransform;
};

const PROJECT_DEPTH = 0.5;

type ImageSize = { width: number; height: number };

const clamp = (value: number, low: number, high: number) =>
	Math.max(low, Math.min(high, value));

/* ------------------------- drag to position -------------------------- */

// How far off the zone plane a surface hit can be and still start a drag
// (decals project onto curved cloth, so hits sit slightly off-plane).
const DRAG_PLANE_TOLERANCE = 0.14;
// Grab margin around the zone so edges are easy to catch.
const DRAG_GRAB_PAD = 0.05;

type DragHandlers = {
	onPointerCancel: (event: ThreeEvent<PointerEvent>) => void;
	onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
	onPointerMove: (event: ThreeEvent<PointerEvent>) => void;
	onPointerOut: (event: ThreeEvent<PointerEvent>) => void;
	onPointerUp: (event: ThreeEvent<PointerEvent>) => void;
};

// Lets the customer grab the design on the garment itself and slide it around
// the active zone. Orbit stays on everywhere else on the model.
export const useZoneDrag = (
	zone: DecorationZone3D,
	enabled: boolean,
	onOffset?: (offsetX: number, offsetY: number) => void
): DragHandlers => {
	const controls = useThree((state) => state.controls) as {
		enabled: boolean;
	} | null;
	const renderer = useThree((state) => state.gl);
	const draggingRef = useRef(false);

	const inverseRotation = useMemo(
		() =>
			new THREE.Quaternion()
				.setFromEuler(new THREE.Euler(...zone.rotation))
				.invert(),
		[zone]
	);

	// Surface hit point → zone-local coordinates (x/y are the offsets).
	const surfaceToZone = (event: ThreeEvent<PointerEvent>) =>
		event.eventObject
			.worldToLocal(event.point.clone())
			.sub(new THREE.Vector3(...zone.position))
			.applyQuaternion(inverseRotation);

	// Pointer ray ∩ zone plane, in zone-local coordinates — keeps the drag
	// smooth even when the pointer slides off the mesh silhouette.
	const rayToZone = (event: ThreeEvent<PointerEvent>) => {
		const origin = event.eventObject.localToWorld(
			new THREE.Vector3(...zone.position)
		);
		const normal = new THREE.Vector3(0, 0, 1)
			.applyEuler(new THREE.Euler(...zone.rotation))
			.transformDirection(event.eventObject.matrixWorld)
			.normalize();
		const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
			normal,
			origin
		);
		const hit = event.ray.intersectPlane(plane, new THREE.Vector3());
		if (!hit) return null;

		return event.eventObject
			.worldToLocal(hit)
			.sub(new THREE.Vector3(...zone.position))
			.applyQuaternion(inverseRotation);
	};

	const overDesign = (event: ThreeEvent<PointerEvent>) => {
		const local = surfaceToZone(event);

		return (
			Math.abs(local.x) <= zone.size[0] / 2 + DRAG_GRAB_PAD &&
			Math.abs(local.y) <= zone.size[1] / 2 + DRAG_GRAB_PAD &&
			Math.abs(local.z) <= DRAG_PLANE_TOLERANCE
		);
	};

	// Pointer capture keeps the drag alive when the cursor leaves the mesh,
	// but it can throw for already-released or synthetic pointers — the drag
	// itself works either way, so failures are non-fatal.
	const capturePointer = (event: ThreeEvent<PointerEvent>, take: boolean) => {
		try {
			const target = event.target as Element | null;
			if (take) target?.setPointerCapture?.(event.pointerId);
			else target?.releasePointerCapture?.(event.pointerId);
		} catch {
			/* no active pointer — nothing to capture */
		}
	};

	const endDrag = (event: ThreeEvent<PointerEvent>) => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		if (controls) controls.enabled = true;
		renderer.domElement.style.cursor = 'grab';
		capturePointer(event, false);
	};

	return {
		onPointerCancel: endDrag,
		onPointerUp: endDrag,
		onPointerDown: (event) => {
			if (!enabled || !onOffset || !overDesign(event)) return;
			event.stopPropagation();
			draggingRef.current = true;
			if (controls) controls.enabled = false;
			renderer.domElement.style.cursor = 'grabbing';
			capturePointer(event, true);
		},
		onPointerMove: (event) => {
			if (!onOffset) return;
			if (!draggingRef.current) {
				if (enabled)
					renderer.domElement.style.cursor = overDesign(event)
						? 'move'
						: 'grab';

				return;
			}
			const local = rayToZone(event);
			if (!local) return;
			onOffset(
				clamp(local.x, -zone.size[0] / 2, zone.size[0] / 2),
				clamp(local.y, -zone.size[1] / 2, zone.size[1] / 2)
			);
		},
		onPointerOut: (event) => {
			if (!draggingRef.current) renderer.domElement.style.cursor = 'grab';
			void event;
		}
	};
};

/* ------------------------------ decals ------------------------------- */

type DesignDecalProps = {
	maps: DecorationMaps;
	method: DecorationMethodId;
	embroideryType: EmbroideryType;
	zone: DecorationZone3D;
	transform: DesignTransform;
};

export const DesignDecal = ({
	maps,
	method,
	embroideryType,
	zone,
	transform
}: DesignDecalProps) => {
	const image = maps.map.image as ImageSize | undefined;
	const aspect = image && image.height ? image.width / image.height : 1;
	const { width, height } = fitDesignIn(zone, aspect, transform.scale);
	const surface = METHOD_SURFACE[method];
	const normalScale = normalScaleFor(embroideryType);

	const maxX = Math.max(0, (zone.size[0] - width) / 2);
	const maxY = Math.max(0, (zone.size[1] - height) / 2);
	const local = new THREE.Vector3(
		clamp(transform.offsetX, -maxX, maxX),
		clamp(transform.offsetY, -maxY, maxY),
		0
	).applyEuler(new THREE.Euler(...zone.rotation));

	const position: [number, number, number] = [
		zone.position[0] + local.x,
		zone.position[1] + local.y,
		zone.position[2] + local.z
	];
	const rotation: [number, number, number] = [
		zone.rotation[0],
		zone.rotation[1],
		zone.rotation[2] + transform.rotation
	];

	return (
		<Decal
			position={position}
			rotation={rotation}
			scale={[width, height, PROJECT_DEPTH]}
		>
			<meshStandardMaterial
				depthTest
				depthWrite={false}
				map={maps.map}
				metalness={surface.metalness}
				normalMap={maps.normalMap ?? undefined}
				normalScale={
					maps.normalMap
						? new THREE.Vector2(normalScale, normalScale)
						: undefined
				}
				polygonOffset
				polygonOffsetFactor={-10}
				roughness={surface.roughness}
				transparent
			/>
		</Decal>
	);
};

// One placement: builds its method-aware textures (a hook per instance),
// then projects them onto the zone.
export const PlacementDecal = ({
	design,
	threadCatalog
}: {
	design: PlacedDesign;
	threadCatalog: ThreadRef[];
}) => {
	const maps = useDecorationTexture(
		design.src,
		design.method,
		threadCatalog,
		design.embroideryType
	);
	if (!maps) return null;

	return (
		<DesignDecal
			embroideryType={design.embroideryType}
			maps={maps}
			method={design.method}
			transform={design.transform}
			zone={design.zone}
		/>
	);
};

export const ZoneOutline = ({ zone }: { zone: DecorationZone3D }) => (
	<group position={zone.position} rotation={zone.rotation}>
		<lineSegments position={[0, 0, 0.006]}>
			<edgesGeometry
				args={[new THREE.PlaneGeometry(zone.size[0], zone.size[1])]}
			/>
			<lineBasicMaterial color="#b5862f" depthTest={false} transparent />
		</lineSegments>
	</group>
);

type DecorationProps = {
	placements: PlacedDesign[];
	activeZone: DecorationZone3D;
	showZone: boolean;
	threadCatalog: ThreadRef[];
};

/** Zone outline + every placed design, ready to nest inside a garment mesh. */
export const Decoration = ({
	placements,
	activeZone,
	showZone,
	threadCatalog
}: DecorationProps) => (
	<>
		{showZone && <ZoneOutline zone={activeZone} />}
		{placements.map((design) => (
			<PlacementDecal
				design={design}
				key={design.zoneId}
				threadCatalog={threadCatalog}
			/>
		))}
	</>
);
