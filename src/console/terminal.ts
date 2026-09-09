/**
 * A guest's serial console over the PVE terminal proxy, read back through a
 * headless xterm emulator.
 *
 * termproxy spawns a worker on the node and answers with a port, a ticket and
 * the user it is tied to. The stream runs over vncwebsocket with the framing
 * `pty.ts` describes. Output goes into the emulator, so `screen()` is the
 * text a user would see: a redraw or a progress bar comes out as its final
 * state, and colour and cursor movement leave no escape sequences behind.
 */

import { EventEmitter } from 'node:events'
import { Terminal, type IMarker } from '@xterm/headless'
import type { PveClient } from '../core/client.ts'
import { PveConfigError, PveConsoleError, PveTimeoutError } from '../core/errors.ts'
import {
	consoleAuthHeaders,
	consoleWebSocketUrl,
	requestTermProxy,
	type GuestRef,
	type GuestType,
	type SerialPort,
} from './proxy.ts'
import { KEEPALIVE_FRAME, loginFrame, resizeFrame, sendInput } from './pty.ts'
import { openWebSocket, type ConsoleSocket, type SocketFactory } from './socket.ts'

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_KEEPALIVE_MS = 30_000
const DEFAULT_WAIT_MS = 30_000
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_SCROLLBACK = 1000

/** A line a shell is waiting on: it ends in `$` or `#`. */
export const SHELL_PROMPT = /[$#]\s*$/
const LOGIN_PROMPT = /login:\s*$/i
const PASSWORD_PROMPT = /password:\s*$/i
const LOGIN_REFUSED = /login incorrect|login failed|authentication failure/i

const NAMED_KEYS = {
	enter: '\r',
	tab: '\t',
	escape: '\x1b',
	backspace: '\x7f',
	delete: '\x1b[3~',
	insert: '\x1b[2~',
	up: '\x1b[A',
	down: '\x1b[B',
	right: '\x1b[C',
	left: '\x1b[D',
	home: '\x1b[H',
	end: '\x1b[F',
	pageup: '\x1b[5~',
	pagedown: '\x1b[6~',
	f1: '\x1bOP',
	f2: '\x1bOQ',
	f3: '\x1bOR',
	f4: '\x1bOS',
	f5: '\x1b[15~',
	f6: '\x1b[17~',
	f7: '\x1b[18~',
	f8: '\x1b[19~',
	f9: '\x1b[20~',
	f10: '\x1b[21~',
	f11: '\x1b[23~',
	f12: '\x1b[24~',
} as const

type NamedKey = keyof typeof NAMED_KEYS

type Letter =
	| 'a'
	| 'b'
	| 'c'
	| 'd'
	| 'e'
	| 'f'
	| 'g'
	| 'h'
	| 'i'
	| 'j'
	| 'k'
	| 'l'
	| 'm'
	| 'n'
	| 'o'
	| 'p'
	| 'q'
	| 'r'
	| 's'
	| 't'
	| 'u'
	| 'v'
	| 'w'
	| 'x'
	| 'y'
	| 'z'

/** A key `sendKey` takes: a named key, or `ctrl-` and a letter. */
export type SerialKey = NamedKey | `ctrl-${Letter}`

/** The bytes a terminal sends for a key. */
export function keySequence(key: SerialKey): string {
	if (Object.hasOwn(NAMED_KEYS, key)) return NAMED_KEYS[key as NamedKey]
	const ctrl = /^ctrl-([a-z])$/.exec(key)
	if (ctrl?.[1] !== undefined) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96)
	throw new PveConfigError(
		`Unknown key '${key}'. Named keys: ${Object.keys(NAMED_KEYS).join(', ')}, and ctrl-a to ctrl-z`,
	)
}

