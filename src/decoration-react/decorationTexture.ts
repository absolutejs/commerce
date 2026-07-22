import { useEffect, useState } from "react";
import * as THREE from "three";
import type { EmbroideryType } from "../core/decoration";
import { hexToRgb, nearestThread, type ThreadRef } from "../core/threads";

/** Decoration method id — apps may extend beyond the built-in six. */
export type DecorationMethodId =
  "embroidery" | "screen-print" | "dtg" | "vinyl" | "dtf" | "sublimation";

type MethodSurface = { metalness: number; roughness: number };

// Per-method PBR surface for the decal. Embroidery reads as raised polyester
// thread (low roughness + generated normal map), vinyl as glossy film, DTF
// as a thin semi-gloss transfer, and the ink/dye methods sit matte in the
// fabric (sublimation dyes the fibers — no surface build at all).
export const METHOD_SURFACE: Record<DecorationMethodId, MethodSurface> = {
  dtf: { metalness: 0.02, roughness: 0.5 },
  dtg: { metalness: 0, roughness: 0.92 },
  embroidery: { metalness: 0.05, roughness: 0.38 },
  "screen-print": { metalness: 0, roughness: 0.7 },
  sublimation: { metalness: 0, roughness: 1 },
  vinyl: { metalness: 0.08, roughness: 0.22 },
};

export type DecorationMaps = {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
};

/* ------------------------- stitch simulation ------------------------- */

const MAX_EDGE = 640;
/** Alpha below this is background — embroidery has no translucent thread. */
const ALPHA_CUTOFF = 60;
/** Stitch run length before the needle punches down, px. */
const STITCH_LENGTH = 12;
/** Satin fill direction (classic 45° left-chest fill). */
const STITCH_ANGLE = Math.PI / 4;

type StitchProfile = {
  rowSpacing: number;
  normalStrength: number;
  normalScale: number;
};

// Flat fill vs 3D puff (foam under the stitches): puff reads as thicker
// thread rows with a much stronger raised profile.
const STITCH_PROFILE: Record<EmbroideryType, StitchProfile> = {
  flat: { normalScale: 0.85, normalStrength: 2.2, rowSpacing: 4 },
  puff: { normalScale: 1.45, normalStrength: 3.8, rowSpacing: 6 },
};

const COS_A = Math.cos(STITCH_ANGLE);
const SIN_A = Math.sin(STITCH_ANGLE);

const RGBA = 4;
const FLAT_NORMAL = 128;
const OPAQUE = 255;

const fitEdge = (width: number, height: number) => {
  const factor = Math.min(1, MAX_EDGE / Math.max(width, height));

  return {
    height: Math.max(2, Math.round(height * factor)),
    width: Math.max(2, Math.round(width * factor)),
  };
};

const drawToCanvas = (image: HTMLImageElement) => {
  const { width, height } = fitEdge(
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);

  return { canvas, context, height, width };
};

const readPixels = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) => {
  try {
    return context.getImageData(0, 0, width, height);
  } catch {
    // Tainted canvas (cross-origin artwork without CORS) — bail to flat.
    return null;
  }
};

// Height of the thread surface at a pixel: a sine ridge across each thread
// row, dipping where the needle punches down at the end of each stitch run.
const threadHeight = (xPos: number, yPos: number, rowSpacing: number) => {
  const along = xPos * COS_A + yPos * SIN_A;
  const across = -xPos * SIN_A + yPos * COS_A;
  const row = Math.floor(across / rowSpacing);
  const acrossT = across / rowSpacing - row;
  const ridge = Math.sin(Math.PI * acrossT);
  // Deterministic per-row phase so needle points don't align into a grid.
  const phase = (((row * 7919) % 97) / 97) * STITCH_LENGTH;
  let runT = (along + phase) % STITCH_LENGTH;
  if (runT < 0) runT += STITCH_LENGTH;
  runT /= STITCH_LENGTH;
  const needleDip = runT < 0.07 || runT > 0.93 ? 0.62 : 1;

  return ridge * needleDip;
};

