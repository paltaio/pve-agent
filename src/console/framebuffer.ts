/**
 * Reading pixels out of a framebuffer snapshot.
 *
 * Every helper takes the owned copy `VncSession.snapshot()` hands out, so a
 * paint landing mid-read cannot tear the answer. Channel offsets come from
 * the pixel format the session negotiates, which puts each channel at the
 * byte its shift names.
 */

import { PveConfigError, PveConsoleError } from '../core/errors.ts'
import { PIXEL_FORMAT } from './rfb.ts'
import type { FramebufferSnapshot } from './vnc.ts'

export interface Region {
	x: number
	y: number
	w: number
	h: number
}

/** Red, green and blue, 0 to 255. */
export type Rgb = readonly [number, number, number]

/** A colour as `#rrggbb` or an `[r, g, b]` triple. */
export type Color = string | Rgb

export const BYTES_PER_PIXEL = 4
const RED_OFFSET = PIXEL_FORMAT.readUInt8(10) / 8
const GREEN_OFFSET = PIXEL_FORMAT.readUInt8(11) / 8
const BLUE_OFFSET = PIXEL_FORMAT.readUInt8(12) / 8

export function parseColor(color: Color): Rgb {
	if (typeof color !== 'string') return color
	const match = /^#?([0-9a-f]{6})$/i.exec(color.trim())
	if (!match) throw new PveConfigError(`'${color}' is not a #rrggbb colour`)
	const value = parseInt(match[1] ?? '', 16)
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/**
 * Largest per-channel difference, 0 to 255, so a colour is "near" another when
 * no single channel drifts too far.
 */
export function colorDistance(a: Rgb, b: Rgb): number {
	return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

/** Per-channel drift a similarity threshold of 0 to 1 allows; 1 is exact. */
export function toleranceFor(threshold: number): number {
	if (!(threshold >= 0 && threshold <= 1)) {
		throw new PveConfigError(`A colour threshold has to be between 0 and 1, got ${threshold}`)
	}
	return Math.round((1 - threshold) * 255)
}

/** A region pulled inside the frame; undefined means the whole frame. */
export function clampRegion(frame: FramebufferSnapshot, region?: Region): Region {
	if (frame.width === 0 || frame.height === 0) {
		throw new PveConsoleError('The framebuffer is empty')
	}
	if (!region) return { x: 0, y: 0, w: frame.width, h: frame.height }
	const x = Math.max(0, Math.min(frame.width - 1, Math.trunc(region.x)))
	const y = Math.max(0, Math.min(frame.height - 1, Math.trunc(region.y)))
	const w = Math.max(1, Math.min(frame.width - x, Math.trunc(region.w)))
	const h = Math.max(1, Math.min(frame.height - y, Math.trunc(region.h)))
	return { x, y, w, h }
}

export function pixelAt(frame: FramebufferSnapshot, x: number, y: number): Rgb {
	if (!Number.isInteger(x) || !Number.isInteger(y)) {
		throw new PveConfigError(`Pixel coordinates must be integers, got (${x}, ${y})`)
	}
	if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
		throw new PveConfigError(
			`Pixel (${x}, ${y}) is outside the ${frame.width}x${frame.height} framebuffer`,
		)
	}
	const offset = (y * frame.width + x) * BYTES_PER_PIXEL
	return [
		frame.buffer.readUInt8(offset + RED_OFFSET),
		frame.buffer.readUInt8(offset + GREEN_OFFSET),
		frame.buffer.readUInt8(offset + BLUE_OFFSET),
	]
}

/**
 * The frame's pixels packed as RGB (3 bytes each) or RGBA (4 bytes each,
 * alpha opaque), row-major.
 */
export function packRgb(frame: FramebufferSnapshot, channels: 3 | 4): Buffer {
	const out = Buffer.alloc(frame.width * frame.height * channels)
	const src = frame.buffer
	let dst = 0
	for (let offset = 0; offset < src.length; offset += BYTES_PER_PIXEL) {
		out[dst] = src.readUInt8(offset + RED_OFFSET)
		out[dst + 1] = src.readUInt8(offset + GREEN_OFFSET)
		out[dst + 2] = src.readUInt8(offset + BLUE_OFFSET)
		if (channels === 4) out[dst + 3] = 255
		dst += channels
	}
	return out
}

/** A new snapshot holding one region, with the source's paint counter. */
export function cropFrame(frame: FramebufferSnapshot, region: Region): FramebufferSnapshot {
	const { x, y, w, h } = clampRegion(frame, region)
	const srcStride = frame.width * BYTES_PER_PIXEL
	const rowBytes = w * BYTES_PER_PIXEL
	const buffer = Buffer.alloc(h * rowBytes)
	for (let row = 0; row < h; row++) {
		const src = (y + row) * srcStride + x * BYTES_PER_PIXEL
		frame.buffer.copy(buffer, row * rowBytes, src, src + rowBytes)
	}
	return { width: w, height: h, buffer, seq: frame.seq }
}

/** A new snapshot with every pixel repeated `factor` times in both directions. */
export function scaleFrame(frame: FramebufferSnapshot, factor: number): FramebufferSnapshot {
	if (!Number.isInteger(factor) || factor < 1) {
		throw new PveConfigError(`A scale factor has to be a positive integer, got ${factor}`)
	}
	if (factor === 1) return { ...frame, buffer: Buffer.from(frame.buffer) }
	const width = frame.width * factor
	const height = frame.height * factor
	const srcStride = frame.width * BYTES_PER_PIXEL
	const dstStride = width * BYTES_PER_PIXEL
	const buffer = Buffer.alloc(height * dstStride)
	for (let y = 0; y < frame.height; y++) {
		const firstRow = y * factor * dstStride
		for (let x = 0; x < frame.width; x++) {
			const src = y * srcStride + x * BYTES_PER_PIXEL
			const pixel = frame.buffer.readUInt32LE(src)
			let dst = firstRow + x * factor * BYTES_PER_PIXEL
			for (let i = 0; i < factor; i++) {
				buffer.writeUInt32LE(pixel, dst)
				dst += BYTES_PER_PIXEL
			}
		}
		const rowStart = firstRow
		for (let i = 1; i < factor; i++) {
			buffer.copy(buffer, rowStart + i * dstStride, rowStart, rowStart + dstStride)
		}
	}
	return { width, height, buffer, seq: frame.seq }
}

export interface ColorRatioOptions {
	/** Similarity a pixel needs, 0 to 1. 1 is exact; 0.9 lets each channel drift about 25 levels. Defaults to 0.9. */
	threshold?: number
	region?: Region
}

/** Fraction of a region's pixels within the threshold of a colour. */
export function colorRatio(
	frame: FramebufferSnapshot,
	color: Color,
	options: ColorRatioOptions = {},
): number {
	const [r, g, b] = parseColor(color)
	const tolerance = toleranceFor(options.threshold ?? 0.9)
	const region = clampRegion(frame, options.region)
	const stride = frame.width * BYTES_PER_PIXEL
	const buffer = frame.buffer

	let hits = 0
	for (let row = 0; row < region.h; row++) {
		let offset = (region.y + row) * stride + region.x * BYTES_PER_PIXEL
		for (let col = 0; col < region.w; col++) {
			if (
				Math.abs(buffer.readUInt8(offset + RED_OFFSET) - r) <= tolerance &&
				Math.abs(buffer.readUInt8(offset + GREEN_OFFSET) - g) <= tolerance &&
				Math.abs(buffer.readUInt8(offset + BLUE_OFFSET) - b) <= tolerance
			) {
				hits++
			}
			offset += BYTES_PER_PIXEL
		}
	}
	return hits / (region.w * region.h)
}

/**
 * Fraction of a region's pixels whose colour differs between two frames.
 * Frames of different sizes count as fully changed. The unused fourth byte
 * of each pixel is ignored.
 */
export function changedFraction(
	before: FramebufferSnapshot,
	after: FramebufferSnapshot,
	region?: Region,
): number {
	if (before.width !== after.width || before.height !== after.height) return 1
	const area = clampRegion(after, region)
	const stride = after.width * BYTES_PER_PIXEL

	let changed = 0
	for (let row = 0; row < area.h; row++) {
		let offset = (area.y + row) * stride + area.x * BYTES_PER_PIXEL
		for (let col = 0; col < area.w; col++) {
			if (
				before.buffer.readUInt8(offset + RED_OFFSET) !==
					after.buffer.readUInt8(offset + RED_OFFSET) ||
				before.buffer.readUInt8(offset + GREEN_OFFSET) !==
					after.buffer.readUInt8(offset + GREEN_OFFSET) ||
				before.buffer.readUInt8(offset + BLUE_OFFSET) !==
					after.buffer.readUInt8(offset + BLUE_OFFSET)
			) {
				changed++
			}
			offset += BYTES_PER_PIXEL
		}
	}
	return changed / (area.w * area.h)
}
