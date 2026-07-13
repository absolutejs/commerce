import { describe, expect, it } from 'bun:test';
import {
	parseDstHeader,
	parseExpStitches,
	parseMachineFile,
	parsePesHeader
} from './machineFiles';

const DST_HEADER_BYTES = 512;

/** Builds a fake Tajima DST header padded with spaces to 512 bytes. */
const buildDstBytes = () => {
	const header =
		'LA:sampletee\r' +
		'ST:0000123\r' +
		'CO:002\r' +
		'+X:00450\r' +
		'-X:00050\r' +
		'+Y:00300\r' +
		'-Y:00100\r';
	const bytes = new Uint8Array(DST_HEADER_BYTES).fill(0x20);
	new TextEncoder().encode(header).forEach((byte, index) => {
		bytes[index] = byte;
	});

	return bytes;
};

/** A 10-stitch EXP stream: run right, color change, jump up, run up-left. */
const buildExpBytes = () =>
	new Uint8Array([
		// 5 stitches of (+20, 0) → x reaches 100
		0x14, 0x00, 0x14, 0x00, 0x14, 0x00, 0x14, 0x00, 0x14, 0x00,
		// color change
		0x80, 0x01,
		// trim marks the next pair as a jump: (0, +30) → y reaches 30
		0x80, 0x80, 0x00, 0x1e,
		// 4 stitches of (0, +20) → y reaches 110
		0x00, 0x14, 0x00, 0x14, 0x00, 0x14, 0x00, 0x14,
		// 1 stitch of (-20, -10) — two's complement deltas
		0xec, 0xf6,
		// stop with conventional zero padding, then end
		0x80, 0x02, 0x00, 0x00, 0x80, 0x00
	]);

const PEC_STITCH_DATA_OFFSET = 532;

/** Builds a minimal PES: "#PES0001", PEC pointer, hand-built PEC block. */
const buildPesBytes = () => {
	const pecOffset = 16;
	const stitchBytes = [
		// short-form stitch (+10, +5)
		0x0a, 0x05,
		// short-form stitch (-10, -5) — 7-bit two's complement
		0x76, 0x7b,
		// long-form stitch (+300, -200) — 12-bit two's complement
		0x81, 0x2c, 0x8f, 0x38,
		// long-form jump (+100, 0) — 0x10 flag set, excluded from stitches
		0x90, 0x64, 0x90, 0x00,
		// color change (0xFE 0xB0 <color index>)
		0xfe, 0xb0, 0x02,
		// short-form stitch (+2, +3)
		0x02, 0x03,
		// end of stitches
		0xff
	];
	const bytes = new Uint8Array(
		pecOffset + PEC_STITCH_DATA_OFFSET + stitchBytes.length
	);
	const encoder = new TextEncoder();
	encoder.encode('#PES0001').forEach((byte, index) => {
		bytes[index] = byte;
	});
	bytes[8] = pecOffset; // little-endian PEC pointer
	encoder
		.encode(`LA:${'HALFTONE'.padEnd(16, ' ')}`)
		.forEach((byte, index) => {
			bytes[pecOffset + index] = byte;
		});
	bytes[pecOffset + 48] = 1; // colorCount - 1 → two colors, one change
	stitchBytes.forEach((byte, index) => {
		bytes[pecOffset + PEC_STITCH_DATA_OFFSET + index] = byte;
	});

	return bytes;
};

describe('parseExpStitches', () => {
	it('reads stitches, color changes and extents from an EXP stream', () => {
		const facts = parseExpStitches(buildExpBytes(), 'square.exp');
		expect(facts).not.toBeNull();
		expect(facts?.stitches).toBe(10);
		expect(facts?.colorChanges).toBe(1);
		expect(facts?.widthMm).toBe(10);
		expect(facts?.heightMm).toBe(11);
		expect(facts?.label).toBe('');
		expect(facts?.filename).toBe('square.exp');
	});

	it('returns null for an empty stream', () => {
		expect(parseExpStitches(new Uint8Array(0), 'empty.exp')).toBeNull();
	});

	it('returns null when the stream has controls but no stitches', () => {
		const bytes = new Uint8Array([0x80, 0x01, 0x80, 0x00]);
		expect(parseExpStitches(bytes, 'nostitch.exp')).toBeNull();
	});
});

describe('parsePesHeader', () => {
	it('reads label, colors, stitches and extents from the PEC block', () => {
		const facts = parsePesHeader(buildPesBytes(), 'logo.pes');
		expect(facts).not.toBeNull();
		expect(facts?.stitches).toBe(4);
		expect(facts?.colorChanges).toBe(1);
		expect(facts?.widthMm).toBe(40);
		expect(facts?.heightMm).toBe(21);
		expect(facts?.label).toBe('HALFTONE');
		expect(facts?.filename).toBe('logo.pes');
	});

	it('counts 0xFE color changes when the palette byte is 0xFF', () => {
		const bytes = buildPesBytes();
		bytes[16 + 48] = 0xff;
		expect(parsePesHeader(bytes, 'logo.pes')?.colorChanges).toBe(1);
	});

	it('returns null when the magic is missing', () => {
		const bytes = buildPesBytes();
		bytes[0] = 0x00;
		expect(parsePesHeader(bytes, 'logo.pes')).toBeNull();
	});

	it('returns null when the PEC pointer runs past the file', () => {
		const bytes = buildPesBytes().slice(0, 64);
		expect(parsePesHeader(bytes, 'truncated.pes')).toBeNull();
	});
});

describe('parseDstHeader', () => {
	it('still reads ST/CO/extents/label from a DST header', () => {
		const facts = parseDstHeader(buildDstBytes(), 'tee.dst');
		expect(facts).not.toBeNull();
		expect(facts?.stitches).toBe(123);
		expect(facts?.colorChanges).toBe(2);
		expect(facts?.widthMm).toBe(50);
		expect(facts?.heightMm).toBe(40);
		expect(facts?.label).toBe('sampletee');
	});

	it('returns null for a header without a stitch count', () => {
		const bytes = new Uint8Array(DST_HEADER_BYTES).fill(0x20);
		expect(parseDstHeader(bytes, 'blank.dst')).toBeNull();
	});
});

describe('parseMachineFile', () => {
	it('routes .dst to the DST header parser (case-insensitive)', () => {
		expect(parseMachineFile(buildDstBytes(), 'tee.DST')?.stitches).toBe(
			123
		);
	});

	it('routes .exp to the EXP stream parser', () => {
		expect(parseMachineFile(buildExpBytes(), 'square.exp')?.stitches).toBe(
			10
		);
	});

	it('routes .pes to the PES parser', () => {
		expect(parseMachineFile(buildPesBytes(), 'logo.pes')?.stitches).toBe(
			4
		);
	});

	it('returns null for unknown extensions and missing extensions', () => {
		expect(parseMachineFile(buildDstBytes(), 'tee.svg')).toBeNull();
		expect(parseMachineFile(buildDstBytes(), 'tee')).toBeNull();
	});

	it('returns null for garbage bytes without throwing', () => {
		const garbage = new Uint8Array(600);
		for (let index = 0; index < garbage.length; index += 1) {
			garbage[index] = (index * 37 + 11) % 251;
		}
		expect(parseMachineFile(garbage, 'junk.pes')).toBeNull();
		expect(parseMachineFile(new Uint8Array(3), 'junk.pes')).toBeNull();
		expect(parseMachineFile(new Uint8Array(3), 'junk.dst')).toBeNull();
	});
});
