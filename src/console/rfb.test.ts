import { describe, expect, test } from 'bun:test'
import { PveConsoleError } from '../core/errors.ts'
import {
	buildClientCutText,
	buildClientInit,
	buildFbUpdateRequest,
	buildKeyEvent,
	buildPointerEvent,
	buildSetEncodings,
	buildSetPixelFormat,
	charToKeysym,
	parseKeyCombo,
	parseProtocolVersion,
	parseRectangle,
	parseSecurityResult,
	parseSecurityTypes,
	parseServerInit,
	parseServerMessage,
	PIXEL_FORMAT,
	RFB_ENCODING_COPYRECT,
	RFB_ENCODING_DESKTOP_SIZE,
	RFB_ENCODING_RAW,
	SHIFTED_CHARS,
	SPECIAL_KEYS,
} from './rfb.ts'

const hex = (buf: Buffer): string => buf.toString('hex')
const bytes = (text: string): Buffer => Buffer.from(text, 'hex')
const char = (code: number): string => String.fromCharCode(code)

describe('buildSetPixelFormat', () => {
	test('is a 20-byte message with three padding bytes before the pixel format', () => {
		expect(hex(buildSetPixelFormat())).toBe('000000002018000100ff00ff00ff100800000000')
	})

	test('carries the 16-byte PIXEL_FORMAT verbatim', () => {
		expect(PIXEL_FORMAT).toHaveLength(16)
		expect(buildSetPixelFormat().subarray(4).equals(PIXEL_FORMAT)).toBe(true)
	})
})

describe('buildSetEncodings', () => {
	test('writes the count as U16 and each encoding as signed big-endian S32', () => {
		const msg = buildSetEncodings([
			RFB_ENCODING_COPYRECT,
			RFB_ENCODING_RAW,
			RFB_ENCODING_DESKTOP_SIZE,
		])
		expect(hex(msg)).toBe('020000030000000100000000ffffff21')
	})

	test('accepts an empty encoding list', () => {
		expect(hex(buildSetEncodings([]))).toBe('02000000')
	})
})

describe('buildFbUpdateRequest', () => {
	test('encodes an incremental request over a 1024x768 screen', () => {
		expect(hex(buildFbUpdateRequest(true, 0, 0, 1024, 768))).toBe('03010000000004000300')
	})

	test('encodes a full request with the position fields set', () => {
		expect(hex(buildFbUpdateRequest(false, 16, 32, 64, 48))).toBe('03000010002000400030')
	})
})

describe('buildKeyEvent', () => {
	test('encodes a key press with two padding bytes before the keysym', () => {
		expect(hex(buildKeyEvent(true, 0xff0d))).toBe('040100000000ff0d')
	})

	test('encodes a key release', () => {
		expect(hex(buildKeyEvent(false, 0x41))).toBe('0400000000000041')
	})

	test('writes keysyms above 0xffff at full width', () => {
		expect(hex(buildKeyEvent(true, 0x010020ac))).toBe('04010000010020ac')
	})
})

describe('buildPointerEvent', () => {
	test('encodes the button mask and position', () => {
		expect(hex(buildPointerEvent(1, 800, 600))).toBe('050103200258')
	})

	test('keeps the full 8-bit button mask, including the wheel buttons', () => {
		expect(hex(buildPointerEvent(0b0001_0000, 1, 2))).toBe('051000010002')
	})
})

describe('buildClientCutText', () => {
	test('writes the byte length and latin-1 text after three padding bytes', () => {
		expect(hex(buildClientCutText('hi'))).toBe('0600000000000002' + '6869')
	})

	test('counts latin-1 bytes, not code points', () => {
		const frame = buildClientCutText('caf\u00e9')
		expect(frame.readUInt32BE(4)).toBe(4)
		expect(frame.subarray(8).toString('latin1')).toBe('caf\u00e9')
	})
})

describe('buildClientInit', () => {
	test('is the shared flag alone', () => {
		expect(hex(buildClientInit(true))).toBe('01')
		expect(hex(buildClientInit(false))).toBe('00')
	})
})

describe('parseProtocolVersion', () => {
	test('reads the 12-byte version string', () => {
		expect(parseProtocolVersion(Buffer.from('RFB 003.008\nxx', 'ascii'))).toEqual({
			value: 'RFB 003.008\n',
			length: 12,
		})
	})

	test('asks for 12 bytes while short', () => {
		expect(parseProtocolVersion(Buffer.from('RFB 003', 'ascii'))).toBe(12)
	})

	test('rejects a string that is not RFB', () => {
		expect(() => parseProtocolVersion(Buffer.from('HTTP/1.1 40\n', 'ascii'))).toThrow(
			/Not an RFB version string/,
		)
	})
})