export interface SerialConsoleOptions {
	client: PveClient
	node: string
	vmid: number
	/** Defaults to qemu. A container always has a console; a VM needs a serial socket in its config. */
	type?: GuestType
	/** The VM serial port. Defaults to serial0. A container has one console and ignores it. */
	serial?: SerialPort
	/** Defaults to 80. */
	cols?: number
	/** Defaults to 24. */
	rows?: number
	/** Lines kept above the screen. Defaults to 1000. */
	scrollback?: number
	/** Milliseconds allowed to reach the proxy's OK. Defaults to 15000. */
	connectTimeoutMs?: number
	/** Keepalive period; 0 turns it off. Defaults to 30000. */
	keepaliveMs?: number
	/** Opens the WebSocket. Replaceable for tests. */
	socketFactory?: SocketFactory
}

export interface SerialWaitOptions {
	/** Defaults to 30000. */
	timeoutMs?: number
}

export interface PromptOptions extends SerialWaitOptions {
	/** What the line the cursor is on has to match. Defaults to SHELL_PROMPT. */
	pattern?: RegExp
}

export interface SerialConsoleEvents {
	/** Output arrived and the screen shows it. */
	data: [chunk: string]
	close: []
	error: [error: Error]
}

interface Settler {
	resolve: () => void
	reject: (error: Error) => void
}

interface Waiter {
	check: () => void
	fail: (error: Error) => void
}

/**
 * A place in the buffer. The emulator moves the marker as lines scroll and
 * drops it when its line scrolls out or is cleared.
 */
interface Mark {
	marker: IMarker | undefined
	column: number
}

/** One serial console attached to one guest. */
export class SerialConsole extends EventEmitter<SerialConsoleEvents> {
	readonly node: string
	readonly vmid: number
	readonly guestType: GuestType
	readonly serial: SerialPort

	private readonly client: PveClient
	private readonly connectTimeoutMs: number
	private readonly keepaliveMs: number
	private readonly socketFactory: SocketFactory
	private readonly terminal: Terminal
	// One decoder per console: a UTF-8 sequence can straddle two frames.
	private readonly decoder = new TextDecoder()
	private readonly waiters = new Set<Waiter>()

	private socket: ConsoleSocket | undefined
	private authenticated = false
	private answer = Buffer.alloc(0)
	private settler: Settler | undefined
	private connectTimer: ReturnType<typeof setTimeout> | undefined
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined
	private readMark: Mark
	private sentMark: Mark | undefined

	constructor(options: SerialConsoleOptions) {
		super()
		this.client = options.client
		this.node = options.node
		this.vmid = options.vmid
		this.guestType = options.type ?? 'qemu'
		this.serial = options.serial ?? 'serial0'
		this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
		this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS
		this.socketFactory = options.socketFactory ?? openWebSocket
		this.terminal = new Terminal({
			cols: options.cols ?? DEFAULT_COLS,
			rows: options.rows ?? DEFAULT_ROWS,
			scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
			convertEol: true,
			// registerMarker is a proposed API.
			allowProposedApi: true,
		})
		this.readMark = this.mark()
	}

	/** True once the proxy accepted the ticket and the socket is still up. */
	get connected(): boolean {
		return this.authenticated && this.socket !== undefined
	}

	get cols(): number {
		return this.terminal.cols
	}

	get rows(): number {
		return this.terminal.rows
	}

	/**
	 * Spawns a terminal proxy worker, opens the WebSocket, logs in and sends
	 * the window size.
	 */
	async connect(): Promise<void> {
		const guest: GuestRef = { node: this.node, vmid: this.vmid, type: this.guestType }
		const proxy = await requestTermProxy(
			this.client,
			guest,
			this.guestType === 'qemu' ? { serial: this.serial } : {},
		)
		const url = consoleWebSocketUrl(this.client.baseUrl, guest, proxy.port, proxy.ticket)
		const headers = await consoleAuthHeaders(this.client.auth)
		const socket = this.socketFactory(url, { headers, verifySsl: this.client.http.verifySsl })
		// A failure after this point runs through teardown, which closes the
		// socket; only a synchronous refusal to attach leaves it open.
		let opened: Promise<void>
		try {
			opened = this.attach(socket, proxy.user, proxy.ticket)
		} catch (error) {
			socket.close()
			throw error
		}
		await opened
	}

