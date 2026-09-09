/**
 * The frame protocol of a PVE termproxy websocket.
 *
 * The client sends `user:ticket\n` first and the proxy answers `OK`. From
 * then on every client frame starts with a type digit: `0:<bytes>:<data>`
 * carries input, `1:<cols>:<rows>:` a window size and `2` a keepalive. What
 * the proxy sends is pty output with no framing at all.
 */

import type { ConsoleSocket } from './socket.ts'

/** Bytes of input one frame carries. */
const INPUT_CHUNK_BYTES = 256

export const KEEPALIVE_FRAME = '2'

export function loginFrame(user: string, ticket: string): string {
	return `${user}:${ticket}\n`
}

/** Input frames for `text`. The length in each is bytes, not characters. */
export function inputFrames(text: string): Buffer[] {
	const payload = Buffer.from(text, 'utf8')
	const frames: Buffer[] = []
	for (let offset = 0; offset < payload.length; offset += INPUT_CHUNK_BYTES) {
		const chunk = payload.subarray(offset, offset + INPUT_CHUNK_BYTES)
		frames.push(Buffer.concat([Buffer.from(`0:${chunk.length}:`, 'ascii'), chunk]))
	}
	return frames
}

export function resizeFrame(cols: number, rows: number): string {
	return `1:${cols}:${rows}:`
}

/** Sends `text` as input, one frame per chunk. */
export function sendInput(socket: ConsoleSocket, text: string): void {
	for (const frame of inputFrames(text)) socket.send(frame)
}