describe('parseSecurityTypes', () => {
	test('reads the offered types', () => {
		expect(parseSecurityTypes(Buffer.from([2, 2, 1]))).toEqual({ value: [2, 1], length: 3 })
	})

	test('asks for the count, then the types', () => {
		expect(parseSecurityTypes(Buffer.alloc(0))).toBe(1)
		expect(parseSecurityTypes(Buffer.from([3, 1]))).toBe(4)
	})

	test('reports the reason when the server refuses', () => {
		const reason = Buffer.from('too many', 'utf8')
		const head = Buffer.alloc(5)
		head.writeUInt32BE(reason.length, 1)
		expect(parseSecurityTypes(head)).toBe(5 + reason.length)
		expect(() => parseSecurityTypes(Buffer.concat([head, reason]))).toThrow(
			/refused the connection: too many/,
		)
	})
})

describe('parseSecurityResult', () => {
	test('accepts zero', () => {
		expect(parseSecurityResult(bytes('00000000'))).toEqual({ value: undefined, length: 4 })
	})

	test('reports the failure reason', () => {
		expect(parseSecurityResult(bytes('00000001'))).toBe(8)
		expect(() => parseSecurityResult(bytes('0000000100000003626164'))).toThrow(
			/VNC authentication failed: bad/,
		)
	})
})

describe('parseServerInit', () => {
	test('reads the size and the name', () => {
		const buf = Buffer.alloc(28)
		buf.writeUInt16BE(800, 0)
		buf.writeUInt16BE(600, 2)
		buf.writeUInt32BE(4, 20)
		buf.write('qemu', 24)
		expect(parseServerInit(buf)).toEqual({
			value: { width: 800, height: 600, name: 'qemu' },
			length: 28,
		})
		expect(parseServerInit(buf.subarray(0, 26))).toBe(28)
	})
})

describe('parseServerMessage', () => {
	test('reads a FramebufferUpdate header as its rectangle count', () => {
		expect(parseServerMessage(bytes('00000003'))).toEqual({
			value: { type: 'update', rectCount: 3 },
			length: 4,
		})
		expect(parseServerMessage(bytes('0000'))).toBe(4)
	})

	test('consumes a colour map', () => {
		const colourMap = Buffer.alloc(6 + 2 * 6)
		colourMap.writeUInt8(1, 0)
		colourMap.writeUInt16BE(2, 4)
		expect(parseServerMessage(colourMap)).toEqual({ value: { type: 'colour-map' }, length: 18 })
		expect(parseServerMessage(colourMap.subarray(0, 10))).toBe(18)
	})

	test('reads Bell and ServerCutText', () => {
		expect(parseServerMessage(bytes('02'))).toEqual({ value: { type: 'bell' }, length: 1 })
		expect(parseServerMessage(bytes('03000000000000026869'))).toEqual({
			value: { type: 'cut-text', text: 'hi' },
			length: 10,
		})
	})

	test('a length prefix near 2^32 comes back as the byte count, without overflowing', () => {
		const cut = Buffer.concat([Buffer.from([3, 0, 0, 0]), bytes('ffffffff')])
		expect(parseServerMessage(cut)).toBe(8 + 0xffffffff)
		const refused = Buffer.concat([Buffer.from([0]), bytes('fffffffe')])
		expect(parseSecurityTypes(refused)).toBe(5 + 0xfffffffe)
	})

	test('rejects an unknown type', () => {
		expect(() => parseServerMessage(bytes('fa'))).toThrow(/Unknown RFB server message type 250/)
	})
})

