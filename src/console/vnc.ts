/**
 * An RFB session to a guest over the PVE VNC WebSocket proxy.
 *
 * vncproxy spawns a proxy worker and answers with a port, a VNC ticket good
 * for about forty seconds and a one-time password; the WebSocket carries the
 * raw RFB stream from there, and the handshake runs under a timeout well
 * inside the ticket window. The guest has to be running: a stopped guest has
 * no VNC server behind the proxy and the handshake never starts.
 */

import { EventEmitter } from 'node:events'
import type { PveClient } from '../core/client.ts'
import { PveConfigError, PveConsoleError } from '../core/errors.ts'
import { sleep } from '../core/poll.ts'
import { vncDesEncrypt } from './des.ts'
import {
	buildClientCutText,
	buildClientInit,
	buildFbUpdateRequest,
	buildKeyEvent,
	buildPointerEvent,
	buildSetEncodings,
	buildSetPixelFormat,
	charToKeysym,
	CLIENT_VERSION,
	parseKeyCombo,
	parseProtocolVersion,
	parseRectangle,
	parseSecurityResult,
	parseSecurityTypes,
	parseServerInit,
	parseServerMessage,
	RFB_ENCODING_COPYRECT,
	RFB_ENCODING_DESKTOP_SIZE,
	RFB_ENCODING_RAW,
	SECURITY_NONE,
	SECURITY_VNC_AUTH,
	SHIFTED_CHARS,
	type ParseResult,
	type Parsed,
	type Rectangle,
} from './rfb.ts'
import {
	consoleAuthHeaders,
	consoleWebSocketUrl,
	requestVncProxy,
	type GuestRef,
	type GuestType,
} from './proxy.ts'
import { openWebSocket, type ConsoleSocket, type SocketFactory } from './socket.ts'

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000
const DEFAULT_CPS = 20
/** Largest screen a framebuffer is allocated for, at 4 bytes per pixel. */
const MAX_SCREEN_PIXELS = 7680 * 4320
/** A Raw rectangle covering the largest screen, plus its 12-byte header. */
const DEFAULT_MAX_MESSAGE_BYTES = MAX_SCREEN_PIXELS * 4 + 12
const ENCODINGS = [RFB_ENCODING_COPYRECT, RFB_ENCODING_RAW, RFB_ENCODING_DESKTOP_SIZE]
/** Control characters `type` sends as a key. */
const TYPED_CONTROL_KEYS: Readonly<Record<string, string>> = {
	'\n': 'enter',
	'\r': 'enter',
	'\t': 'tab',
}

/** Button bits of a PointerEvent mask. */
export const POINTER_BUTTONS = {
	left: 1,
	middle: 2,
	right: 4,
	scrollUp: 8,
	scrollDown: 16,
} as const

export type MouseButton = 'left' | 'middle' | 'right'

export interface VncScreenSize {
	width: number
	height: number
}

export interface FramebufferSnapshot {
	width: number
	height: number
	/** Owned copy, safe to read across an await. */
	buffer: Buffer
	/** The paint counter at the moment of the snapshot. */
	seq: number
}

/**
 * The guest's screen as painted by FramebufferUpdate rectangles, 4 bytes per
 * pixel in the session's pixel format. Every paint bumps `updateSeq`, so a
 * reader waits for the next frame by comparing counters.
 */
export class Framebuffer {
	private _width: number
	private _height: number
	private _buffer: Buffer
	private _updateSeq = 0

	constructor(width: number, height: number) {
		this._width = width
		this._height = height
		this._buffer = Buffer.alloc(width * height * 4)
	}

	get width(): number {
		return this._width
	}

	get height(): number {
		return this._height
	}

	/** The live pixels. A paint can land between two reads; prefer `snapshot()`. */
	get buffer(): Buffer {
		return this._buffer
	}

	/** Paint counter, starting at 0. */
	get updateSeq(): number {
		return this._updateSeq
	}

