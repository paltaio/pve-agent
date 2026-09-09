/**
 * RFB 3.8 wire format: the client messages a session sends, parsers for what
 * the server answers, and the keysym tables the keyboard helpers map through.
 *
 * Parsers take a buffer that starts at a message boundary. A complete message
 * comes back as a value plus the bytes it occupied; a message still in flight
 * comes back as the number of bytes it needs before it can be read at all.
 */

import { PveConsoleError } from '../core/errors.ts'

export const CLIENT_VERSION = 'RFB 003.008\n'

export const SECURITY_NONE = 1
export const SECURITY_VNC_AUTH = 2

export const RFB_ENCODING_RAW = 0
export const RFB_ENCODING_COPYRECT = 1
export const RFB_ENCODING_DESKTOP_SIZE = -223

export const MSG_SET_PIXEL_FORMAT = 0
export const MSG_SET_ENCODINGS = 2
export const MSG_FB_UPDATE_REQUEST = 3
export const MSG_KEY_EVENT = 4
export const MSG_POINTER_EVENT = 5
export const MSG_CLIENT_CUT_TEXT = 6

export const MSG_FB_UPDATE = 0
export const MSG_SET_COLOUR_MAP = 1
export const MSG_BELL = 2
export const MSG_SERVER_CUT_TEXT = 3

/**
 * The pixel format every session asks for: 32 bits per pixel, depth 24,
 * little-endian, true colour, shifts R=16 G=8 B=0. Pixels land in memory as
 * B, G, R, unused.
 */
export const PIXEL_FORMAT = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])

// --- Client messages ---

export function buildSetPixelFormat(): Buffer {
	const buf = Buffer.alloc(20)
	buf.writeUInt8(MSG_SET_PIXEL_FORMAT, 0)
	PIXEL_FORMAT.copy(buf, 4)
	return buf
}

/** Encodings in preference order. */
export function buildSetEncodings(encodings: readonly number[]): Buffer {
	const buf = Buffer.alloc(4 + encodings.length * 4)
	buf.writeUInt8(MSG_SET_ENCODINGS, 0)
	buf.writeUInt16BE(encodings.length, 2)
	encodings.forEach((encoding, i) => buf.writeInt32BE(encoding, 4 + i * 4))
	return buf
}

export function buildFbUpdateRequest(
	incremental: boolean,
	x: number,
	y: number,
	w: number,
	h: number,
): Buffer {
	const buf = Buffer.alloc(10)
	buf.writeUInt8(MSG_FB_UPDATE_REQUEST, 0)
	buf.writeUInt8(incremental ? 1 : 0, 1)
	buf.writeUInt16BE(x, 2)
	buf.writeUInt16BE(y, 4)
	buf.writeUInt16BE(w, 6)
	buf.writeUInt16BE(h, 8)
	return buf
}

export function buildKeyEvent(down: boolean, keysym: number): Buffer {
	const buf = Buffer.alloc(8)
	buf.writeUInt8(MSG_KEY_EVENT, 0)
	buf.writeUInt8(down ? 1 : 0, 1)
	buf.writeUInt32BE(keysym, 4)
	return buf
}

export function buildPointerEvent(buttonMask: number, x: number, y: number): Buffer {
	const buf = Buffer.alloc(6)
	buf.writeUInt8(MSG_POINTER_EVENT, 0)
	buf.writeUInt8(buttonMask, 1)
	buf.writeUInt16BE(x, 2)
	buf.writeUInt16BE(y, 4)
	return buf
}

/** RFB carries clipboard text as latin-1. */
export function buildClientCutText(text: string): Buffer {
	const body = Buffer.from(text, 'latin1')
	const buf = Buffer.alloc(8 + body.length)
	buf.writeUInt8(MSG_CLIENT_CUT_TEXT, 0)
	buf.writeUInt32BE(body.length, 4)
	body.copy(buf, 8)
	return buf
}

/** ClientInit. The shared flag keeps an open web console attached. */
export function buildClientInit(shared: boolean): Buffer {
	return Buffer.from([shared ? 1 : 0])
}

// --- Server messages ---

export interface Parsed<T> {
	value: T
	/** Bytes the message occupied. */
	length: number
}

/** A value, or the byte count the buffer has to reach before the message can be read. */
export type ParseResult<T> = Parsed<T> | number

export interface ServerInit {
	width: number
	height: number
	name: string
}

export interface ScreenSize {
	width: number
	height: number
}

