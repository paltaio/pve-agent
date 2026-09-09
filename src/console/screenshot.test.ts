import { describe, expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { decode as decodeJpeg } from 'jpeg-js'
import { captureScreenshot, encodeScreenshot } from './screenshot.ts'
import { fill, frame, put } from './test-support/frames.ts'
import type { FramebufferSnapshot } from './vnc.ts'

interface PngChunk {
	type: string
	body: Buffer
}

function pngChunks(png: Buffer): PngChunk[] {
	const chunks: PngChunk[] = []
	let offset = 8
	while (offset < png.length) {
		const length = png.readUInt32BE(offset)
		const type = png.toString('ascii', offset + 4, offset + 8)
		chunks.push({ type, body: png.subarray(offset + 8, offset + 8 + length) })
		offset += 12 + length
	}
	return chunks
}

describe('encodeScreenshot', () => {
	test('writes a JPEG with the channels in the right order', () => {
		const fb = frame(8, 8, 5)
		fill(fb, 255, 0, 0)
		const shot = encodeScreenshot(fb, { quality: 100 })
		const decoded = decodeJpeg(shot.data, { useTArray: true })

		expect(shot.format).toBe('jpeg')
		expect(shot.width).toBe(8)
		expect(shot.height).toBe(8)
		expect(shot.seq).toBe(5)
		expect(decoded.width).toBe(8)
		expect(decoded.height).toBe(8)
		expect(decoded.data[0]).toBeGreaterThan(200)
		expect(decoded.data[1]).toBeLessThan(60)
		expect(decoded.data[2]).toBeLessThan(60)
	})

	test('encodes only the region asked for', () => {
		const fb = frame(16, 16)
		for (let y = 8; y < 16; y++) {
			for (let x = 8; x < 16; x++) put(fb, x, y, 0, 255, 0)
		}
		const shot = encodeScreenshot(fb, { region: { x: 8, y: 8, w: 8, h: 8 }, quality: 100 })
		const decoded = decodeJpeg(shot.data, { useTArray: true })

		expect(shot.width).toBe(8)
		expect(shot.height).toBe(8)
		expect(decoded.width).toBe(8)
		expect(decoded.data[1]).toBeGreaterThan(200)
		expect(decoded.data[0]).toBeLessThan(60)
	})

	test('writes a PNG whose IDAT inflates to unfiltered RGB scanlines', () => {
		const fb = frame(5, 3, 9)
		fill(fb, 10, 20, 30)
		put(fb, 4, 2, 200, 100, 50)
		const shot = encodeScreenshot(fb, { format: 'png' })

		expect(shot.format).toBe('png')
		expect(shot.width).toBe(5)
		expect(shot.height).toBe(3)
		expect(shot.seq).toBe(9)
		expect([...shot.data.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

		const chunks = pngChunks(shot.data)
		expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])

		const ihdr = chunks[0]?.body
		expect(ihdr?.readUInt32BE(0)).toBe(5)
		expect(ihdr?.readUInt32BE(4)).toBe(3)
		expect([...(ihdr?.subarray(8) ?? [])]).toEqual([8, 2, 0, 0, 0])

		const scanlines = inflateSync(chunks[1]?.body ?? Buffer.alloc(0))
		expect(scanlines).toHaveLength(3 * (1 + 5 * 3))
		expect(scanlines[0]).toBe(0)
		expect([...scanlines.subarray(1, 4)]).toEqual([10, 20, 30])
		expect([...scanlines.subarray(scanlines.length - 3)]).toEqual([200, 100, 50])
	})

	test('refuses an empty frame', () => {
		expect(() => encodeScreenshot(frame(0, 0))).toThrow(/framebuffer is empty/)
	})
})

describe('captureScreenshot', () => {
	function fakeSession(): {
		snapshot: () => FramebufferSnapshot
		requestUpdate: () => number
		waitForUpdate: (timeoutMs?: number, since?: number) => Promise<number>
		calls: string[]
	} {
		const fb = frame(4, 4, 1)
		const calls: string[] = []
		return {
			calls,
			snapshot: () => {
				calls.push('snapshot')
				return { ...fb, buffer: Buffer.from(fb.buffer) }
			},
			requestUpdate: () => {
				calls.push('requestUpdate')
				return fb.seq
			},
			waitForUpdate: async (timeoutMs, since) => {
				calls.push(`waitForUpdate ${timeoutMs} ${since}`)
				fb.seq = 2
				return fb.seq
			},
		}
	}

	test('encodes the current frame without a repaint by default', async () => {
		const session = fakeSession()
		const shot = await captureScreenshot(session)
		expect(shot.seq).toBe(1)
		expect(session.calls).toEqual(['snapshot'])
	})

	test('requests a repaint and waits for it when fresh is set', async () => {
		const session = fakeSession()
		const shot = await captureScreenshot(session, { fresh: true, timeoutMs: 500, format: 'png' })
		expect(shot.seq).toBe(2)
		expect(shot.format).toBe('png')
		expect(session.calls).toEqual(['requestUpdate', 'waitForUpdate 500 1', 'snapshot'])
	})
})
