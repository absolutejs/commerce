import { describe, expect, it } from "bun:test";
import { priceDecoration, type DecorationRates } from "./decorationPricing";

const rates: DecorationRates = {
  digitizingFeeCents: 1500,
  embroideryMinimumCents: 500,
  embroideryPer1000StitchesCents: 100,
  flatPerPieceCents: { dtf: 700, dtg: 800, vinyl: 600 },
  flatSetupCents: { vinyl: 400 },
  rushSurchargePct: 0.25,
  screenPerColorPerPieceCents: 150,
  screenSetupPerColorCents: 1800,
};

describe("decoration pricing", () => {
  it("prices embroidery by stitch count with a per-piece floor", () => {
    // 8,000 stitches × $1/1000 = $8.00/piece; above the $5 floor.
    const quote = priceDecoration(
      {
        blankCents: 2200,
        method: "embroidery",
        quantity: 12,
        stitchCount: 8000,
      },
      rates,
    );
    expect(quote.perPieceCents).toBe(3000); // $22 blank + $8 stitch
    expect(quote.setupCents).toBe(1500); // one digitizing fee
    expect(quote.subtotalCents).toBe(3000 * 12 + 1500);
    expect(quote.rushCents).toBe(0);
  });

  it("charges a design's setup once, on the line that carries it", () => {
    const first = priceDecoration(
      {
        blankCents: 2200,
        method: "embroidery",
        quantity: 12,
        stitchCount: 8000,
      },
      rates,
    );
    // The same design on a second garment: the file is already digitized.
    const second = priceDecoration(
      {
        blankCents: 3400,
        method: "embroidery",
        quantity: 6,
        setupPaid: true,
        stitchCount: 8000,
      },
      rates,
    );
    expect(first.setupCents).toBe(1500);
    expect(second.setupCents).toBe(0);
    expect(second.subtotalCents).toBe(second.perPieceCents * 6);
    expect(
      second.breakdown.some((line) => /Digitizing/u.test(line.label)),
    ).toBe(false);
  });

  it("keeps rush honest on a line whose setup was already paid", () => {
    const quote = priceDecoration(
      {
        method: "screen-print",
        colors: 2,
        quantity: 10,
        rush: true,
        setupPaid: true,
      },
      rates,
    );
    // Rush follows the subtotal, and the subtotal no longer carries screens.
    expect(quote.setupCents).toBe(0);
    expect(quote.subtotalCents).toBe(quote.perPieceCents * 10);
    expect(quote.rushCents).toBe(Math.round(quote.subtotalCents * 0.25));
  });

  it("applies the embroidery minimum on tiny designs", () => {
    const quote = priceDecoration(
      { method: "embroidery", quantity: 1, stitchCount: 1000 },
      rates,
    );
    // $1 of stitches floors up to the $5 minimum.
    expect(quote.perPieceCents).toBe(500);
  });

  it("prices screen-print by colors × pieces, plus per-color screens", () => {
    const quote = priceDecoration(
      { blankCents: 600, colors: 3, method: "screen-print", quantity: 50 },
      rates,
    );
    expect(quote.perPieceCents).toBe(600 + 3 * 150); // $6 blank + 3×$1.50
    expect(quote.setupCents).toBe(3 * 1800); // 3 screens
  });

  it("discounts the decorated unit on volume, then adds rush on top", () => {
    const quote = priceDecoration(
      {
        blankCents: 2000,
        method: "embroidery",
        quantity: 50,
        quantityBreaks: [
          { discount: 0, min: 1 },
          { discount: 0.2, min: 50 },
        ],
        rush: true,
        stitchCount: 5000,
      },
      rates,
    );
    // unit = ($20 + $5) × 0.8 = $20.00
    expect(quote.perPieceCents).toBe(2000);
    const preRush = 2000 * 50 + 1500;
    expect(quote.subtotalCents).toBe(preRush);
    expect(quote.rushCents).toBe(Math.round(preRush * 0.25));
    expect(quote.totalCents).toBe(preRush + quote.rushCents);
  });

  it("doubles per-piece decoration across two placements", () => {
    const one = priceDecoration(
      { locations: 1, method: "dtf", quantity: 10 },
      rates,
    );
    const two = priceDecoration(
      { locations: 2, method: "dtf", quantity: 10 },
      rates,
    );
    expect(two.perPieceCents).toBe(one.perPieceCents * 2);
  });
  it("sublimation prices like the other flat methods, and reads as itself", () => {
    const quote = priceDecoration(
      { method: "sublimation", quantity: 24 },
      {
        ...rates,
        flatPerPieceCents: { ...rates.flatPerPieceCents, sublimation: 650 },
      },
    );
    expect(quote.perPieceCents).toBe(650);
    expect(quote.subtotalCents).toBe(650 * 24);
    expect(quote.breakdown.some((line) => line.label === "Sublimation")).toBe(
      true,
    );
  });

  it("a flat method reads in the shop's words, not SHOUTED", () => {
    const quote = priceDecoration(
      { method: "vinyl", quantity: 10 },
      {
        ...rates,
        flatPerPieceCents: { ...rates.flatPerPieceCents, vinyl: 600 },
      },
    );
    expect(quote.breakdown.some((line) => line.label === "Vinyl / HTV")).toBe(
      true,
    );
  });
});
