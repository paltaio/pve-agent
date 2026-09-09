/**
 * Stand-ins the shell tests use in place of a node: a ShellTransport that
 * answers from a table of replies, and the far side of a termproxy websocket.
 */

import type { ConsoleSocket } from '../console/socket.ts'
import type { CommandResult, RunOptions, ShellTransport } from './types.ts'

export interface FakeReply {
	exitCode?: number
	stdout?: string
	stderr?: string
}

export interface FakeCall {
	command: string
	options: RunOptions
}

/** A ShellTransport that records every call. */
export class FakeTransport implements ShellTransport {
	readonly kind = 'ssh' as const
	readonly node: string
	readonly description = 'fake transport'

	readonly calls: FakeCall[] = []
	readonly uploads: { localPath: string; remotePath: string }[] = []
	readonly downloads: { remotePath: string; localPath: string }[] = []
	closes = 0

	private readonly reply: (command: string) => FakeReply

	constructor(options: { node?: string; reply?: (command: string) => FakeReply } = {}) {
		this.node = options.node ?? 'test-node'
		this.reply = options.reply ?? (() => ({}))
	}

	get commands(): string[] {
		return this.calls.map((call) => call.command)
	}

	async run(command: string, options: RunOptions = {}): Promise<CommandResult> {
		this.calls.push({ command, options })
		const reply = this.reply(command)
		return {
			exitCode: reply.exitCode ?? 0,
			stdout: reply.stdout ?? '',
			stderr: reply.stderr ?? '',
			durationMs: 0,
		}
	}

	async upload(localPath: string, remotePath: string): Promise<void> {
		this.uploads.push({ localPath, remotePath })
	}

	async download(remotePath: string, localPath: string): Promise<void> {
		this.downloads.push({ remotePath, localPath })
	}

	async close(): Promise<void> {
		this.closes++
	}
}

/** Output a pty would print for a command. 'hang' stands for a command that never comes back. */
export type PtyReply = FakeReply | 'hang' | undefined

export interface FakePtyOptions {
	/** Answers a decoded command. The probe is answered by the pty itself; undefined stands for no output. */
	reply?: (command: string, input: string | undefined) => PtyReply
	/** Answers a line as typed, before any wrapper parsing. What it returns is printed. */
	onLine?: (line: string) => string | undefined
	/** Text the shell prints once logged in. One ending in `login:` swallows every line typed at it. */
	banner?: string
	/** Echo typed lines back, as a pty with echo on does. Defaults to true. */
	echo?: boolean
	/** Answer the ticket line with OK. Defaults to true. */
	answerAuth?: boolean
	/** Deliver output in pieces of this many bytes. */
	splitBytes?: number
}

const START = '\u0001'
const STOP = '\u0002'

/**
 * The far side of a termproxy websocket: it speaks the frame protocol, echoes
 * what it is sent, and answers the marker wrapper with stdout, stderr and an
 * exit code.
 */
export class FakePty implements ConsoleSocket {
	open = true
	/** Every frame received, as text. */
	readonly sent: string[] = []
	/** Every command decoded out of a wrapper line, in order. */
	readonly commands: string[] = []
	/** The input each command carried, in the same order. */
	readonly inputs: (string | undefined)[] = []
	closes = 0

	private line = ''
	private marker = ''
	private authenticated = false
	private messageHandler: ((data: Buffer) => void) | undefined
	private closeHandler: (() => void) | undefined
	private readonly options: FakePtyOptions

	constructor(options: FakePtyOptions = {}) {
		this.options = options
	}

	send(data: Buffer | string): void {
		const text = typeof data === 'string' ? data : data.toString('utf8')
		this.sent.push(text)
		if (!this.authenticated) {
			if (/^[^:]+:[^:]+\n$/.test(text) && this.options.answerAuth !== false) {
				this.authenticated = true
				this.emit('OK')
				const banner = this.options.banner
				if (banner !== undefined) setTimeout(() => this.emit(banner), 30)
			}
			return
		}
		const frame = /^0:(\d+):([\s\S]*)$/.exec(text)
		if (frame?.[2] !== undefined) this.feed(frame[2])
	}

	close(): void {
		this.closes++
		this.open = false
		this.closeHandler?.()
	}

	onOpen(): void {}

	onMessage(handler: (data: Buffer) => void): void {
		this.messageHandler = handler
	}

	onError(): void {}

	onClose(handler: () => void): void {
		this.closeHandler = handler
	}

	/** Delivers text as the shell's own output. */
	emit(text: string): void {
		const bytes = Buffer.from(text, 'utf8')
		const step = this.options.splitBytes ?? bytes.length
		for (let offset = 0; offset < bytes.length; offset += step) {
			this.messageHandler?.(bytes.subarray(offset, offset + step))
		}
	}

	/** Ends a line the way a tty does: on a carriage return or a newline. */
	private feed(text: string): void {
		this.line += text
		for (;;) {
			const end = /\r\n|[\r\n]/.exec(this.line)
			if (end === null) break
			const line = this.line.slice(0, end.index)
			this.line = this.line.slice(end.index + end[0].length)
			this.handleLine(line)
		}
	}

	private handleLine(line: string): void {
		if (this.options.echo !== false) this.emit(`${line}\r\n`)
		if (this.options.onLine !== undefined) {
			const answer = this.options.onLine(line)
			if (answer !== undefined) this.emit(answer)
			return
		}
		if (/login:\s*$/.test(this.options.banner ?? '')) {
			this.emit('Password: ')
			return
		}

		const setup = /__A=([A-Z0-9]+)/.exec(line)
		if (setup?.[1] !== undefined) {
			this.marker = setup[1]
			return
		}
		const encoded = /eval "\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"/.exec(line)
		if (encoded?.[1] === undefined || this.marker === '') return
		const command = Buffer.from(encoded[1], 'base64').toString('utf8')
		const inputMatch = /\( printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| eval/.exec(line)
		const input =
			inputMatch?.[1] === undefined
				? undefined
				: Buffer.from(inputMatch[1], 'base64').toString('utf8')
		this.commands.push(command)
		this.inputs.push(input)

		const reply =
			command === 'printf ready' ? { stdout: 'ready' } : this.options.reply?.(command, input)
		if (reply === 'hang') return
		const answer = reply ?? {}
		this.emit(
			`${START}${this.marker}BEGIN${STOP}${answer.stdout ?? ''}` +
				`${START}${this.marker}ERR${STOP}${answer.stderr ?? ''}` +
				`${START}${this.marker}END:${answer.exitCode ?? 0}${STOP}\r\n`,
		)
	}
}
