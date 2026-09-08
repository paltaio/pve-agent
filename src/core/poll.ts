/**
 * Waiting for the node to catch up.
 *
 * A task, a run state and a guest-agent process are all read by asking again
 * until the answer settles. One backoff policy serves all three: a short first
 * delay so a quick change is seen quickly, doubling to a ceiling so a slow one
 * does not hammer the node.
 */

/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}
		const onAbort = (): void => {
			clearTimeout(timer)
			reject(signal?.reason)
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}

export interface PollOptions<T> {
	/** True when the answer is final and polling stops. */
	done: (value: T) => boolean
	/**
	 * Called with the last answer once the deadline has passed. Throw to make the
	 * timeout a failure, or return a value to hand that back to the caller.
	 */
	onTimeout: (value: T) => T
	/** Give up after this long. Defaults to 10 minutes. */
	timeoutMs?: number
	/** First poll delay. Defaults to 200 ms. */
	initialDelayMs?: number
	/** Ceiling for the backoff. Defaults to 2000 ms. */
	maxDelayMs?: number
	/** Called with every answer, for progress reporting. */
	onPoll?: (value: T) => void
	signal?: AbortSignal
}

/**
 * Call `probe` until `done` accepts its answer, then return that answer.
 *
 * The first probe runs before any wait, so a condition that already holds costs
 * one call. `probe` is called once more after the deadline passes, and its
 * answer goes to `onTimeout`.
 */
export async function pollUntil<T>(probe: () => Promise<T>, options: PollOptions<T>): Promise<T> {
	const maxDelayMs = options.maxDelayMs ?? 2000
	const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
	let delay = options.initialDelayMs ?? 200

	for (;;) {
		const value = await probe()
		options.onPoll?.(value)
		if (options.done(value)) return value
		if (Date.now() >= deadline) return options.onTimeout(value)

		await sleep(Math.min(delay, maxDelayMs, Math.max(deadline - Date.now(), 0)), options.signal)
		delay = Math.min(delay * 2, maxDelayMs)
	}
}