	/**
	 * Logs in over a socket the caller opened and sends the window size.
	 * Resolves once the proxy answered OK.
	 */
	attach(socket: ConsoleSocket, user: string, ticket: string): Promise<void> {
		if (this.socket) throw new PveConfigError('This serial console already has a socket')
		this.socket = socket
		this.authenticated = false
		this.answer = Buffer.alloc(0)

		return new Promise<void>((resolve, reject) => {
			this.settler = { resolve, reject }
			this.connectTimer = setTimeout(() => {
				this.fail(
					new PveConsoleError(
						`The terminal proxy for guest ${this.vmid} did not answer within ${this.connectTimeoutMs}ms`,
					),
				)
			}, this.connectTimeoutMs)
			this.connectTimer.unref()

			socket.onMessage((chunk) => this.receive(chunk))
			socket.onError((error) => this.fail(error))
			socket.onClose(() => {
				if (this.settler) {
					this.fail(new PveConsoleError('The WebSocket closed before the terminal proxy answered'))
					return
				}
				this.teardown(this.closedError())
			})
			const login = (): void => socket.send(loginFrame(user, ticket))
			if (socket.open) login()
			else socket.onOpen(login)
		})
	}

	/** Sends text as typed. */
	write(text: string): void {
		sendInput(this.requireSocket(), text)
	}

	/**
	 * Sends text followed by Enter, and moves the point the waits read from:
	 * the cursor line still ends in the old prompt until the echo arrives,
	 * so `waitForText` and `waitForPrompt` only look at output rendered after
	 * this call.
	 */
	sendLine(text: string): void {
		this.write(`${text}\r`)
		this.sentMark?.marker?.dispose()
		this.sentMark = this.mark()
	}

	sendKey(key: SerialKey): void {
		this.write(keySequence(key))
	}

