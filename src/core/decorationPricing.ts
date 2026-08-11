// Decoration pricing for custom-apparel shops: embroidery priced by stitch
// count, screen-print by colors × pieces, transfer/DTG/vinyl by a flat run
// rate — the numbers an embroidery or print shop actually quotes from. All
// money is in integer cents; the caller supplies the shop's own rate card.

import type { QuantityBreak } from "./pricing";
import { quantityDiscount } from "./pricing";

export type DecorationMethod =
  "embroidery" | "screen-print" | "dtg" | "dtf" | "vinyl";

/** A shop's editable rate card. Every field is integer cents unless noted. */
export type DecorationRates = {
  /** Embroidery run cost per 1,000 stitches, per piece. */
  embroideryPer1000StitchesCents: number;
  /** Floor charge per embroidered piece, however small the design. */
  embroideryMinimumCents: number;
  /** One-time cost to digitize art into a stitch file. */
  digitizingFeeCents: number;
  /** Screen-print: one-time screen burn, per color. */
  screenSetupPerColorCents: number;
  /** Screen-print: run cost per color, per piece. */
  screenPerColorPerPieceCents: number;
  /** Flat run cost per piece for methods priced per placement (dtg/dtf/vinyl). */
  flatPerPieceCents: Partial<Record<DecorationMethod, number>>;
  /** One-time setup for those flat methods (cut file, transfer gang, etc.). */
  flatSetupCents: Partial<Record<DecorationMethod, number>>;
  /** Rush surcharge as a fraction of the pre-rush total (e.g. 0.25 = +25%). */
  rushSurchargePct: number;
};

export type DecorationJob = {
  method: DecorationMethod;
  quantity: number;
  /** Per-piece blank cost, rolled into the priced unit so breaks discount it. */
  blankCents?: number;
  /** Embroidery: total stitches in the design. */
  stitchCount?: number;
  /** Screen-print: number of spot colors. */
  colors?: number;
  /** Placements decorated (front + back = 2). Defaults to 1. */
  locations?: number;
  rush?: boolean;
  /** Whole-unit volume breaks (garment + decoration), applied before rush. */
  quantityBreaks?: QuantityBreak[];
};

export type DecorationLine = { amountCents: number; label: string };

export type DecorationQuote = {
  /** Decorated price of one piece, after volume discount, before setup/rush. */
  perPieceCents: number;
  /** One-time charges (digitizing, screens, cut file). */
  setupCents: number;
  /** perPiece × quantity + setup, before rush. */
  subtotalCents: number;
  rushCents: number;
  totalCents: number;
  /** Human-readable line items for a quote or work order. */
  breakdown: DecorationLine[];
};

const clampQty = (quantity: number) => Math.max(1, Math.floor(quantity || 1));

/** Per-piece decoration cost (before the blank and volume discount). */
const decorationPerPieceCents = (
  job: DecorationJob,
  rates: DecorationRates,
): number => {
  const locations = Math.max(1, job.locations ?? 1);
  if (job.method === "embroidery") {
    const stitches = Math.max(0, job.stitchCount ?? 0);
    const raw = Math.round(
      (stitches / 1000) * rates.embroideryPer1000StitchesCents,
    );

    return Math.max(rates.embroideryMinimumCents, raw) * locations;
  }
  if (job.method === "screen-print") {
    const colors = Math.max(1, job.colors ?? 1);

    return colors * rates.screenPerColorPerPieceCents * locations;
  }

  return (rates.flatPerPieceCents[job.method] ?? 0) * locations;
};

/** One-time setup cost for the whole job. */
const setupCents = (job: DecorationJob, rates: DecorationRates): number => {
  const locations = Math.max(1, job.locations ?? 1);
  if (job.method === "embroidery") return rates.digitizingFeeCents * locations;
  if (job.method === "screen-print")
    return (
      Math.max(1, job.colors ?? 1) * rates.screenSetupPerColorCents * locations
    );

  return (rates.flatSetupCents[job.method] ?? 0) * locations;
};

/**
 * Price a decoration job the way a shop quotes it. Volume breaks discount the
 * decorated unit (blank + decoration); setup is charged once; rush is a
 * percentage of the discounted subtotal so it scales with the job.
 */
export const priceDecoration = (
  job: DecorationJob,
  rates: DecorationRates,
): DecorationQuote => {
  const quantity = clampQty(job.quantity);
  const blank = Math.max(0, job.blankCents ?? 0);
  const decoration = decorationPerPieceCents(job, rates);
  const discount = job.quantityBreaks
    ? quantityDiscount(job.quantityBreaks, quantity)
    : 0;
  const perPieceCents = Math.round((blank + decoration) * (1 - discount));
  const setup = setupCents(job, rates);
  const subtotalCents = perPieceCents * quantity + setup;
  const rushCents = job.rush
    ? Math.round(subtotalCents * rates.rushSurchargePct)
    : 0;

  const breakdown: DecorationLine[] = [];
  if (blank > 0)
    breakdown.push({ amountCents: blank * quantity, label: "Garments" });
  breakdown.push({
    amountCents: decoration * quantity,
    label:
      job.method === "embroidery"
        ? `Embroidery — ${(job.stitchCount ?? 0).toLocaleString()} stitches`
        : job.method === "screen-print"
          ? `Screen print — ${Math.max(1, job.colors ?? 1)} color${(job.colors ?? 1) === 1 ? "" : "s"}`
          : `${job.method.toUpperCase()} print`,
  });
  if (discount > 0)
    breakdown.push({
      amountCents: -Math.round((blank + decoration) * quantity * discount),
      label: `Volume discount (${Math.round(discount * 100)}%)`,
    });
  if (setup > 0)
    breakdown.push({
      amountCents: setup,
      label:
        job.method === "embroidery"
          ? "Digitizing (one time)"
          : job.method === "screen-print"
            ? "Screen setup (one time)"
            : "Setup (one time)",
    });
  if (rushCents > 0) breakdown.push({ amountCents: rushCents, label: "Rush" });

  return {
    breakdown,
    perPieceCents,
    rushCents,
    setupCents: setup,
    subtotalCents,
    totalCents: subtotalCents + rushCents,
  };
};
