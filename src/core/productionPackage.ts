// Production package: everything the operator needs to run the job, in one
// ZIP — machine-readable spec, printable work order (with due date + approval
// stamps), thread color sequence (DST/EXP carry no color), print production
// sheet, full-res artwork with a manifest, and every production file
// (DST/EXP/PES stitch files, SVG/DXF cut files) on record.

import { strToU8, zipSync } from "fflate";
import {
  printSheetText,
  threadSequenceText,
  workOrderMarkdown,
  type OrderProductionSpec,
  type WorkOrderHeader,
} from "./decoration";

const FETCH_TIMEOUT_MS = 15000;

const safeName = (value: string) =>
  value.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "file";

const basenameOf = (url: string) => {
  try {
    const name = new URL(url).pathname.split("/").pop();

    return name ? decodeURIComponent(name) : null;
  } catch {
    return null;
  }
};

const extensionFrom = (url: string, contentType: string | null) => {
  const fromUrl = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromUrl) return fromUrl.toLowerCase();
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("svg")) return "svg";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg"))
    return "jpg";

  return "bin";
};

// Fetch a hosted asset (artwork / production file) for the ZIP.
// Failures degrade to a note file instead of failing the whole package.
const fetchAsset = async (url: string) => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());

    return { bytes, contentType: response.headers.get("content-type") };
  } catch {
    return null;
  }
};

type PackageFiles = Record<string, Uint8Array>;

const addArtwork = async (
  files: PackageFiles,
  missing: string[],
  url: string,
  index: number,
) => {
  const asset = await fetchAsset(url);
  if (!asset) return missing.push(`artwork ${index + 1}: ${url}`);
  const ext = extensionFrom(url, asset.contentType);
  files[`artwork/art-${index + 1}.${ext}`] = asset.bytes;

  return undefined;
};

// Which placements reference each artwork file, so the operator never has
// to guess which art is the back print.
const artworkManifest = (spec: OrderProductionSpec, urls: string[]) => {
  const lines = ["ARTWORK MANIFEST", "================", ""];
  urls.forEach((url, index) => {
    const uses = spec.items.flatMap((item) =>
      item.placements
        .filter((place) => place.artworkUrl === url)
        .map(
          (place) =>
            `${item.product} · ${place.code ? `${place.code} · ` : ""}${place.zoneLabel} (${item.methodLabel})`,
        ),
    );
    lines.push(
      `artwork/art-${index + 1}.* ← ${url}`,
      ...(uses.length > 0
        ? uses.map((use) => `  used by: ${use}`)
        : ["  (not referenced by a placement — check order notes)"]),
      "",
    );
  });

  return lines.join("\n");
};

/** A digitized/cut production file on record for this order. */
export type ProductionFileRef = {
  url: string;
  /** Original filename (keep the digitizer's name). */
  filename?: string | null;
  /** Which uploaded artwork it was produced from. */
  artworkUrl?: string | null;
};

const NO_FILES_README =
  "No production files on this order yet.\n" +
  "Upload the digitized stitch file (DST/EXP/PES) or the cut file (SVG/DXF)\n" +
  "via the admin work order once prepared — then re-export this package.\n";

const addProductionFiles = async (
  files: PackageFiles,
  missing: string[],
  refs: ProductionFileRef[],
) => {
  if (refs.length === 0) {
    files["production-files/README.txt"] = strToU8(NO_FILES_README);

    return;
  }
  await Promise.all(
    refs.map(async (ref, index) => {
      const asset = await fetchAsset(ref.url);
      if (!asset) {
        missing.push(`production file: ${ref.url}`);

        return;
      }
      const name =
        ref.filename ??
        basenameOf(ref.url) ??
        `design-${index + 1}.${extensionFrom(ref.url, asset.contentType)}`;
      files[`production-files/${safeName(name)}`] = asset.bytes;
    }),
  );
};

export type ProductionPackageOrder = {
  session_id: string;
  customer_email: string | null;
  artwork_urls: string[] | null;
  digitized_url: string | null;
  /** Multi-file slot — preferred over digitized_url when present. */
  production_files?: ProductionFileRef[] | null;
  due_date?: string | null;
  placed_at?: string | null;
  fulfillment?: string | null;
  proof_status?: string | null;
  sewout_status?: string | null;
};

export const buildProductionPackage = async (
  order: ProductionPackageOrder,
  spec: OrderProductionSpec,
) => {
  const orderRef = order.session_id.slice(-8).toUpperCase();
  const files: PackageFiles = {};
  const missing: string[] = [];
  const header: WorkOrderHeader = {
    customerEmail: order.customer_email,
    dueDate: order.due_date ?? null,
    fulfillment: order.fulfillment ?? null,
    placedAt: order.placed_at ?? null,
    proofStatus: order.proof_status ?? null,
    sewoutStatus: order.sewout_status ?? null,
  };

  files["spec.json"] = strToU8(JSON.stringify(spec, null, "\t"));
  files["work-order.md"] = strToU8(
    workOrderMarkdown(spec, `#${orderRef}`, header),
  );
  if (spec.items.some((item) => item.method === "embroidery"))
    files["thread-sequence.txt"] = strToU8(threadSequenceText(spec));
  if (spec.items.some((item) => item.method !== "embroidery"))
    files["print-sheet.txt"] = strToU8(printSheetText(spec));

  const artworkUrls = [...new Set(order.artwork_urls ?? [])];
  if (artworkUrls.length > 0)
    files["artwork/MANIFEST.txt"] = strToU8(artworkManifest(spec, artworkUrls));
  await Promise.all(
    artworkUrls.map((url, index) => addArtwork(files, missing, url, index)),
  );
  const refs =
    order.production_files ??
    (order.digitized_url ? [{ url: order.digitized_url }] : []);
  await addProductionFiles(files, missing, refs);

  if (missing.length > 0)
    files["FETCH-ERRORS.txt"] = strToU8(
      `These assets could not be fetched at export time:\n${missing.join("\n")}\n`,
    );

  const zipped = zipSync(files, { level: 6 });

  return { bytes: zipped, filename: `production-${orderRef}.zip` };
};