export type ServerMessage =
	| { type: 'update'; rectCount: number }
	| { type: 'bell' }
	| { type: 'cut-text'; text: string }
	| { type: 'colour-map' }

export type Rectangle =
	| { encoding: 'raw'; x: number; y: number; w: number; h: number; data: Buffer }
	| { encoding: 'copy'; x: number; y: number; w: number; h: number; srcX: number; srcY: number }
	| { encoding: 'resize'; width: number; height: number }

/** ProtocolVersion: 12 ASCII bytes such as `RFB 003.008\n`. */
export function parseProtocolVersion(buf: Buffer): ParseResult<string> {
	if (buf.length < 12) return 12
	const version = buf.toString('ascii', 0, 12)
	if (!/^RFB \d{3}\.\d{3}\n$/.test(version)) {
		throw new PveConsoleError(`Not an RFB version string: ${JSON.stringify(version)}`)
	}
	return { value: version, length: 12 }
}

/**
 * The security types on offer. A count of zero means the server refused the
 * connection and a reason string follows.
 */
export function parseSecurityTypes(buf: Buffer): ParseResult<number[]> {
	if (buf.length < 1) return 1
	const count = buf.readUInt8(0)
	if (count === 0) {
		const reason = readReason(buf, 1)
		if (typeof reason === 'number') return reason
		throw new PveConsoleError(`The VNC server refused the connection: ${reason}`)
	}
	if (buf.length < 1 + count) return 1 + count
	return { value: [...buf.subarray(1, 1 + count)], length: 1 + count }
}

/** SecurityResult: 0 for success; any other value carries a reason string. */
export function parseSecurityResult(buf: Buffer): ParseResult<void> {
	if (buf.length < 4) return 4
	if (buf.readUInt32BE(0) !== 0) {
		const reason = readReason(buf, 4)
		if (typeof reason === 'number') return reason
		throw new PveConsoleError(`VNC authentication failed: ${reason}`)
	}
	return { value: undefined, length: 4 }
}

/** ServerInit: width, height, the server's pixel format, then the desktop name. */
export function parseServerInit(buf: Buffer): ParseResult<ServerInit> {
	if (buf.length < 24) return 24
	const nameLength = buf.readUInt32BE(20)
	if (buf.length < 24 + nameLength) return 24 + nameLength
	return {
		value: {
			width: buf.readUInt16BE(0),
			height: buf.readUInt16BE(2),
			name: buf.toString('utf8', 24, 24 + nameLength),
		},
		length: 24 + nameLength,
	}
}

/**
 * One server message header. A FramebufferUpdate is returned as its rectangle
 * count; the rectangles follow and are read one at a time with parseRectangle.
 */
export function parseServerMessage(buf: Buffer): ParseResult<ServerMessage> {
	if (buf.length < 1) return 1
	const type = buf.readUInt8(0)
	switch (type) {
		case MSG_FB_UPDATE:
			if (buf.length < 4) return 4
			return { value: { type: 'update', rectCount: buf.readUInt16BE(2) }, length: 4 }
		case MSG_SET_COLOUR_MAP: {
			if (buf.length < 6) return 6
			const total = 6 + buf.readUInt16BE(4) * 6
			if (buf.length < total) return total
			return { value: { type: 'colour-map' }, length: total }
		}
		case MSG_BELL:
			return { value: { type: 'bell' }, length: 1 }
		case MSG_SERVER_CUT_TEXT: {
			if (buf.length < 8) return 8
			const length = buf.readUInt32BE(4)
			if (buf.length < 8 + length) return 8 + length
			return {
				value: { type: 'cut-text', text: buf.toString('latin1', 8, 8 + length) },
				length: 8 + length,
			}
		}
		default:
			throw new PveConsoleError(`Unknown RFB server message type ${type}`)
	}
}

/**
 * One rectangle of a FramebufferUpdate, checked against the screen it will be
 * painted on. A DesktopSize rectangle changes that screen for the rectangles
 * after it, so the caller passes the size as it stands.
 */
