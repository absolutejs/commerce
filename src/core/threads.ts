// Machine-embroidery thread color model. Production work orders reference
// threads by BRAND + CATALOG CODE (never RGB): DST/EXP machine files carry no
// color data, so the operator pulls cones from a color sequence sheet.
//
// All helpers take the shop's thread catalog as data — each shop stocks a
// different rack, so the catalog is app-side configuration.

export type ThreadRef = {
  /** Thread manufacturer + line, e.g. "Madeira Polyneon". */
  brand: string;
  /** Manufacturer catalog number the operator uses to pull the cone. */
  code: string;
  name: string;
  hex: string;
};

export type PantoneMatch = {
  /** What the customer asked for, e.g. "PMS 186 C" or "#c8102e". */
  requested: string;
  /** Screen-approximate color of the request. */
  requestedHex: string;
  /** Closest stocked thread — final match is confirmed at digitizing. */
  thread: ThreadRef;
};

export type NearestPantone = {
  /** Display code, e.g. "PMS 186 C" or "PMS WARM RED". */
  code: string;
  /** Screen-approximate sRGB hex of the matched swatch. */
  hex: string;
  /** Euclidean sRGB distance from the input — 0 is an exact table hit. */
  distanceRgb: number;
};

export type PantoneMatchQuality = "exact" | "close" | "approximate";

type Rgb = [number, number, number];

const HEX_RED = 1;
const HEX_GREEN = 3;
const HEX_BLUE = 5;
const HEX_END = 7;
const HEX_BASE = 16;

export const hexToRgb = (hex: string) =>
  [
    parseInt(hex.slice(HEX_RED, HEX_GREEN), HEX_BASE),
    parseInt(hex.slice(HEX_GREEN, HEX_BLUE), HEX_BASE),
    parseInt(hex.slice(HEX_BLUE, HEX_END), HEX_BASE),
  ] as Rgb;

export const isThreadRef = (value: unknown): value is ThreadRef => {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<ThreadRef>;

  return (
    typeof ref.brand === "string" &&
    typeof ref.code === "string" &&
    typeof ref.name === "string" &&
    typeof ref.hex === "string"
  );
};

export const isPantoneMatch = (value: unknown): value is PantoneMatch => {
  if (!value || typeof value !== "object") return false;
  const match = value as Partial<PantoneMatch>;

  return (
    typeof match.requested === "string" &&
    typeof match.requestedHex === "string" &&
    isThreadRef(match.thread)
  );
};

/**
 * Nearest stocked thread by RGB distance — the same mapping a digitizer does
 * against the thread rack. Drives stitch-preview quantization and the
 * auto-extracted thread sequence on the work order.
 */
export const nearestThread = (
  catalog: ThreadRef[],
  red: number,
  green: number,
  blue: number,
) => {
  let best = catalog[0] as ThreadRef;
  let bestDist = Infinity;
  for (const candidate of catalog) {
    const [candidateRed, candidateGreen, candidateBlue] = hexToRgb(
      candidate.hex,
    );
    const deltaRed = red - candidateRed;
    const deltaGreen = green - candidateGreen;
    const deltaBlue = blue - candidateBlue;
    const dist =
      deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue;
    if (dist >= bestDist) continue;
    bestDist = dist;
    best = candidate;
  }

  return best;
};

export const threadByHex = (catalog: ThreadRef[], hex: string) =>
  catalog.find((thread) => thread.hex.toLowerCase() === hex.toLowerCase()) ??
  null;

