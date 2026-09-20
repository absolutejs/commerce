/** Supplier evidence is independent from a merchant's permission to sell. */
export type SupplierStockObservation = {
  sourceId: string;
  supplierSku: string;
  available: boolean | null;
  quantity?: number | null;
  /** Time the source observed stock, not the time a cached file was downloaded. */
  observedAt: string | null;
  receivedAt: string;
  revision?: string;
  transport: "api" | "file" | "manual";
};

export type SupplierStockPolicy = {
  /** Explicit source/account policy; omission never implies freshness. */
  maxAgeMs?: number;
  uncertain: "allow-review" | "block";
};

export type SupplierStockDecision = {
  state: "available" | "unavailable" | "unknown" | "stale";
  purchasable: boolean;
  reviewRequired: boolean;
  reason: "merchant-paused" | "supplier-unavailable" | "insufficient-stock" |
    "observation-missing" | "freshness-policy-missing" | "observation-stale" | null;
};

/** Pure evaluation: fetching/retries belong to adapters and the sync runtime. */
export const evaluateSupplierStock = (input: {
  observation?: SupplierStockObservation | null;
  policy: SupplierStockPolicy;
  saleEnabled: boolean;
  quantity: number;
  now?: number;
}): SupplierStockDecision => {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1)
    throw new RangeError("Purchase quantity must be a positive integer");
  const maxAge = input.policy.maxAgeMs;
  if (maxAge !== undefined && (!Number.isFinite(maxAge) || maxAge <= 0))
    throw new RangeError("Stock freshness must be a positive duration");
  const observation = input.observation;
  const now = input.now ?? Date.now();
  const observedAt = observation?.observedAt ? Date.parse(observation.observedAt) : NaN;
  const hasEvidence = observation &&
    (typeof observation.available === "boolean" ||
      (typeof observation.quantity === "number" && Number.isFinite(observation.quantity) && observation.quantity >= 0));
  let state: SupplierStockDecision["state"] = "unknown";
  let reason: SupplierStockDecision["reason"] = "observation-missing";
  if (hasEvidence && Number.isFinite(observedAt) && observedAt <= now) {
    if (maxAge === undefined) {
      if (observation.available === false) {state = "unavailable"; reason = "supplier-unavailable";}
      else if (typeof observation.quantity === "number" && observation.quantity < input.quantity) {state = "unavailable"; reason = "insufficient-stock";}
      else reason = "freshness-policy-missing";
    }
    else if (now - observedAt >= maxAge) {
      state = "stale";
      reason = "observation-stale";
    } else if (observation.available === false) {
      state = "unavailable";
      reason = "supplier-unavailable";
    } else if (typeof observation.quantity === "number" && observation.quantity < input.quantity) {
      state = "unavailable";
      reason = "insufficient-stock";
    } else {
      state = "available";
      reason = null;
    }
  }
  const uncertain = state === "unknown" || state === "stale";
  return {
    state,
    reason: input.saleEnabled ? reason : "merchant-paused",
    purchasable: input.saleEnabled && (state === "available" || (uncertain && input.policy.uncertain === "allow-review")),
    reviewRequired: input.saleEnabled && uncertain && input.policy.uncertain === "allow-review",
  };
};
