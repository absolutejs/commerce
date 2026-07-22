import { describe, expect, test } from "bun:test";
import {
  storefrontCheckoutRequestDigest,
  storefrontPaymentWebhookReceiptSelection,
} from "./storefrontPayments";

describe("storefrontCheckoutRequestDigest", () => {
  test("is stable across object key ordering", () => {
    expect(
      storefrontCheckoutRequestDigest({
        catalogId: "catalog",
        lines: [{ customization: { buyerFields: { back: "2", front: "1" } } }],
      }),
    ).toBe(
      storefrontCheckoutRequestDigest({
        lines: [{ customization: { buyerFields: { front: "1", back: "2" } } }],
        catalogId: "catalog",
      }),
    );
  });

  test("changes when the checkout request changes", () => {
    expect(
      storefrontCheckoutRequestDigest({ catalogId: "catalog", quantity: 1 }),
    ).not.toBe(
      storefrontCheckoutRequestDigest({ catalogId: "catalog", quantity: 2 }),
    );
  });
});

describe("storefrontPaymentWebhookReceiptSelection", () => {
  test("never selects the normalized event for operator posture", () => {
    expect(storefrontPaymentWebhookReceiptSelection()).not.toHaveProperty(
      "event",
    );
  });
});
