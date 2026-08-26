import { describe, expect, test } from "bun:test";
import {
  containedImageRect,
  photoPlacementStyle,
  photoTintStyle,
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
});
