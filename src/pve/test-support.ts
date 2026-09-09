/**
 * Stand-ins the facade tests use in place of a cluster: a VNC server that
 * completes the RFB handshake on its own, a socket factory that hands out
 * VNC servers and terminal ptys by URL, and an ssh binary answered from a
 * table of replies.
 */

import { MSG_KEY_EVENT, MSG_POINTER_EVENT } from '../console/rfb.ts'
import type { SocketFactory } from '../console/socket.ts'
import { FakeSocket } from '../console/test-support/sockets.ts'
import { mockClient, type MockClient } from '../core/test-support/api-mock.ts'
import type { SpawnFn } from '../shell/spawn.ts'
import { FakePty, fakeSpawn, type FakePtyOptions } from '../shell/test-support.ts'
import { PveCluster, type PveClusterOptions } from './cluster.ts'

/** Replies the facade tests queue for a task, a VNC proxy and a terminal proxy. */
export const UPID = 'UPID:ms01-0160:0007A1F2:0121C6B4:65F4A0E2:qmstart:9000:agents@pve!ci:'
export const DONE = { status: 'stopped', exitstatus: 'OK' }
export const VNC_PROXY = { port: '5900', ticket: 'VNCTICKET', user: 'root@pam', password: 'pw' }
export const TERM_PROXY = { port: '6001', ticket: 'TERMTICKET', user: 'root@pam' }

export interface ClusterFixtureOptions extends PveClusterOptions {
	/** The default node the client is configured with. Unset leaves it out. */
	node?: string
	sockets?: FakeSocketOptions
}

export type ClusterFixture = MockClient & ReturnType<typeof fakeSockets> & { cluster: PveCluster }

/**
 * A cluster on a mock API with fake sockets and, when `node` is given, a
 * default node. A `socketFactory` in the options replaces the fake one.
 */
export function clusterFixture(options: ClusterFixtureOptions = {}): ClusterFixture {
	const { node, sockets, ...clusterOptions } = options
	const mock = mockClient()
	if (node !== undefined) mock.client.auth.connection.node = node
	const fakes = fakeSockets(sockets)
	const cluster = new PveCluster(mock.client, {
		socketFactory: fakes.factory,
		...clusterOptions,
	})
	return { ...mock, ...fakes, cluster }
}

/** A VNC server that answers the handshake with a blank screen of the given size. */
export class FakeVncServer extends FakeSocket {
	readonly width: number
	readonly height: number

	constructor(width = 64, height = 32) {
		super()
		this.width = width
		this.height = height
	}

	override onMessage(handler: (data: Buffer) => void): void {
		super.onMessage(handler)
		setTimeout(() => this.deliver(this.handshake()), 0)
	}

	/** Drops the connection from the server side. */
	dropConnection(): void {
		this.fireClose()
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

export interface SshReply {
	stdout?: string
	stderr?: string
	exitCode?: number
}

/** The reply an ssh invocation gets, keyed by a fragment of its argument line. */
export type SshReplies = Record<string, SshReply | (() => SshReply)>

/**
 * An ssh binary answered from the first reply whose key the argument line
 * contains, with exit 0 and no output for everything else. `commands` holds
 * every argument line, the probe's `true` included.
 */
export function fakeSsh(replies: SshReplies = {}): { spawn: SpawnFn; commands: string[] } {
	const commands: string[] = []
	const encoder = new TextEncoder()
	const spawn = fakeSpawn((request) => {
		const command = request.argv.join(' ')
		commands.push(command)
		const key = Object.keys(replies).find((fragment) => command.includes(fragment))
		const found = key === undefined ? {} : (replies[key] ?? {})
		const reply = typeof found === 'function' ? found() : found
		return {
			...(reply.exitCode === undefined ? {} : { exitCode: reply.exitCode }),
			stdout: encoder.encode(reply.stdout ?? ''),
			stderr: encoder.encode(reply.stderr ?? ''),
		}
	})
	return { spawn, commands }
}
