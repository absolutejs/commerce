import { describe, expect, test } from "bun:test";
import {
  containedImageRect,
  photoPlacementStyle,
  photoTintStyle,
  recolorGarmentPixels,
  type PhotoPlacedDesign,
} from "./index";

describe("product photo preview geometry", () => {
  test("positions overlays against the contained source image, not letterboxing", () => {
    expect(containedImageRect(1000, 800, 1000, 1000)).toEqual({
      height: 800,
      left: 100,
      top: 0,
      width: 800,
    });
  });

  test("uses the same bounded transform as production dimensions", () => {
    const image = containedImageRect(1000, 1000, 1000, 1000);
    const design: PhotoPlacedDesign = {
      aspect: 1,
      src: "https://example.com/logo.png",
      transform: {
        offsetX: 999,
        offsetY: 999,
        rotation: 0,
        scale: 0.5,
      },
      zone: {
        id: "front",
        label: "Front",
        physical: { anchor: "centered", heightIn: 10, widthIn: 10 },
        previewBox: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 },
        size: [1, 1],
      },
      zoneId: "front",
    };
    const style = photoPlacementStyle(image, design);

    expect(style.width).toBe(250);
    expect(style.height).toBe(250);
    expect(style.left).toBe(625);
    expect(style.top).toBe(375);
  });

  test("tint layer covers exactly the contained photo and is masked by it", () => {
    const image = containedImageRect(1000, 800, 1000, 1000);
    const style = photoTintStyle(image, 'https://x.test/a "b".webp', "#112233");

    expect(style.left).toBe(100);
    expect(style.width).toBe(800);
    expect(style.height).toBe(800);
    expect(style.background).toBe("#112233");
    expect(style.mixBlendMode).toBe("multiply");
    expect(style.maskImage).toBe('url("https://x.test/a %22b%22.webp")');
  });

  test("recolors opaque garment pixels by relative shade and skips keyed background", () => {
    // white garment (255) with a fold (128), one transparent background pixel
    const data = new Uint8ClampedArray([
      255, 255, 255, 255, 128, 128, 128, 255, 255, 255, 255, 255, 10, 10, 10, 0,
    ]);
    recolorGarmentPixels(data, [200, 0, 100]);
    expect([data[0], data[1], data[2]]).toEqual([200, 0, 100]);
    expect(data[4]).toBeLessThan(120);
    expect(data[6]).toBeLessThan(60);
    expect([data[12], data[13], data[14]]).toEqual([10, 10, 10]);
  });

  test("lifts a dark blank so a light tint still reads", () => {
    const data = new Uint8ClampedArray([30, 30, 30, 255, 40, 40, 40, 255]);
    recolorGarmentPixels(data, [200, 200, 200]);
    expect(data[0]).toBe(200);
    expect(data[4]).toBeGreaterThan(data[0]);
  });

  test("keeps an opaque studio background and recolors only the garment", () => {
    // 4x4: cream background border, a 2x2 white garment in the middle
    const w = 32,
      h = 32;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const x = p % w,
        y = Math.floor(p / w);
      const garment = x >= 8 && x < 24 && y >= 8 && y < 24;
      data.set(garment ? [255, 255, 255, 255] : [246, 242, 234, 255], p * 4);
    }
    recolorGarmentPixels(data, [20, 40, 120], { height: h, width: w });
    // corner stays cream
    expect([data[0], data[1], data[2]]).toEqual([246, 242, 234]);
    // centre becomes the tint
    const c = (16 * w + 16) * 4;
    expect(data[c]).toBeLessThan(60);
    expect(data[c + 2]).toBeGreaterThan(100);
  });
});
