/**
 * Deciding whether a screen shows what a caller is waiting for.
 *
 * A matcher reads the framebuffer directly: a pixel near a colour, a region
 * mostly one colour, or a region that changed since a reference frame. That
 * is enough to spot a firmware splash, a boot menu or an installer step
 * without reading any text.
 */

import { PveTimeoutError } from '../core/errors.ts'
import { pollUntil } from '../core/poll.ts'
import {
	changedFraction,
	colorDistance,
	colorRatio,
	parseColor,
	pixelAt,
	toleranceFor,
	type Color,
	type Region,
	type Rgb,
} from './framebuffer.ts'
import type { FramebufferSnapshot, VncSession } from './vnc.ts'

/** One pixel is within `threshold` similarity of a colour. */
export interface PixelMatcher {
	kind: 'pixel'
	x: number
	y: number
	color: Color
	/** 0 to 1; 1 is exact, 0.9 lets each channel drift about 25 levels. Defaults to 0.9. */
	threshold?: number
}

/** At least `area` of a region is within `threshold` similarity of a colour. */
export interface ColorMatcher {
	kind: 'color'
	color: Color
	/** 0 to 1; 1 is exact, 0.9 lets each channel drift about 25 levels. Defaults to 0.9. */
	threshold?: number
	/** Fraction of the region that has to match, 0 to 1. Defaults to 0.5. */
	area?: number
	region?: Region
}

/** At least `area` of a region differs from a reference frame. */
export interface ChangedMatcher {
	kind: 'changed'
	since: FramebufferSnapshot
	/** Fraction of the region that has to differ, 0 to 1. Defaults to 0.001. */
	area?: number
	region?: Region
}

export type ScreenMatcher = PixelMatcher | ColorMatcher | ChangedMatcher

export type MatcherResult =
	| { kind: 'pixel'; matched: boolean; color: Rgb }
	| { kind: 'color'; matched: boolean; fraction: number }
	| { kind: 'changed'; matched: boolean; fraction: number }

export interface ScreenMatchOptions {
	/** Require every matcher ('all', the default) or any one of them ('any'). */
	match?: 'all' | 'any'
}

export interface ScreenMatchResult {
	matched: boolean
	/** One entry per matcher, in the order given. */
	results: MatcherResult[]
}

export type ScreenPredicate = (frame: FramebufferSnapshot) => boolean

export interface ScreenWaitOptions extends ScreenMatchOptions {
	/** Give up after this long. Defaults to 30000. */
	timeoutMs?: number
	/** Delay between reads. Defaults to 250. */
	intervalMs?: number
	signal?: AbortSignal
}

const DEFAULT_THRESHOLD = 0.9
const DEFAULT_COLOR_AREA = 0.5
const DEFAULT_CHANGED_AREA = 0.001

export function runMatcher(frame: FramebufferSnapshot, matcher: ScreenMatcher): MatcherResult {
	switch (matcher.kind) {
		case 'pixel': {
			const color = pixelAt(frame, matcher.x, matcher.y)
			const tolerance = toleranceFor(matcher.threshold ?? DEFAULT_THRESHOLD)
			const matched = colorDistance(color, parseColor(matcher.color)) <= tolerance
			return { kind: 'pixel', matched, color }
		}
		case 'color': {
			const options: Parameters<typeof colorRatio>[2] = {
				threshold: matcher.threshold ?? DEFAULT_THRESHOLD,
			}
			if (matcher.region) options.region = matcher.region
			const fraction = colorRatio(frame, matcher.color, options)
			return { kind: 'color', matched: fraction >= (matcher.area ?? DEFAULT_COLOR_AREA), fraction }
		}
		case 'changed': {
			const fraction = changedFraction(matcher.since, frame, matcher.region)
			return {
				kind: 'changed',
				matched: fraction >= (matcher.area ?? DEFAULT_CHANGED_AREA),
				fraction,
			}
		}
	}
}

/** Runs every matcher against one frame and combines the verdicts. */
export function matchScreen(
	frame: FramebufferSnapshot,
	matchers: ScreenMatcher | readonly ScreenMatcher[],
	options: ScreenMatchOptions = {},
): ScreenMatchResult {
	const list = 'kind' in matchers ? [matchers] : matchers
	const results = list.map((matcher) => runMatcher(frame, matcher))
	const matched =
		options.match === 'any'
			? results.some((result) => result.matched)
			: results.every((result) => result.matched)
	return { matched, results }
}

/**
 * Reads the screen every `intervalMs` until it satisfies the predicate or the
 * matchers, and resolves with the frame that did. Throws PveTimeoutError when
 * the deadline passes first.
 */
export async function waitForScreen(
	session: Pick<VncSession, 'vmid' | 'snapshot'>,
	check: ScreenPredicate | ScreenMatcher | readonly ScreenMatcher[],
	options: ScreenWaitOptions = {},
): Promise<FramebufferSnapshot> {
	const timeoutMs = options.timeoutMs ?? 30_000
	const intervalMs = options.intervalMs ?? 250
	const test: ScreenPredicate =
		typeof check === 'function'
			? check
			: (frame) => matchScreen(frame, check, { match: options.match ?? 'all' }).matched

	const probe = async (): Promise<{ frame: FramebufferSnapshot; ok: boolean }> => {
		const frame = session.snapshot()
		return { frame, ok: test(frame) }
	}
	const outcome = await pollUntil(probe, {
		done: (value) => value.ok,
		onTimeout: () => {
			throw new PveTimeoutError({
				what: `guest ${session.vmid} to show the expected screen`,
				waitedMs: timeoutMs,
			})
		},
		timeoutMs,
		initialDelayMs: intervalMs,
		maxDelayMs: intervalMs,
		...(options.signal ? { signal: options.signal } : {}),
	})
	return outcome.frame
}