// Screen-approximate sRGB values for PANTONE Solid Coated colors, sourced
// from the coated-book conversion tables mirrored by open-source design
// tools (Pantone's own published sRGB equivalents). These are screen
// approximations only: thread matching against a physical Pantone book
// happens under 4100K light at digitizing — this table just drives the
// on-screen nearest-thread hint and the nearest-Pantone label.
export const PMS_APPROX: Record<string, string> = {
  "012": "#ffd700",
  "021": "#fe5000",
  "032": "#ef3340",
  "072": "#10069f",
  "109": "#ffd100",
  "116": "#ffcd00",
  "117": "#c99700",
  "118": "#ac8400",
  "119": "#897322",
  "120": "#fbdb65",
  "121": "#fdd757",
  "122": "#fed141",
  "123": "#ffc72c",
  "137": "#ffa300",
  "138": "#de7c00",
  "139": "#af6d04",
  "140": "#74531c",
  "141": "#f2c75c",
  "142": "#f1be48",
  "143": "#f1b434",
  "144": "#ed8b00",
  "151": "#ff8200",
  "152": "#e57200",
  "153": "#be6a14",
  "154": "#9b5a1a",
  "155": "#efd19f",
  "156": "#efbe7d",
  "157": "#eca154",
  "158": "#e87722",
  "159": "#cb6015",
  "160": "#a1561c",
  "161": "#603d20",
  "162": "#ffbe9f",
  "163": "#ff9d6e",
  "164": "#ff7f41",
  "165": "#ff671f",
  "172": "#fa4616",
  "173": "#cf4520",
  "174": "#963821",
  "175": "#6b3529",
  "176": "#ffb1bb",
  "177": "#ff808b",
  "178": "#ff585d",
  "179": "#e03c31",
  "185": "#e4002b",
  "186": "#c8102e",
  "187": "#a6192e",
  "199": "#d50032",
  "200": "#ba0c2f",
  "208": "#861f41",
  "209": "#6f263d",
  "210": "#f99fc9",
  "211": "#f57eb6",
  "212": "#f04e98",
  "213": "#e31c79",
  "214": "#ce0f69",
  "215": "#ac145a",
  "226": "#d0006f",
  "227": "#aa0061",
  "228": "#890c58",
  "229": "#672146",
  "230": "#f4a6d7",
  "231": "#f277c6",
  "232": "#e93cac",
  "233": "#c6007e",
  "234": "#a20067",
  "235": "#840b55",
  "241": "#af1685",
  "242": "#80225f",
  "243": "#eab8e4",
  "244": "#e59bdc",
  "245": "#dd7fd3",
  "246": "#c724b1",
  "247": "#bb16a3",
  "248": "#a51890",
  "249": "#80276c",
  "250": "#e7bae4",
  "251": "#dd9cdf",
  "252": "#c964cf",
  "253": "#ad1aac",
  "254": "#981d97",
  "255": "#72246c",
  "256": "#d6bfdd",
  "257": "#c6a1cf",
  "258": "#8c4799",
  "259": "#6d2077",
  "260": "#642667",
  "261": "#5d285f",
  "262": "#51284f",
  "263": "#d7c6e6",
  "264": "#c1a7e2",
  "265": "#9063cd",
  "266": "#753bbd",
  "267": "#5f259f",
  "268": "#582c83",
  "274": "#211551",
  "275": "#201747",
  "276": "#221c35",
  "277": "#abcae9",
  "278": "#8bb8e8",
  "279": "#418fde",
  "280": "#012169",
  "281": "#00205b",
  "282": "#041e42",
  "286": "#0033a0",
  "287": "#003087",
  "288": "#002d72",
  "289": "#0c2340",
  "290": "#b9d9eb",
  "291": "#9bcbeb",
  "292": "#69b3e7",
  "293": "#003da5",
  "294": "#002f6c",
  "300": "#005eb8",
  "301": "#004b87",
  "302": "#003b5c",
  "303": "#002a3a",
  "304": "#9adbe8",
  "305": "#59cbe8",
  "306": "#00b5e2",
  "317": "#b1e4e3",
  "320": "#009ca6",
  "321": "#008c95",
  "322": "#007377",
  "331": "#a7e6d7",
  "337": "#8fd6bd",
  "347": "#009a44",
  "348": "#00843d",
  "349": "#046a38",
  "350": "#2c5234",
  "351": "#a2e4b8",
  "352": "#8fe2b0",
  "353": "#80e0a7",
  "354": "#00b140",
  "355": "#009639",
  "361": "#43b02a",
  "362": "#509e2f",
  "363": "#4c8c2b",
  "364": "#4a7729",
  "365": "#c2e189",
  "366": "#b7dd79",
  "367": "#a4d65e",
  "368": "#78be20",
  "375": "#97d700",
  "376": "#84bd00",
  "382": "#c4d600",
  "424": "#707372",
  "425": "#54585a",
  "426": "#25282a",
  "427": "#d0d3d4",
  "428": "#c1c6c8",
  "429": "#a2aaad",
  "430": "#7c878e",
  "431": "#5b6770",
  "432": "#333f48",
  "433": "#1d252d",
  "448": "#4a412a",
  "449": "#524727",
  "450": "#594a25",
  "468": "#ddcba4",
  "485": "#da291c",
  "649": "#dbe2e9",
  "656": "#dde5ed",
  "705": "#f5dadf",
  "801": "#009ace",
  "802": "#44d62c",
  "803": "#ffe900",
  "804": "#ffaa4d",
  "805": "#ff7276",
  "806": "#ff3eb5",
  "807": "#ea27c2",
  "871": "#84754e",
  "872": "#85714d",
  "873": "#866d4b",
  "874": "#8b6f4e",
  "875": "#87674f",
  "876": "#8b634b",
  "877": "#8a8d8f",
  "2607": "#500778",
  "2685": "#330072",
  "2935": "#0057b8",
  "3425": "#006341",
  "4625": "#4f2c1d",
  "7401": "#f5e1a4",
  "7443": "#dddae8",
  black: "#2d2926",
  "cool gray 1": "#d9d9d6",
  "cool gray 2": "#d0d0ce",
  "cool gray 3": "#c8c9c7",
  "cool gray 4": "#bbbcbc",
  "cool gray 5": "#b1b3b3",
  "cool gray 6": "#a7a8aa",
  "cool gray 7": "#97999b",
  "cool gray 8": "#888b8d",
  "cool gray 9": "#75787b",
  "cool gray 10": "#63666a",
  "cool gray 11": "#53565a",
  green: "#00ab84",
  "process blue": "#0085ca",
  purple: "#bb29bb",
  "reflex blue": "#001489",
  "rhodamine red": "#e10098",
  "rubine red": "#ce0058",
  violet: "#440099",
  "warm gray 1": "#d7d2cb",
  "warm gray 2": "#cbc4bc",
  "warm gray 3": "#bfb8af",
  "warm gray 4": "#b6ada5",
  "warm gray 5": "#aca39a",
  "warm gray 6": "#a59c94",
  "warm gray 7": "#968c83",
  "warm gray 8": "#8c8279",
  "warm gray 9": "#83786f",
  "warm gray 10": "#796e65",
  "warm gray 11": "#6e6259",
  "warm red": "#f9423a",
  // No Solid Coated white swatch exists — plain ink/thread white.
  white: "#ffffff",
  yellow: "#fedd00",
};

