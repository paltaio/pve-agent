/**
 * The socket surface a console session speaks to.
 *
 * Sessions program against this interface rather than the WebSocket itself,
 * so a test can feed a handshake byte by byte without a server.
 */

import { PveConsoleError } from '../core/errors.ts'

export interface ConsoleSocket {
	/** True while the socket can take a send. */
	readonly open: boolean
	send(data: Buffer | string): void
	close(): void
	onOpen(handler: () => void): void
	onMessage(handler: (data: Buffer) => void): void
	onError(handler: (error: Error) => void): void
	onClose(handler: () => void): void
}

export interface SocketOptions {
	headers: Record<string, string>
	/** Verify the node's TLS certificate. */
	verifySsl: boolean
}

export type SocketFactory = (url: string, options: SocketOptions) => ConsoleSocket

/**
 * Opens a WebSocket to a PVE console proxy on the `binary` subprotocol, which
 * PVE offers for both the RFB stream and the terminal stream.
 */
export const openWebSocket: SocketFactory = (url, options) => {
	const wsOptions: Bun.WebSocketOptions = {
		protocols: ['binary'],
		headers: options.headers,
		tls: { rejectUnauthorized: options.verifySsl },
	}
	const ws = new WebSocket(url, wsOptions)
	ws.binaryType = 'nodebuffer'

	return {
		get open(): boolean {
			return ws.readyState === WebSocket.OPEN
		},
		send: (data) => ws.send(data),
		close: () => ws.close(),
		onOpen: (handler) => {
			ws.onopen = () => handler()
		},
		onMessage: (handler) => {
			ws.onmessage = (event) => handler(toBuffer(event.data))
		},
		onError: (handler) => {
			ws.onerror = (event) => {
				const detail = event instanceof ErrorEvent ? event.message : 'WebSocket error'
				handler(new PveConsoleError(detail))
			}
		},
		onClose: (handler) => {
			ws.onclose = () => handler()
		},
	}
}

function toBuffer(data: unknown): Buffer {
	if (Buffer.isBuffer(data)) return data
	if (data instanceof ArrayBuffer) return Buffer.from(data)
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
	return Buffer.from(String(data), 'latin1')
}
