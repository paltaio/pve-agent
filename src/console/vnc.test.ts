import { describe, expect, test } from 'bun:test'
import type { PveClient } from '../core/client.ts'
import { PveConsoleError } from '../core/errors.ts'
import { vncDesEncrypt } from './des.ts'
import {
	buildClientCutText,
	MSG_BELL,
	MSG_FB_UPDATE,
	MSG_SERVER_CUT_TEXT,
	MSG_SET_COLOUR_MAP,
	RFB_ENCODING_COPYRECT,
	RFB_ENCODING_DESKTOP_SIZE,
	RFB_ENCODING_RAW,
} from './rfb.ts'
import type { ConsoleSocket, SocketFactory } from './socket.ts'
import { VncSession, type VncSessionOptions } from './vnc.ts'

/** A socket the test drives byte by byte. */
class FakeSocket implements ConsoleSocket {
	open = true
	readonly sent: Buffer[] = []
	closes = 0

	private messageHandler: ((data: Buffer) => void) | undefined
	private errorHandler: ((error: Error) => void) | undefined
	private closeHandler: (() => void) | undefined

	send(data: Buffer | string): void {
		this.sent.push(typeof data === 'string' ? Buffer.from(data, 'ascii') : data)
	}

	close(): void {
		this.closes++
		this.open = false
	}

	onOpen(): void {}

	onMessage(handler: (data: Buffer) => void): void {
		this.messageHandler = handler
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandler = handler
	}

	onClose(handler: () => void): void {
		this.closeHandler = handler
	}

	/** Delivers server bytes in pieces of `chunkSize`. */
	deliver(data: Buffer, chunkSize = data.length): void {
		for (let i = 0; i < data.length; i += chunkSize) {
			this.messageHandler?.(data.subarray(i, Math.min(i + chunkSize, data.length)))
		}
	}

	fireError(error: Error): void {
		this.errorHandler?.(error)
	}

	fireClose(): void {
		this.open = false
		this.closeHandler?.()
	}

	/** Everything sent since the marker. */
	since(marker: number): Buffer[] {
		return this.sent.slice(marker)
	}
}

const PASSWORD = 'sekret42'

function newSession(options: Partial<VncSessionOptions> = {}): VncSession {
	return new VncSession({
		client: {} as PveClient,
		node: 'ms01',
		vmid: 100,
		handshakeTimeoutMs: 1000,
		...options,
	})
}

const version = (text = 'RFB 003.008\n'): Buffer => Buffer.from(text, 'ascii')

const securityTypes = (types: number[]): Buffer => Buffer.from([types.length, ...types])

const securityResult = (code: number, reason?: string): Buffer => {
	const head = Buffer.alloc(4)
	head.writeUInt32BE(code, 0)
	if (reason === undefined) return head
	const body = Buffer.from(reason, 'utf8')
	const length = Buffer.alloc(4)
	length.writeUInt32BE(body.length, 0)
	return Buffer.concat([head, length, body])
}

const serverInit = (width: number, height: number, name = 'qemu'): Buffer => {
	const nameBytes = Buffer.from(name, 'utf8')
	const buf = Buffer.alloc(24 + nameBytes.length)
	buf.writeUInt16BE(width, 0)
	buf.writeUInt16BE(height, 2)
	buf.writeUInt32BE(nameBytes.length, 20)
	nameBytes.copy(buf, 24)
	return buf
}

interface Rect {
	x: number
	y: number
	w: number
	h: number
	encoding: number
	data?: Buffer
}

const fbUpdate = (rects: Rect[]): Buffer => {
	const head = Buffer.alloc(4)
	head.writeUInt8(MSG_FB_UPDATE, 0)
	head.writeUInt16BE(rects.length, 2)
	const parts: Buffer[] = [head]
	for (const rect of rects) {
		const header = Buffer.alloc(12)
		header.writeUInt16BE(rect.x, 0)
		header.writeUInt16BE(rect.y, 2)
		header.writeUInt16BE(rect.w, 4)
		header.writeUInt16BE(rect.h, 6)
		header.writeInt32BE(rect.encoding, 8)
		parts.push(header)
		if (rect.data) parts.push(rect.data)
	}
	return Buffer.concat(parts)
}

