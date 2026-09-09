import { describe, expect, test } from 'bun:test'
import {
	changedFraction,
	clampRegion,
	colorDistance,
	colorRatio,
	cropFrame,
	packRgb,
	parseColor,
	pixelAt,
	scaleFrame,
	toleranceFor,
} from './framebuffer.ts'
import { clone, fill, frame, put } from './test-support/frames.ts'

describe('parseColor', () => {
	test('takes #rrggbb, bare hex and a triple', () => {
		expect(parseColor('#336699')).toEqual([0x33, 0x66, 0x99])
		expect(parseColor('336699')).toEqual([0x33, 0x66, 0x99])
		expect(parseColor([1, 2, 3])).toEqual([1, 2, 3])
	})

	test('rejects anything else', () => {
		expect(() => parseColor('red')).toThrow(/not a #rrggbb colour/)
		expect(() => parseColor('#fff')).toThrow(/not a #rrggbb colour/)
	})
})

describe('colorDistance and toleranceFor', () => {
	test('distance is the largest channel gap', () => {
		expect(colorDistance([10, 20, 30], [10, 20, 30])).toBe(0)
		expect(colorDistance([0, 0, 0], [5, 100, 3])).toBe(100)
	})

	test('threshold 1 is exact and 0.9 allows about 25 levels', () => {
		expect(toleranceFor(1)).toBe(0)
		expect(toleranceFor(0.9)).toBe(25)
		expect(toleranceFor(0)).toBe(255)
		expect(() => toleranceFor(1.5)).toThrow(/between 0 and 1/)
	})
})

describe('clampRegion', () => {
	test('defaults to the whole frame', () => {
		expect(clampRegion(frame(40, 20))).toEqual({ x: 0, y: 0, w: 40, h: 20 })
	})

	test('pulls a region back inside the frame', () => {
		expect(clampRegion(frame(40, 20), { x: 35, y: 18, w: 100, h: 100 })).toEqual({
			x: 35,
			y: 18,
			w: 5,
			h: 2,
		})
		expect(clampRegion(frame(40, 20), { x: -10, y: -10, w: 4, h: 4 })).toEqual({
			x: 0,
			y: 0,
			w: 4,
			h: 4,
		})
	})

	test('refuses an empty frame', () => {
		expect(() => clampRegion(frame(0, 0))).toThrow(/framebuffer is empty/)
	})
})

describe('pixelAt', () => {
	test('reads red, green and blue from the B G R X layout', () => {
		const fb = frame(3, 2)
		put(fb, 2, 1, 10, 20, 30)
		expect(pixelAt(fb, 2, 1)).toEqual([10, 20, 30])
		expect(pixelAt(fb, 0, 0)).toEqual([0, 0, 0])
	})

	test('rejects coordinates outside the frame or not integers', () => {
		const fb = frame(3, 2)
		expect(() => pixelAt(fb, 3, 0)).toThrow(/outside the 3x2 framebuffer/)
		expect(() => pixelAt(fb, 0, -1)).toThrow(/outside/)
		expect(() => pixelAt(fb, 1.5, 0)).toThrow(/integers/)
	})
})

describe('packRgb', () => {
	test('packs RGB and RGBA with opaque alpha', () => {
		const fb = frame(2, 1)
		put(fb, 0, 0, 1, 2, 3)
		put(fb, 1, 0, 4, 5, 6)
		expect([...packRgb(fb, 3)]).toEqual([1, 2, 3, 4, 5, 6])
		expect([...packRgb(fb, 4)]).toEqual([1, 2, 3, 255, 4, 5, 6, 255])
	})
})

describe('cropFrame', () => {
	test('copies only the region and keeps the paint counter', () => {
		const fb = frame(4, 4, 7)
		fill(fb, 0, 0, 0)
		put(fb, 2, 2, 255, 0, 0)
		put(fb, 3, 3, 0, 255, 0)

		const crop = cropFrame(fb, { x: 2, y: 2, w: 2, h: 2 })

		expect(crop.width).toBe(2)
		expect(crop.height).toBe(2)
		expect(crop.seq).toBe(7)
		expect(crop.buffer).toHaveLength(16)
		expect(pixelAt(crop, 0, 0)).toEqual([255, 0, 0])
		expect(pixelAt(crop, 1, 1)).toEqual([0, 255, 0])
		expect(pixelAt(crop, 1, 0)).toEqual([0, 0, 0])
	})

	test('owns its pixels', () => {
		const fb = frame(2, 2)
		const crop = cropFrame(fb, { x: 0, y: 0, w: 2, h: 2 })
		put(fb, 0, 0, 9, 9, 9)
		expect(pixelAt(crop, 0, 0)).toEqual([0, 0, 0])
	})
})

describe('scaleFrame', () => {
	test('repeats every pixel in both directions', () => {
		const fb = frame(2, 1, 3)
		put(fb, 0, 0, 1, 2, 3)
		put(fb, 1, 0, 4, 5, 6)

		const scaled = scaleFrame(fb, 3)

		expect(scaled.width).toBe(6)
		expect(scaled.height).toBe(3)
		expect(scaled.seq).toBe(3)
		for (let y = 0; y < 3; y++) {
			for (let x = 0; x < 3; x++) expect(pixelAt(scaled, x, y)).toEqual([1, 2, 3])
			for (let x = 3; x < 6; x++) expect(pixelAt(scaled, x, y)).toEqual([4, 5, 6])
		}
	})

	test('copies at factor 1 and rejects other factors', () => {
		const fb = frame(2, 2)
		const same = scaleFrame(fb, 1)
		expect(same.buffer).not.toBe(fb.buffer)
		expect(same.buffer.equals(fb.buffer)).toBe(true)
		expect(() => scaleFrame(fb, 0)).toThrow(/positive integer/)
		expect(() => scaleFrame(fb, 1.5)).toThrow(/positive integer/)
	})
})

describe('colorRatio', () => {
	test('reports the whole frame when every pixel matches', () => {
		const fb = frame(8, 8)
		fill(fb, 0x33, 0x66, 0x99)
		expect(colorRatio(fb, '#336699', { threshold: 1 })).toBe(1)
	})

	test('counts only the pixels within the tolerance', () => {
		const fb = frame(4, 1)
		put(fb, 0, 0, 255, 0, 0)
		put(fb, 1, 0, 250, 5, 5)
		expect(colorRatio(fb, [255, 0, 0], { threshold: 0.95 })).toBe(0.5)
		expect(colorRatio(fb, [255, 0, 0], { threshold: 1 })).toBe(0.25)
	})

	test('restricts the count to a region', () => {
		const fb = frame(4, 2)
		for (let x = 0; x < 4; x++) put(fb, x, 1, 255, 255, 255)
		expect(colorRatio(fb, '#ffffff', { region: { x: 0, y: 1, w: 4, h: 1 } })).toBe(1)
		expect(colorRatio(fb, '#ffffff', { region: { x: 0, y: 0, w: 4, h: 1 } })).toBe(0)
	})
})

describe('changedFraction', () => {
	test('is 0 for identical frames and counts differing pixels', () => {
		const before = frame(4, 2)
		fill(before, 10, 10, 10)
		const after = clone(before)
		expect(changedFraction(before, after)).toBe(0)

		put(after, 0, 0, 11, 10, 10)
		put(after, 3, 1, 10, 10, 200)
		expect(changedFraction(before, after)).toBe(0.25)
	})

	test('ignores the unused fourth byte', () => {
		const before = frame(1, 1)
		const after = clone(before)
		after.buffer[3] = 0xff
		expect(changedFraction(before, after)).toBe(0)
	})

	test('limits the comparison to a region', () => {
		const before = frame(4, 4)
		const after = clone(before)
		put(after, 0, 0, 1, 1, 1)
		expect(changedFraction(before, after, { x: 0, y: 0, w: 2, h: 2 })).toBe(0.25)
		expect(changedFraction(before, after, { x: 2, y: 2, w: 2, h: 2 })).toBe(0)
	})

	test('treats a size change as fully changed', () => {
		expect(changedFraction(frame(2, 2), frame(4, 1))).toBe(1)
	})
})
