import { describe, expect, test } from 'bun:test'
import { PveTimeoutError } from '../core/errors.ts'
import { matchScreen, runMatcher, waitForScreen, type ScreenMatcher } from './match.ts'
import { clone, fill, frame, put } from './test-support/frames.ts'
import type { FramebufferSnapshot } from './vnc.ts'

describe('runMatcher', () => {
	test('pixel: exact and near colours, with the pixel colour reported', () => {
		const fb = frame(2, 2)
		put(fb, 1, 1, 250, 5, 5)

		expect(runMatcher(fb, { kind: 'pixel', x: 1, y: 1, color: '#ff0000' })).toEqual({
			kind: 'pixel',
			matched: true,
			color: [250, 5, 5],
		})
		expect(
			runMatcher(fb, { kind: 'pixel', x: 1, y: 1, color: '#ff0000', threshold: 1 }).matched,
		).toBe(false)
		expect(
			runMatcher(fb, { kind: 'pixel', x: 0, y: 0, color: [0, 0, 0], threshold: 1 }).matched,
		).toBe(true)
	})

	test('color: fraction of the region near the colour against area', () => {
		const fb = frame(10, 10)
		for (let x = 0; x < 10; x++) put(fb, x, 0, 0, 0, 255)

		const hit = runMatcher(fb, { kind: 'color', color: '#0000ff', area: 0.05 })
		expect(hit).toEqual({ kind: 'color', matched: true, fraction: 0.1 })

		const miss = runMatcher(fb, { kind: 'color', color: '#0000ff' })
		expect(miss.matched).toBe(false)

		const region = runMatcher(fb, {
			kind: 'color',
			color: '#0000ff',
			region: { x: 0, y: 0, w: 10, h: 1 },
		})
		expect(region).toEqual({ kind: 'color', matched: true, fraction: 1 })
	})

	test('changed: fraction differing from the reference against area', () => {
		const before = frame(10, 10)
		fill(before, 1, 1, 1)
		const same = clone(before)
		expect(runMatcher(same, { kind: 'changed', since: before })).toEqual({
			kind: 'changed',
			matched: false,
			fraction: 0,
		})

		const after = clone(before)
		put(after, 3, 3, 2, 2, 2)
		expect(runMatcher(after, { kind: 'changed', since: before })).toEqual({
			kind: 'changed',
			matched: true,
			fraction: 0.01,
		})
		expect(runMatcher(after, { kind: 'changed', since: before, area: 0.5 }).matched).toBe(false)
		expect(
			runMatcher(after, { kind: 'changed', since: before, region: { x: 0, y: 0, w: 2, h: 2 } })
				.matched,
		).toBe(false)
	})
})

describe('matchScreen', () => {
	const fb = frame(4, 4)
	fill(fb, 255, 255, 255)
	const white: ScreenMatcher = { kind: 'color', color: '#ffffff' }
	const black: ScreenMatcher = { kind: 'color', color: '#000000' }

	test('a single matcher', () => {
		expect(matchScreen(fb, white).matched).toBe(true)
		expect(matchScreen(fb, black).matched).toBe(false)
	})

	test.each([
		['all', [true, true], true],
		['all', [true, false], false],
		['all', [false, false], false],
		['any', [true, false], true],
		['any', [false, false], false],
		['any', [true, true], true],
	] as const)('%s over %p is %p', (match, truth, expected) => {
		const matchers = truth.map((ok) => (ok ? white : black))
		const result = matchScreen(fb, matchers, { match })
		expect(result.matched).toBe(expected)
		expect(result.results.map((r) => r.matched)).toEqual([...truth])
	})

	test('an empty list matches under all and not under any', () => {
		expect(matchScreen(fb, []).matched).toBe(true)
		expect(matchScreen(fb, [], { match: 'any' }).matched).toBe(false)
	})
})

describe('waitForScreen', () => {
	function session(frames: FramebufferSnapshot[]): {
		vmid: number
		snapshot: () => FramebufferSnapshot
		reads: number
	} {
		const state = {
			vmid: 101,
			reads: 0,
			snapshot: (): FramebufferSnapshot => {
				const index = Math.min(state.reads, frames.length - 1)
				state.reads++
				const next = frames[index]
				if (!next) throw new Error('no frames')
				return next
			},
		}
		return state
	}

	test('resolves with the first frame that satisfies the matchers', async () => {
		const dark = frame(4, 4)
		const lit = frame(4, 4, 1)
		fill(lit, 255, 255, 255)
		const s = session([dark, dark, lit])

		const hit = await waitForScreen(s, { kind: 'color', color: '#ffffff' }, { intervalMs: 1 })

		expect(hit).toBe(lit)
		expect(s.reads).toBe(3)
	})

	test('takes a predicate', async () => {
		const first = frame(4, 4, 0)
		const later = frame(4, 4, 3)
		const s = session([first, later])

		const hit = await waitForScreen(s, (f) => f.seq >= 3, { intervalMs: 1 })

		expect(hit.seq).toBe(3)
	})

	test('throws PveTimeoutError when nothing matches in time', async () => {
		const s = session([frame(4, 4)])
		const started = Date.now()

		const failure = waitForScreen(
			s,
			{ kind: 'color', color: '#ffffff' },
			{ timeoutMs: 40, intervalMs: 5 },
		)

		await expect(failure).rejects.toBeInstanceOf(PveTimeoutError)
		await expect(failure).rejects.toThrow(/guest 101 to show the expected screen/)
		expect(Date.now() - started).toBeGreaterThanOrEqual(35)
		expect(s.reads).toBeGreaterThan(1)
	})
})