const rawPixels = (w: number, h: number, marker: number): Buffer => Buffer.alloc(w * h * 4, marker)

/** Raw payload whose every pixel in row r carries `first + r`. */
const rawRows = (w: number, h: number, first: number): Buffer => {
	const data = Buffer.alloc(w * h * 4)
	for (let row = 0; row < h; row++) data.fill(first + row, row * w * 4, (row + 1) * w * 4)
	return data
}

const copyRectSource = (srcX: number, srcY: number): Buffer => {
	const buf = Buffer.alloc(4)
	buf.writeUInt16BE(srcX, 0)
	buf.writeUInt16BE(srcY, 2)
	return buf
}

/** The first byte of each framebuffer row. */
const rowMarkers = (session: VncSession): number[] => {
	const frame = session.snapshot()
	const markers: number[] = []
	for (let row = 0; row < frame.height; row++) {
		markers.push(frame.buffer[row * frame.width * 4] ?? 0)
	}
	return markers
}

/** Key events as [down, keysym] pairs. */
const keyEvents = (frames: Buffer[]): [number, number][] =>
	frames.map((buf) => [buf.readUInt8(1), buf.readUInt32BE(4)])

/** Drives a socket through to ServerInit and returns the connected session. */
async function connected(
	options: {
		width?: number
		height?: number
		types?: number[]
		chunkSize?: number
		maxMessageBytes?: number
	} = {},
): Promise<{ session: VncSession; socket: FakeSocket }> {
	const socket = new FakeSocket()
	const session = newSession(
		options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes },
	)
	const types = options.types ?? [1]
	const opened = session.attach(socket, PASSWORD)
	const stream: Buffer[] = [version(), securityTypes(types)]
	if (types.includes(2)) stream.push(Buffer.alloc(16, 0x11))
	stream.push(securityResult(0), serverInit(options.width ?? 64, options.height ?? 32))

	socket.deliver(Buffer.concat(stream), options.chunkSize ?? Number.MAX_SAFE_INTEGER)
	await opened
	return { session, socket }
}

