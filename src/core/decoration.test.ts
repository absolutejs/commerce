import { describe, expect, test } from "bun:test";
import {
  buildOrderProductionSpec,
  clampPlacementTransform,
  designDimensions,
  placementBounds,
  workOrderMarkdown,
  type DecorationItemInput,
  type DecorationZoneSpec,
} from "./decoration";

const zone: DecorationZoneSpec = {
  id: "front",
  label: "Front",
  physical: {
    anchor: '3" below collar, centered',
    heightIn: 12,
    widthIn: 10,
  },
  size: [1, 1.2],
};

describe("decoration placement normalization", () => {
  test("keeps the whole design inside the zone", () => {
    const bounds = placementBounds(zone, 2, 1);
    const normalized = clampPlacementTransform(zone, 2, {
      offsetX: 99,
      offsetY: -99,
      rotation: 0.25,
      scale: 1.8,
    });

    expect(normalized.scale).toBe(1);
    expect(normalized.offsetX).toBe(bounds.maxX);
    expect(normalized.offsetY).toBe(-bounds.maxY);
    expect(normalized.rotation).toBe(0.25);
  });

  test("records the same clamped offsets production preview displays", () => {
    const normalized = clampPlacementTransform(zone, 1, {
      offsetX: 99,
      offsetY: 99,
      rotation: 0,
      scale: 0.5,
    });
    const dims = designDimensions(zone, 1, 0.5, 99, 99);

    expect(dims.offsetXIn).toBe(
      Math.round(normalized.offsetX * zone.physical.widthIn * 10) / 10,
    );
    expect(dims.offsetYIn).toBe(
      Math.round(
        normalized.offsetY * (zone.physical.heightIn / zone.size[1]) * 10,
      ) / 10,
    );
  });
});

describe("production item identity", () => {
  test("survives into the spec and operator work order", () => {
    const item: DecorationItemInput = {
      backing: "cutaway",
      fabric: "100% cotton",
      garmentColor: { hex: "#1c3f6e", name: "Navy" },
      identity: {
        brand: "Nike",
        catalogSlug: "main",
        listingSlug: "nike-tee",
        sku: "NK100-NVY-M",
        styleCode: "NK100",
        supplierSku: "SUP-42",
        variantId: "variant-42",
      },
      method: "embroidery",
      methodLabel: "Embroidery",
      names: [],
      placements: [],
      product: "Nike Tee",
      productId: "shirt",
      quantity: 12,
      size: "M",
      usesStitchSize: true,
    };
    const spec = buildOrderProductionSpec([item], "2026-07-30T00:00:00Z");
    const workOrder = workOrderMarkdown(spec, "#ORDER");

    expect(spec.items[0]?.identity?.sku).toBe("NK100-NVY-M");
    expect(workOrder).toContain("Nike · NK100 · SKU NK100-NVY-M");
    expect(workOrder).toContain("main / nike-tee / variant-42");
  });
});
