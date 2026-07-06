// Production package: everything the operator needs to run the job, in one
// ZIP — machine-readable spec, printable work order, thread color sequence
// (DST/EXP carry no color), full-res artwork, and the digitized machine file
// when it's on file.

import { strToU8, zipSync } from 'fflate';
import {
	threadSequenceText,
	workOrderMarkdown,
	type OrderProductionSpec
} from './decoration';

const FETCH_TIMEOUT_MS = 15000;

const safeName = (value: string) =>
	value.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'file';

const extensionFrom = (url: string, contentType: string | null) => {
	const fromUrl = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1];
	if (fromUrl) return fromUrl.toLowerCase();
	if (contentType?.includes('png')) return 'png';
	if (contentType?.includes('svg')) return 'svg';
	if (contentType?.includes('jpeg') || contentType?.includes('jpg'))
		return 'jpg';

	return 'bin';
};

// Fetch a hosted asset (artwork / digitized machine file) for the ZIP.
// Failures degrade to a note file instead of failing the whole package.
const fetchAsset = async (url: string) => {
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!response.ok) return null;
		const bytes = new Uint8Array(await response.arrayBuffer());

		return { bytes, contentType: response.headers.get('content-type') };
	} catch {
		return null;
	}
};

type PackageFiles = Record<string, Uint8Array>;

const addArtwork = async (
	files: PackageFiles,
	missing: string[],
	url: string,
	index: number
) => {
	const asset = await fetchAsset(url);
	if (!asset) return missing.push(`artwork ${index + 1}: ${url}`);
	const ext = extensionFrom(url, asset.contentType);
	files[`artwork/art-${index + 1}.${ext}`] = asset.bytes;

	return undefined;
};

const addMachineFile = async (
	files: PackageFiles,
	missing: string[],
	digitizedUrl: string | null
) => {
	if (!digitizedUrl) {
		files['machine-file/README.txt'] = strToU8(
			'No digitized machine file on this order yet.\n' +
				'Upload the DST/EXP via the admin work order once digitizing is done —\n' +
				'then re-export this package to include it.\n'
		);

		return;
	}
	const asset = await fetchAsset(digitizedUrl);
	if (!asset) {
		missing.push(`digitized file: ${digitizedUrl}`);

		return;
	}
	const ext = extensionFrom(digitizedUrl, asset.contentType);
	files[`machine-file/${safeName(`design.${ext}`)}`] = asset.bytes;
};

export type ProductionPackageOrder = {
	session_id: string;
	customer_email: string | null;
	artwork_urls: string[] | null;
	digitized_url: string | null;
};

export const buildProductionPackage = async (
	order: ProductionPackageOrder,
	spec: OrderProductionSpec
) => {
	const orderRef = order.session_id.slice(-8).toUpperCase();
	const files: PackageFiles = {};
	const missing: string[] = [];

	files['spec.json'] = strToU8(JSON.stringify(spec, null, '\t'));
	files['work-order.md'] = strToU8(workOrderMarkdown(spec, `#${orderRef}`));
	files['thread-sequence.txt'] = strToU8(threadSequenceText(spec));

	const artworkUrls = [...new Set(order.artwork_urls ?? [])];
	await Promise.all(
		artworkUrls.map((url, index) => addArtwork(files, missing, url, index))
	);
	await addMachineFile(files, missing, order.digitized_url);

	if (missing.length > 0)
		files['FETCH-ERRORS.txt'] = strToU8(
			`These assets could not be fetched at export time:\n${missing.join('\n')}\n`
		);

	const zipped = zipSync(files, { level: 6 });

	return { bytes: zipped, filename: `production-${orderRef}.zip` };
};
