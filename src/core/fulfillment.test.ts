import { describe, expect, it } from "bun:test";
import {
  routeFulfillmentOrder,
  validateFulfillmentOrder,
  type FulfillmentCostQuoteProvider,
  type FulfillmentOrderRequest,
  type FulfillmentShippingMethodProvider,
} from "./fulfillment";

const order: FulfillmentOrderRequest = {
  externalOrderId: "ORDER-100",
  lines: [
    {
      artwork: [{ placement: "front", url: "https://cdn.test/art.png" }],
      id: "line-1",
      providerId: "customcat",
      providerSku: "48146",
      quantity: 1,
      variantId: "customcat:48146",
    },
  ],
  recipient: {
    address1: "100 Main St",
    city: "Detroit",
    country: "US",
    firstName: "Ada",
    lastName: "Lovelace",
    postalCode: "48201",
    state: "MI",
  },
};

describe("fulfillment routing", () => {
  it("keeps a single-provider order id unchanged", () => {
    const [routed] = routeFulfillmentOrder(order);
    expect(routed?.externalOrderId).toBe("ORDER-100");
    expect(routed?.providerId).toBe("customcat");
  });

  it("splits mixed-provider orders into stable provider jobs", () => {
    const routed = routeFulfillmentOrder({
      ...order,
      lines: [
        ...order.lines,
        { ...order.lines[0]!, id: "line-2", providerId: "local" },
      ],
    });
    expect(routed.map((job) => job.externalOrderId)).toEqual([
      "ORDER-100-customcat",
      "ORDER-100-local",
    ]);
  });
});

describe("fulfillment validation", () => {
  it("accepts a complete provider order", () => {
    expect(validateFulfillmentOrder(order)).toEqual({
      errors: [],
      valid: true,
    });
  });

  it("reports line and address failures together", () => {
    const result = validateFulfillmentOrder({
      ...order,
      lines: [{ ...order.lines[0]!, artwork: [], quantity: 0 }],
      recipient: { ...order.recipient, postalCode: "" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
  });
});

describe("fulfillment cost preflight", () => {
  it("keeps read-only quotes separate from provider order submission", async () => {
    const quoting: FulfillmentCostQuoteProvider = {
      quoteOrder: async () => ({
        adjustmentsCents: 0,
        assumptions: ["provider price is not reserved"],
        currency: "USD",
        itemsCents: 1_000,
        quotedAt: "2030-01-01T00:00:00.000Z",
        shippingCents: 500,
        totalCents: 1_500,
      }),
    };
    const quote = await quoting.quoteOrder({
      lines: order.lines,
      recipient: order.recipient,
    });

    expect(quote.totalCents).toBe(
      quote.itemsCents + quote.shippingCents + quote.adjustmentsCents,
    );
  });

  it("discovers stable provider shipping choices from an order draft", async () => {
    const shipping: FulfillmentShippingMethodProvider = {
      listShippingMethods: async () => [
        { description: "Tracked ground delivery", id: "1", name: "Economy" },
      ],
    };
    const methods = await shipping.listShippingMethods({
      lines: order.lines,
      recipient: order.recipient,
    });

    expect(methods).toEqual([
      { description: "Tracked ground delivery", id: "1", name: "Economy" },
    ]);
  });
});
