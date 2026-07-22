// Digital → physical decoration specs. Converts a customer's configured
// design into the numbers a real operator needs: design dimensions, placement
// measurements from garment landmarks, thread color sequence (brand + catalog
// code), stitch estimates, per-1k-stitch pricing, print validation
// (DPI-at-size, separations, underbase), and printable work-order sheets.
//
// Everything is data-in: the app resolves its own product/method catalogs and
// hands plain inputs — no shop-specific lookups live here.

import {
  hexToRgb,
  nearestPantone,
  pantoneMatchQuality,
  type PantoneMatch,
  type ThreadRef,
} from "./threads";

export type EmbroideryType = "flat" | "puff";

/** Real-world size of a decoration zone + the landmark it's measured from. */
export type ZonePhysical = {
  widthIn: number;
  heightIn: number;
  /** Where the zone center sits, e.g. "5″ below collar seam, centered". */
  anchor: string;
  /** Shop shorthand for the zone (FF, FB, LS…) — see PLACEMENT_CODE_NAMES. */
  code?: string;
};

/** A decoratable region: 3D size (scene units) + physical size (inches). */
export type DecorationZoneSpec = {
  id: string;
  label: string;
  size: [number, number];
  physical: ZonePhysical;
};

export type PlacementTransform = {
  offsetX: number;
  offsetY: number;
  rotation: number;
  scale: number;
};

/** One dominant art color and its share of the covered pixels. */
export type ArtPaletteEntry = { hex: string; share: number };

/** Source-art facts for print-method validation (DPI, separations, inks). */
export type ArtFacts = {
  pixelWidth: number;
  isVector: boolean;
  colorCount: number;
  /** Dominant colors (largest share first) — drives ink PMS references. */
  palette?: ArtPaletteEntry[];
  /** SVG contains live <text> — fonts must be outlined before production. */
  svgLiveText?: boolean;
};

const MM_PER_INCH = 25.4;
/** Fill-stitch density heuristic (~2.8 stitches per mm² of covered area). */
const STITCHES_PER_MM2 = 2.8;
/** Round stitch estimates to the nearest hundred — a quote, not a count. */
const STITCH_ROUND = 100;

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

// Mirrors the 3D decal fit: design fits inside the zone preserving aspect,
// then scales by the customer's size setting.
export const fitDesignIn = (
  zone: DecorationZoneSpec,
  aspect: number,
  scale: number,
) => {
  const [zoneW, zoneH] = zone.size;
  let width = zoneW;
  let height = zoneW / aspect;
  if (height > zoneH) {
    height = zoneH;
    width = zoneH * aspect;
  }
  const factor = clamp(scale, 0.2, 1);

  return { height: height * factor, width: width * factor };
};

