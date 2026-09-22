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

test("one fresh snapshot per run preserves explicit zeroes, timestamps and ambiguous failures", async () => {
  let requests = 0;
  const provider: CatalogSourceProvider = {
    ...base,
    getCatalogInventory: async () => {
      requests++;
      return [
        {
          externalId: "P",
          levels: [
            { sku: "retired", available: false, updatedAt: now },
            { sku: "duplicate", available: true, updatedAt: now },
            { sku: "duplicate", available: false, updatedAt: now },
            { sku: "undated", available: true },
          ],
        },
        {
          externalId: "Q",
          levels: [{ sku: "live", available: true, updatedAt: now }],
        },
      ];
    },
    getProductInventory: async () => {
      throw Error("snapshot must take precedence");
    },
  };
  const input = {
    provider,
    sourceId: "s",
    products: [
      { externalId: "P", skus: ["retired", "duplicate", "undated", "missing"] },
      { externalId: "Q", skus: ["live"] },
    ],
    persist: async (
      _id: string,
      stocks: {
        observedAt: string | null;
        available: boolean | null;
        supplierSku: string;
      }[],
    ) => {
      for (const stock of stocks) {
        expect(stock.observedAt).toBe(now);
        expect(stock.available).toBe(stock.supplierSku !== "retired");
      }
    },
  };
  expect(await refreshSupplierInventory(input)).toMatchObject({
    variantsUpdated: 2,
    variantsFailed: 3,
    status: "partial",
  });
  expect(requests).toBe(1);
  await refreshSupplierInventory(input);
  expect(requests).toBe(2);
});

test("failed full snapshot never persists a partial successful page", async () => {
  let writes = 0;
  await expect(
    refreshSupplierInventory({
      provider: {
        ...base,
        getCatalogInventory: async () => {
          throw Error("snapshot failed");
        },
      },
      sourceId: "s",
      products: [{ externalId: "p", skus: ["s"] }],
      persist: async () => {
        writes++;
      },
    }),
  ).rejects.toThrow("snapshot failed");
  expect(writes).toBe(0);
});