describe('RFB handshake', () => {
	test('echoes the version, picks security type 1 and resolves with the screen size', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket)

		socket.deliver(version())
		expect(socket.sent[0]).toEqual(Buffer.from('RFB 003.008\n', 'ascii'))

		socket.deliver(securityTypes([1]))
		expect(socket.sent[1]).toEqual(Buffer.from([1]))

		socket.deliver(securityResult(0))
		expect(socket.sent[2]).toEqual(Buffer.from([1]))

		socket.deliver(serverInit(800, 600))
		await expect(opened).resolves.toEqual({ width: 800, height: 600 })
		expect(session.connected).toBe(true)
		expect(session.screen?.width).toBe(800)
		expect(session.screen?.height).toBe(600)
	})

	test('answers the security type 2 challenge with its DES cipher text', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket, PASSWORD)
		const challenge = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')

		socket.deliver(Buffer.concat([version(), securityTypes([2, 1])]))
		expect(socket.sent[1]).toEqual(Buffer.from([2]))

		socket.deliver(challenge)
		expect(socket.sent[2]).toEqual(vncDesEncrypt(PASSWORD, challenge))

		socket.deliver(Buffer.concat([securityResult(0), serverInit(640, 480)]))
		await expect(opened).resolves.toEqual({ width: 640, height: 480 })
	})

	test('prefers type 2 over type 1 when it has a password', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket, PASSWORD)
		socket.deliver(Buffer.concat([version(), securityTypes([1, 2])]))
		expect(socket.sent[1]).toEqual(Buffer.from([2]))
		socket.fireClose()
		await expect(opened).rejects.toThrow(/closed before the RFB handshake/)
	})

	test('falls back to type 1 without a password', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket)
		socket.deliver(Buffer.concat([version(), securityTypes([2, 1])]))
		expect(socket.sent[1]).toEqual(Buffer.from([1]))
		socket.deliver(Buffer.concat([securityResult(0), serverInit(8, 8)]))
		await expect(opened).resolves.toEqual({ width: 8, height: 8 })
	})

	test('completes when the whole handshake arrives one byte at a time', async () => {
		const { session, socket } = await connected({
			width: 16,
			height: 8,
			types: [2],
			chunkSize: 1,
		})
		expect(session.connected).toBe(true)
		expect(socket.sent[0]).toEqual(Buffer.from('RFB 003.008\n', 'ascii'))
	})

	test('rejects a version string that is not RFB', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket)
		socket.deliver(Buffer.from('HTTP/1.1 40\n', 'ascii'))
		await expect(opened).rejects.toThrow(/Not an RFB version string/)
		expect(session.connected).toBe(false)
		expect(socket.closes).toBe(1)
	})

	test('rejects when only unknown security types are on offer', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket)
		socket.deliver(Buffer.concat([version(), securityTypes([16, 19])]))
		await expect(opened).rejects.toThrow(/No usable VNC security type on offer: 16, 19/)
	})

	test('rejects when the server wants a password vncproxy did not issue', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket)
		socket.deliver(Buffer.concat([version(), securityTypes([2])]))
		await expect(opened).rejects.toThrow(/vncproxy issued no password/)
	})

	test('reports the reason from a failed SecurityResult', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket, PASSWORD)
		socket.deliver(
			Buffer.concat([
				version(),
				securityTypes([2]),
				Buffer.alloc(16, 7),
				securityResult(1, 'Authentication failure'),
			]),
		)
		await expect(opened).rejects.toThrow(/VNC authentication failed: Authentication failure/)
	})

	test('times out inside the VNC ticket window', async () => {
		const socket = new FakeSocket()
		const session = newSession({ handshakeTimeoutMs: 20 })
		await expect(session.attach(socket)).rejects.toThrow(/did not finish within 20ms/)
		expect(socket.closes).toBe(1)
	})

	test('rejects when the socket closes mid-handshake', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket)
		socket.deliver(version())
		socket.fireClose()
		await expect(opened).rejects.toThrow(/closed before the RFB handshake finished/)
	})

	test('sends SetPixelFormat, SetEncodings and a full update request after ServerInit', async () => {
		const { socket } = await connected({ width: 32, height: 16 })
		const afterInit = socket.since(3)
		expect(afterInit[0]?.readUInt8(0)).toBe(0)
		expect(afterInit[1]?.toString('hex')).toBe('020000030000000100000000ffffff21')
		expect(afterInit[2]?.toString('hex')).toBe('03000000000000200010')
	})

	test('refuses a second socket on the same session', async () => {
		const { session } = await connected()
		expect(() => session.attach(new FakeSocket())).toThrow(/already has a socket/)
	})

	test('refuses a ServerInit screen the framebuffer cannot hold', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket)
		socket.deliver(
			Buffer.concat([version(), securityTypes([1]), securityResult(0), serverInit(65535, 65535)]),
		)
		await expect(opened).rejects.toThrow(/65535x65535/)
	})
})