type StitchField = {
  heightField: Float32Array;
  mask: Uint8Array;
};

// Pass 1: thread-palette quantization + satin ridge shading in place.
const shadeStitches = (
  pixels: ImageData,
  width: number,
  height: number,
  rowSpacing: number,
  catalog: ThreadRef[],
) => {
  const { data } = pixels;
  const heightField = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  const total = width * height;
  const rgbCache = new Map<string, [number, number, number]>();

  for (let pixel = 0; pixel < total; pixel += 1) {
    const channel = pixel * RGBA;
    const stitched = (data[channel + 3] as number) >= ALPHA_CUTOFF;
    data[channel + 3] = stitched ? OPAQUE : 0;
    if (!stitched) continue;
    mask[pixel] = 1;
    const xPos = pixel % width;
    const yPos = Math.floor(pixel / width);
    const thread = nearestThread(
      catalog,
      data[channel] as number,
      data[channel + 1] as number,
      data[channel + 2] as number,
    );
    const cached = rgbCache.get(thread.code);
    const rgb = cached ?? hexToRgb(thread.hex);
    if (!cached) rgbCache.set(thread.code, rgb);
    const lift = threadHeight(xPos, yPos, rowSpacing);
    heightField[pixel] = lift;
    const shade = 0.7 + 0.32 * lift;
    data[channel] = Math.min(OPAQUE, rgb[0] * shade);
    data[channel + 1] = Math.min(OPAQUE, rgb[1] * shade);
    data[channel + 2] = Math.min(OPAQUE, rgb[2] * shade);
  }

  return { heightField, mask };
};

// Pass 2: darken the outline ring (thread rolls under at the border of a
// fill, reading as a stitched edge rather than a printed cut line).
const darkenEdges = (
  pixels: ImageData,
  field: StitchField,
  width: number,
  height: number,
) => {
  const { data } = pixels;
  const { heightField, mask } = field;
  const total = width * height;

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (!mask[pixel]) continue;
    const xPos = pixel % width;
    const yPos = Math.floor(pixel / width);
    const bare =
      xPos === 0 ||
      yPos === 0 ||
      xPos === width - 1 ||
      yPos === height - 1 ||
      !mask[pixel - 1] ||
      !mask[pixel + 1] ||
      !mask[pixel - width] ||
      !mask[pixel + width];
    if (!bare) continue;
    const channel = pixel * RGBA;
    data[channel] = (data[channel] as number) * 0.72;
    data[channel + 1] = (data[channel + 1] as number) * 0.72;
    data[channel + 2] = (data[channel + 2] as number) * 0.72;
    heightField[pixel] = (heightField[pixel] as number) * 0.5;
  }
};

// Pass 3: normal map from the height field so ridges shade with the lights.
const buildNormalCanvas = (
  field: StitchField,
  width: number,
  height: number,
  normalStrength: number,
) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const output = context.createImageData(width, height);
  const out = output.data;
  const { heightField, mask } = field;
  const total = width * height;

  // Start from a flat normal everywhere, then carve the thread ridges in.
  for (let channel = 0; channel < out.length; channel += RGBA) {
    out[channel] = FLAT_NORMAL;
    out[channel + 1] = FLAT_NORMAL;
    out[channel + 2] = OPAQUE;
    out[channel + 3] = OPAQUE;
  }

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (!mask[pixel]) continue;
    const channel = pixel * RGBA;
    const xPos = pixel % width;
    const yPos = Math.floor(pixel / width);
    const left = heightField[pixel - (xPos > 0 ? 1 : 0)] as number;
    const right = heightField[pixel + (xPos < width - 1 ? 1 : 0)] as number;
    const above = heightField[pixel - (yPos > 0 ? width : 0)] as number;
    const below = heightField[
      pixel + (yPos < height - 1 ? width : 0)
    ] as number;
    const slopeX = (left - right) * normalStrength;
    const slopeY = (below - above) * normalStrength;
    const inverse = 1 / Math.sqrt(slopeX * slopeX + slopeY * slopeY + 1);
    out[channel] = (slopeX * inverse * 0.5 + 0.5) * OPAQUE;
    out[channel + 1] = (slopeY * inverse * 0.5 + 0.5) * OPAQUE;
    out[channel + 2] = (inverse * 0.5 + 0.5) * OPAQUE;
    out[channel + 3] = OPAQUE;
  }

  context.putImageData(output, 0, 0);

  return canvas;
};

