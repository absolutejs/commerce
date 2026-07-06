import { useMemo } from 'react';
import * as THREE from 'three';

// Procedural fabric normal maps so each blank reads as its real material —
// jersey knit, rib knit, twill, canvas weave — instead of smooth plastic.
// Tiny tiling canvases generated once per fabric kind (client-only, cached).

export type FabricKind = 'jersey' | 'rib' | 'twill' | 'canvas';

const TILE = 128;
const OPAQUE = 255;

// Height field per fabric: values in [0,1] over a TILE×TILE tile that wraps.
const fabricHeight = (kind: FabricKind, xPos: number, yPos: number) => {
	const tau = (Math.PI * 2) / TILE;
	if (kind === 'rib')
		// Chunky vertical ribs with a slight row wobble (1x1 rib knit).
		return (
			0.5 +
			0.5 * Math.sin(xPos * tau * 16 + 0.6 * Math.sin(yPos * tau * 2))
		);
	if (kind === 'twill')
		// Diagonal twill wale (cap fabric).
		return 0.5 + 0.5 * Math.sin((xPos + yPos) * tau * 20);
	if (kind === 'canvas')
		// Over/under basket weave (heavy tote canvas).
		return (
			0.5 +
			0.25 * Math.sin(xPos * tau * 24) +
			0.25 * Math.sin(yPos * tau * 24)
		);

	// Jersey: fine vertical wales with gentle courses across.
	return (
		0.5 +
		0.35 * Math.sin(xPos * tau * 32) +
		0.15 * Math.sin(yPos * tau * 8)
	);
};

const NORMAL_STRENGTH: Record<FabricKind, number> = {
	canvas: 2.4,
	jersey: 0.9,
	rib: 2.8,
	twill: 1.6
};

const buildFabricNormal = (kind: FabricKind) => {
	const canvas = document.createElement('canvas');
	canvas.width = TILE;
	canvas.height = TILE;
	const context = canvas.getContext('2d');
	if (!context) return null;
	const output = context.createImageData(TILE, TILE);
	const { data } = output;
	const strength = NORMAL_STRENGTH[kind];

	for (let pixel = 0; pixel < TILE * TILE; pixel += 1) {
		const xPos = pixel % TILE;
		const yPos = Math.floor(pixel / TILE);
		// Wrapping gradients keep the tile seamless.
		const left = fabricHeight(kind, (xPos + TILE - 1) % TILE, yPos);
		const right = fabricHeight(kind, (xPos + 1) % TILE, yPos);
		const above = fabricHeight(kind, xPos, (yPos + TILE - 1) % TILE);
		const below = fabricHeight(kind, xPos, (yPos + 1) % TILE);
		const slopeX = (left - right) * strength;
		const slopeY = (below - above) * strength;
		const inverse = 1 / Math.sqrt(slopeX * slopeX + slopeY * slopeY + 1);
		const channel = pixel * 4;
		data[channel] = (slopeX * inverse * 0.5 + 0.5) * OPAQUE;
		data[channel + 1] = (slopeY * inverse * 0.5 + 0.5) * OPAQUE;
		data[channel + 2] = (inverse * 0.5 + 0.5) * OPAQUE;
		data[channel + 3] = OPAQUE;
	}

	context.putImageData(output, 0, 0);

	return canvas;
};

const cache = new Map<FabricKind, THREE.Texture | null>();

const fabricNormalTexture = (kind: FabricKind, repeat: number) => {
	const cached = cache.get(kind);
	if (cached !== undefined) return cached;
	const canvas = buildFabricNormal(kind);
	if (!canvas) {
		cache.set(kind, null);

		return null;
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.repeat.set(repeat, repeat);
	texture.anisotropy = 4;
	cache.set(kind, texture);

	return texture;
};

/** Tiling fabric normal map for a garment mesh (cached per fabric kind). */
export const useFabricNormal = (kind: FabricKind, repeat = 10) =>
	useMemo(() => fabricNormalTexture(kind, repeat), [kind, repeat]);