export type DesignDimensions = {
  widthIn: number;
  heightIn: number;
  widthMm: number;
  heightMm: number;
  /** Offset of design center from zone center, inches (right/up positive). */
  offsetXIn: number;
  offsetYIn: number;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

export const designDimensions = (
  zone: DecorationZoneSpec,
  aspect: number,
  scale: number,
  offsetX: number,
  offsetY: number,
): DesignDimensions => {
  const fit = fitDesignIn(zone, aspect, scale);
  const inchesPerUnitX = zone.physical.widthIn / zone.size[0];
  const inchesPerUnitY = zone.physical.heightIn / zone.size[1];
  const widthIn = fit.width * inchesPerUnitX;
  const heightIn = fit.height * inchesPerUnitY;

  return {
    heightIn: round1(heightIn),
    heightMm: Math.round(heightIn * MM_PER_INCH),
    offsetXIn: round1(offsetX * inchesPerUnitX),
    offsetYIn: round1(offsetY * inchesPerUnitY),
    widthIn: round1(widthIn),
    widthMm: Math.round(widthIn * MM_PER_INCH),
  };
};

/**
 * Coverage-based stitch estimate for quoting. Real counts come from
 * digitizing — this mirrors how estimator tools quote from raw art.
 */
export const estimateStitches = (
  dims: Pick<DesignDimensions, "widthMm" | "heightMm">,
  coverage: number,
) => {
  const area = dims.widthMm * dims.heightMm * clamp(coverage, 0.02, 1);
  const raw = area * STITCHES_PER_MM2;

  return Math.max(STITCH_ROUND, Math.round(raw / STITCH_ROUND) * STITCH_ROUND);
};

export const formatInches = (dims: DesignDimensions) =>
  `${dims.widthIn}″ × ${dims.heightIn}″`;

export const formatStitches = (count: number) =>
  count >= 1000
    ? `~${(count / 1000).toFixed(1).replace(/\.0$/, "")}k stitches`
    : `~${count} stitches`;

/* -------------------------- per-1k-stitch pricing ------------------------- */

export type EmbroideryRates = {
  /** Handling base per piece. */
  base: number;
  /** Price per 1,000 estimated stitches. */
  per1k: number;
};

export const DEFAULT_EMBROIDERY_RATES: EmbroideryRates = {
  base: 3,
  per1k: 0.5,
};

/** Per-piece embroidery price for an estimated stitch count. */
export const embroideryUnitPrice = (
  estimatedStitches: number,
  rates: EmbroideryRates = DEFAULT_EMBROIDERY_RATES,
) => rates.base + (rates.per1k * estimatedStitches) / 1000;

/** Coarse tier from the physical design size (widest edge), for labeling. */
export const stitchTierFor = (
  dims: Pick<DesignDimensions, "widthIn" | "heightIn">,
) => {
  const edge = Math.max(dims.widthIn, dims.heightIn);
  if (edge <= 4) return "left-chest" as const;
  if (edge <= 7) return "standard" as const;

  return "large" as const;
};

type EstimateInput = {
  zone: DecorationZoneSpec;
  aspect: number;
  coverage: number;
  transform: { offsetX: number; offsetY: number; scale: number };
};

/** Dimensions + stitch estimate for one placement (pricing + specs). */
export const placementEstimate = ({
  zone,
  aspect,
  coverage,
  transform,
}: EstimateInput) => {
  const dims = designDimensions(
    zone,
    aspect,
    transform.scale,
    transform.offsetX,
    transform.offsetY,
  );

  return { dims, stitches: estimateStitches(dims, coverage) };
};

/* ------------------------------ hoop sizing ------------------------------ */

type Hoop = { name: string; maxIn: number };

// Common commercial round hoops + rectangular frames; a design needs ~1″ of
// stabilizer margin. Full backs run in one hooping on a rectangular frame.
const HOOPS: Hoop[] = [
  { maxIn: 2.5, name: "9cm (3.5″) round" },
  { maxIn: 3.7, name: "12cm (4.7″) round" },
  { maxIn: 4.9, name: "15cm (5.9″) round" },
  { maxIn: 6, name: "18cm (7″) round" },
  { maxIn: 8.4, name: "24cm (9.4″) round" },
  { maxIn: 10.8, name: "30cm (11.8″) round" },
  { maxIn: 13.2, name: "36×30cm (14.2×11.8″) rectangular frame" },
];

/** Smallest round hoop that fits the design with margin. */
export const suggestHoop = (
  dims: Pick<DesignDimensions, "widthIn" | "heightIn">,
) => {
  const edge = Math.max(dims.widthIn, dims.heightIn);
  const hoop = HOOPS.find((entry) => edge <= entry.maxIn);

  return hoop ? hoop.name : "Split into multiple hoopings (oversize)";
};

/* --------------------------- print-method specs --------------------------- */

/** An ink to mix/load: dominant art color → nearest Pantone Solid Coated. */
export type InkColor = {
  hex: string;
  /** Fraction of covered art pixels this ink accounts for. */
  share: number;
  /** Nearest PMS reference (screen approximation), e.g. "PMS 186 C". */
  pms: string | null;
  pmsHex: string | null;
  pmsMatch: "exact" | "close" | "approximate" | null;
};

/** Screen-print press facts: screens, mesh, halftones, ink system, order. */
export type ScreenPrintFacts = {
  inks: InkColor[];
  underbase: boolean;
  /** Underbase gets flash-cured before colors print wet-on-dry on top. */
  flashAfterUnderbase: boolean;
  meshUnderbase: string | null;
  meshColors: string;
  /** Raster art past the spot limit runs as halftones/simulated process. */
  halftones: boolean;
  lpi: number | null;
  halftoneAngleDeg: number | null;
  inkSystem: string;
  inkSystemNote: string | null;
  /** Screen order on press: underbase → flash → colors light-to-dark. */
  printOrder: string[];
  /** Final cure — under-cured plastisol passes visual QC, fails in the wash. */
  cureSpec: string;
};

/** DTG press facts: pretreat, white ink, substrate suitability, cure. */
export type DtgFacts = {
  /** Dark garments are pretreated so the white underbase sits on top. */
  pretreat: boolean;
  whiteInk: boolean;
  colorProfile: "sRGB";
  fabricNote: string | null;
  /** Pretreat dry + post-print cure — DTG ink is wet until cured. */
  cureSpec: string;
};

/** Cut-vinyl / HTV facts: mirror, layers, material, press, weeding limits. */
export type VinylFacts = {
  /** HTV cuts from the adhesive back — always mirrored. */
  mirror: boolean;
  /** One cut + one press per color, applied bottom-up. */
  layers: InkColor[];
  material: string;
  pressSpec: string;
  minDetail: string;
};

/** DTF transfer facts: mirrored film print, white behind CMYK, press. */
export type DtfFacts = {
  mirror: boolean;
  whiteUnderbase: boolean;
  pressSpec: string;
  /** Gang-sheet convention for the film run. */
  filmNote: string;
};

/** Sublimation facts: poly/light-garment gates, mirrored transfer, press. */
export type SublimationFacts = {
  mirror: boolean;
  /** Dye only bonds to polyester (≥65%, 100% ideal). */
  polyOk: boolean;
  /** No white sublimation ink — white areas = garment color. */
  lightGarment: boolean;
  pressSpec: string;
};

/** Print-method production facts (screen / DTG / vinyl / DTF / sublimation). */
export type PrintSpec = {
  /** Effective raster DPI at the printed size (null for vector art). */
  dpiAtSize: number | null;
  isVector: boolean;
  /** Distinct spot colors detected in the art. */
  colorCount: number;
  /** Screen count for screen print (colors + underbase screen). */
  screens: number | null;
  /** Light ink on a dark garment needs an underbase (screen print). */
  underbase: boolean;
  /** Dominant art colors with nearest-PMS references (all print methods). */
  inks: InkColor[];
  screenPrint: ScreenPrintFacts | null;
  dtg: DtgFacts | null;
  vinyl: VinylFacts | null;
  dtf: DtfFacts | null;
  sublimation: SublimationFacts | null;
  warnings: string[];
};

/** DTG/raster quality bar: 300 DPI ideal, under 150 visibly degrades. */
const DPI_GOOD = 300;
const DPI_MIN = 150;
/** Screen-print economics degrade past this many spot colors. */
const MAX_SPOT_COLORS = 6;
/** Practical HTV layering limit — more cooks layer 1 under repeated presses. */
const MAX_VINYL_LAYERS = 3;
/** Garment halftones: 45 LPI sweet spot, one angle for every screen. */
const HALFTONE_LPI = 45;
/** 22.5° keeps halftone dots off the mesh-thread axes (moiré). */
const HALFTONE_ANGLE_DEG = 22.5;
/** Mesh picks per supplier charts; halftone mesh ≈ 4.5–5× LPI. */
const MESH_UNDERBASE = "110–156 (110 = one-pass white)";
const MESH_SPOT = "156–200 (230+ for fine detail)";
const MESH_HALFTONE = "230–305 (≈4.5–5× LPI)";
/** Substrate heuristics from the garment fabric description. */
const COTTON_FABRIC = /\bcotton|canvas|denim\b/i;
const SYNTHETIC_FABRIC = /\bpoly(?:ester)?|acrylic|nylon\b/i;

const luminance = (hex: string) => {
  const [red, green, blue] = hexToRgb(hex);

  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
};

/** Dark garments need underbase/pretreat — shared with app-side pricing. */
export const garmentIsDark = (hex: string) => luminance(hex) < 0.45;

const inkColors = (facts: ArtFacts): InkColor[] =>
  (facts.palette ?? []).map((entry) => {
    const match = nearestPantone(entry.hex);

    return {
      hex: entry.hex,
      pms: match?.code ?? null,
      pmsHex: match?.hex ?? null,
      pmsMatch: match ? pantoneMatchQuality(match.distanceRgb) : null,
      share: entry.share,
    };
  });

const inkLabel = (ink: InkColor) => ink.pms ?? ink.hex;

const screenPrintFacts = (
  facts: ArtFacts,
  inks: InkColor[],
  underbase: boolean,
  darkGarment: boolean,
  fabric: string,
): ScreenPrintFacts => {
  const halftones = !facts.isVector && facts.colorCount > MAX_SPOT_COLORS;
  const cotton = COTTON_FABRIC.test(fabric) && !SYNTHETIC_FABRIC.test(fabric);
  // Colors print light-to-dark on press (wet-on-wet trapping).
  const ordered = [...inks].sort((a, b) => luminance(b.hex) - luminance(a.hex));
  const printOrder = [
    ...(underbase ? ["White underbase", "Flash cure"] : []),
    ...ordered.map(inkLabel),
  ];

  return {
    cureSpec:
      "plastisol full cure ≈320°F ink-film temp on the conveyor — verify with temp strips/donut probe; under-cure fails in the wash",
    flashAfterUnderbase: underbase,
    halftoneAngleDeg: halftones ? HALFTONE_ANGLE_DEG : null,
    halftones,
    inkSystem: "plastisol",
    inkSystemNote:
      cotton && darkGarment
        ? "discharge candidate (100% cotton, dark garment) — test the dye lot; royal/purple/forest discharge unpredictably; discharge/water-based cure needs forced air + longer dwell"
        : cotton
          ? "water-based candidate for a softer hand (light cotton garment, higher mesh, forced-air cure with longer dwell)"
          : null,
    inks,
    lpi: halftones ? HALFTONE_LPI : null,
    meshColors: halftones ? MESH_HALFTONE : MESH_SPOT,
    meshUnderbase: underbase ? MESH_UNDERBASE : null,
    printOrder,
    underbase,
  };
};

const dtgFacts = (darkGarment: boolean, fabric: string): DtgFacts => ({
  colorProfile: "sRGB",
  cureSpec: `${darkGarment ? "press pretreat dry (~330°F 15s, cover sheet) before printing · " : ""}post-print cure: heat press ~330°F 90–120s or tunnel equivalent`,
  fabricNote: SYNTHETIC_FABRIC.test(fabric)
    ? `"${fabric}" is synthetic — needs poly pretreat + low-temp cure (≤285°F) or dye migrates; DTF is the safer method`
    : null,
  pretreat: darkGarment,
  whiteInk: darkGarment,
});

const vinylFacts = (inks: InkColor[]): VinylFacts => ({
  layers: inks,
  material: "PU HTV (e.g. Siser EasyWeed) unless order specifies otherwise",
  minDetail: "strokes ≥ 1mm (~3pt) — thinner breaks during weeding; text ≥ 8pt",
  mirror: true,
  pressSpec:
    "305°F / 150°C · 10–15s · medium pressure · peel per material datasheet (EasyWeed: hot or cold)",
});

const dtfFacts = (): DtfFacts => ({
  filmNote:
    "gang onto 22″ film, ~0.5″ gaps · CMYK then white ink layer · adhesive powder cured ~250–300°F 2–3 min before transfer",
  mirror: true,
  pressSpec: "300–325°F · 10–15s · medium pressure · + 5–10s post-press",
  whiteUnderbase: true,
});

const sublimationFacts = (
  darkGarment: boolean,
  fabric: string,
): SublimationFacts => ({
  lightGarment: !darkGarment,
  mirror: true,
  polyOk: SYNTHETIC_FABRIC.test(fabric),
  pressSpec: "385–400°F · 45–60s · medium pressure",
});

// Print-method validation the shop would otherwise do by eye: DPI at the
// actual printed size, separation counts, underbase need, per-method press
// facts (mesh/LPI, pretreat, mirror/layers, film, poly gates).
export const buildPrintSpec = (
  method: string,
  art: ArtFacts | undefined,
  dims: DesignDimensions,
  garmentHex: string,
  fabric = "",
): PrintSpec | null => {
  if (method === "embroidery") return null;
  const facts = art ?? { colorCount: 1, isVector: false, pixelWidth: 0 };
  const dpiAtSize =
    facts.isVector || !facts.pixelWidth || dims.widthIn <= 0
      ? null
      : Math.round(facts.pixelWidth / dims.widthIn);
  const darkGarment = garmentIsDark(garmentHex);
  const underbase = method === "screen-print" && darkGarment;
  const screens =
    method === "screen-print" ? facts.colorCount + (underbase ? 1 : 0) : null;
  const inks = inkColors(facts);
  const screenPrint =
    method === "screen-print"
      ? screenPrintFacts(facts, inks, underbase, darkGarment, fabric)
      : null;
  const dtg = method === "dtg" ? dtgFacts(darkGarment, fabric) : null;
  const vinyl = method === "vinyl" ? vinylFacts(inks) : null;
  const dtf = method === "dtf" ? dtfFacts() : null;
  const sublimation =
    method === "sublimation" ? sublimationFacts(darkGarment, fabric) : null;

  const warnings: string[] = [];
  if (dpiAtSize !== null && dpiAtSize < DPI_MIN)
    warnings.push(
      `Low resolution: ${dpiAtSize} DPI at print size (${DPI_GOOD} recommended) — request larger art or shrink the print.`,
    );
  else if (dpiAtSize !== null && dpiAtSize < DPI_GOOD && method === "dtg")
    warnings.push(
      `${dpiAtSize} DPI at print size — acceptable, ${DPI_GOOD} recommended for DTG.`,
    );
  if (method === "screen-print" && facts.colorCount > MAX_SPOT_COLORS)
    warnings.push(
      screenPrint?.halftones
        ? `${facts.colorCount} colors in raster art — run as halftones/simulated process (${HALFTONE_LPI} LPI @ ${HALFTONE_ANGLE_DEG}°, ${MESH_HALFTONE} mesh) or switch to DTG/DTF.`
        : `${facts.colorCount} spot colors → ${screens} screens — consider DTG/DTF or simplifying the art.`,
    );
  if (method === "dtg" && dtg?.fabricNote) warnings.push(dtg.fabricNote);
  if (method === "vinyl" && facts.colorCount > MAX_VINYL_LAYERS)
    warnings.push(
      `Vinyl layers cap at ~${MAX_VINYL_LAYERS} (repeated pressing scorches layer 1) — ${facts.colorCount} colors detected; use knockout/inlay layering or move to DTF.`,
    );
  else if (method === "vinyl" && facts.colorCount > 2)
    warnings.push(
      `Vinyl cuts solid colors — ${facts.colorCount} colors = ${facts.colorCount} cut layers, pressed bottom-up.`,
    );
  if (method === "vinyl" && !facts.isVector)
    warnings.push(
      "Vinyl needs a cut path — raster art must be vectorized before cutting.",
    );
  if (facts.svgLiveText)
    warnings.push(
      "SVG contains live text — outline/convert fonts to paths before production or the output machine substitutes fonts.",
    );
  if (method === "sublimation" && sublimation && !sublimation.polyOk)
    warnings.push(
      `Sublimation dye only bonds to polyester (≥65%, 100% ideal) — "${fabric || "unknown fabric"}" won't hold the print.`,
    );
  if (method === "sublimation" && darkGarment)
    warnings.push(
      "Sublimation has no white ink — dark garments swallow the print; use white/light poly garments.",
    );

  return {
    colorCount: facts.colorCount,
    dpiAtSize,
    dtf,
    dtg,
    inks,
    isVector: facts.isVector,
    screenPrint,
    screens,
    sublimation,
    underbase,
    vinyl,
    warnings,
  };
};

/* ----------------------------- placement codes ---------------------------- */

/** Shop shorthand → spoken name. Always print both — the codes are
 * ubiquitous decorator convention, not a governed standard. */
export const PLACEMENT_CODE_NAMES: Record<string, string> = {
  CB: "Center back",
  CF: "Center front",
  FB: "Full back",
  FF: "Full front",
  LC: "Left chest",
  LS: "Left sleeve",
  NP: "Nape / back yoke",
  RC: "Right chest",
  RS: "Right sleeve",
};

/**
 * Placement code for a design: the zone's code, refined to LC/RC when a
 * small design sits off-center on a full-front zone (+X = wearer's left).
 */
export const placementCode = (
  zone: DecorationZoneSpec,
  dims: DesignDimensions,
) => {
  const base = zone.physical.code ?? null;
  if (base !== "FF" || dims.widthIn > 4.5) return base;
  if (dims.offsetXIn >= 1) return "LC";
  if (dims.offsetXIn <= -1) return "RC";

  return base;
};

export const placementCodeLabel = (code: string | null) =>
  code ? `${code} — ${PLACEMENT_CODE_NAMES[code] ?? code}` : null;

/* ------------------------------- gang sheets ------------------------------ */

export type GangSheetPlan = {
  filmWidthIn: number;
  /** Linear film length to order/print, inches (rounded up). */
  lengthIn: number;
  pieces: number;
  rows: number;
  /** Printed-area fraction of the film used (0–1). */
  utilization: number;
};

/**
 * Shelf-pack DTF designs onto a film roll (22″ standard width, gaps between
 * pieces). Row-based packing — a slight overestimate, which is the right
 * direction for ordering film.
 */
export const gangSheetPlan = (
  designs: { widthIn: number; heightIn: number; count: number }[],
  filmWidthIn = 22,
  gapIn = 0.5,
): GangSheetPlan => {
  const pieces = designs
    .flatMap((design) =>
      Array.from({ length: Math.max(1, design.count) }, () => design),
    )
    .sort((a, b) => b.heightIn - a.heightIn);
  let rows = 0;
  let lengthIn = 0;
  let rowWidth = filmWidthIn;
  let printedArea = 0;
  pieces.forEach((piece) => {
    const width = piece.widthIn + gapIn;
    if (rowWidth + width > filmWidthIn) {
      rows += 1;
      rowWidth = 0;
      lengthIn += piece.heightIn + gapIn;
    }
    rowWidth += width;
    printedArea += piece.widthIn * piece.heightIn;
  });
  const totalLength = Math.ceil(lengthIn);

  return {
    filmWidthIn,
    lengthIn: totalLength,
    pieces: pieces.length,
    rows,
    utilization:
      totalLength > 0
        ? Math.min(1, printedArea / (totalLength * filmWidthIn))
        : 0,
  };
};

/* ------------------------------ order spec ------------------------------ */

export type PlacementSpec = {
  zoneId: string;
  zoneLabel: string;
  /** Decorator shorthand for the spot (LC, FB…), when derivable. */
  code: string | null;
  artwork: string;
  artworkUrl: string | null;
  anchor: string;
  dimensions: DesignDimensions;
  rotationDeg: number;
  embroideryType: EmbroideryType;
  stitchTier: string | null;
  estimatedStitches: number | null;
  threads: ThreadRef[];
  hoop: string | null;
  note: string | null;
  pantone: PantoneMatch | null;
  /** Raw brand-color request for print methods, e.g. "PMS 186 C". */
  pmsRequest: string | null;
  print: PrintSpec | null;
};

export type ItemSpec = {
  product: string;
  productId: string;
  method: string;
  methodLabel: string;
  garmentColor: { name: string; hex: string };
  size: string;
  quantity: number;
  names: string[];
  fabric: string;
  backing: string;
  placements: PlacementSpec[];
};

/** Ground truth read from the digitized machine file (vs our estimates). */
export type MachineFileFacts = {
  stitches: number;
  colorChanges: number;
  widthMm: number;
  heightMm: number;
  label: string;
  filename: string;
  /** Which uploaded artwork this file was digitized from (multi-design orders). */
  artworkUrl?: string | null;
};

export type OrderProductionSpec = {
  version: 1;
  generatedAt: string;
  items: ItemSpec[];
  notes: string[];
  /** Legacy single-file slot — read when machineFiles is absent. */
  machineFile?: MachineFileFacts;
  /** Parsed machine files, one per digitized design (keyed by artworkUrl). */
  machineFiles?: MachineFileFacts[];
};

/** All parsed machine files on a spec (legacy single slot included). */
export const specMachineFiles = (spec: OrderProductionSpec) =>
  spec.machineFiles ?? (spec.machineFile ? [spec.machineFile] : []);

/** The machine file digitized from a placement's artwork, if attached. */
export const machineFileFor = (
  spec: OrderProductionSpec,
  place: Pick<PlacementSpec, "artworkUrl">,
) => {
  const files = specMachineFiles(spec);

  return (
    files.find(
      (file) => file.artworkUrl && file.artworkUrl === place.artworkUrl,
    ) ?? (files.length === 1 ? files[0] : undefined)
  );
};

/** Total estimated stitches across all embroidery placements. */
export const totalEstimatedStitches = (spec: OrderProductionSpec) =>
  spec.items
    .flatMap((item) => item.placements)
    .reduce((sum, place) => sum + (place.estimatedStitches ?? 0), 0);

/* ------------------------- data-in spec building ------------------------- */

export type DecorationPlacementInput = {
  zone: DecorationZoneSpec;
  zoneId: string;
  zoneLabel: string;
  artwork: string;
  artworkUrl: string | null;
  transform?: PlacementTransform;
  aspect?: number;
  coverage?: number;
  threads?: ThreadRef[];
  embroideryType?: EmbroideryType;
  note?: string;
  pantone?: PantoneMatch | null;
  /** Customer's brand-color callout for print methods ("PMS 186 C"). */
  pmsRequest?: string | null;
  art?: ArtFacts;
  /** App-resolved tier label (e.g. "Left chest"); null for print methods. */
  stitchTierLabel?: string | null;
  /** Override the round-hoop suggestion (e.g. "Cap frame"). */
  hoopOverride?: string;
};

export type DecorationItemInput = {
  product: string;
  productId: string;
  method: string;
  methodLabel: string;
  usesStitchSize: boolean;
  garmentColor: { name: string; hex: string };
  size: string;
  quantity: number;
  names: string[];
  fabric: string;
  backing: string;
  placements: DecorationPlacementInput[];
};

const DEG = 180 / Math.PI;

const IDENTITY: PlacementTransform = {
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  scale: 1,
};

const placementSpec = (
  item: DecorationItemInput,
  place: DecorationPlacementInput,
): PlacementSpec => {
  const transform = place.transform ?? IDENTITY;
  const dims = designDimensions(
    place.zone,
    place.aspect ?? 1,
    transform.scale,
    transform.offsetX,
    transform.offsetY,
  );

  return {
    anchor: place.zone.physical.anchor,
    artwork: place.artwork,
    artworkUrl: place.artworkUrl,
    code: placementCode(place.zone, dims),
    dimensions: dims,
    embroideryType: place.embroideryType ?? "flat",
    estimatedStitches: item.usesStitchSize
      ? estimateStitches(dims, place.coverage ?? 0.4)
      : null,
    hoop: item.usesStitchSize
      ? (place.hoopOverride ?? suggestHoop(dims))
      : null,
    note: place.note ?? null,
    pantone: place.pantone ?? null,
    pmsRequest: place.pmsRequest ?? null,
    print: buildPrintSpec(
      item.method,
      place.art,
      dims,
      item.garmentColor.hex,
      item.fabric,
    ),
    rotationDeg: Math.round(transform.rotation * DEG),
    stitchTier: item.usesStitchSize ? (place.stitchTierLabel ?? null) : null,
    // Thread cones are an embroidery concept — print methods speak inks.
    threads: item.usesStitchSize ? (place.threads ?? []) : [],
    zoneId: place.zoneId,
    zoneLabel: place.zoneLabel,
  };
};

const EMBROIDERY_NOTES = [
  "Stitch counts are quoting estimates — final counts come from digitizing.",
  "DST/EXP machine files carry no thread colors; pull cones from the thread sequence below.",
  "Thread codes must match the cones on the rack — confirm brand/line before running.",
];

const PRINT_NOTES = [
  "Ink PMS references are nearest-match screen approximations — confirm against the Pantone formula guide before mixing.",
  "Min print detail: lines ≥ 1pt (0.014″), text ≥ 8pt, knockout detail ≥ 2pt.",
];

export const buildOrderProductionSpec = (
  items: DecorationItemInput[],
  generatedAt: string,
): OrderProductionSpec => {
  const hasEmbroidery = items.some((item) => item.method === "embroidery");
  const hasPrint = items.some((item) => item.method !== "embroidery");

  return {
    generatedAt,
    items: items.map((item) => ({
      backing: item.backing,
      fabric: item.fabric,
      garmentColor: item.garmentColor,
      method: item.method,
      methodLabel: item.methodLabel,
      names: item.names,
      placements: item.placements.map((place) => placementSpec(item, place)),
      product: item.product,
      productId: item.productId,
      quantity: item.quantity,
      size: item.size,
    })),
    notes: [
      ...(hasEmbroidery ? EMBROIDERY_NOTES : []),
      ...(hasPrint ? PRINT_NOTES : []),
      "Placement measurements assume adult sizing — adjust per the size column (youth back placement: 3″ below collar).",
      "Placement tolerance ±0.25″ unless the order notes say otherwise.",
    ],
    version: 1,
  };
};

/* -------------------------- text sheet renderers ------------------------- */

const placementSequenceLines = (item: ItemSpec, place: PlacementSpec) => {
  const header = `${item.product} — ${place.zoneLabel} (${item.garmentColor.name} garment, ${item.methodLabel})`;
  const threadLines =
    place.threads.length === 0
      ? ["  (no thread data — assign at digitizing)"]
      : place.threads.map(
          (thread, index) =>
            `  Needle ${index + 1}: ${thread.brand} ${thread.code} — ${thread.name} (${thread.hex})`,
        );

  return [header, ...threadLines, ""];
};

// Operator-facing color sequence: DST files have color-change stops only, so
// this sheet is what tells the operator which cone goes on which needle.
// Print-method items are excluded — their colors are inks, not cones.
export const threadSequenceText = (spec: OrderProductionSpec) => {
  const embroidery = spec.items.filter((item) => item.method === "embroidery");
  const lines = [
    "THREAD COLOR SEQUENCE",
    "=====================",
    "Machine files (DST/EXP) do not carry color. This is a PROVISIONAL cone",
    "list from the art colors — confirm the final sequence against the",
    "digitizer's color stops before running.",
    "",
    ...(embroidery.length === 0
      ? ["(no embroidery items on this order)"]
      : embroidery.flatMap((item) =>
          item.placements.flatMap((place) =>
            placementSequenceLines(item, place),
          ),
        )),
  ];

  return lines.join("\n");
};

/* --------------------------- print production sheet ----------------------- */

const inkLine = (ink: InkColor, index: number) => {
  const pms = ink.pms
    ? `${ink.pms} (${ink.hex}${ink.pmsMatch && ink.pmsMatch !== "exact" ? `, ${ink.pmsMatch} match` : ""})`
    : ink.hex;

  return `  Ink ${index + 1}: ${pms} — ${Math.round(ink.share * 100)}% of art`;
};

const screenPrintLines = (print: PrintSpec) => {
  const facts = print.screenPrint;
  if (!facts) return [];

  return [
    ...facts.inks.map(inkLine),
    `  Screens: ${print.screens}${facts.underbase ? " (incl. white underbase)" : ""} · mesh: colors ${facts.meshColors}${facts.meshUnderbase ? ` · underbase ${facts.meshUnderbase}` : ""}`,
    ...(facts.halftones
      ? [
          `  Halftones: ${facts.lpi} LPI @ ${facts.halftoneAngleDeg}° (all screens same angle)`,
          `  Films: output positives at ${facts.lpi} LPI / ${facts.halftoneAngleDeg}° with registration marks`,
        ]
      : []),
    `  Ink system: ${facts.inkSystem}${facts.inkSystemNote ? ` — ${facts.inkSystemNote}` : ""}`,
    `  Print order: ${facts.printOrder.join(" → ")}`,
    ...(facts.cureSpec ? [`  Cure: ${facts.cureSpec}`] : []),
  ];
};

const dtgLines = (print: PrintSpec) => {
  const facts = print.dtg;
  if (!facts) return [];

  return [
    `  ${facts.pretreat ? "PRETREAT + white underbase (dark garment)" : "No pretreat (light garment, no white ink)"}`,
    `  Color profile: ${facts.colorProfile} · ${DPI_GOOD} DPI target at print size`,
    ...(facts.cureSpec ? [`  Cure: ${facts.cureSpec}`] : []),
    ...(facts.fabricNote ? [`  ⚠ ${facts.fabricNote}`] : []),
  ];
};

const vinylLines = (print: PrintSpec) => {
  const facts = print.vinyl;
  if (!facts) return [];

  return [
    "  Cut MIRRORED (HTV cuts from the adhesive back)",
    `  Layers (press bottom-up, one per color): ${facts.layers.length === 0 ? "1" : facts.layers.map(inkLabel).join(" → ")}`,
    `  Material: ${facts.material}`,
    `  Press: ${facts.pressSpec}`,
    `  Min detail: ${facts.minDetail}`,
  ];
};

const dtfLines = (print: PrintSpec, item: ItemSpec, place: PlacementSpec) => {
  const facts = print.dtf;
  if (!facts) return [];
  const plan = gangSheetPlan([
    {
      count: item.quantity,
      heightIn: place.dimensions.heightIn,
      widthIn: place.dimensions.widthIn,
    },
  ]);

  return [
    "  Print MIRRORED on film · white ink behind CMYK",
    `  Film: ${facts.filmNote}`,
    `  Gang sheet: ${plan.pieces} pcs ≈ ${plan.lengthIn}″ of ${plan.filmWidthIn}″ film (${Math.round(plan.utilization * 100)}% used)`,
    `  Press: ${facts.pressSpec}`,
  ];
};

const sublimationLines = (print: PrintSpec) => {
  const facts = print.sublimation;
  if (!facts) return [];

  return [
    "  Print MIRRORED on transfer paper · no white ink (white = garment)",
    `  Substrate: ${facts.polyOk ? "poly OK" : "⚠ NOT poly — will not hold dye"} · ${facts.lightGarment ? "light garment OK" : "⚠ dark garment"}`,
    `  Press: ${facts.pressSpec}`,
  ];
};

const printPlacementLines = (item: ItemSpec, place: PlacementSpec) => {
  const { print } = place;
  if (!print) return [];
  const dims = place.dimensions;
  const codeLabel = placementCodeLabel(place.code);

  return [
    `${item.product} — ${place.zoneLabel} (${item.garmentColor.name} garment, ${item.methodLabel}, qty ${item.quantity})`,
    `  Size: ${dims.widthIn}″ × ${dims.heightIn}″${codeLabel ? ` · placement: ${codeLabel}` : ""}`,
    `  Art: ${print.isVector ? "vector" : `raster · ${print.dpiAtSize ?? "?"} DPI at print size`} · ${print.colorCount} color(s)`,
    ...screenPrintLines(print),
    ...dtgLines(print),
    ...vinylLines(print),
    ...dtfLines(print, item, place),
    ...sublimationLines(print),
    ...(place.pmsRequest
      ? [
          `  Brand color request: ${place.pmsRequest} — match against the Pantone formula guide`,
        ]
      : []),
    ...print.warnings.map((warning) => `  ⚠ ${warning}`),
    "",
  ];
};

// Operator-facing press sheet for print methods: inks with PMS references,
// mesh/LPI, pretreat, mirror/layer/press instructions per placement.
export const printSheetText = (spec: OrderProductionSpec) => {
  const printItems = spec.items.filter((item) => item.method !== "embroidery");
  const lines = [
    "PRINT PRODUCTION SHEET",
    "======================",
    "Ink PMS codes are nearest-match screen approximations — confirm against",
    "the Pantone formula guide before mixing.",
    "",
    ...(printItems.length === 0
      ? ["(no print-method items on this order)"]
      : printItems.flatMap((item) =>
          item.placements.flatMap((place) => printPlacementLines(item, place)),
        )),
  ];

  return lines.join("\n");
};

/** Order-level facts for the work-order header (all optional/legacy-safe). */
export type WorkOrderHeader = {
  customerEmail?: string | null;
  placedAt?: string | null;
  dueDate?: string | null;
  /** 'pickup' | 'ship' — how the finished run leaves the shop. */
  fulfillment?: string | null;
  proofStatus?: string | null;
  sewoutStatus?: string | null;
};

const approvalLine = (label: string, status: string | null | undefined) => {
  if (!status) return `- ${label}: not sent`;
  if (status === "approved") return `- ${label}: approved ✓`;

  return `- ⚠ ${label}: ${status} — confirm approval before running`;
};

export const workOrderMarkdown = (
  spec: OrderProductionSpec,
  orderRef: string,
  header?: WorkOrderHeader,
) => {
  const lines: string[] = [
    `# Work order ${orderRef}`,
    "",
    `Generated ${spec.generatedAt}`,
    "",
  ];
  if (header) {
    if (header.dueDate) lines.push(`- **Due: ${header.dueDate}**`);
    if (header.placedAt) lines.push(`- Placed: ${header.placedAt}`);
    if (header.customerEmail) lines.push(`- Customer: ${header.customerEmail}`);
    if (header.fulfillment)
      lines.push(
        `- Fulfillment: ${header.fulfillment === "pickup" ? "LOCAL PICKUP" : header.fulfillment}`,
      );
    lines.push(approvalLine("Proof", header.proofStatus));
    if (header.sewoutStatus)
      lines.push(approvalLine("Sewout/first piece", header.sewoutStatus));
    lines.push("");
  }

  spec.items.forEach((item, itemIndex) => {
    lines.push(
      `## ${itemIndex + 1}. ${item.product} — ${item.methodLabel}`,
      "",
      `- Garment: ${item.garmentColor.name} (${item.garmentColor.hex}) · size ${item.size} · qty ${item.quantity}`,
      `- Fabric: ${item.fabric} · Backing: ${item.backing}`,
    );
    if (item.names.length > 0)
      lines.push(
        `- Names & numbers (${item.names.length}): ${item.names.join(", ")}`,
        "- Roster lettering defaults: names ~1″ tall across upper back, numbers 6–8″ center back — adjust per order notes",
        ...(item.names.length !== item.quantity
          ? [
              `- ⚠ Roster has ${item.names.length} entries but line quantity is ${item.quantity} — confirm piece count`,
            ]
          : []),
      );
    lines.push("");
    item.placements.forEach((place) => {
      const dims = place.dimensions;
      const codeLabel = placementCodeLabel(place.code ?? null);
      lines.push(
        `### ${place.code ? `${place.code} · ` : ""}${place.zoneLabel} — ${place.artwork}`,
        "",
        `- Design size: ${dims.widthIn}″ × ${dims.heightIn}″ (${dims.widthMm} × ${dims.heightMm} mm)`,
        `- Placement: ${codeLabel ? `${codeLabel} · ` : ""}${place.anchor}`,
        `- Offset from zone center: ${dims.offsetXIn}″ horizontal, ${dims.offsetYIn}″ vertical${place.rotationDeg ? ` · rotated ${place.rotationDeg}°` : ""}`,
      );
      if (place.stitchTier)
        lines.push(
          `- Stitch tier: ${place.stitchTier}${place.estimatedStitches ? ` · est. ${place.estimatedStitches.toLocaleString()} stitches` : ""}`,
          `- Embroidery type: ${place.embroideryType === "puff" ? "3D puff" : "Flat"}`,
        );
      if (place.embroideryType === "puff")
        lines.push(
          "- 3D puff: bold satin columns ≥ 3mm over foam — fine detail and small text will not raise; run puff elements last, no trims over foam",
        );
      if (place.hoop) lines.push(`- Hoop: ${place.hoop}`);
      const machineFile =
        item.method === "embroidery" ? machineFileFor(spec, place) : undefined;
      if (machineFile) {
        lines.push(
          `- Machine file: ${machineFile.filename} · ${machineFile.stitches.toLocaleString()} stitches actual · ${machineFile.colorChanges} color changes · ${machineFile.widthMm} × ${machineFile.heightMm} mm`,
        );
        const stops = machineFile.colorChanges + 1;
        if (place.threads.length > 0 && stops !== place.threads.length)
          lines.push(
            `- ⚠ Color stops (${stops}) ≠ cone list (${place.threads.length}) — confirm the sequence against the digitizer's runsheet`,
          );
      }
      if (place.print) {
        const { print } = place;
        lines.push(
          `- Art: ${print.isVector ? "vector (resolution-independent)" : `raster · ${print.dpiAtSize ?? "?"} DPI at print size`} · ${print.colorCount} color(s)${print.screens ? ` · ${print.screens} screens${print.underbase ? " (incl. underbase)" : ""}` : ""}`,
        );
        if ((print.inks ?? []).length > 0)
          lines.push(
            `- Inks: ${print.inks.map((ink) => (ink.pms ? `${ink.pms} (${ink.hex})` : ink.hex)).join(", ")} — screen approximations, confirm vs formula guide`,
          );
        const sp = print.screenPrint;
        if (sp)
          lines.push(
            `- Screen print: mesh colors ${sp.meshColors}${sp.meshUnderbase ? ` · underbase ${sp.meshUnderbase}` : ""}${sp.halftones ? ` · halftones ${sp.lpi} LPI @ ${sp.halftoneAngleDeg}°` : ""} · ${sp.inkSystem}${sp.inkSystemNote ? ` (${sp.inkSystemNote})` : ""}`,
            `- Print order: ${sp.printOrder.join(" → ")}`,
          );
        if (print.dtg)
          lines.push(
            `- DTG: ${print.dtg.pretreat ? "pretreat + white underbase (dark garment)" : "no pretreat (light garment)"} · ${print.dtg.colorProfile} · 300 DPI target`,
          );
        if (print.vinyl)
          lines.push(
            `- Vinyl: cut MIRRORED · ${Math.max(1, print.vinyl.layers.length)} layer(s) bottom-up · ${print.vinyl.material}`,
            `- Press: ${print.vinyl.pressSpec} · ${print.vinyl.minDetail}`,
          );
        if (print.dtf)
          lines.push(
            `- DTF: print MIRRORED on film · white behind CMYK · ${print.dtf.filmNote}`,
            `- Press: ${print.dtf.pressSpec}`,
          );
        if (print.sublimation)
          lines.push(
            `- Sublimation: MIRRORED transfer · ${print.sublimation.polyOk ? "poly OK" : "⚠ not poly"} · ${print.sublimation.lightGarment ? "light garment" : "⚠ dark garment"} · press ${print.sublimation.pressSpec}`,
          );
        print.warnings.forEach((warning) => lines.push(`- ⚠ ${warning}`));
      }
      if (place.threads.length > 0)
        lines.push(
          `- Threads: ${place.threads.map((thread) => `${thread.brand} ${thread.code} (${thread.name})`).join(", ")}`,
        );
      if (place.pantone)
        lines.push(
          `- Color match request: ${place.pantone.requested} → closest stocked ${place.pantone.thread.brand} ${place.pantone.thread.code} (${place.pantone.thread.name}) — confirm against Pantone book at digitizing`,
        );
      if (place.pmsRequest)
        lines.push(
          `- Brand color request: ${place.pmsRequest} — match against the Pantone formula guide at press`,
        );
      if (place.note) lines.push(`- Customer note: ${place.note}`);
      if (place.artworkUrl) lines.push(`- Artwork: ${place.artworkUrl}`);
      lines.push("");
    });
  });

  lines.push("---", "");
  spec.notes.forEach((note) => lines.push(`- ${note}`));

  return lines.join("\n");
};
