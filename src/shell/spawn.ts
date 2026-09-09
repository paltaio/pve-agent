/**
 * Local process runner for the SSH transport. Every caller takes a SpawnFn,
 * so a test replaces this boundary instead of running a real ssh.
 */

export interface SpawnRequest {
	/** Program and arguments. The first element is the binary. */
	argv: readonly string[]
	input?: Uint8Array
	/** Kill the process after this many milliseconds. */
	timeoutMs?: number
}

export interface SpawnResult {
	exitCode: number
	stdout: Uint8Array
	stderr: Uint8Array
	/** True when the deadline killed the process. */
	timedOut: boolean
}

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnResult>

/**
 * Run a program to completion and collect its output. Rejects when the binary
 * cannot be started at all.
 */
export const spawnProcess: SpawnFn = async (request) => {
	const proc = Bun.spawn({
		cmd: [...request.argv],
		stdin: request.input ?? 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const stdout = collect(proc.stdout)
	const stderr = collect(proc.stderr)

	let timedOut = false
	const timer =
		request.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true
					proc.kill('SIGKILL')
				}, request.timeoutMs)

	try {
		const exitCode = await proc.exited
		// A killed child can leave a grandchild holding the pipes open, so the
		// reads stop at what has arrived rather than waiting for end of stream.
		if (timedOut) await Promise.all([stdout.cancel(), stderr.cancel()])
		return { exitCode, stdout: await stdout.bytes, stderr: await stderr.bytes, timedOut }
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

interface Collector {
	bytes: Promise<Uint8Array>
	cancel(): Promise<void>
}

/** Reads a stream to the end, or to the point where `cancel` is called. */
function collect(stream: ReadableStream<Uint8Array>): Collector {
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	const bytes = (async () => {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			chunks.push(value)
		}
		return Buffer.concat(chunks)
	})()
	return { bytes, cancel: () => reader.cancel() }
}