	snapshot(): FramebufferSnapshot {
		return {
			width: this._width,
			height: this._height,
			buffer: Buffer.from(this._buffer),
			seq: this._updateSeq,
		}
	}

	applyRaw(x: number, y: number, w: number, h: number, data: Buffer): void {
		const stride = this._width * 4
		for (let row = 0; row < h; row++) {
			const src = row * w * 4
			data.copy(this._buffer, (y + row) * stride + x * 4, src, src + w * 4)
		}
		this._updateSeq++
	}

	/** Blits a rectangle from (srcX, srcY) to (dstX, dstY) inside the frame. */
	applyCopyRect(
		dstX: number,
		dstY: number,
		w: number,
		h: number,
		srcX: number,
		srcY: number,
	): void {
		const stride = this._width * 4
		// Overlapping rows are copied bottom-up when the destination sits below
		// the source, so no source row is overwritten before it is read.
		const bottomUp = srcY < dstY || (srcY === dstY && srcX < dstX)
		for (let i = 0; i < h; i++) {
			const row = bottomUp ? h - 1 - i : i
			const src = (srcY + row) * stride + srcX * 4
			this._buffer.copy(this._buffer, (dstY + row) * stride + dstX * 4, src, src + w * 4)
		}
		this._updateSeq++
	}

	/** Takes the DesktopSize pseudo-encoding: a new blank surface. */
	resize(width: number, height: number): void {
		this._width = width
		this._height = height
		this._buffer = Buffer.alloc(width * height * 4)
		this._updateSeq++
	}
}

export interface VncSessionOptions {
	client: PveClient
	node: string
	vmid: number
	/** Defaults to qemu. */
	type?: GuestType
	/** Milliseconds allowed for the RFB handshake. Defaults to 15000. */
	handshakeTimeoutMs?: number
	/** Bytes held for one incomplete server message before the session fails. Defaults to 64 MiB. */
	maxMessageBytes?: number
	/** Opens the WebSocket. Replaceable for tests. */
	socketFactory?: SocketFactory
}

export interface TypeOptions {
	/** Characters per second. Defaults to 20. */
	cps?: number
}

export interface VncSessionEvents {
	/** The framebuffer changed; carries the new paint counter. */
	update: [seq: number]
	resize: [width: number, height: number]
	/** The guest put text on its clipboard. */
	clipboard: [text: string]
	bell: []
	close: []
	error: [error: Error]
}

type State =
	| 'version'
	| 'security-types'
	| 'challenge'
	| 'security-result'
	| 'server-init'
	| 'message'
	| 'rectangles'

interface Settler {
	resolve: (size: VncScreenSize) => void
	reject: (error: Error) => void
}

/** Sessions holding a key down, so the process can let go of them on exit. */
const holdingKeys = new Set<VncSession>()
let exitHookInstalled = false

function trackHeldKeys(session: VncSession): void {
	holdingKeys.add(session)
	if (exitHookInstalled) return
	exitHookInstalled = true
	process.on('exit', () => {
		for (const held of holdingKeys) held.releaseKeys()
	})
}

/** One RFB connection to one guest. */
export class VncSession extends EventEmitter<VncSessionEvents> {
	readonly node: string
	readonly vmid: number
	readonly guestType: GuestType

	private readonly client: PveClient
	private readonly handshakeTimeoutMs: number
	private readonly maxMessageBytes: number
	private readonly socketFactory: SocketFactory

	private socket: ConsoleSocket | undefined
	private framebuffer: Framebuffer | undefined
	private chunks: Buffer[] = []
	private buffered = 0
	/** Bytes the next parse needs; nothing is tried until they have arrived. */
	private need = 1
	private state: State = 'version'
	private pendingRects = 0
	private painted = false
	private settler: Settler | undefined
	private handshakeTimer: ReturnType<typeof setTimeout> | undefined
	private password = ''
	private readonly held = new Set<number>()
	private lastError: Error | undefined
	private closeEmitted = false

