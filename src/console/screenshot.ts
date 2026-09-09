/**
 * Encoding a framebuffer snapshot as an image file.
 *
 * JPEG goes through jpeg-js, which reads RGBA. PNG is written here: one IHDR,
 * one zlib-compressed IDAT of unfiltered RGB scanlines, one IEND.
 */

import { crc32, deflateSync } from 'node:zlib'
import { encode as encodeJpeg } from 'jpeg-js'
import { clampRegion, cropFrame, packRgb, type Region } from './framebuffer.ts'
import type { FramebufferSnapshot, VncSession } from './vnc.ts'

export type ScreenshotFormat = 'jpeg' | 'png'

export interface Screenshot {
	format: ScreenshotFormat
	width: number
	height: number
	/** The encoded file. */
	data: Buffer
	/** Paint counter of the frame this came from. */
	seq: number
}

export interface ScreenshotOptions {
	/** Defaults to jpeg. */
	format?: ScreenshotFormat
	/** JPEG quality, 1 to 100. Defaults to 85. Ignored for PNG. */
	quality?: number
	/** Part of the frame to encode. Defaults to the whole frame. */
	region?: Region
}

export interface CaptureOptions extends ScreenshotOptions {
	/** Ask the guest for a full repaint and encode the frame that answers it. */
	fresh?: boolean
	/** How long to wait for the repaint when `fresh` is set. Defaults to 3000. */
	timeoutMs?: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Encodes a snapshot, or a region of it. */
export function encodeScreenshot(
	frame: FramebufferSnapshot,
	options: ScreenshotOptions = {},
): Screenshot {
	const region = clampRegion(frame, options.region)
	const whole = region.w === frame.width && region.h === frame.height
	const source = whole ? frame : cropFrame(frame, region)
	const format = options.format ?? 'jpeg'
	const data = format === 'png' ? toPng(source) : toJpeg(source, options.quality ?? 85)
	return { format, width: source.width, height: source.height, data, seq: frame.seq }
}

/**
 * Encodes the session's current frame. With `fresh`, requests a full repaint
 * first and encodes the frame that arrives, so a stale screen is never
 * mistaken for the current one.
 */
export async function captureScreenshot(
	session: Pick<VncSession, 'snapshot' | 'requestUpdate' | 'waitForUpdate'>,
	options: CaptureOptions = {},
): Promise<Screenshot> {
	const { fresh, timeoutMs, ...encodeOptions } = options
	if (fresh) {
		const since = session.requestUpdate()
		await session.waitForUpdate(timeoutMs, since)
	}
	return encodeScreenshot(session.snapshot(), encodeOptions)
}

function toJpeg(frame: FramebufferSnapshot, quality: number): Buffer {
	const rgba = packRgb(frame, 4)
	return encodeJpeg({ data: rgba, width: frame.width, height: frame.height }, quality).data
}

function toPng(frame: FramebufferSnapshot): Buffer {
	// Each scanline starts with a filter byte; 0 leaves the row as is.
	const rgb = packRgb(frame, 3)
	const rowBytes = frame.width * 3
	const scanlines = Buffer.alloc(frame.height * (rowBytes + 1))
	for (let y = 0; y < frame.height; y++) {
		rgb.copy(scanlines, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes)
	}

	// Width, height, then 8 bits per sample, colour type 2 (RGB), compression
	// 0, filter method 0, no interlace.
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(frame.width, 0)
	ihdr.writeUInt32BE(frame.height, 4)
	ihdr.set([8, 2, 0, 0, 0], 8)

	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', deflateSync(scanlines)),
		pngChunk('IEND', Buffer.alloc(0)),
	])
}

function pngChunk(type: string, body: Buffer): Buffer {
	const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
	const length = Buffer.alloc(4)
	length.writeUInt32BE(body.length, 0)
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(typed), 0)
	return Buffer.concat([length, typed, crc])
}