describe('framebuffer updates', () => {
	test('applies a Raw rectangle, bumps the counter, emits update and asks for the next frame', async () => {
		const { session, socket } = await connected({ width: 4, height: 2 })
		const seen: number[] = []
		session.on('update', (seq) => seen.push(seq))
		const before = socket.sent.length

		socket.deliver(
			fbUpdate([
				{ x: 1, y: 0, w: 2, h: 2, encoding: RFB_ENCODING_RAW, data: rawPixels(2, 2, 0xab) },
			]),
		)

		expect(session.screen?.buffer[4]).toBe(0xab)
		expect(session.screen?.buffer[0]).toBe(0)
		expect(session.updateSeq).toBe(1)
		expect(seen).toEqual([1])
		expect(socket.since(before)[0]?.toString('hex')).toBe('03010000000000040002')
	})

	test('applies a CopyRect rectangle', async () => {
		const { session, socket } = await connected({ width: 4, height: 1 })
		socket.deliver(
			fbUpdate([
				{ x: 0, y: 0, w: 2, h: 1, encoding: RFB_ENCODING_RAW, data: rawPixels(2, 1, 0x5a) },
				{ x: 2, y: 0, w: 2, h: 1, encoding: RFB_ENCODING_COPYRECT, data: copyRectSource(0, 0) },
			]),
		)
		expect([...(session.screen?.buffer.subarray(8, 16) ?? [])]).toEqual(Array(8).fill(0x5a))
		expect(session.updateSeq).toBe(2)
	})

	test('blits overlapping rows without clobbering the source', async () => {
		const { session, socket } = await connected({ width: 4, height: 4 })
		socket.deliver(fbUpdate([{ x: 0, y: 0, w: 4, h: 4, encoding: 0, data: rawRows(4, 4, 1) }]))
		socket.deliver(fbUpdate([{ x: 0, y: 1, w: 4, h: 3, encoding: 1, data: copyRectSource(0, 0) }]))
		expect(rowMarkers(session)).toEqual([1, 1, 2, 3])
		socket.deliver(fbUpdate([{ x: 0, y: 0, w: 4, h: 3, encoding: 1, data: copyRectSource(0, 1) }]))
		expect(rowMarkers(session)).toEqual([1, 2, 3, 3])
	})

	test('resizes on DesktopSize and checks later rectangles against the new size', async () => {
		const { session, socket } = await connected({ width: 8, height: 4 })
		const sizes: [number, number][] = []
		session.on('resize', (w, h) => sizes.push([w, h]))

		socket.deliver(
			fbUpdate([
				{ x: 0, y: 0, w: 16, h: 8, encoding: RFB_ENCODING_DESKTOP_SIZE },
				{ x: 12, y: 6, w: 4, h: 2, encoding: RFB_ENCODING_RAW, data: rawPixels(4, 2, 0x77) },
			]),
		)

		expect(sizes).toEqual([[16, 8]])
		expect(session.screen?.width).toBe(16)
		expect(session.screen?.buffer).toHaveLength(16 * 8 * 4)
		expect(session.screen?.buffer[(6 * 16 + 12) * 4]).toBe(0x77)
		expect(session.connected).toBe(true)
	})

	test('applies each rectangle once when a message arrives in pieces', async () => {
		const { session, socket } = await connected({ width: 4, height: 4 })
		socket.deliver(fbUpdate([{ x: 0, y: 0, w: 4, h: 4, encoding: 0, data: rawRows(4, 4, 1) }]))
		const seen: number[] = []
		session.on('update', (seq) => seen.push(seq))

		// A scroll blit followed by the new bottom row, the shape a text console produces.
		const update = fbUpdate([
			{ x: 0, y: 0, w: 4, h: 3, encoding: 1, data: copyRectSource(0, 1) },
			{ x: 0, y: 3, w: 4, h: 1, encoding: 0, data: Buffer.alloc(16, 9) },
		])
		socket.deliver(update, 5)

		expect(rowMarkers(session)).toEqual([2, 3, 4, 9])
		expect(session.updateSeq).toBe(3)
		expect(seen).toEqual([3])
	})

	test('takes an update with no rectangles', async () => {
		const { session, socket } = await connected()
		socket.deliver(fbUpdate([]))
		expect(session.updateSeq).toBe(0)
		expect(session.connected).toBe(true)
	})

	test('fails the session on a rectangle that does not fit', async () => {
		const { session, socket } = await connected({ width: 4, height: 4 })
		const failures: Error[] = []
		session.on('error', (error) => failures.push(error))
		socket.deliver(
			fbUpdate([{ x: 3, y: 0, w: 4, h: 1, encoding: RFB_ENCODING_RAW, data: rawPixels(4, 1, 1) }]),
		)
		expect(failures[0]).toBeInstanceOf(PveConsoleError)
		expect(failures[0]?.message).toMatch(/does not fit the 4x4 framebuffer/)
		expect(session.connected).toBe(false)
	})

	test('fails the session on an unknown server message type', async () => {
		const { session, socket } = await connected()
		const failures: Error[] = []
		session.on('error', (error) => failures.push(error))
		socket.deliver(Buffer.from([250]))
		expect(failures[0]?.message).toMatch(/Unknown RFB server message type 250/)
		expect(session.connected).toBe(false)
	})

	test('consumes SetColourMapEntries and Bell', async () => {
		const { session, socket } = await connected({ width: 2, height: 2 })
		let bells = 0
		session.on('bell', () => bells++)

		const colourMap = Buffer.alloc(6 + 2 * 6)
		colourMap.writeUInt8(MSG_SET_COLOUR_MAP, 0)
		colourMap.writeUInt16BE(2, 4)
		socket.deliver(
			Buffer.concat([
				colourMap,
				Buffer.from([MSG_BELL]),
				fbUpdate([
					{ x: 0, y: 0, w: 1, h: 1, encoding: RFB_ENCODING_RAW, data: rawPixels(1, 1, 9) },
				]),
			]),
		)

		expect(bells).toBe(1)
		expect(session.updateSeq).toBe(1)
	})

	test('fails the session once a message passes the size limit', async () => {
		const { session, socket } = await connected({ width: 4, height: 4, maxMessageBytes: 4096 })
		const errors: Error[] = []
		session.on('error', (error) => errors.push(error))

		const head = Buffer.alloc(8)
		head.writeUInt8(MSG_SERVER_CUT_TEXT, 0)
		head.writeUInt32BE(0xff_ff_ff, 4)
		socket.deliver(head)

		expect(errors[0]?.message).toMatch(/over the 4096 byte limit/)
		expect(session.connected).toBe(false)
	})

	test('refuses a DesktopSize the framebuffer cannot hold', async () => {
		const { session, socket } = await connected()
		const errors: Error[] = []
		session.on('error', (error) => errors.push(error))
		socket.deliver(
			fbUpdate([{ x: 0, y: 0, w: 65535, h: 65535, encoding: RFB_ENCODING_DESKTOP_SIZE }]),
		)
		expect(errors[0]?.message).toMatch(/65535x65535/)
	})
})

