/**
 * Root shell over the PVE termproxy websocket, for a caller that has no SSH
 * key but can reach port 8006 with a root@pam ticket. `get_shell_command` in
 * PVE compares the caller against the literal 'root@pam' and hands anyone
 * else, an API token included, a `/bin/login` password prompt.
 *
 * The far side is a pty: output is text, a line of input is capped by the
 * line discipline, and a command is wrapped so its stdout, stderr and exit
 * code come back between markers the transport parses. stderr goes through a
 * temporary file on the node that the login shell removes when it exits.
 *
 * Frames on the websocket: `user:ticket\n` once to log in, then
 * `0:<bytes>:<data>` for input, `1:<cols>:<rows>:` for a resize and `2` as a
 * keepalive.
 */

import type { PveClient } from '../core/client.ts'
import { consoleAuthHeaders } from '../console/proxy.ts'
import { openWebSocket, type ConsoleSocket, type SocketFactory } from '../console/socket.ts'
import type { PveShellError } from '../core/errors.ts'
import {
	PveShellCommandError,
	PveShellCredentialError,
	PveShellTimeoutError,
	PveShellTransportError,
} from './errors.ts'
import { shQuote, shWrap } from './escape.ts'
import type { CommandResult, RunOptions, ShellTransport } from './types.ts'

export interface TermproxyOptions {
	client: PveClient
	node: string
	/** Defaults to 20000. */
	connectTimeoutMs?: number
	/** Defaults to 120000. */
	defaultTimeoutMs?: number
	/** Longest wrapped command line the pty accepts. Defaults to 4096. */
	maxCommandBytes?: number
	/** Largest file this transport moves in either direction. Defaults to 1 MiB. */
	maxTransferBytes?: number
	/** Pty output held before the session fails. Defaults to 8 MiB. */
	maxOutputBytes?: number
	/** Replaced by tests. */
	socketFactory?: SocketFactory
}

interface TermproxyTicket {
	user: string
	ticket: string
	port: number | string
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_COMMAND_BYTES = 4096
const DEFAULT_MAX_TRANSFER_BYTES = 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const KEEPALIVE_MS = 30_000
const SEND_CHUNK_BYTES = 256
const APPEND_CHUNK_CHARS = 1024

/** Marker delimiters: the bytes the parser matches, and what printf is given. */
const START = '\u0001'
const STOP = '\u0002'
const START_ESCAPE = '\\001'
const STOP_ESCAPE = '\\002'
const INTERRUPT = '\u0003'

const LOGIN_PROMPT = /(^|\n)[^\n]*(login:|password:)\s*$/i

export class TermproxyTransport implements ShellTransport {
	readonly kind = 'termproxy' as const
	readonly node: string

	private readonly options: TermproxyOptions
	private readonly marker: string
	private readonly maxCommandBytes: number
	private readonly maxTransferBytes: number
	private readonly maxOutputBytes: number
	private readonly defaultTimeoutMs: number
	// One decoder per session: a UTF-8 sequence can straddle two websocket
	// frames, and a fresh decoder turns each half into a replacement character.
	private readonly decoder = new TextDecoder()

	private socket: ConsoleSocket | undefined
	private buffer = ''
	private ready = false
	private failure: PveShellError | undefined
	private waiter: { check: () => void; fail: (error: Error) => void } | undefined
	private keepalive: ReturnType<typeof setInterval> | undefined
	private queue: Promise<unknown> = Promise.resolve()

