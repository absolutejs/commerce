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
});