	/** Resizes the emulator and tells the guest the new window size. */
	resize(cols: number, rows: number): void {
		if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
			throw new PveConfigError(`Terminal size must be positive integers, got ${cols}x${rows}`)
		}
		const socket = this.requireSocket()
		this.terminal.resize(cols, rows)
		socket.send(resizeFrame(cols, rows))
	}

	/** The screen as plain text, trailing blank lines removed. */
	screen(): string {
		const buffer = this.terminal.buffer.active
		const lines: string[] = []
		for (let y = 0; y < this.terminal.rows; y++) {
			lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
		}
		return lines.join('\n').trimEnd()
	}

	/**
	 * Text rendered since the previous call, or since the console was made.
	 * Lines that left the scrollback in between are gone; after a screen
	 * clear the read restarts at the top of the buffer.
	 */
	readNew(): string {
		const text = this.textSince(this.readMark)
		this.readMark.marker?.dispose()
		this.readMark = this.mark()
		return text
	}

	/**
	 * Resolves with the screen once `pattern` matches the text rendered since
	 * the last `sendLine`, or the whole screen when nothing has been sent.
	 * Throws PveTimeoutError carrying the last screen when the deadline
	 * passes.
	 */
	waitForText(pattern: string | RegExp, options: SerialWaitOptions = {}): Promise<string> {
		return this.waitFor(
			`${describe(pattern)} on the serial console of guest ${this.vmid}`,
			() => (matches(this.unread(), pattern) ? this.screen() : undefined),
			options.timeoutMs,
		)
	}

	/**
	 * Resolves with the screen once the line the cursor is on ends in a shell
	 * prompt. After a `sendLine`, the prompt has to be rendered after the line
	 * went out; the one the line was typed at does not count.
	 */
	waitForPrompt(options: PromptOptions = {}): Promise<string> {
		const pattern = options.pattern ?? SHELL_PROMPT
		return this.waitFor(
			`a shell prompt on the serial console of guest ${this.vmid}`,
			() => {
				if (this.unread() === '') return undefined
				return matches(this.cursorLine(), pattern) ? this.screen() : undefined
			},
			options.timeoutMs,
		)
	}

	/**
	 * Logs in at a getty: waits for the login prompt, types the user, waits
	 * for the password prompt, types the password, and resolves with the
	 * screen once a shell prompt shows. Throws PveConsoleError when the guest
	 * refuses the credentials. `timeoutMs` applies to each prompt.
	 *
	 * When the cursor is not on a login prompt, Enter goes out first, so a
	 * getty that printed its prompt before the console opened, or sits at a
	 * stale password prompt, asks again.
	 */
	async login(user: string, password: string, options: PromptOptions = {}): Promise<string> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS
		const prompt = options.pattern ?? SHELL_PROMPT
		const where = `on the serial console of guest ${this.vmid}`

		if (!LOGIN_PROMPT.test(this.cursorLine())) this.sendKey('enter')
		await this.waitFor(
			`a login prompt ${where}`,
			() => (LOGIN_PROMPT.test(this.cursorLine()) ? this.screen() : undefined),
			timeoutMs,
		)
		this.sendLine(user)
		await this.waitFor(
			`a password prompt for ${user} ${where}`,
			() => (PASSWORD_PROMPT.test(this.cursorLine()) ? this.screen() : undefined),
			timeoutMs,
		)

		const sent = this.mark()
		this.sendLine(password)
		try {
			return await this.waitFor(
				`a shell prompt for ${user} ${where}`,
				() => {
					if (LOGIN_REFUSED.test(this.textSince(sent))) {
						throw new PveConsoleError(`Guest ${this.vmid} refused the login of ${user} ${where}`)
					}
					return matches(this.cursorLine(), prompt) ? this.screen() : undefined
				},
				timeoutMs,
			)
		} finally {
			sent.marker?.dispose()
		}
	}

	/** Closes the socket and emits `close`. The screen stays readable. */
	close(): void {
		this.teardown(this.closedError())
	}

	private requireSocket(): ConsoleSocket {
		if (!this.authenticated || this.socket === undefined || !this.socket.open) {
			throw this.closedError()
		}
		return this.socket
	}

	private closedError(): PveConsoleError {
		return new PveConsoleError(`The serial console for guest ${this.vmid} is closed`)
	}

	private receive(chunk: Buffer): void {
		if (this.authenticated) {
			this.feed(chunk)
			return
		}
		// The OK carries no framing: it can arrive split, or share a frame
		// with the console's first output.
		this.answer = Buffer.concat([this.answer, chunk])
		if (this.answer.length < 2) return
		if (this.answer.subarray(0, 2).toString('latin1') !== 'OK') {
			const shown = JSON.stringify(this.answer.subarray(0, 200).toString('utf8'))
			this.fail(new PveConsoleError(`The terminal proxy rejected the ticket: ${shown}`))
			return
		}
		const rest = this.answer.subarray(2)
		this.answer = Buffer.alloc(0)
		this.authenticated = true
		this.socket?.send(resizeFrame(this.terminal.cols, this.terminal.rows))
		this.startKeepalive()
		this.settle()
		if (rest.length > 0) this.feed(rest)
	}

	private feed(chunk: Buffer): void {
		const text = this.decoder.decode(chunk, { stream: true })
		// The emulator parses asynchronously; the callback runs once the
		// screen shows the chunk, so a waiter woken here reads the new state.
		this.terminal.write(chunk, () => {
			this.emit('data', text)
			for (const waiter of [...this.waiters]) waiter.check()
		})
	}

	private async waitFor(
		what: string,
		probe: () => string | undefined,
		timeoutMs = DEFAULT_WAIT_MS,
	): Promise<string> {
		const now = probe()
		if (now !== undefined) return now
		if (!this.connected) throw this.closedError()

		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter)
				reject(
					new PveTimeoutError({
						what,
						waitedMs: timeoutMs,
						detail: `the screen showed:\n${this.screen()}`,
					}),
				)
			}, timeoutMs)
			timer.unref()
			const waiter: Waiter = {
				check: () => {
					let value: string | undefined
					try {
						value = probe()
					} catch (error) {
						waiter.fail(error instanceof Error ? error : new Error(String(error)))
						return
					}
					if (value === undefined) return
					clearTimeout(timer)
					this.waiters.delete(waiter)
					resolve(value)
				},
				fail: (error) => {
					clearTimeout(timer)
					this.waiters.delete(waiter)
					reject(error)
				},
			}
			this.waiters.add(waiter)
		})
	}

	/**
	 * Text rendered since the last sendLine. Before any, or once the guest
	 * has moved the cursor back above the mark by redrawing the screen, it
	 * is the whole screen.
	 */
	private unread(): string {
		const mark = this.sentMark
		if (mark === undefined || this.cursorBefore(mark)) return this.screen()
		return this.textSince(mark)
	}

	private cursorBefore(mark: Mark): boolean {
		const marker = mark.marker
		if (marker === undefined || marker.isDisposed) return false
		const buffer = this.terminal.buffer.active
		const line = buffer.baseY + buffer.cursorY
		return line < marker.line || (line === marker.line && buffer.cursorX < mark.column)
	}

	private cursorLine(): string {
		const buffer = this.terminal.buffer.active
		return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? ''
	}

	private mark(): Mark {
		return { marker: this.terminal.registerMarker(0), column: this.terminal.buffer.active.cursorX }
	}

	/** Text from a mark to the cursor; from the top of the buffer when the mark was dropped. */
	private textSince(mark: Mark): string {
		const buffer = this.terminal.buffer.active
		const endLine = buffer.baseY + buffer.cursorY
		const endColumn = buffer.cursorX
		const marker = mark.marker
		const live = marker !== undefined && !marker.isDisposed
		const startLine = live ? marker.line : 0
		const startColumn = live ? mark.column : 0
		if (endLine < startLine || (endLine === startLine && endColumn <= startColumn)) return ''

		const lines: string[] = []
		for (let y = startLine; y <= endLine; y++) {
			const line = buffer.getLine(y)
			if (line === undefined) continue
			lines.push(
				line.translateToString(
					true,
					y === startLine ? startColumn : 0,
					y === endLine ? endColumn : undefined,
				),
			)
		}
		return lines.join('\n')
	}

	private startKeepalive(): void {
		if (this.keepaliveMs <= 0) return
		this.keepaliveTimer = setInterval(() => {
			if (this.socket?.open) this.socket.send(KEEPALIVE_FRAME)
		}, this.keepaliveMs)
		this.keepaliveTimer.unref()
	}

	private settle(): void {
		const settler = this.settler
		this.settler = undefined
		this.clearConnectTimer()
		settler?.resolve()
	}

	private fail(error: Error): void {
		const pending = this.settler !== undefined
		this.teardown(error)
		if (!pending && this.listenerCount('error') > 0) this.emit('error', error)
	}

	private clearConnectTimer(): void {
		if (this.connectTimer) clearTimeout(this.connectTimer)
		this.connectTimer = undefined
	}

	/** Drops the socket, settles every pending promise with `error` and emits `close` once. */
	private teardown(error: Error): void {
		const socket = this.socket
		if (socket === undefined) return
		const settler = this.settler
		this.socket = undefined
		this.settler = undefined
		this.authenticated = false
		this.answer = Buffer.alloc(0)
		this.clearConnectTimer()
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
		this.keepaliveTimer = undefined
		settler?.reject(error)
		for (const waiter of [...this.waiters]) waiter.fail(error)
		socket.close()
		this.emit('close')
	}
}

/** Opens a serial console and returns it once the proxy accepted the ticket. */
export async function openSerialConsole(options: SerialConsoleOptions): Promise<SerialConsole> {
	const serial = new SerialConsole(options)
	await serial.connect()
	return serial
}

function matches(text: string, pattern: string | RegExp): boolean {
	return typeof pattern === 'string' ? text.includes(pattern) : text.search(pattern) !== -1
}

function describe(pattern: string | RegExp): string {
	return typeof pattern === 'string' ? `'${pattern}'` : String(pattern)
}
