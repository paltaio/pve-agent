/**
 * A ConsoleSocket the tests drive from the server side, byte by byte.
 */

import type { ConsoleSocket } from '../socket.ts'

/** A socket the test drives byte by byte. */
export class FakeSocket implements ConsoleSocket {
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