	constructor(options: TermproxyOptions) {
		this.options = options
		this.node = options.node
		this.marker = `PVEAGENT${randomHex(12)}`
		this.maxCommandBytes = options.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES
		this.maxTransferBytes = options.maxTransferBytes ?? DEFAULT_MAX_TRANSFER_BYTES
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	get description(): string {
		return `termproxy ${this.options.client.baseUrl}/nodes/${this.node}`
	}

	/**
	 * Open the websocket, log in, and put the remote shell in a state the
	 * parser can read. Throws PveShellCredentialError before any request goes
	 * out when the client holds no root@pam ticket.
	 */
	async connect(): Promise<void> {
		const client = this.options.client
		if (!client.auth.hasRootTicket) {
			throw new PveShellCredentialError(this.node, credentialMessage(this.node, client))
		}

		const proxy = await client.post<TermproxyTicket>(
			`/nodes/${this.node}/termproxy`,
			{},
			{ tier: 'ticket' },
		)
		const headers = await consoleAuthHeaders(client.auth)
		const authority = client.baseUrl.replace(/^https?:\/\//, '')
		const query = `port=${encodeURIComponent(String(proxy.port))}&vncticket=${encodeURIComponent(proxy.ticket)}`
		const url = `wss://${authority}/api2/json/nodes/${this.node}/vncwebsocket?${query}`

		const factory = this.options.socketFactory ?? openWebSocket
		const socket = factory(url, { headers, verifySsl: client.http.verifySsl })
		this.socket = socket
		const opened = new Promise<void>((resolve, reject) => {
			socket.onOpen(resolve)
			socket.onError((error) => {
				this.fail(error.message)
				reject(error)
			})
			socket.onClose(() => {
				this.fail('the websocket closed')
				reject(new Error('the websocket closed'))
			})
			if (socket.open) resolve()
		})
		socket.onMessage((chunk) => this.append(this.decoder.decode(chunk, { stream: true })))

		const connectTimeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
		try {
			try {
				await withTimeout(opened, connectTimeoutMs, 'the websocket did not open')
			} catch (cause) {
				throw new PveShellTransportError({
					node: this.node,
					transport: 'termproxy',
					message: `Cannot open the termproxy websocket for ${this.node}: ${cause instanceof Error ? cause.message : String(cause)}`,
					cause,
				})
			}

			socket.send(`${proxy.user}:${proxy.ticket}\n`)
			await this.waitFor(() => this.buffer.includes('OK') || undefined, connectTimeoutMs, 'login')
			this.buffer = ''
			socket.send('1:200:50:')
			this.keepalive = setInterval(() => this.socket?.send('2'), KEEPALIVE_MS)
			this.keepalive.unref()

			// The marker is assembled from variables so the shell's own echo of a
			// command line can never contain the expanded marker the parser
			// matches. TERM=dumb and the colour variables stop programs on the
			// far side wrapping their output in escape sequences.
			this.sendLine(
				'stty -echo 2>/dev/null; PS1=; PS2=; unset PROMPT_COMMAND; ' +
					'export LC_ALL=C TERM=dumb NO_COLOR=1 SYSTEMD_COLORS=0 CLICOLOR=0; ' +
					`__A=${this.marker}; __B=BEGIN; __S=ERR; __E=END; ` +
					`__T=$(mktemp); trap 'rm -f -- "$__T"' EXIT HUP`,
			)
			const probe = await this.runNow('printf ready', { timeoutMs: connectTimeoutMs })
			if (probe.exitCode !== 0 || probe.stdout !== 'ready') {
				throw new PveShellTransportError({
					node: this.node,
					transport: 'termproxy',
					message: `The termproxy shell on ${this.node} did not answer a probe command. Last output: ${this.buffer.slice(-500) || '(none)'}`,
				})
			}
			this.ready = true
		} catch (error) {
			await this.close()
			throw error
		}
	}

	/**
	 * Run a command line on the node. The command travels base64-encoded and
	 * is decoded by the remote shell, so quoting, newlines and tabs survive
	 * the pty. It runs in a subshell, so `exit` and a `cd` in one call do not
	 * reach the next.
	 */
	run(command: string, options: RunOptions = {}): Promise<CommandResult> {
		return this.serialize(() => this.runNow(command, options))
	}

	private async runNow(command: string, options: RunOptions): Promise<CommandResult> {
		const socket = this.requireSocket()
		const started = Date.now()
		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
		const decodeCommand = `"$(printf %s ${shQuote(toBase64(shWrap(command, options)))} | base64 -d)"`
		const body =
			options.input === undefined
				? `( eval ${decodeCommand} )`
				: `( printf %s ${shQuote(toBase64(options.input))} | base64 -d | eval ${decodeCommand} )`
		const line =
			`printf '${START_ESCAPE}%s${STOP_ESCAPE}' "$__A$__B"; ` +
			`${body} 2>"$__T"; __rc=$?; ` +
			`printf '${START_ESCAPE}%s${STOP_ESCAPE}' "$__A$__S"; cat -- "$__T"; ` +
			`printf '${START_ESCAPE}%s:%d${STOP_ESCAPE}\\n' "$__A$__E" "$__rc"`

		const lineBytes = Buffer.byteLength(line, 'utf8')
		if (lineBytes > this.maxCommandBytes) {
			throw new PveShellTransportError({
				node: this.node,
				transport: 'termproxy',
				message: `The wrapped command is ${lineBytes} bytes, over the ${this.maxCommandBytes} byte pty line limit. Use the ssh transport, or write the script to a file first.`,
			})
		}

		this.buffer = ''
		this.sendLine(line)

		let parsed: Omit<CommandResult, 'durationMs'>
		try {
			parsed = await this.waitFor(() => this.parse(), timeoutMs, command)
		} catch (error) {
			// Interrupt the remote command so the session stays usable.
			if (socket.open) socket.send(`0:1:${INTERRUPT}`)
			throw error
		}

		if (options.check === true && parsed.exitCode !== 0) {
			throw new PveShellCommandError({ node: this.node, command, ...parsed })
		}
		return { ...parsed, durationMs: Date.now() - started }
	}

	/**
	 * Copy a local file onto the node. The content goes over as base64 in
	 * pty-sized pieces, is decoded into a temporary file and renamed over the
	 * target.
	 */
	async upload(localPath: string, remotePath: string): Promise<void> {
		const data = await Bun.file(localPath).bytes()
		if (data.byteLength > this.maxTransferBytes) {
			throw this.transferLimit(`${localPath} is ${data.byteLength} bytes`)
		}
		const encoded = Buffer.from(data).toString('base64')
		const staging = (await this.run('mktemp /tmp/pve-agent.XXXXXX', { check: true })).stdout.trim()
		const quotedStaging = shQuote(staging)
		try {
			for (let offset = 0; offset < encoded.length; offset += APPEND_CHUNK_CHARS) {
				const chunk = encoded.slice(offset, offset + APPEND_CHUNK_CHARS)
				await this.run(`printf %s ${shQuote(chunk)} >> ${quotedStaging}`, { check: true })
			}
			const quoted = shQuote(remotePath)
			await this.run(
				`set -e; d=$(dirname -- ${quoted}); o=$(mktemp "$d/.pve-agent.XXXXXX"); ` +
					`base64 -d ${quotedStaging} > "$o"; mv -f -- "$o" ${quoted}`,
				{ check: true },
			)
		} finally {
			await this.run(`rm -f -- ${quotedStaging}`).catch(() => undefined)
		}
	}

	/** Copy a file off the node. The bytes come back base64-encoded. */
	async download(remotePath: string, localPath: string): Promise<void> {
		const quoted = shQuote(remotePath)
		const reported = (await this.run(`stat -c %s -- ${quoted}`, { check: true })).stdout.trim()
		const size = Number.parseInt(reported, 10)
		if (!Number.isFinite(size)) {
			throw new PveShellTransportError({
				node: this.node,
				transport: 'termproxy',
				message: `Cannot read the size of ${remotePath}: stat answered ${JSON.stringify(reported.slice(0, 200))}`,
			})
		}
		if (size > this.maxTransferBytes) throw this.transferLimit(`${remotePath} is ${size} bytes`)
		const result = await this.run(`base64 -w 0 -- ${quoted}`, { check: true })
		await Bun.write(localPath, Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64'))
	}

	/** Stops the keepalive and closes the websocket. */
	async close(): Promise<void> {
		if (this.keepalive !== undefined) clearInterval(this.keepalive)
		this.keepalive = undefined
		this.socket?.close()
		this.socket = undefined
	}

	/** Take pty output, and fail the session when it outgrows the cap. */
	private append(text: string): void {
		this.buffer += text
		if (this.buffer.length > this.maxOutputBytes) {
			this.buffer = ''
			this.fail(`the output passed the ${this.maxOutputBytes} byte limit`)
			void this.close()
			return
		}
		if (!this.ready && LOGIN_PROMPT.test(this.buffer)) {
			this.failWith(
				new PveShellCredentialError(
					this.node,
					`termproxy on ${this.node} answered with a login prompt instead of a root shell. ${credentialMessage(this.node, this.options.client)}`,
				),
			)
			return
		}
		this.waiter?.check()
	}

	/** Records why the session died and fails the pending wait. */
	private fail(reason: string): void {
		this.failWith(
			new PveShellTransportError({
				node: this.node,
				transport: 'termproxy',
				message: `The termproxy session for ${this.node} is closed: ${reason}`,
			}),
		)
	}

	/** The first failure recorded is the one that explains it; later ones only repeat that the socket is gone. */
	private failWith(error: PveShellError): void {
		this.failure ??= error
		this.waiter?.fail(this.failure)
	}

	private closedError(): PveShellError {
		return (
			this.failure ??
			new PveShellTransportError({
				node: this.node,
				transport: 'termproxy',
				message: `The termproxy session for ${this.node} is closed`,
			})
		)
	}

	/** The next complete result in the buffer, consumed from it. */
	private parse(): Omit<CommandResult, 'durationMs'> | undefined {
		const beginMark = `${START}${this.marker}BEGIN${STOP}`
		const errMark = `${START}${this.marker}ERR${STOP}`
		const endMark = `${START}${this.marker}END:`
		const begin = this.buffer.indexOf(beginMark)
		if (begin === -1) return undefined
		const err = this.buffer.indexOf(errMark, begin)
		if (err === -1) return undefined
		const end = this.buffer.indexOf(endMark, err)
		if (end === -1) return undefined
		const stop = this.buffer.indexOf(STOP, end + endMark.length)
		if (stop === -1) return undefined

		const stdout = cleanOutput(this.buffer.slice(begin + beginMark.length, err))
		const stderr = cleanOutput(this.buffer.slice(err + errMark.length, end))
		const exitCode = Number.parseInt(this.buffer.slice(end + endMark.length, stop), 10)
		this.buffer = this.buffer.slice(stop + 1)
		return { stdout, stderr, exitCode: Number.isFinite(exitCode) ? exitCode : -1 }
	}

	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(work, work)
		this.queue = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}

	private requireSocket(): ConsoleSocket {
		if (this.socket === undefined || this.failure !== undefined) throw this.closedError()
		return this.socket
	}

	private sendLine(line: string): void {
		const socket = this.requireSocket()
		const payload = Buffer.from(`${line}\n`, 'utf8')
		for (let offset = 0; offset < payload.length; offset += SEND_CHUNK_BYTES) {
			const chunk = payload.subarray(offset, offset + SEND_CHUNK_BYTES)
			socket.send(Buffer.concat([Buffer.from(`0:${chunk.length}:`, 'ascii'), chunk]))
		}
	}

	/**
	 * Settles with the first defined value `ready` produces, checked on every
	 * chunk of output; rejects when the session dies or the deadline passes.
	 */
	private waitFor<T>(ready: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
		if (this.failure !== undefined) return Promise.reject(this.failure)
		const now = ready()
		if (now !== undefined) return Promise.resolve(now)
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiter = undefined
				reject(
					new PveShellTimeoutError({
						node: this.node,
						command: what,
						timeoutMs,
						partialOutput: cleanOutput(this.buffer),
					}),
				)
			}, timeoutMs)
			timer.unref()
			this.waiter = {
				check: () => {
					const value = ready()
					if (value === undefined) return
					clearTimeout(timer)
					this.waiter = undefined
					resolve(value)
				},
				fail: (error) => {
					clearTimeout(timer)
					this.waiter = undefined
					reject(error)
				},
			}
		})
	}

	private transferLimit(what: string): PveShellTransportError {
		return new PveShellTransportError({
			node: this.node,
			transport: 'termproxy',
			message: `${what}, over the ${this.maxTransferBytes} byte termproxy transfer limit. Use the ssh transport for a file this size.`,
		})
	}
}

