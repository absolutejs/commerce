import { describe, expect, it } from "bun:test";
import {
  evaluateSupplierStock,
  type SupplierStockObservation,
} from "./supplierAvailability";
const now = Date.parse("2026-09-20T12:00:00Z");
const observation: SupplierStockObservation = {
  sourceId: "producer",
  supplierSku: "shirt-blue-m",
  available: true,
  observedAt: new Date(now - 1_000).toISOString(),
  receivedAt: new Date(now).toISOString(),
  transport: "api",
};
const evaluate = (stock: SupplierStockObservation | null, saleEnabled = true) =>
  evaluateSupplierStock({
    observation: stock,
    saleEnabled,
    quantity: 2,
    now,
    policy: { maxAgeMs: 60_000, uncertain: "allow-review" },
  });
describe("supplier stock evidence", () => {
  it("blocks fresh negative evidence and insufficient quantity", () => {
    expect(evaluate({ ...observation, available: false }).purchasable).toBe(
      false,
    );
    expect(evaluate({ ...observation, quantity: 1 }).reason).toBe(
      "insufficient-stock",
    );
  });
  it("allows unknown and stale evidence with review", () => {
    expect(evaluate(null)).toMatchObject({
      state: "unknown",
      purchasable: true,
      reviewRequired: true,
    });
    expect(
      evaluate({
        ...observation,
        available: false,
        observedAt: new Date(now - 60_000).toISOString(),
      }),
    ).toMatchObject({
      state: "stale",
      purchasable: true,
      reviewRequired: true,
    });
  });
  it("does not refresh an FTP snapshot when it is downloaded again", () => {
    expect(
      evaluate({
        ...observation,
        transport: "file",
        observedAt: new Date(now - 90_000).toISOString(),
        receivedAt: new Date(now).toISOString(),
      }).state,
    ).toBe("stale");
  });
  it("merchant resume never overrides a fresh supplier restriction", () => {
    expect(evaluate(observation, false).reason).toBe("merchant-paused");
    expect(
      evaluate({ ...observation, available: false }, true).purchasable,
    ).toBe(false);
  });
  it("does not invent freshness for missing policy or future timestamps", () => {
    expect(
      evaluateSupplierStock({
        observation,
        saleEnabled: true,
        quantity: 1,
        now,
        policy: { uncertain: "allow-review" },
      }).reason,
    ).toBe("freshness-policy-missing");
    expect(
      evaluate({ ...observation, observedAt: new Date(now + 1).toISOString() })
        .state,
    ).toBe("unknown");
  });
  it("does not infer available from a timestamp alone", () => {
    expect(evaluate({ ...observation, available: null }).state).toBe("unknown");
  });
});
