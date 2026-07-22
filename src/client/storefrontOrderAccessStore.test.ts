import { describe, expect, test } from "bun:test";
import { normalizeStorefrontOrderAccess } from "./storefrontOrderAccessStore";

describe("storefront order access store", () => {
  test("drops malformed and low-entropy bearer references", () => {
    expect(
      normalizeStorefrontOrderAccess([
        null,
        {
          checkoutIntentId: "intent",
          createdAt: "now",
          orderAccessToken: "short",
        },
        {
          checkoutIntentId: "intent-valid",
          createdAt: "2026-07-22T00:00:00.000Z",
          orderAccessToken: "a".repeat(32),
        },
      ]),
    ).toEqual([
      {
        checkoutIntentId: "intent-valid",
        createdAt: "2026-07-22T00:00:00.000Z",
        orderAccessToken: "a".repeat(32),
      },
    ]);
  });
});
