import { describe, expect, it } from "bun:test";
import {
  nearestPantone,
  pantoneMatchQuality,
  PMS_APPROX,
  resolveThreadQuery,
  type ThreadRef,
} from "./threads";

const catalog: ThreadRef[] = [
  { brand: "Test Poly", code: "1801", hex: "#c8102e", name: "Ruby Red" },
  { brand: "Test Poly", code: "1966", hex: "#001489", name: "Deep Blue" },
  { brand: "Test Poly", code: "1771", hex: "#ffffff", name: "White" },
  { brand: "Test Poly", code: "1800", hex: "#000000", name: "Black" },
];

describe("nearestPantone", () => {
  it("returns an exact match for a hex that is in the table", () => {
    const match = nearestPantone("#c8102e");
    expect(match).not.toBeNull();
    expect(match?.code).toBe("PMS 186 C");
    expect(match?.hex).toBe("#c8102e");
    expect(match?.distanceRgb).toBe(0);
  });

  it("normalizes input like the other helpers", () => {
    const match = nearestPantone("  C8102E ");
    expect(match?.code).toBe("PMS 186 C");
    expect(match?.distanceRgb).toBe(0);
  });

  it("formats named swatches without a C suffix", () => {
    const match = nearestPantone(PMS_APPROX["reflex blue"] as string);
    expect(match?.code).toBe("PMS REFLEX BLUE");
    expect(match?.distanceRgb).toBe(0);
  });

  it("returns a sensible neighbor for a slightly-off hex", () => {
    const match = nearestPantone("#ca142f");
    expect(match?.code).toBe("PMS 186 C");
    expect(match?.hex).toBe("#c8102e");
    expect(match?.distanceRgb).toBeGreaterThan(0);
    expect(match?.distanceRgb).toBeLessThan(10);
  });

  it("returns null for non-hex input", () => {
    expect(nearestPantone("not a color")).toBeNull();
    expect(nearestPantone("#fff")).toBeNull();
    expect(nearestPantone("")).toBeNull();
  });
});

describe("pantoneMatchQuality", () => {
  it("labels a zero distance as exact", () => {
    expect(pantoneMatchQuality(0)).toBe("exact");
  });

  it("labels distances up to the cutoff as close", () => {
    expect(pantoneMatchQuality(1)).toBe("close");
    expect(pantoneMatchQuality(60)).toBe("close");
  });

  it("labels distances past the cutoff as approximate", () => {
    expect(pantoneMatchQuality(60.5)).toBe("approximate");
    expect(pantoneMatchQuality(255)).toBe("approximate");
  });
});

describe("resolveThreadQuery", () => {
  it("resolves a hex input to the nearest stocked thread", () => {
    const match = resolveThreadQuery(catalog, "#c00d28");
    expect(match).not.toBeNull();
    expect(match?.requested).toBe("#c00d28");
    expect(match?.requestedHex).toBe("#c00d28");
    expect(match?.thread.code).toBe("1801");
  });

  it("resolves a numeric PMS input via the table", () => {
    const match = resolveThreadQuery(catalog, "PMS 186 C");
    expect(match).not.toBeNull();
    expect(match?.requested).toBe("PMS 186 C");
    expect(match?.requestedHex).toBe("#c8102e");
    expect(match?.thread.code).toBe("1801");
  });

  it("resolves a named PMS input via the table", () => {
    const match = resolveThreadQuery(catalog, "Pantone Reflex Blue C");
    expect(match).not.toBeNull();
    expect(match?.requested).toBe("PMS REFLEX BLUE");
    expect(match?.requestedHex).toBe("#001489");
    expect(match?.thread.code).toBe("1966");
  });

  it("returns null for unknown input", () => {
    expect(resolveThreadQuery(catalog, "PMS 99999 C")).toBeNull();
    expect(resolveThreadQuery(catalog, "")).toBeNull();
  });
});
