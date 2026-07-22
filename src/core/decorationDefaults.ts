// Industry-standard decoration defaults. Placement measurements follow
// published embroidery placement charts, and the starter thread catalog is a
// common Madeira Polyneon rack — every shop starts from these and overrides
// with its own truth (⚠️ thread codes must be confirmed against the physical
// cone rack before they appear on a customer-facing spec).

import type { ZonePhysical } from "./decoration";
import type { ThreadRef } from "./threads";

const MADEIRA = "Madeira Polyneon";

/** Starter 12-cone rack (Madeira Polyneon poly). Override per shop. */
export const DEFAULT_THREAD_CATALOG: ThreadRef[] = [
  { brand: MADEIRA, code: "1800", hex: "#1a1712", name: "Black" },
  { brand: MADEIRA, code: "1801", hex: "#ffffff", name: "White" },
  { brand: MADEIRA, code: "1592", hex: "#b5862f", name: "Old Gold" },
  { brand: MADEIRA, code: "1781", hex: "#9b1c2e", name: "Cardinal" },
  { brand: MADEIRA, code: "1967", hex: "#1c3f6e", name: "Navy" },
  { brand: MADEIRA, code: "1751", hex: "#0d6e5e", name: "Kelly" },
  { brand: MADEIRA, code: "1918", hex: "#5a5346", name: "Pewter" },
  { brand: MADEIRA, code: "1839", hex: "#c0392b", name: "Red" },
  { brand: MADEIRA, code: "1624", hex: "#e0a82e", name: "Sunflower" },
  { brand: MADEIRA, code: "1922", hex: "#7048b6", name: "Purple" },
  { brand: MADEIRA, code: "1976", hex: "#4a9bd4", name: "Sky" },
  { brand: MADEIRA, code: "1921", hex: "#d6455f", name: "Rose" },
];

// Standard garment placements per industry charts (inch values are shop
// conventions that vary slightly — treat as defaults, adjust per house style).
export const STANDARD_ZONE_PHYSICALS = {
  beanieCuff: {
    anchor: "centered on the folded cuff, front of beanie",
    heightIn: 1.75,
    widthIn: 4,
  },
  capFront: {
    anchor: "centered on front panels, bottom edge ~0.5″ above brim seam",
    heightIn: 2.25,
    widthIn: 4.5,
  },
  fullBack: {
    anchor: "centered, top of design 5″ below collar seam (3″ for youth sizes)",
    code: "FB",
    heightIn: 12.5,
    widthIn: 11,
  },
  shirtFront: {
    anchor:
      "zone center at mid-chest; left-chest placement ≈ 7–9″ down from left shoulder seam, 3–5″ from center",
    code: "FF",
    heightIn: 11,
    widthIn: 9.5,
  },
  sleeve: {
    anchor: "centered on left sleeve, ~1″ above hem",
    code: "LS",
    heightIn: 3.5,
    widthIn: 3.5,
  },
  toteFront: {
    anchor: "centered on front panel, ~3″ below top seam",
    heightIn: 12,
    widthIn: 11.5,
  },
} satisfies Record<string, ZonePhysical>;

/** Typical fabric + stabilizer pairings per common blank type. */
export const DEFAULT_GARMENT_SPECS = {
  beanie: {
    backing: "none — knit hooped with wash-away topping",
    fabric: "acrylic rib knit",
  },
  cap: {
    backing: "cap buckram (built-in) — no extra stabilizer",
    fabric: "structured cotton twill, 6-panel",
  },
  tee: {
    backing: "medium cutaway, 2.5oz",
    fabric: "100% combed cotton jersey, 180gsm",
  },
  tote: {
    backing: "light tearaway, 1.8oz",
    fabric: "12oz cotton canvas",
  },
} satisfies Record<string, { fabric: string; backing: string }>;
