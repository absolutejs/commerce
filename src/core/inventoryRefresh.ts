import type { CatalogSourceProvider, InventoryLevel } from "./catalog";
import type { SupplierStockObservation } from "./supplierAvailability";

export type InventoryRefreshProduct = { externalId: string; skus: string[] };
export type InventoryRefreshReport = {
  productsChecked: number;
  variantsUpdated: number;
  variantsFailed: number;
  failures: { externalId: string; code: string; skus: string[] }[];
  status: "passed" | "partial" | "unsupported";
};

/** A provider timestamp is required. Re-downloading a cached feed is not new evidence. */
export const inventoryObservation = (
  sourceId: string,
  level: InventoryLevel,
  receivedAt = new Date().toISOString(),
): SupplierStockObservation => {
  if (
    !level.sku?.trim() ||
    typeof level.available !== "boolean" ||
    (level.quantity != null &&
      (!Number.isSafeInteger(level.quantity) ||
        level.quantity < 0 ||
        level.quantity > 2147483647))
  )
    throw new Error("invalid_inventory_level");
  const timestamp = level.updatedAt ? Date.parse(level.updatedAt) : NaN;
  return {
    sourceId,
    supplierSku: level.sku,
    available: level.available,
    quantity: level.quantity ?? null,
    observedAt:
      Number.isFinite(timestamp) && timestamp <= Date.parse(receivedAt)
        ? new Date(timestamp).toISOString()
        : null,
    receivedAt,
    transport: level.transport ?? "api",
  };
};

/** Keep a dedicated stock lookup when a catalog page omits stock or is older. */
export const preserveSupplierStock = (
  current: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
  sourceId: string,
  sku: string | null | undefined,
) => {
  const next = { ...incoming };
  const old = current?.supplierStock as SupplierStockObservation | undefined;
  const newer = next.supplierStock as SupplierStockObservation | undefined;
  const valid = (value: SupplierStockObservation | undefined) =>
    value?.sourceId === sourceId &&
    value.supplierSku === sku &&
    Number.isFinite(Date.parse(value.observedAt ?? ""));
  if (
    valid(old) &&
    (!valid(newer) ||
      Date.parse(old!.observedAt!) > Date.parse(newer!.observedAt!))
  )
    next.supplierStock = old;
  return next;
};

/** Product-scoped lookup avoids one HTTP request per color/size. Each product's
 * failures are isolated; persistence failures propagate and stop the refresh. */
export const refreshSupplierInventory = async (input: {
  provider: CatalogSourceProvider;
  sourceId: string;
  products: InventoryRefreshProduct[];
  concurrency?: number;
  signal?: AbortSignal;
  persist: (
    externalId: string,
    observations: SupplierStockObservation[],
  ) => Promise<void>;
  progress?: (report: InventoryRefreshReport) => Promise<void>;
}): Promise<InventoryRefreshReport> => {
  const report: InventoryRefreshReport = {
    productsChecked: 0,
    variantsUpdated: 0,
    variantsFailed: 0,
    failures: [],
    status: "passed",
  };
  if (
    !input.provider.getCatalogInventory &&
    !input.provider.getProductInventory &&
    !input.provider.getInventory
  )
    return { ...report, status: "unsupported" };
  const concurrency = input.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new RangeError("Inventory concurrency must be between one and 16");
  // Fetch once per run, not once per worker or product. Never cache across runs.
  let snapshot: Map<string, InventoryLevel[]> | undefined;
  if (input.provider.getCatalogInventory) {
    input.signal?.throwIfAborted();
    const rows = await input.provider.getCatalogInventory();
    input.signal?.throwIfAborted();
    snapshot = new Map();
    for (const row of rows) {
      // Keep duplicate observations so validation rejects ambiguous SKU evidence.
      snapshot.set(row.externalId, [
        ...(snapshot.get(row.externalId) ?? []),
        ...row.levels,
      ]);
    }
  }
  let cursor = 0,
    fatal: unknown;
  const worker = async () => {
    while (!fatal) {
      input.signal?.throwIfAborted();
      const product = input.products[cursor++];
      if (!product) return;
      const wanted = [...new Set(product.skus.filter(Boolean))];
      let levels: InventoryLevel[] = [];
      try {
        levels = snapshot
          ? (snapshot.get(product.externalId) ?? [])
          : input.provider.getProductInventory
            ? await input.provider.getProductInventory(product.externalId)
            : await input.provider.getInventory!(wanted);
      } catch {
        report.failures.push({
          externalId: product.externalId,
          code: "lookup_failed",
          skus: wanted,
        });
        report.variantsFailed += wanted.length;
        report.productsChecked++;
        continue;
      }
      const receivedAt = new Date().toISOString();
      const observations: SupplierStockObservation[] = [];
      const failed: string[] = [];
      for (const sku of wanted) {
        const matches = levels.filter((level) => level.sku === sku);
        if (matches.length !== 1) {
          failed.push(sku);
          continue;
        }
        try {
          const observation = inventoryObservation(
            input.sourceId,
            matches[0]!,
            receivedAt,
          );
          if (!observation.observedAt) failed.push(sku);
          else observations.push(observation);
        } catch {
          failed.push(sku);
        }
      }
      if (failed.length) {
        report.failures.push({
          externalId: product.externalId,
          code: "missing_or_invalid_stock",
          skus: failed,
        });
        report.variantsFailed += failed.length;
      }
      input.signal?.throwIfAborted();
      try {
        if (observations.length)
          await input.persist(product.externalId, observations);
      } catch (error) {
        fatal = error;
        return;
      }
      report.productsChecked++;
      report.variantsUpdated += observations.length;
      if (input.progress)
        await input.progress({
          ...report,
          status: report.variantsFailed ? "partial" : "passed",
        });
    }
  };
  // Wait for every worker before returning or releasing a persistence lease.
  const workers = await Promise.allSettled(
    Array.from({ length: concurrency }, worker),
  );
  if (fatal) throw fatal;
  const rejected = workers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
  return { ...report, status: report.variantsFailed ? "partial" : "passed" };
};