// Converts flat artwork into what the embroidery machine would actually sew:
// thread-palette colors, directional satin ridges, needle penetration points,
// plus a matching normal map so the stitches catch light in 3D.
const stitchify = (
  image: HTMLImageElement,
  embroideryType: EmbroideryType,
  catalog: ThreadRef[],
) => {
  const drawn = drawToCanvas(image);
  if (!drawn) return null;
  const { canvas, context, width, height } = drawn;

  const pixels = readPixels(context, width, height);
  if (!pixels) return null;

  const profile = STITCH_PROFILE[embroideryType];
  const field = shadeStitches(
    pixels,
    width,
    height,
    profile.rowSpacing,
    catalog,
  );
  darkenEdges(pixels, field, width, height);
  context.putImageData(pixels, 0, 0);

  return {
    map: canvas,
    normal: buildNormalCanvas(field, width, height, profile.normalStrength),
  };
};

// Vinyl is cut from solid film: hard edges, no translucency, colors as-is.
const hardenAlpha = (image: HTMLImageElement) => {
  const drawn = drawToCanvas(image);
  if (!drawn) return null;
  const { canvas, context, width, height } = drawn;

  const pixels = readPixels(context, width, height);
  if (!pixels) return null;

  const { data } = pixels;
  for (let channel = 3; channel < data.length; channel += RGBA) {
    data[channel] = (data[channel] as number) < ALPHA_CUTOFF ? 0 : OPAQUE;
  }
  context.putImageData(pixels, 0, 0);

  return canvas;
};

/* ----------------------------- textures ------------------------------ */

const colorTexture = (source: HTMLImageElement | HTMLCanvasElement) => {
  const texture =
    source instanceof HTMLCanvasElement
      ? new THREE.CanvasTexture(source)
      : new THREE.Texture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  return texture;
};

const buildMaps = (
  image: HTMLImageElement,
  method: DecorationMethodId,
  embroideryType: EmbroideryType,
  catalog: ThreadRef[],
): DecorationMaps => {
  const stitched =
    method === "embroidery" ? stitchify(image, embroideryType, catalog) : null;
  if (stitched) {
    const normalMap = stitched.normal
      ? new THREE.CanvasTexture(stitched.normal)
      : null;
    if (normalMap) normalMap.anisotropy = 8;

    return { map: colorTexture(stitched.map), normalMap };
  }

  const hardened = method === "vinyl" ? hardenAlpha(image) : null;
  if (hardened) return { map: colorTexture(hardened), normalMap: null };

  return { map: colorTexture(image), normalMap: null };
};

/** Normal-map intensity for the decal material, per embroidery type. */
export const normalScaleFor = (embroideryType: EmbroideryType) =>
  STITCH_PROFILE[embroideryType].normalScale;

// Turns any design source (uploaded file, inline SVG data URL, rendered text)
// into decal textures that reflect the chosen decoration method — embroidery
// gets a simulated stitch map + normal map, not the flat artwork.
export const useDecorationTexture = (
  src: string | null,
  method: DecorationMethodId,
  catalog: ThreadRef[],
  embroideryType: EmbroideryType = "flat",
) => {
  const [maps, setMaps] = useState<DecorationMaps | null>(null);

  useEffect(() => {
    if (!src) {
      setMaps(null);

      return undefined;
    }

    let disposed = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (disposed) return;
      setMaps(buildMaps(image, method, embroideryType, catalog));
    };
    image.src = src;

    return () => {
      disposed = true;
    };
  }, [src, method, embroideryType, catalog]);

  useEffect(
    () => () => {
      maps?.map.dispose();
      maps?.normalMap?.dispose();
    },
    [maps],
  );

  return maps;
};
