import { describe, expect, test } from "bun:test";
import {
  buildOrderProductionSpec,
  type DecorationItemInput,
  type DecorationZoneSpec,
} from "./decoration";
import { productionReadinessIssues } from "./productionPackage";

const zone: DecorationZoneSpec = {
  id: "front",
  label: "Front",
  physical: { anchor: "centered", heightIn: 12, widthIn: 10 },
  size: [1, 1.2],
};

const mixedSpec = () => {
  const item: DecorationItemInput = {
    backing: "cutaway",
    fabric: "cotton",
    garmentColor: { hex: "#111111", name: "Black" },
    method: "embroidery",
    methodLabel: "Mixed",
    names: [],
    placements: [
      {
        artwork: "Logo",
        artworkUrl: "https://example.com/logo.svg",
        method: "embroidery",
        methodLabel: "Embroidery",
        placementId: "left-chest",
        usesStitchSize: true,
        zone,
        zoneId: "front",
        zoneLabel: "Left chest",
      },
      {
        artwork: "Logo",
        artworkUrl: "https://example.com/logo.svg",
        method: "screen-print",
        methodLabel: "Screen print",
        placementId: "full-back",
        usesStitchSize: false,
        zone,
        zoneId: "back",
        zoneLabel: "Full back",
      },
    ],
    product: "Tee",
    productId: "shirt",
    quantity: 24,
    size: "M",
    usesStitchSize: true,
  };

  return buildOrderProductionSpec([item], "2026-07-30T00:00:00Z");
};

describe("production readiness", () => {
  test("requires an approved method-specific file for every placement", () => {
    const issues = productionReadinessIssues(mixedSpec(), [
      {
        approved: true,
        artworkUrl: "https://example.com/logo.svg",
        kind: "stitch",
        placementId: "left-chest",
        url: "https://example.com/logo.dst",
      },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("full-back");
    expect(issues[0]).toContain("separation or rip");
  });

  test("does not confuse two placements that reuse the same artwork", () => {
    const issues = productionReadinessIssues(mixedSpec(), [
      {
        approved: true,
        artworkUrl: "https://example.com/logo.svg",
        kind: "stitch",
        placementId: "left-chest",
        url: "https://example.com/logo.dst",
      },
      {
        approved: true,
        artworkUrl: "https://example.com/logo.svg",
        kind: "separation",
        placementId: "full-back",
        url: "https://example.com/logo-back.pdf",
      },
    ]);

    expect(issues).toEqual([]);
  });
});
