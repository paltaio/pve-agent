/**
 * The two ways a command reaches a guest: the QEMU guest agent for a VM, and
 * `pct exec` on the node for a container.
 */

import { GuestCommandError, PveTimeoutError } from '../core/errors.ts'
import type { AgentExecOptions, QemuAgent } from '../guest/agent.ts'
import { PveShellTimeoutError } from '../shell/errors.ts'
import { assertSafeInteger, shJoin } from '../shell/escape.ts'
import type { NodeShell } from '../shell/node-shell.ts'
import type { RunOptions } from '../shell/types.ts'
import type { GuestExecutor, GuestRunOptions, GuestRunResult } from './types.ts'

export const DEFAULT_TIMEOUT_MS = 30_000

/** Run commands inside a VM through its guest agent. */
export function qemuAgentExecutor(agent: QemuAgent): GuestExecutor {
	return {
		vmid: agent.vmid,
		async exec(argv, options = {}) {
			const execOptions: AgentExecOptions = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }
			if (options.input !== undefined) execOptions.inputData = options.input
			if (options.signal !== undefined) execOptions.signal = options.signal
			const status = await agent.exec(argv, execOptions)
			return {
				exitCode: status.timedOut
					? -1
					: (status.exitCode ?? (status.signal === undefined ? -1 : 128 + status.signal)),
				stdout: status.stdout,
				stderr: status.stderr,
				timedOut: status.timedOut,
			}
		},
	}
}

/**
 * Run commands inside a container through `pct exec` on a root shell of its
 * node. The shell's policy sees the whole `pct exec` line, so its built-in
 * refusals apply to what runs inside the container too.
 */
export function pctExecutor(shell: NodeShell, vmid: number): GuestExecutor {
	assertSafeInteger(vmid, 'vmid')
	return {
		vmid,
		async exec(argv, options = {}) {
			const runOptions: RunOptions = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }
			if (options.input !== undefined) runOptions.input = options.input
			try {
				const result = await shell.run(`pct exec ${vmid} -- ${shJoin(argv)}`, runOptions)
				return {
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
					timedOut: false,
				}
			} catch (error) {
				if (error instanceof PveShellTimeoutError) {
					return { exitCode: -1, stdout: error.partialOutput, stderr: '', timedOut: true }
				}
				throw error
			}
		},
	}
}

/**
 * Turn a failed result into the error a caller branches on: PveTimeoutError
 * when the command is still running, GuestCommandError when it exited
 * non-zero. A successful result comes back unchanged.
 */
export function checkResult(
	vmid: number,
	what: string,
	result: GuestRunResult,
	options: GuestRunOptions = {},
): GuestRunResult {
	if (result.timedOut) {
		throw new PveTimeoutError({
			what: `${what} in guest ${vmid} to exit`,
			waitedMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			detail: 'it is still running inside the guest',
		})
	}
	if (result.exitCode !== 0) {
		throw new GuestCommandError({
			vmid,
			what,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		})
	}
	return result
}
