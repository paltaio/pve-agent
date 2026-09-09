/**
 * Stand-ins the facade tests use in place of a cluster: a VNC server that
 * completes the RFB handshake on its own, a socket factory that hands out
 * VNC servers and terminal ptys by URL, and an ssh binary answered from a
 * table of replies.
 */

import { MSG_KEY_EVENT, MSG_POINTER_EVENT } from '../console/rfb.ts'
import type { ConsoleSocket, SocketFactory } from '../console/socket.ts'
import type { SpawnFn } from '../shell/spawn.ts'
import { FakePty, type FakePtyOptions } from '../shell/test-support.ts'

/** A VNC server that answers the handshake with a blank screen of the given size. */
export class FakeVncServer implements ConsoleSocket {
	open = true
	readonly width: number
	readonly height: number
	readonly sent: Buffer[] = []
	closes = 0

	private messageHandler: ((data: Buffer) => void) | undefined
	private closeHandler: (() => void) | undefined

	constructor(width = 64, height = 32) {
		this.width = width
		this.height = height
	}

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
		setTimeout(() => this.messageHandler?.(this.handshake()), 0)
	}

	onError(): void {}

	onClose(handler: () => void): void {
		this.closeHandler = handler
	}

	/** Drops the connection from the server side. */
	dropConnection(): void {
		this.open = false
		this.closeHandler?.()
	}

	/** Key events as [down, keysym] pairs. */
	get keyEvents(): [number, number][] {
		return this.sent
			.filter((buf) => buf.length === 8 && buf[0] === MSG_KEY_EVENT)
			.map((buf) => [buf.readUInt8(1), buf.readUInt32BE(4)])
	}

	/** Pointer events as [mask, x, y] triples. */
	get pointerEvents(): [number, number, number][] {
		return this.sent
			.filter((buf) => buf.length === 6 && buf[0] === MSG_POINTER_EVENT)
			.map((buf) => [buf.readUInt8(1), buf.readUInt16BE(2), buf.readUInt16BE(4)])
	}

	private handshake(): Buffer {
		const init = Buffer.alloc(24)
		init.writeUInt16BE(this.width, 0)
		init.writeUInt16BE(this.height, 2)
		return Buffer.concat([
			Buffer.from('RFB 003.008\n', 'ascii'),
			Buffer.from([1, 1]),
			Buffer.alloc(4),
			init,
		])
	}
}

export interface FakeSocketOptions {
	/** Screen size the VNC servers answer with. */
	screen?: { width: number; height: number }
	pty?: FakePtyOptions
}

/**
 * A socket factory that records the sockets it hands out. A URL whose port
 * starts with 59 gets a VNC server; any other gets a terminal pty.
 */
export function fakeSockets(options: FakeSocketOptions = {}): {
	factory: SocketFactory
	urls: string[]
	vnc: FakeVncServer[]
	ptys: FakePty[]
} {
	const urls: string[] = []
	const vnc: FakeVncServer[] = []
	const ptys: FakePty[] = []
	const factory: SocketFactory = (url) => {
		urls.push(url)
		const port = new URL(url).searchParams.get('port') ?? ''
		if (port.startsWith('59')) {
			const server = new FakeVncServer(options.screen?.width, options.screen?.height)
			vnc.push(server)
			return server
		}
		const pty = new FakePty(options.pty)
		ptys.push(pty)
		return pty
	}
	return { factory, urls, vnc, ptys }
}

/** The reply an ssh invocation gets, keyed by a fragment of its argument line. */
export type SshReplies = Record<string, { stdout?: string; stderr?: string; exitCode?: number }>

/**
 * An ssh binary answered from the first reply whose key the argument line
 * contains, with exit 0 and no output for everything else. `commands` holds
 * every argument line, the probe's `true` included.
 */
export function fakeSsh(replies: SshReplies = {}): { spawn: SpawnFn; commands: string[] } {
	const commands: string[] = []
	const encoder = new TextEncoder()
	const spawn: SpawnFn = async (request) => {
		const command = request.argv.join(' ')
		commands.push(command)
		const key = Object.keys(replies).find((fragment) => command.includes(fragment))
		const reply = key === undefined ? {} : (replies[key] ?? {})
		return {
			exitCode: reply.exitCode ?? 0,
			stdout: encoder.encode(reply.stdout ?? ''),
			stderr: encoder.encode(reply.stderr ?? ''),
			timedOut: false,
		}
	}
	return { spawn, commands }
}