	constructor(options: VncSessionOptions) {
		super()
		this.client = options.client
		this.node = options.node
		this.vmid = options.vmid
		this.guestType = options.type ?? 'qemu'
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
		this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
		this.socketFactory = options.socketFactory ?? openWebSocket
	}

	/** True once the handshake finished and the socket is still up. */
	get connected(): boolean {
		return this.socket !== undefined && (this.state === 'message' || this.state === 'rectangles')
	}

	/** The live framebuffer, or undefined before ServerInit. */
	get screen(): Framebuffer | undefined {
		return this.framebuffer
	}

	/** Paint counter. 0 until the first rectangle lands. */
	get updateSeq(): number {
		return this.framebuffer?.updateSeq ?? 0
	}

	/** Keysyms currently held down through keyDown. */
	get heldKeys(): readonly number[] {
		return [...this.held]
	}

	snapshot(): FramebufferSnapshot {
		return this.requireFramebuffer().snapshot()
	}

	/**
	 * Spawns a proxy worker, opens the WebSocket and runs the RFB handshake.
	 * Resolves with the guest's screen size.
	 */
	async connect(): Promise<VncScreenSize> {
		const guest: GuestRef = { node: this.node, vmid: this.vmid, type: this.guestType }
		const proxy = await requestVncProxy(this.client, guest)
		const url = consoleWebSocketUrl(this.client.baseUrl, guest, proxy.port, proxy.ticket)
		const headers = await consoleAuthHeaders(this.client.auth)
		const socket = this.socketFactory(url, { headers, verifySsl: this.client.http.verifySsl })
		try {
			return await this.attach(socket, proxy.password)
		} catch (error) {
			socket.close()
			throw error
		}
	}

	/** Runs the RFB handshake over a socket the caller opened. */
	attach(socket: ConsoleSocket, password?: string): Promise<VncScreenSize> {
		if (this.socket) throw new PveConfigError('This VNC session already has a socket')

		this.socket = socket
		this.password = password ?? ''
		this.resetReceiver()
		this.state = 'version'
		this.closeEmitted = false
		this.lastError = undefined

		return new Promise<VncScreenSize>((resolve, reject) => {
			this.settler = { resolve, reject }
			this.handshakeTimer = setTimeout(() => {
				this.fail(
					new PveConsoleError(
						`RFB handshake did not finish within ${this.handshakeTimeoutMs}ms; the VNC ticket lasts about 40 seconds`,
					),
				)
			}, this.handshakeTimeoutMs)
			this.handshakeTimer.unref()

			socket.onMessage((chunk) => this.receive(chunk))
			socket.onError((error) => this.fail(error))
			socket.onClose(() => {
				if (this.settler) {
					this.fail(new PveConsoleError('The WebSocket closed before the RFB handshake finished'))
					return
				}
				this.teardown()
			})
		})
	}

	/** Lets go of every held key, closes the socket and emits `close` once. */
	close(): void {
		this.releaseKeys()
		this.teardown()
	}

	// --- Keyboard ---

	sendKeyEvent(down: boolean, keysym: number): void {
		this.send(buildKeyEvent(down, keysym))
	}

	/** Holds a key down until keyUp, close or process exit. */
	keyDown(key: string): void {
		const keysym = charToKeysym(key)
		this.sendKeyEvent(true, keysym)
		this.held.add(keysym)
		trackHeldKeys(this)
	}

	keyUp(key: string): void {
		const keysym = charToKeysym(key)
		this.sendKeyEvent(false, keysym)
		this.forgetHeld(keysym)
	}

	/**
	 * Taps a key or a combination such as `ctrl-alt-delete`: every key goes
	 * down in the order written and comes back up in reverse.
	 */
	press(combo: string): void {
		const keysyms = parseKeyCombo(combo)
		for (const keysym of keysyms) this.sendKeyEvent(true, keysym)
		for (const keysym of keysyms.reverse()) this.sendKeyEvent(false, keysym)
	}

