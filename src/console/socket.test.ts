import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PveConsoleError } from '../core/errors.ts'
import { openWebSocket } from './socket.ts'

interface Seen {
	cookie: string | null
	protocol: string | null
}

let server: ReturnType<typeof Bun.serve<Seen>>
let seen: Seen | undefined

beforeAll(() => {
	server = Bun.serve<Seen>({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request, self) {
			const data: Seen = {
				cookie: request.headers.get('cookie'),
				protocol: request.headers.get('sec-websocket-protocol'),
			}
			if (new URL(request.url).pathname === '/refuse') {
				return new Response('', { status: 401, statusText: 'Unauthorized' })
			}
			if (self.upgrade(request, { data })) return undefined
			return new Response('', { status: 400 })
		},
		websocket: {
			open(ws) {
				seen = ws.data
			},
			message(ws, message) {
				ws.send(message)
			},
		},
	})
})

afterAll(() => {
	server.stop(true)
})

describe('openWebSocket', () => {
	test('opens on the binary subprotocol, carries the headers and round-trips a frame', async () => {
		const socket = openWebSocket(`ws://127.0.0.1:${server.port}/echo`, {
			headers: { Cookie: 'PVEAuthCookie=PVE%3Aroot%40pam%3ATICKET' },
			verifySsl: false,
		})

		const opened = new Promise<void>((resolve) => socket.onOpen(resolve))
		const echoed = new Promise<Buffer>((resolve) => socket.onMessage(resolve))
		const closed = new Promise<void>((resolve) => socket.onClose(resolve))

		await opened
		expect(socket.open).toBe(true)
		expect(seen).toEqual({ cookie: 'PVEAuthCookie=PVE%3Aroot%40pam%3ATICKET', protocol: 'binary' })

		socket.send(Buffer.from([0x52, 0x46, 0x42]))
		const frame = await echoed
		expect(Buffer.isBuffer(frame)).toBe(true)
		expect([...frame]).toEqual([0x52, 0x46, 0x42])

		socket.close()
		await closed
		expect(socket.open).toBe(false)
	})

	test('reports a refused upgrade as a console error', async () => {
		const socket = openWebSocket(`ws://127.0.0.1:${server.port}/refuse`, {
			headers: {},
			verifySsl: false,
		})
		const error = await new Promise<Error>((resolve) => socket.onError(resolve))
		expect(error).toBeInstanceOf(PveConsoleError)
		expect(error.message).toMatch(/101/)
		expect(socket.open).toBe(false)
	})

	test('reports a connection that never opens', async () => {
		const socket = openWebSocket('ws://127.0.0.1:1', { headers: {}, verifySsl: false })
		const error = await new Promise<Error>((resolve) => socket.onError(resolve))
		expect(error).toBeInstanceOf(PveConsoleError)
		expect(error.message).toMatch(/Failed to connect/)
	})
})