describe('clipboard', () => {
	test('emits inbound ServerCutText', async () => {
		const { session, socket } = await connected()
		const seen: string[] = []
		session.on('clipboard', (text) => seen.push(text))

		const body = Buffer.from('copied text', 'latin1')
		const message = Buffer.alloc(8 + body.length)
		message.writeUInt8(MSG_SERVER_CUT_TEXT, 0)
		message.writeUInt32BE(body.length, 4)
		body.copy(message, 8)
		socket.deliver(message)

		expect(seen).toEqual(['copied text'])
	})

	test('sends ClientCutText', async () => {
		const { session, socket } = await connected()
		const before = socket.sent.length
		session.sendClipboard('paste me')
		expect(socket.since(before)[0]).toEqual(buildClientCutText('paste me'))
	})
})

describe('keyboard', () => {
	test('press holds every key of a combination and releases in reverse', async () => {
		const { session, socket } = await connected()
		const before = socket.sent.length
		session.press('ctrl-alt-delete')
		expect(keyEvents(socket.since(before))).toEqual([
			[1, 0xffe3],
			[1, 0xffe9],
			[1, 0xffff],
			[0, 0xffff],
			[0, 0xffe9],
			[0, 0xffe3],
		])
		expect(session.heldKeys).toEqual([])
	})

	test('type wraps shifted characters in a shift press and maps newline to enter', async () => {
		const { session, socket } = await connected()
		const before = socket.sent.length
		await session.type('aA@\n', { cps: 1000 })
		expect(keyEvents(socket.since(before))).toEqual([
			[1, 0x61],
			[0, 0x61],
			[1, 0xffe1],
			[1, 0x41],
			[0, 0x41],
			[0, 0xffe1],
			[1, 0xffe1],
			[1, 0x40],
			[0, 0x40],
			[0, 0xffe1],
			[1, 0xff0d],
			[0, 0xff0d],
		])
	})

	test('type paces characters at cps', async () => {
		const { session } = await connected()
		const started = Date.now()
		await session.type('abc', { cps: 50 })
		expect(Date.now() - started).toBeGreaterThanOrEqual(35)
		await expect(session.type('a', { cps: 0 })).rejects.toThrow(/cps must be positive/)
	})

	test('keyDown tracks the key until keyUp', async () => {
		const { session, socket } = await connected()
		const before = socket.sent.length
		session.keyDown('shift')
		expect(session.heldKeys).toEqual([0xffe1])
		session.keyUp('shift')
		expect(session.heldKeys).toEqual([])
		expect(keyEvents(socket.since(before))).toEqual([
			[1, 0xffe1],
			[0, 0xffe1],
		])
	})

	test('close lets go of held keys before the socket goes', async () => {
		const { session, socket } = await connected()
		session.keyDown('ctrl')
		session.keyDown('alt')
		const before = socket.sent.length
		session.close()
		expect(keyEvents(socket.since(before))).toEqual([
			[0, 0xffe3],
			[0, 0xffe9],
		])
		expect(session.heldKeys).toEqual([])
		expect(socket.closes).toBe(1)
	})

	test('refuses input once the session is gone', async () => {
		const { session } = await connected()
		session.close()
		expect(() => session.sendKeyEvent(true, 0x61)).toThrow(/not connected/)
	})
})