	/**
	 * Types text one character at a time at `cps` characters per second.
	 * Characters a US keyboard reaches with shift are wrapped in a shift press;
	 * newline, carriage return and tab go out as enter and tab, and any other
	 * control character is skipped.
	 */
	async type(text: string, options: TypeOptions = {}): Promise<void> {
		const cps = options.cps ?? DEFAULT_CPS
		if (!(cps > 0)) throw new PveConfigError(`cps must be positive, got ${cps}`)
		const shift = charToKeysym('shift')
		let first = true
		for (const char of text) {
			const named = TYPED_CONTROL_KEYS[char]
			if (named === undefined && /^[\0-\x1f\x7f]$/.test(char)) continue
			if (!first) await sleep(1000 / cps)
			first = false
			const keysym = charToKeysym(named ?? char)
			const shifted = SHIFTED_CHARS.has(char)
			if (shifted) this.sendKeyEvent(true, shift)
			this.sendKeyEvent(true, keysym)
			this.sendKeyEvent(false, keysym)
			if (shifted) this.sendKeyEvent(false, shift)
		}
	}

	/** Sends key-up for every key keyDown is still holding. */
	releaseKeys(): void {
		for (const keysym of this.held) {
			if (this.socket?.open) this.socket.send(buildKeyEvent(false, keysym))
		}
		this.held.clear()
		holdingKeys.delete(this)
	}

	// --- Pointer ---

	/**
	 * Sends a PointerEvent. Coordinates are checked against the framebuffer,
	 * since a guest silently ignores a pointer outside it.
	 */
	sendPointerEvent(buttonMask: number, x: number, y: number): void {
		const fb = this.requireFramebuffer()
		if (!Number.isInteger(x) || !Number.isInteger(y)) {
			throw new PveConfigError(`Pointer coordinates must be integers, got (${x}, ${y})`)
		}
		if (x < 0 || y < 0 || x >= fb.width || y >= fb.height) {
			throw new PveConfigError(
				`Pointer (${x}, ${y}) is outside the ${fb.width}x${fb.height} framebuffer`,
			)
		}
		this.send(buildPointerEvent(buttonMask, x, y))
	}

	move(x: number, y: number): void {
		this.sendPointerEvent(0, x, y)
	}

	/** Moves to a point, presses a button there and releases it. */
	click(x: number, y: number, button: MouseButton = 'left'): void {
		const mask = POINTER_BUTTONS[button]
		this.sendPointerEvent(0, x, y)
		this.sendPointerEvent(mask, x, y)
		this.sendPointerEvent(0, x, y)
	}

	/** Sends `amount` wheel clicks at a point. */
	scroll(x: number, y: number, direction: 'up' | 'down', amount = 3): void {
		const mask = direction === 'up' ? POINTER_BUTTONS.scrollUp : POINTER_BUTTONS.scrollDown
		for (let i = 0; i < amount; i++) {
			this.sendPointerEvent(mask, x, y)
			this.sendPointerEvent(0, x, y)
		}
	}

	/** Puts text on the guest's clipboard. RFB carries it as latin-1. */
	sendClipboard(text: string): void {
		this.send(buildClientCutText(text))
	}

	// --- Framebuffer ---

	/** Asks for a full repaint. Returns the paint counter at the time of the request. */
	requestUpdate(): number {
		const fb = this.requireFramebuffer()
		this.send(buildFbUpdateRequest(false, 0, 0, fb.width, fb.height))
		return fb.updateSeq
	}

	/**
	 * Resolves with the paint counter once it passes `since`, which defaults to
	 * the current value. Rejects on timeout and when the session closes.
	 */
	waitForUpdate(timeoutMs = 3000, since?: number): Promise<number> {
		const fb = this.framebuffer
		if (!fb) return Promise.reject(noFramebuffer())
		const baseline = since ?? fb.updateSeq
		if (fb.updateSeq > baseline) return Promise.resolve(fb.updateSeq)
		if (!this.connected) return Promise.reject(this.closedError())

		return new Promise<number>((resolve, reject) => {
			const cleanup = (): void => {
				clearTimeout(timer)
				this.removeListener('update', onUpdate)
				this.removeListener('close', onClose)
			}
			const onUpdate = (seq: number): void => {
				if (seq <= baseline) return
				cleanup()
				resolve(seq)
			}
			const onClose = (): void => {
				cleanup()
				reject(this.closedError())
			}
			const timer = setTimeout(() => {
				cleanup()
				reject(
					new PveConsoleError(
						`No framebuffer update within ${timeoutMs}ms (paint counter still ${fb.updateSeq})`,
					),
				)
			}, timeoutMs)
			timer.unref()
			this.on('update', onUpdate)
			this.once('close', onClose)
		})
	}

