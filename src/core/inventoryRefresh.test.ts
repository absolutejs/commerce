import { test, expect } from "bun:test";
import {
  refreshSupplierInventory,
  inventoryObservation,
  preserveSupplierStock,
} from "./inventoryRefresh";
import type { CatalogSourceProvider } from "./catalog";
const now = new Date().toISOString();
const base = { id: "provider", listProducts: async () => ({ items: [] }) };
test("product lookup is bounded, isolates failures, and never invents missing observations", async () => {
  let active = 0,
    peak = 0;
  const saved: string[] = [];
  const provider: CatalogSourceProvider = {
    ...base,
    getProductInventory: async (id) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(2);
      active--;
      if (id === "bad") throw Error("credentials should not leak");
      return [{ sku: id, available: id !== "out", updatedAt: now }];
    },
    getInventory: async () => {
      throw Error("must use product endpoint");
    },
  };
  const report = await refreshSupplierInventory({
    provider,
    sourceId: "source",
    products: ["yes", "bad", "out"].map((id) => ({
      externalId: id,
      skus: [id, "missing"],
    })),
    concurrency: 2,
    persist: async (id, stock) => {
      expect(stock[0]?.sourceId).toBe("source");
      saved.push(id);
    },
  });
  expect(peak).toBeLessThanOrEqual(2);
  expect(saved.sort()).toEqual(["out", "yes"]);
  expect(report.variantsUpdated).toBe(2);
  expect(report.variantsFailed).toBe(4);
  expect(report.status).toBe("partial");
  expect(JSON.stringify(report)).not.toContain("credentials");
});
test("unsupported lookup and missing timestamps stay explicit", async () => {
  const persist = async () => {
    throw Error("should not persist");
  };
  expect(
    (
      await refreshSupplierInventory({
        provider: base,
        sourceId: "s",
        products: [],
        persist,
      })
    ).status,
  ).toBe("unsupported");
  expect(
    inventoryObservation("s", { sku: "S", available: true }).observedAt,
  ).toBeNull();
  expect(
    (
      await refreshSupplierInventory({
        provider: {
          ...base,
          getInventory: async () => [{ sku: "S", available: true }],
        },
        sourceId: "s",
        products: [{ externalId: "P", skus: ["S"] }],
        persist,
      })
    ).variantsFailed,
  ).toBe(1);
});
test("stock identity and timestamp survive catalog pages without fresh stock", () => {
  const old = {
    supplierStock: inventoryObservation("s", {
      sku: "S",
      available: false,
      updatedAt: now,
    }),
  };
  expect(preserveSupplierStock(old, { other: true }, "s", "S")).toEqual({
    ...old,
    other: true,
  });
  expect(preserveSupplierStock(old, {}, "s", "different")).toEqual({});
  expect(
    preserveSupplierStock(
      old,
      {
        supplierStock: {
          ...old.supplierStock,
          observedAt: "2000-01-01T00:00:00Z",
        },
      },
      "s",
      "S",
    ),
  ).toEqual(old);
});
test("persistence failure is surfaced, not counted as a supplier outage", async () => {
  await expect(
    refreshSupplierInventory({
      provider: {
        ...base,
        getInventory: async () => [
          { sku: "S", available: true, updatedAt: now },
        ],
      },
      sourceId: "s",
      products: [{ externalId: "P", skus: ["S"] }],
      persist: async () => {
        throw Error("database offline");
      },
    }),
  ).rejects.toThrow("database offline");
});
