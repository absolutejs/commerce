import { describe, expect, it } from "bun:test";
import {
  storefrontCustomizationIsValid,
  storefrontPriceIsValid,
} from "./storefrontMerchandising";

describe("storefront merchandising policy", () => {
  it("requires internally consistent prices", () => {
    expect(storefrontPriceIsValid(2_000, 2_500)).toBeTrue();
    expect(storefrontPriceIsValid(2_000, 1_500)).toBeFalse();
    expect(storefrontPriceIsValid(-1, null)).toBeFalse();
  });

  it("requires approved artwork for approval-only storefronts", () => {
    expect(storefrontCustomizationIsValid("approved", {})).toBeFalse();
    expect(
      storefrontCustomizationIsValid("approved", {
        approvedArtwork: [
          {
            id: "logo",
            name: "Approved logo",
            placements: ["front"],
            url: "https://cdn.example/logo.png",
          },
        ],
      }),
    ).toBeTrue();
  });

  it("rejects incomplete buyer field and artwork contracts", () => {
    expect(
      storefrontCustomizationIsValid("both", {
        approvedArtwork: [
          { id: "logo", name: "Approved logo", url: "not-a-url" },
        ],
      }),
    ).toBeFalse();
    expect(
      storefrontCustomizationIsValid("customizable", {
        buyerFields: [
          {
            id: "department",
            label: "Department",
            required: true,
            type: "select",
          },
        ],
      }),
    ).toBeFalse();
  });
});