	// --- Internals ---

	private send(data: Buffer | string): void {
		const socket = this.socket
		if (!socket?.open) throw new PveConsoleError('The VNC session is not connected')
		socket.send(data)
	}

	private requireFramebuffer(): Framebuffer {
		if (!this.framebuffer) throw noFramebuffer()
		return this.framebuffer
	}

	private closedError(): Error {
		return this.lastError ?? new PveConsoleError('The VNC session is closed')
	}

	private forgetHeld(keysym: number): void {
		this.held.delete(keysym)
		if (this.held.size === 0) holdingKeys.delete(this)
	}

	private receive(chunk: Buffer): void {
		this.chunks.push(chunk)
		this.buffered += chunk.length
		try {
			while (this.socket && this.buffered >= this.need) {
				const buf =
					this.chunks.length === 1 ? (this.chunks[0] ?? chunk) : Buffer.concat(this.chunks)
				const consumed = this.step(buf)
				if (consumed === 0) {
					this.chunks = [buf]
					break
				}
				const rest = buf.subarray(consumed)
				this.chunks = rest.length > 0 ? [rest] : []
				this.buffered = rest.length
				this.need = 1
			}
		} catch (cause) {
			this.fail(cause instanceof Error ? cause : new PveConsoleError(String(cause)))
		}
	}

	private resetReceiver(): void {
		this.chunks = []
		this.buffered = 0
		this.need = 1
		this.pendingRects = 0
		this.painted = false
	}

	/**
	 * A parse result, or undefined once `need` records how many bytes the
	 * message wants before it can be tried again.
	 */
	private take<T>(result: ParseResult<T>): Parsed<T> | undefined {
		if (typeof result !== 'number') return result
		if (result > this.maxMessageBytes) {
			throw new PveConsoleError(
				`An RFB message needs ${result} bytes, over the ${this.maxMessageBytes} byte limit`,
			)
		}
		this.need = result
		return undefined
	}

	/** Reads one protocol unit from the front of `buf`. Returns the bytes consumed. */
	private step(buf: Buffer): number {
		switch (this.state) {
			case 'version': {
				const parsed = this.take(parseProtocolVersion(buf))
				if (!parsed) return 0
				this.send(CLIENT_VERSION)
				this.state = 'security-types'
				return parsed.length
			}
			case 'security-types': {
				const parsed = this.take(parseSecurityTypes(buf))
				if (!parsed) return 0
				this.chooseSecurity(parsed.value)
				return parsed.length
			}
			case 'challenge': {
				if (buf.length < 16) {
					this.need = 16
					return 0
				}
				this.send(vncDesEncrypt(this.password, buf.subarray(0, 16)))
				this.state = 'security-result'
				return 16
			}
			case 'security-result': {
				const parsed = this.take(parseSecurityResult(buf))
				if (!parsed) return 0
				this.send(buildClientInit(true))
				this.state = 'server-init'
				return parsed.length
			}
			case 'server-init': {
				const parsed = this.take(parseServerInit(buf))
				if (!parsed) return 0
				const { width, height } = parsed.value
				checkScreenSize(width, height)
				this.framebuffer = new Framebuffer(width, height)
				this.send(buildSetPixelFormat())
				this.send(buildSetEncodings(ENCODINGS))
				this.send(buildFbUpdateRequest(false, 0, 0, width, height))
				this.state = 'message'
				this.settle({ width, height })
				return parsed.length
			}
			case 'message': {
				const parsed = this.take(parseServerMessage(buf))
				if (!parsed) return 0
				const message = parsed.value
				switch (message.type) {
					case 'update':
						this.pendingRects = message.rectCount
						this.painted = false
						if (message.rectCount === 0) this.requestIncremental()
						else this.state = 'rectangles'
						break
					case 'bell':
						this.emit('bell')
						break
					case 'cut-text':
						this.emit('clipboard', message.text)
						break
					case 'colour-map':
						break
				}
				return parsed.length
			}
			case 'rectangles': {
				const fb = this.requireFramebuffer()
				const parsed = this.take(parseRectangle(buf, fb))
				if (!parsed) return 0
				this.apply(fb, parsed.value)
				if (--this.pendingRects === 0) {
					this.state = 'message'
					this.requestIncremental()
					if (this.painted) this.emit('update', fb.updateSeq)
				}
				return parsed.length
			}
		}
	}

