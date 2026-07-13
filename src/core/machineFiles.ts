// Embroidery machine-file readers. DST (Tajima) is the universal interchange
// format; its 512-byte ASCII header carries the actual stitch count — the
// ground truth that calibrates quoting estimates. EXP (Melco) and PES
// (Brother) are read by walking their stitch streams directly.

import type { MachineFileFacts } from './decoration';

const DST_HEADER_BYTES = 512;
/** DST, EXP and PEC coordinates are all in 0.1mm units. */
const UNITS_PER_MM = 10;

const dstField = (header: string, key: string) => {
	const match = new RegExp(`${key}:\\s*(-?\\d+)`).exec(header);

	return match ? Number(match[1]) : null;
};

/** Interprets a byte as a two's-complement signed 8-bit delta. */
const signed8 = (byte: number) => (byte > 0x7f ? byte - 0x100 : byte);

/** Tracks a running needle position and its min/max extents (origin included). */
const createExtents = () => {
	let maxX = 0;
	let maxY = 0;
	let minX = 0;
	let minY = 0;
	let x = 0;
	let y = 0;

	return {
		heightMm: () => Math.round((maxY - minY) / UNITS_PER_MM),
		move: (deltaX: number, deltaY: number) => {
			x += deltaX;
			y += deltaY;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		},
		widthMm: () => Math.round((maxX - minX) / UNITS_PER_MM)
	};
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
		heightMm: Math.round((plusY + minusY) / UNITS_PER_MM),
		label,
		stitches,
		widthMm: Math.round((plusX + minusX) / UNITS_PER_MM)
	};

	return facts;
};

/** EXP control lead byte; the following byte selects the control function. */
const EXP_CONTROL = 0x80;
const EXP_END = 0x00;
const EXP_COLOR_CHANGE = 0x01;
const EXP_STOP = 0x02;
const EXP_FAST_MOVE = 0x04;

/** Swallows the 0x00 0x00 pad pair some EXP writers emit after a control. */
const expZeroPad = (bytes: Uint8Array, index: number) =>
	bytes[index] === 0 && bytes[index + 1] === 0 ? 2 : 0;

/**
 * Reads a Melco EXP raw stitch stream (headerless 2-byte signed 0.1mm delta
 * records; 0x80-led control records): stitches, color changes and extents.
 */
export const parseExpStitches = (bytes: Uint8Array, filename: string) => {
	const extents = createExtents();
	let colorChanges = 0;
	let stitches = 0;
	let jumpPending = false;
	let index = 0;

	while (index + 1 < bytes.length) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1] ?? 0;
		index += 2;
		if (first !== EXP_CONTROL) {
			extents.move(signed8(first), signed8(second));
			if (jumpPending) jumpPending = false;
			else stitches += 1;
			continue;
		}
		if (second === EXP_END) break;
		if (second === EXP_COLOR_CHANGE) {
			colorChanges += 1;
			// Some writers pad the color change to four bytes; a literal
			// zero pair adds nothing as a stitch, so swallow it either way.
			index += expZeroPad(bytes, index);
			continue;
		}
		if (second === EXP_STOP) {
			index += expZeroPad(bytes, index);
			continue;
		}
		if (second === EXP_FAST_MOVE || second === EXP_CONTROL) {
			// 0x80 0x80 (trim) and 0x80 0x04 (fast move) both mark the next
			// delta pair as a needle-up jump rather than a stitch.
			jumpPending = true;
			continue;
		}
		// Unknown control: skip the record and keep going (writer extras).
	}

	if (stitches <= 0) return null;

	const facts: MachineFileFacts = {
		colorChanges,
		filename,
		heightMm: extents.heightMm(),
		label: '',
		stitches,
		widthMm: extents.widthMm()
	};

	return facts;
};

const PES_MAGIC = '#PES';
/** Byte offset of the little-endian PEC-block pointer in a PES header. */
const PES_PEC_POINTER_OFFSET = 8;
const PEC_LABEL_OFFSET = 3;
const PEC_LABEL_BYTES = 16;
/** Byte at PEC+48 holds colorCount - 1; 0xFF means no palette recorded. */
const PEC_COLOR_COUNT_OFFSET = 48;
const PEC_NO_COLORS = 0xff;
const PEC_STITCH_DATA_OFFSET = 532;
const PEC_END = 0xff;
const PEC_COLOR_CHANGE = 0xfe;
const PEC_COLOR_CHANGE_SECOND = 0xb0;
/** Long-form flag bits in the first PEC delta byte: 0x20 trim, 0x10 jump. */
const PEC_NEEDLE_UP_FLAGS = 0x30;