describe('pointer', () => {
	test('refuses coordinates outside the framebuffer', async () => {
		const { session } = await connected({ width: 32, height: 16 })
		expect(() => session.move(32, 0)).toThrow(/Pointer \(32, 0\) is outside the 32x16 framebuffer/)
		expect(() => session.move(0, -1)).toThrow(/outside the 32x16 framebuffer/)
		expect(() => session.move(1.5, 2)).toThrow(/must be integers/)
		expect(() => session.move(31, 15)).not.toThrow()
	})

	test('click moves, presses and releases at the same point', async () => {
		const { session, socket } = await connected({ width: 16, height: 16 })
		const before = socket.sent.length
		session.click(4, 5, 'right')
		const events = socket.since(before)
		expect(events.map((buf) => buf.readUInt8(1))).toEqual([0, 4, 0])
		expect(events.map((buf) => [buf.readUInt16BE(2), buf.readUInt16BE(4)])).toEqual([
			[4, 5],
			[4, 5],
			[4, 5],
		])
	})

	test('scroll sends wheel clicks', async () => {
		const { session, socket } = await connected({ width: 16, height: 16 })
		const before = socket.sent.length
		session.scroll(1, 2, 'down', 2)
		expect(socket.since(before).map((buf) => buf.readUInt8(1))).toEqual([16, 0, 16, 0])
	})
})