const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;

const formatPmsCode = (key: string) =>
  `PMS ${key.toUpperCase()}${/^\d+$/.test(key) ? " C" : ""}`;

/**
 * Nearest PMS_APPROX swatch by RGB distance to a hex color — the reverse of
 * resolveThreadQuery, used to label an arbitrary artwork color with the
 * closest common Pantone code. Returns null when the input is not a hex
 * color. Screen approximation only — final ink match is confirmed against a
 * physical Pantone book.
 */
export const nearestPantone = (hex: string): NearestPantone | null => {
  const hexMatch = HEX_PATTERN.exec(hex.trim());
  if (!hexMatch) return null;

  const normalized = `#${(hexMatch[1] as string).toLowerCase()}`;
  const [red, green, blue] = hexToRgb(normalized);
  let bestKey = "";
  let bestHex = "";
  let bestDist = Infinity;
  for (const [key, candidateHex] of Object.entries(PMS_APPROX)) {
    const [candidateRed, candidateGreen, candidateBlue] =
      hexToRgb(candidateHex);
    const deltaRed = red - candidateRed;
    const deltaGreen = green - candidateGreen;
    const deltaBlue = blue - candidateBlue;
    const dist =
      deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue;
    if (dist >= bestDist) continue;
    bestDist = dist;
    bestKey = key;
    bestHex = candidateHex;
  }
  if (!bestKey) return null;

  return {
    code: formatPmsCode(bestKey),
    distanceRgb: Math.sqrt(bestDist),
    hex: bestHex,
  };
};

// Euclidean sRGB distance of 60 is roughly a CIE delta-E of ~10 for
// mid-tone colors — past that the swatch reads as a visibly different
// color on screen, so the match is labeled "approximate" instead.
const PANTONE_CLOSE_MAX_DISTANCE = 60;

export const pantoneMatchQuality = (
  distanceRgb: number,
): PantoneMatchQuality => {
  if (distanceRgb === 0) return "exact";

  return distanceRgb <= PANTONE_CLOSE_MAX_DISTANCE ? "close" : "approximate";
};

/**
 * Resolve a customer color request — a hex value or a common PMS code —
 * to the nearest stocked thread. Returns null when the input is neither a
 * hex color nor a PMS number in the built-in table.
 */
export const resolveThreadQuery = (
  catalog: ThreadRef[],
  input: string,
): PantoneMatch | null => {
  const raw = input.trim();
  if (!raw) return null;

  const hexMatch = HEX_PATTERN.exec(raw);
  if (hexMatch) {
    const requestedHex = `#${(hexMatch[1] as string).toLowerCase()}`;
    const [red, green, blue] = hexToRgb(requestedHex);

    return {
      requested: requestedHex,
      requestedHex,
      thread: nearestThread(catalog, red, green, blue),
    };
  }

  const key = raw
    .toLowerCase()
    .replace(/^pantone\s*/i, "")
    .replace(/^pms\s*/i, "")
    .replace(/\s*[cu]$/i, "")
    .trim();
  const approx = PMS_APPROX[key];
  if (!approx) return null;
  const [red, green, blue] = hexToRgb(approx);

  return {
    requested: formatPmsCode(key),
    requestedHex: approx,
    thread: nearestThread(catalog, red, green, blue),
  };
};
