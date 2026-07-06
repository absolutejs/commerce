// Embroidery machine-file readers. DST (Tajima) is the universal interchange
// format; its 512-byte ASCII header carries the actual stitch count — the
// ground truth that calibrates quoting estimates.

import type { MachineFileFacts } from './decoration';

const DST_HEADER_BYTES = 512;
/** DST extents are in 0.1mm units. */
const DST_UNITS_PER_MM = 10;

const dstField = (header: string, key: string) => {
	const match = new RegExp(`${key}:\\s*(-?\\d+)`).exec(header);

	return match ? Number(match[1]) : null;
};

/**
 * Reads the Tajima DST 512-byte ASCII header: actual stitch count (ST),
 * color-change count (CO) and design extents (±X/±Y in 0.1mm).
 */
export const parseDstHeader = (bytes: Uint8Array, filename: string) => {
	if (bytes.length < DST_HEADER_BYTES) return null;
	const header = new TextDecoder('latin1').decode(
		bytes.slice(0, DST_HEADER_BYTES)
	);
	const stitches = dstField(header, 'ST');
	if (stitches === null || stitches <= 0) return null;
	const colorChanges = dstField(header, 'CO') ?? 0;
	const plusX = dstField(header, '\\+X') ?? 0;
	const minusX = dstField(header, '-X') ?? 0;
	const plusY = dstField(header, '\\+Y') ?? 0;
	const minusY = dstField(header, '-Y') ?? 0;
	const label = /LA:([^\r\n]{0,16})/.exec(header)?.[1]?.trim() ?? '';

	const facts: MachineFileFacts = {
		colorChanges,
		filename,
		heightMm: Math.round((plusY + minusY) / DST_UNITS_PER_MM),
		label,
		stitches,
		widthMm: Math.round((plusX + minusX) / DST_UNITS_PER_MM)
	};

	return facts;
};