const readUint32Le = (bytes: Uint8Array, offset: number) => {
	const byte0 = bytes[offset];
	const byte1 = bytes[offset + 1];
	const byte2 = bytes[offset + 2];
	const byte3 = bytes[offset + 3];
	if (
		byte0 === undefined ||
		byte1 === undefined ||
		byte2 === undefined ||
		byte3 === undefined
	)
		return null;

	return (byte0 | (byte1 << 8) | (byte2 << 16) | (byte3 << 24)) >>> 0;
};

/** Reads one PEC delta component (short 7-bit or long 12-bit form). */
const pecComponent = (bytes: Uint8Array, offset: number) => {
	const first = bytes[offset];
	if (first === undefined) return null;
	if (first & 0x80) {
		const second = bytes[offset + 1];
		if (second === undefined) return null;
		let value = ((first & 0x0f) << 8) | second;
		if (value & 0x800) value -= 0x1000;

		return {
			needleUp: (first & PEC_NEEDLE_UP_FLAGS) !== 0,
			next: offset + 2,
			value
		};
	}

	return {
		needleUp: false,
		next: offset + 1,
		value: first >= 0x40 ? first - 0x80 : first
	};
};

/**
 * Reads a Brother PES file via its embedded PEC block: label, color count
 * and a walk of the PEC stitch stream for stitches and extents.
 */
export const parsePesHeader = (bytes: Uint8Array, filename: string) => {
	const decoder = new TextDecoder('latin1');
	if (
		bytes.length < PES_PEC_POINTER_OFFSET + 4 ||
		decoder.decode(bytes.slice(0, PES_MAGIC.length)) !== PES_MAGIC
	)
		return null;
	const pecOffset = readUint32Le(bytes, PES_PEC_POINTER_OFFSET);
	if (pecOffset === null || pecOffset + PEC_STITCH_DATA_OFFSET > bytes.length)
		return null;
	if (decoder.decode(bytes.slice(pecOffset, pecOffset + 3)) !== 'LA:')
		return null;
	const label = decoder
		.decode(
			bytes.slice(
				pecOffset + PEC_LABEL_OFFSET,
				pecOffset + PEC_LABEL_OFFSET + PEC_LABEL_BYTES
			)
		)
		.replace(/\0/g, ' ')
		.trim();
	const colorByte = bytes[pecOffset + PEC_COLOR_COUNT_OFFSET] ?? PEC_NO_COLORS;

	const extents = createExtents();
	let countedChanges = 0;
	let stitches = 0;
	let index = pecOffset + PEC_STITCH_DATA_OFFSET;

	while (index < bytes.length) {
		const first = bytes[index];
		if (first === undefined || first === PEC_END) break;
		if (
			first === PEC_COLOR_CHANGE &&
			bytes[index + 1] === PEC_COLOR_CHANGE_SECOND
		) {
			countedChanges += 1;
			// 0xFE 0xB0 is followed by a one-byte color index.
			index += 3;
			continue;
		}
		const xPart = pecComponent(bytes, index);
		if (xPart === null) break;
		const yPart = pecComponent(bytes, xPart.next);
		if (yPart === null) break;
		index = yPart.next;
		extents.move(xPart.value, yPart.value);
		if (xPart.needleUp || yPart.needleUp) continue;
		stitches += 1;
	}

	if (stitches <= 0) return null;

	const facts: MachineFileFacts = {
		colorChanges: colorByte === PEC_NO_COLORS ? countedChanges : colorByte,
		filename,
		heightMm: extents.heightMm(),
		label,
		stitches,
		widthMm: extents.widthMm()
	};

	return facts;
};

/** Routes machine-file bytes to the right parser by lowercase extension. */
export const parseMachineFile = (bytes: Uint8Array, filename: string) => {
	const dotIndex = filename.lastIndexOf('.');
	if (dotIndex === -1) return null;
	const extension = filename.slice(dotIndex + 1).toLowerCase();
	if (extension === 'dst') return parseDstHeader(bytes, filename);
	if (extension === 'exp') return parseExpStitches(bytes, filename);
	if (extension === 'pes') return parsePesHeader(bytes, filename);

	return null;
};
