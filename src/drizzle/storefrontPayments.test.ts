import { describe, expect, test } from "bun:test";
import {
  storefrontCheckoutRequestDigest,
  storefrontPaymentWebhookReceiptProjection,
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

describe("storefrontPaymentWebhookReceiptProjection", () => {
  test("omits the normalized event from operator posture", () => {
    const now = new Date();
    const projection = storefrontPaymentWebhookReceiptProjection({
      applied_at: null,
      attempt_count: 1,
      event: {
        checkout: {
          id: "provider-event",
          isComplete: false,
          isFailed: false,
          session: {
            amountTotalCents: 100,
            currency: "USD",
            customerEmail: "private@example.invalid",
            customerName: "Private customer",
            id: "session",
            lineItems: [],
            metadata: {},
            paymentStatus: "unpaid",
            shippingAddress: null,
            status: "open",
          },
          type: "checkout.session.created",
        },
        kind: "checkout",
      },
      event_type: "checkout.session.created",
      id: "receipt",
      installation_id: "installation",
      last_error: null,
      owner_key: "tenant",
      provider_event_id: "provider-event",
      received_at: now,
      result_status: null,
      status: "received",
      updated_at: now,
    });

    expect(projection).not.toHaveProperty("event");
    expect(JSON.stringify(projection)).not.toContain("private@example.invalid");
  });
});