/** Opens a termproxy session and returns it ready for commands. */
export async function openTermproxy(options: TermproxyOptions): Promise<TermproxyTransport> {
	const transport = new TermproxyTransport(options)
	await transport.connect()
	return transport
}

function credentialMessage(node: string, client: PveClient): string {
	const username = client.auth.ticketUsername
	const held =
		username === undefined
			? 'this client has no ticket credential at all'
			: `this client logs in as ${username}`
	return `The termproxy transport for ${node} needs a root@pam ticket, and ${held}. POST /nodes/${node}/termproxy gives only root@pam a passwordless root shell; everyone else, an API token included, gets a /bin/login password prompt. Set PVE_USER=root@pam and PVE_PASSWORD, or authorise an SSH key for root on the node and use the ssh transport.`
}

/** CSI, OSC and character-set sequences a program can still emit on a pty. */
const ANSI = new RegExp(
	[
		'\\u001b\\[[0-9;?]*[ -/]*[@-~]',
		'\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)',
		'\\u001b[()][0-9A-Z]',
		'\\u001b[=>78]',
	].join('|'),
	'g',
)

function cleanOutput(text: string): string {
	return text.replace(ANSI, '').replace(/\r\n/g, '\n')
}

function toBase64(value: string | Uint8Array): string {
	return typeof value === 'string'
		? Buffer.from(value, 'utf8').toString('base64')
		: Buffer.from(value).toString('base64')
}

function randomHex(length: number): string {
	const bytes = new Uint8Array(Math.ceil(length / 2))
	crypto.getRandomValues(bytes)
	return Buffer.from(bytes).toString('hex').slice(0, length).toUpperCase()
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms)
				timer.unref()
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}