	private chooseSecurity(types: readonly number[]): void {
		if (types.includes(SECURITY_VNC_AUTH) && this.password.length > 0) {
			this.send(Buffer.from([SECURITY_VNC_AUTH]))
			this.state = 'challenge'
		} else if (types.includes(SECURITY_NONE)) {
			this.send(Buffer.from([SECURITY_NONE]))
			this.state = 'security-result'
		} else if (types.includes(SECURITY_VNC_AUTH)) {
			throw new PveConsoleError(
				'The server asked for VNC authentication but vncproxy issued no password',
			)
		} else {
			throw new PveConsoleError(`No usable VNC security type on offer: ${types.join(', ')}`)
		}
	}

	private apply(fb: Framebuffer, rect: Rectangle): void {
		switch (rect.encoding) {
			case 'raw':
				fb.applyRaw(rect.x, rect.y, rect.w, rect.h, rect.data)
				break
			case 'copy':
				fb.applyCopyRect(rect.x, rect.y, rect.w, rect.h, rect.srcX, rect.srcY)
				break
			case 'resize':
				checkScreenSize(rect.width, rect.height)
				fb.resize(rect.width, rect.height)
				this.emit('resize', rect.width, rect.height)
				break
		}
		this.painted = true
	}

	private requestIncremental(): void {
		const fb = this.framebuffer
		if (fb && this.socket?.open) {
			this.socket.send(buildFbUpdateRequest(true, 0, 0, fb.width, fb.height))
		}
	}

	private settle(size: VncScreenSize): void {
		const settler = this.settler
		this.settler = undefined
		this.clearHandshakeTimer()
		settler?.resolve(size)
	}

	private fail(error: Error): void {
		this.lastError = error
		const settler = this.settler
		this.settler = undefined
		this.clearHandshakeTimer()
		this.teardown()
		if (settler) settler.reject(error)
		else if (this.listenerCount('error') > 0) this.emit('error', error)
	}

	private clearHandshakeTimer(): void {
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
		this.handshakeTimer = undefined
	}

	private teardown(): void {
		const socket = this.socket
		const settler = this.settler
		this.settler = undefined
		this.socket = undefined
		this.state = 'version'
		this.resetReceiver()
		this.held.clear()
		holdingKeys.delete(this)
		this.clearHandshakeTimer()
		socket?.close()
		if (!this.closeEmitted) {
			this.closeEmitted = true
			this.emit('close')
		}
		// A handshake still in flight belongs to a caller waiting on it.
		settler?.reject(
			new PveConsoleError('The VNC session was closed before the RFB handshake finished'),
		)
	}
}

function noFramebuffer(): PveConsoleError {
	return new PveConsoleError('No framebuffer yet: the RFB handshake has not finished')
}

function checkScreenSize(width: number, height: number): void {
	if (width * height > MAX_SCREEN_PIXELS) {
		throw new PveConsoleError(
			`A ${width}x${height} screen is over the ${MAX_SCREEN_PIXELS} pixel limit`,
		)
	}
}