describe('parseRectangle', () => {
	const screen = { width: 4, height: 4 }
	const header = (x: number, y: number, w: number, h: number, encoding: number): Buffer => {
		const buf = Buffer.alloc(12)
		buf.writeUInt16BE(x, 0)
		buf.writeUInt16BE(y, 2)
		buf.writeUInt16BE(w, 4)
		buf.writeUInt16BE(h, 6)
		buf.writeInt32BE(encoding, 8)
		return buf
	}

	test('reads a Raw rectangle once its pixels have arrived', () => {
		const head = header(1, 0, 2, 2, RFB_ENCODING_RAW)
		expect(parseRectangle(head, screen)).toBe(12 + 16)
		const pixels = Buffer.alloc(16, 0xab)
		const parsed = parseRectangle(Buffer.concat([head, pixels, Buffer.alloc(3)]), screen)
		expect(parsed).toEqual({
			value: { encoding: 'raw', x: 1, y: 0, w: 2, h: 2, data: pixels },
			length: 28,
		})
	})

	test('reads a CopyRect source', () => {
		const buf = Buffer.concat([header(2, 0, 2, 1, RFB_ENCODING_COPYRECT), bytes('00000000')])
		expect(parseRectangle(buf, screen)).toEqual({
			value: { encoding: 'copy', x: 2, y: 0, w: 2, h: 1, srcX: 0, srcY: 0 },
			length: 16,
		})
	})

	test('reads a DesktopSize rectangle regardless of the current screen', () => {
		expect(parseRectangle(header(0, 0, 16, 8, RFB_ENCODING_DESKTOP_SIZE), screen)).toEqual({
			value: { encoding: 'resize', width: 16, height: 8 },
			length: 12,
		})
	})

	test('rejects a rectangle that does not fit the screen', () => {
		const buf = Buffer.concat([header(3, 0, 4, 1, RFB_ENCODING_RAW), Buffer.alloc(16)])
		expect(() => parseRectangle(buf, screen)).toThrow(/does not fit the 4x4 framebuffer/)
		const copy = Buffer.concat([header(0, 0, 2, 1, RFB_ENCODING_COPYRECT), bytes('00030000')])
		expect(() => parseRectangle(copy, screen)).toThrow(/CopyRect source/)
	})

	test('rejects an oversized Raw rectangle from its header, before waiting for its pixels', () => {
		const head = header(0, 0, 65535, 65535, RFB_ENCODING_RAW)
		expect(() => parseRectangle(head, screen)).toThrow(/does not fit the 4x4 framebuffer/)
		const copy = header(3, 3, 2, 2, RFB_ENCODING_COPYRECT)
		expect(() => parseRectangle(copy, screen)).toThrow(/CopyRect destination/)
	})

	test('a zero-sized rectangle is complete with its header', () => {
		expect(parseRectangle(header(4, 4, 0, 0, RFB_ENCODING_RAW), screen)).toEqual({
			value: { encoding: 'raw', x: 4, y: 4, w: 0, h: 0, data: Buffer.alloc(0) },
			length: 12,
		})
		expect(parseRectangle(header(0, 0, 0, 0, RFB_ENCODING_DESKTOP_SIZE), screen)).toEqual({
			value: { encoding: 'resize', width: 0, height: 0 },
			length: 12,
		})
	})

	test('a CopyRect cut after its header asks for the source position', () => {
		const buf = Buffer.concat([header(0, 0, 2, 2, RFB_ENCODING_COPYRECT), bytes('0000')])
		expect(parseRectangle(buf, screen)).toBe(16)
	})

	test('rejects an encoding it cannot decode', () => {
		expect(() => parseRectangle(header(0, 0, 2, 2, 16), screen)).toThrow(
			/Unsupported RFB encoding 16/,
		)
	})
})

describe('charToKeysym', () => {
	test('maps printable ASCII and Latin-1 to their code point', () => {
		expect(charToKeysym('a')).toBe(0x61)
		expect(charToKeysym('Z')).toBe(0x5a)
		expect(charToKeysym('~')).toBe(0x7e)
		expect(charToKeysym(' ')).toBe(0x20)
		expect(charToKeysym(char(0xf1))).toBe(0xf1)
	})

	test('maps the rest of the BMP into the Unicode keysym range', () => {
		expect(charToKeysym(char(0x20ac))).toBe(0x010020ac)
	})

	test('resolves key names case-insensitively', () => {
		expect(charToKeysym('enter')).toBe(0xff0d)
		expect(charToKeysym('F5')).toBe(0xffc2)
		expect(charToKeysym('PageDown')).toBe(0xff56)
		expect(charToKeysym('space')).toBe(0x20)
	})

	test('rejects control characters and unknown names with a console error', () => {
		for (const key of [char(0x0a), char(0x1f), char(0x7f), char(0x80), '', 'nosuchkey']) {
			expect(() => charToKeysym(key)).toThrow(PveConsoleError)
		}
	})
})

describe('parseKeyCombo', () => {
	test('returns a single keysym for a bare key', () => {
		expect(parseKeyCombo('a')).toEqual([0x61])
		expect(parseKeyCombo('f1')).toEqual([0xffbe])
	})

	test('splits on dash or plus, in the order written', () => {
		expect(parseKeyCombo('ctrl-c')).toEqual([0xffe3, 0x63])
		expect(parseKeyCombo('ctrl+alt+delete')).toEqual([0xffe3, 0xffe9, 0xffff])
		expect(parseKeyCombo('meta-r')).toEqual([0xffeb, 0x72])
		expect(parseKeyCombo(' ctrl + c ')).toEqual([0xffe3, 0x63])
	})

	test('keeps a trailing separator as the key itself', () => {
		expect(parseKeyCombo('-')).toEqual([0x2d])
		expect(parseKeyCombo('ctrl--')).toEqual([0xffe3, 0x2d])
		expect(parseKeyCombo('ctrl-+')).toEqual([0xffe3, 0x2b])
		expect(parseKeyCombo('shift-=')).toEqual([0xffe1, 0x3d])
	})

	test('rejects an empty combo', () => {
		expect(() => parseKeyCombo('')).toThrow(/Unknown key/)
	})
})

describe('key tables', () => {
	test('maps meta to Super so guest shortcuts reach the Windows key', () => {
		expect(SPECIAL_KEYS['meta']).toBe(SPECIAL_KEYS['super'])
	})

	test('lists the US shifted characters and the capitals', () => {
		expect(SHIFTED_CHARS.has('@')).toBe(true)
		expect(SHIFTED_CHARS.has('A')).toBe(true)
		expect(SHIFTED_CHARS.has('a')).toBe(false)
		expect(SHIFTED_CHARS.has('2')).toBe(false)
	})
})
