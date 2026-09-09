import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { pollUntil, sleep, type PollOptions } from './poll.ts'

beforeEach(() => {
	jest.useFakeTimers()
})

afterEach(() => {
	jest.useRealTimers()
})

/** Drains the microtask queue so a pending await inside the code under test lands. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve()
}

/**
 * Runs `promise` to completion under fake timers, firing one timer per step,
 * and returns the settled outcome.
 */
async function settle<T>(
	promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
	promise.then(
		(value) => (outcome = { ok: true, value }),
		(error: unknown) => (outcome = { ok: false, error }),
	)
	for (let step = 0; step < 10_000 && outcome === undefined; step++) {
		await flush()
		if (outcome === undefined) jest.advanceTimersToNextTimer()
	}
	await flush()
	if (outcome === undefined) throw new Error('promise did not settle')
	return outcome
}

describe('sleep', () => {
	test('resolves once the delay has passed', async () => {
		let resolved = false
		const promise = sleep(500).then(() => (resolved = true))
		await flush()
		jest.advanceTimersByTime(499)
		await flush()
		expect(resolved).toBe(false)
		jest.advanceTimersByTime(1)
		await promise
		expect(resolved).toBe(true)
	})

	test('rejects with the signal reason when aborted mid-wait', async () => {
		const controller = new AbortController()
		const reason = new Error('cancelled')
		const promise = sleep(500, controller.signal)
		controller.abort(reason)
		await expect(promise).rejects.toBe(reason)
		await flush()
		expect(jest.getTimerCount()).toBe(0)
	})

	test('rejects at once when the signal is already aborted', async () => {
		const controller = new AbortController()
		controller.abort('stop')
		await expect(sleep(500, controller.signal)).rejects.toBe('stop')
		expect(jest.getTimerCount()).toBe(0)
	})
})

describe('pollUntil', () => {
	function counting(overrides: Partial<PollOptions<number>> = {}) {
		let probes = 0
		const at: number[] = []
		const start = Date.now()
		const options: PollOptions<number> = {
			done: () => false,
			onTimeout: (value) => value,
			onPoll: () => at.push(Date.now() - start),
			...overrides,
		}
		return { probe: async () => ++probes, options, at, probes: () => probes }
	}

	test('returns the first answer without waiting when it is already final', async () => {
		const { probe, options, probes } = counting({ done: (value) => value >= 1 })
		const promise = pollUntil(probe, options)
		await flush()
		expect(jest.getTimerCount()).toBe(0)
		expect(await promise).toBe(1)
		expect(probes()).toBe(1)
	})

	test('doubles the delay from 200 ms to a 2 s ceiling', async () => {
		const { probe, options, at } = counting({ done: (value) => value >= 8 })
		const outcome = await settle(pollUntil(probe, options))
		expect(outcome).toEqual({ ok: true, value: 8 })
		expect(at).toEqual([0, 200, 600, 1400, 3000, 5000, 7000, 9000])
	})

	test('takes a custom initial delay and ceiling', async () => {
		const { probe, options, at } = counting({
			done: (value) => value >= 5,
			initialDelayMs: 50,
			maxDelayMs: 120,
		})
		await settle(pollUntil(probe, options))
		expect(at).toEqual([0, 50, 150, 270, 390])
	})

	test('probes once more at the deadline and hands the answer to onTimeout', async () => {
		const seen: number[] = []
		const { probe, options, at } = counting({
			timeoutMs: 1000,
			onTimeout: (value) => {
				seen.push(value)
				return -value
			},
		})
		const outcome = await settle(pollUntil(probe, options))
		expect(at).toEqual([0, 200, 600, 1000])
		expect(seen).toEqual([4])
		expect(outcome).toEqual({ ok: true, value: -4 })
	})

	test('gives up after ten minutes by default', async () => {
		const { probe, options, at } = counting()
		await settle(pollUntil(probe, options))
		expect(at.at(-1)).toBe(600_000)
	})

	test('propagates what onTimeout throws', async () => {
		const failure = new Error('gave up')
		const { probe, options } = counting({
			timeoutMs: 100,
			onTimeout: () => {
				throw failure
			},
		})
		const outcome = await settle(pollUntil(probe, options))
		expect(outcome).toEqual({ ok: false, error: failure })
	})

	test('reports every answer through onPoll', async () => {
		const answers: number[] = []
		const { probe, options } = counting({
			done: (value) => value >= 3,
			onPoll: (value) => answers.push(value),
		})
		await settle(pollUntil(probe, options))
		expect(answers).toEqual([1, 2, 3])
	})

	test('rejects with the signal reason when aborted during a wait', async () => {
		const controller = new AbortController()
		const { probe, options, probes } = counting({ signal: controller.signal })
		const promise = pollUntil(probe, options)
		await flush()
		expect(probes()).toBe(1)
		controller.abort('stop')
		await expect(promise).rejects.toBe('stop')
		await flush()
		expect(probes()).toBe(1)
	})

	test('propagates a probe failure', async () => {
		const failure = new Error('network')
		let calls = 0
		const promise = pollUntil(
			async () => {
				if (++calls === 2) throw failure
				return calls
			},
			{ done: () => false, onTimeout: (value) => value },
		)
		const outcome = await settle(promise)
		expect(outcome).toEqual({ ok: false, error: failure })
		expect(calls).toBe(2)
	})
})
