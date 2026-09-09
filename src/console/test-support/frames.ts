import type { FramebufferSnapshot } from '../vnc.ts'

/** A blank snapshot in the session's pixel format: B, G, R, unused. */
export function frame(width: number, height: number, seq = 0): FramebufferSnapshot {
	return { width, height, buffer: Buffer.alloc(width * height * 4), seq }
}

export function put(
	target: FramebufferSnapshot,
	x: number,
	y: number,
	r: number,
	g: number,
	b: number,
): void {
	const offset = (y * target.width + x) * 4
	target.buffer[offset] = b
	target.buffer[offset + 1] = g
	target.buffer[offset + 2] = r
}

export function fill(target: FramebufferSnapshot, r: number, g: number, b: number): void {
	for (let y = 0; y < target.height; y++) {
		for (let x = 0; x < target.width; x++) put(target, x, y, r, g, b)
	}
}

/** A copy whose pixels can be changed without touching the original. */
export function clone(source: FramebufferSnapshot): FramebufferSnapshot {
	return { ...source, buffer: Buffer.from(source.buffer) }
}