export function parseRectangle(buf: Buffer, screen: ScreenSize): ParseResult<Rectangle> {
	if (buf.length < 12) return 12
	const x = buf.readUInt16BE(0)
	const y = buf.readUInt16BE(2)
	const w = buf.readUInt16BE(4)
	const h = buf.readUInt16BE(6)
	const encoding = buf.readInt32BE(8)

	switch (encoding) {
		case RFB_ENCODING_RAW: {
			const length = 12 + w * h * 4
			if (buf.length < length) return length
			checkBounds(screen, x, y, w, h, 'Raw')
			return { value: { encoding: 'raw', x, y, w, h, data: buf.subarray(12, length) }, length }
		}
		case RFB_ENCODING_COPYRECT: {
			if (buf.length < 16) return 16
			const srcX = buf.readUInt16BE(12)
			const srcY = buf.readUInt16BE(14)
			checkBounds(screen, x, y, w, h, 'CopyRect destination')
			checkBounds(screen, srcX, srcY, w, h, 'CopyRect source')
			return { value: { encoding: 'copy', x, y, w, h, srcX, srcY }, length: 16 }
		}
		case RFB_ENCODING_DESKTOP_SIZE:
			return { value: { encoding: 'resize', width: w, height: h }, length: 12 }
		default:
			throw new PveConsoleError(
				`Unsupported RFB encoding ${encoding} in a ${w}x${h} rectangle at (${x}, ${y})`,
			)
	}
}

/** A length-prefixed reason string at `offset`, or the bytes needed to read it. */
function readReason(buf: Buffer, offset: number): string | number {
	if (buf.length < offset + 4) return offset + 4
	const length = buf.readUInt32BE(offset)
	if (buf.length < offset + 4 + length) return offset + 4 + length
	return buf.toString('utf8', offset + 4, offset + 4 + length)
}

function checkBounds(
	screen: ScreenSize,
	x: number,
	y: number,
	w: number,
	h: number,
	what: string,
): void {
	if (x + w > screen.width || y + h > screen.height) {
		throw new PveConsoleError(
			`${what} rectangle ${w}x${h} at (${x}, ${y}) does not fit the ${screen.width}x${screen.height} framebuffer`,
		)
	}
}

// --- Keysyms ---

/** X11 keysyms by key name. Names are matched in lower case. */
export const SPECIAL_KEYS: Readonly<Record<string, number>> = {
	return: 0xff0d,
	enter: 0xff0d,
	escape: 0xff1b,
	esc: 0xff1b,
	backspace: 0xff08,
	tab: 0xff09,
	space: 0x0020,
	delete: 0xffff,
	insert: 0xff63,
	home: 0xff50,
	end: 0xff57,
	pageup: 0xff55,
	pagedown: 0xff56,
	left: 0xff51,
	up: 0xff52,
	right: 0xff53,
	down: 0xff54,
	f1: 0xffbe,
	f2: 0xffbf,
	f3: 0xffc0,
	f4: 0xffc1,
	f5: 0xffc2,
	f6: 0xffc3,
	f7: 0xffc4,
	f8: 0xffc5,
	f9: 0xffc6,
	f10: 0xffc7,
	f11: 0xffc8,
	f12: 0xffc9,
	shift: 0xffe1,
	shift_l: 0xffe1,
	shift_r: 0xffe2,
	ctrl: 0xffe3,
	control: 0xffe3,
	control_l: 0xffe3,
	control_r: 0xffe4,
	alt: 0xffe9,
	alt_l: 0xffe9,
	alt_r: 0xffea,
	altgr: 0xfe03,
	super: 0xffeb,
	super_l: 0xffeb,
	super_r: 0xffec,
	// Guests read the Windows key as Super, so meta+r opens the run box.
	meta: 0xffeb,
	meta_l: 0xffeb,
	meta_r: 0xffec,
	capslock: 0xffe5,
	numlock: 0xff7f,
	scrolllock: 0xff14,
	printscreen: 0xff61,
	pause: 0xff13,
	menu: 0xff67,
}

/** Characters a US keyboard types with shift held. */
export const SHIFTED_CHARS: ReadonlySet<string> = new Set(
	'~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ',
)

/**
 * The keysym for a key name or a single character. Printable ASCII and
 * Latin-1 map to their code point; the rest of the BMP uses the Unicode
 * keysym range.
 */
export function charToKeysym(key: string): number {
	const named = SPECIAL_KEYS[key.toLowerCase()]
	if (named !== undefined) return named

	if (key.length === 1) {
		const code = key.charCodeAt(0)
		if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code
		if (code > 0xff) return 0x01000000 + code
	}

	throw new PveConsoleError(`Unknown key: ${JSON.stringify(key)}`)
}

/**
 * Keysyms of a combination such as `ctrl-alt-delete` or `ctrl+c`, in the
 * order written. Either separator works; a separator with nothing after it
 * is the key itself, so `ctrl--` is ctrl and minus.
 */
export function parseKeyCombo(combo: string): number[] {
	return combo
		.trim()
		.split(/\s*[+-]\s*(?=\S)/)
		.map(charToKeysym)
}
