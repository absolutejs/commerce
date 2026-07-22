import { describe, expect, test } from "bun:test";
import { storefrontOrderAccessTokenHash } from "./storefrontOrders";

describe("storefront order access", () => {
  test("retains a stable digest instead of the guest bearer token", () => {
    const token = "guest-order-access-token-with-enough-entropy";
    const digest = storefrontOrderAccessTokenHash(token);

    expect(digest).toHaveLength(64);
    expect(digest).not.toContain(token);
    expect(storefrontOrderAccessTokenHash(token)).toBe(digest);
  });

  test("binds access to the exact guest token", () => {
    expect(storefrontOrderAccessTokenHash("first-token")).not.toBe(
      storefrontOrderAccessTokenHash("second-token"),
    );
  });
});