describe('requestUpdate and waitForUpdate', () => {
	test('requestUpdate asks for a full repaint and returns the counter', async () => {
		const { session, socket } = await connected({ width: 8, height: 4 })
		const before = socket.sent.length
		expect(session.requestUpdate()).toBe(0)
		expect(socket.since(before)[0]?.toString('hex')).toBe('03000000000000080004')
	})

	test('resolves on the next paint', async () => {
		const { session, socket } = await connected({ width: 4, height: 4 })
		const waiting = session.waitForUpdate(1000)
		socket.deliver(
			fbUpdate([{ x: 0, y: 0, w: 1, h: 1, encoding: RFB_ENCODING_RAW, data: rawPixels(1, 1, 8) }]),
		)
		await expect(waiting).resolves.toBe(1)
		await expect(session.waitForUpdate(1000, 0)).resolves.toBe(1)
	})

	test('rejects when the session closes instead of painting', async () => {
		const { session, socket } = await connected({ width: 4, height: 4 })
		const waiting = session.waitForUpdate(1000)
		socket.fireClose()
		await expect(waiting).rejects.toThrow(/closed/)
		await expect(session.waitForUpdate(60_000)).rejects.toThrow(/closed/)
	})

	test('rejects on its own timeout', async () => {
		const { session } = await connected({ width: 4, height: 4 })
		await expect(session.waitForUpdate(10)).rejects.toThrow(/No framebuffer update within 10ms/)
	})

	test('rejects before the handshake', async () => {
		await expect(newSession().waitForUpdate(10)).rejects.toThrow(/No framebuffer yet/)
	})
})

describe('session lifecycle', () => {
	test('emits close once however many times close is called', async () => {
		const { session } = await connected()
		let closes = 0
		session.on('close', () => closes++)
		session.close()
		session.close()
		expect(closes).toBe(1)
		expect(session.connected).toBe(false)
	})

	test('reports a socket error through the handshake promise', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket)
		socket.fireError(new Error('ECONNRESET'))
		await expect(opened).rejects.toThrow('ECONNRESET')
	})

	test('rejects a pending handshake when close is called', async () => {
		const socket = new FakeSocket()
		const session = newSession()
		const opened = session.attach(socket)
		socket.deliver(version())
		session.close()
		await expect(opened).rejects.toThrow(/closed before the RFB handshake finished/)
	})
})

/** A client stub that answers vncproxy and nothing else. */
function stubClient(): PveClient {
	return {
		baseUrl: 'https://192.168.80.21:8006',
		auth: { has: () => false, tokenHeader: () => 'PVEAPIToken=x' },
		http: { verifySsl: false },
		post: async () => ({ port: '5900', ticket: 'TICKET', user: 'root@pam', password: PASSWORD }),
	} as unknown as PveClient
}

/** A socket factory that plays a whole RFB handshake once the socket exists. */
function handshakeFactory(sockets: FakeSocket[], types: number[]): SocketFactory {
	return (url, options) => {
		const socket = new FakeSocket()
		sockets.push(socket)
		queueMicrotask(() => {
			const stream = [version(), securityTypes(types)]
			if (types.includes(2)) stream.push(Buffer.alloc(16, 0x11))
			stream.push(securityResult(0), serverInit(800, 600))
			socket.deliver(Buffer.concat(stream))
		})
		Object.assign(socket, { url, options })
		return socket
	}
}

describe('connect', () => {
	test('opens the socket at the vncwebsocket URL with the token header and the proxy password', async () => {
		const sockets: FakeSocket[] = []
		const session = newSession({
			client: stubClient(),
			socketFactory: handshakeFactory(sockets, [2]),
		})
		await expect(session.connect()).resolves.toEqual({ width: 800, height: 600 })
		expect(sockets[0]).toMatchObject({
			url: 'wss://192.168.80.21:8006/api2/json/nodes/ms01/qemu/100/vncwebsocket?port=5900&vncticket=TICKET',
			options: { headers: { Authorization: 'PVEAPIToken=x' }, verifySsl: false },
		})
		expect(sockets[0]?.sent[2]).toEqual(vncDesEncrypt(PASSWORD, Buffer.alloc(16, 0x11)))
		session.close()
	})

	test('closes the socket it opened when the session already has one', async () => {
		const sockets: FakeSocket[] = []
		const session = newSession({
			client: stubClient(),
			socketFactory: handshakeFactory(sockets, [1]),
		})
		session.attach(new FakeSocket()).catch(() => undefined)

		await expect(session.connect()).rejects.toThrow(/already has a socket/)
		expect(sockets).toHaveLength(1)
		expect(sockets[0]?.closes).toBe(1)
		session.close()
	})
})
