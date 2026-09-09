/**
 * The QEMU guest agent surface of one VM.
 *
 * Every call needs qemu-guest-agent running inside the VM and `agent=1` in
 * the VM config; without both, the node answers 500 with "No QEMU guest agent
 * configured" or "QEMU guest agent is not running". Nothing here returns a
 * UPID; the node talks to the agent inline and answers with the result.
 *
 * The read calls need VM.GuestAgent.Audit, `exec` needs
 * VM.GuestAgent.Unrestricted, and the file calls need VM.GuestAgent.FileRead
 * or VM.GuestAgent.FileWrite. An API token reaches all of them.
 */

import type { PveClient } from '../core/client.ts'
import { GuestCommandError, PveTimeoutError } from '../core/errors.ts'
import { pollUntil, type PollOptions } from '../core/poll.ts'
import { toBoolean, toOptionalNumber } from '../core/values.ts'
import type {
	NodesQemuAgentPostParams,
	NodesQemuAgentSetUserPasswordPostParams,
} from '../generated/types.ts'
import { guestPath, type GuestRef } from './types.ts'

/** Commands the combined agent endpoint accepts, all of which take no arguments. */
export type AgentSimpleCommand = NodesQemuAgentPostParams['command']

export type AgentSetUserPasswordParams = NodesQemuAgentSetUserPasswordPostParams

export interface AgentOsInfo extends Record<string, unknown> {
	id?: string
	name?: string
	'pretty-name'?: string
	version?: string
	'version-id'?: string
	'kernel-release'?: string
	'kernel-version'?: string
	machine?: string
}

export interface AgentIpAddress {
	'ip-address': string
	'ip-address-type': string
	prefix: number
}

export interface AgentNetworkInterface extends Record<string, unknown> {
	name: string
	'hardware-address'?: string
	'ip-addresses'?: AgentIpAddress[]
	statistics?: Record<string, number>
}

export interface AgentUser {
	user: string
	'login-time': number
	domain?: string
}

export interface AgentFilesystem extends Record<string, unknown> {
	name: string
	mountpoint: string
	type: string
	'used-bytes'?: number
	'total-bytes'?: number
	disk?: Record<string, unknown>[]
}

export interface AgentExecStatus {
	exited: boolean
	/** Set when the process ended normally. */
	exitCode: number | undefined
	/** Set when the process was killed by a signal. */
	signal: number | undefined
	stdout: string
	stderr: string
	stdoutTruncated: boolean
	stderrTruncated: boolean
	raw: Readonly<Record<string, unknown>>
}

export interface AgentExecOptions {
	/** Passed to the command on stdin. */
	inputData?: string
	/** Stop polling after this long. Defaults to 30 seconds. */
	timeoutMs?: number
	/** First poll delay. Defaults to 50 ms. */
	initialDelayMs?: number
	/** Ceiling for the backoff. Defaults to 1000 ms. */
	maxDelayMs?: number
	signal?: AbortSignal
}

/** What `exec` returns: an exec-status plus the pid it was read from. */
export interface AgentExecResult extends AgentExecStatus {
	pid: number
	/**
	 * True when the wait gave up rather than the process ending. The process is
	 * still running inside the guest and `execStatus(pid)` still reads it.
	 */
	timedOut: boolean
}

export interface AgentFileContent {
	content: string
	/** True when the read stopped before the end of the file. */
	truncated: boolean
	bytesRead: number | undefined
}

/**
 * The node base64-decodes the agent's stdout, stderr and file content, then
 * hands the raw bytes to a JSON encoder that emits one code point per byte.
 * Reading those code points back as bytes recovers the original UTF-8. ASCII
 * is unchanged by the round trip.
 */
function decodeAgentBytes(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) return ''
	return Buffer.from(value, 'latin1').toString('utf8')
}

function normalizeExecStatus(raw: Readonly<Record<string, unknown>>): AgentExecStatus {
	return {
		exited: toBoolean(raw['exited']),
		exitCode: toOptionalNumber(raw['exitcode']),
		signal: toOptionalNumber(raw['signal']),
		stdout: decodeAgentBytes(raw['out-data']),
		stderr: decodeAgentBytes(raw['err-data']),
		stdoutTruncated: toBoolean(raw['out-truncated']),
		stderrTruncated: toBoolean(raw['err-truncated']),
		raw,
	}
}

export class QemuAgent {
	readonly client: PveClient
	readonly vmid: number
	private readonly base: string

	constructor(client: PveClient, ref: Omit<GuestRef, 'type'>) {
		this.client = client
		this.vmid = ref.vmid
		this.base = `${guestPath({ node: ref.node, vmid: ref.vmid, type: 'qemu' })}/agent`
	}

	/** Agent commands this node exposes as their own endpoints. */
	async commands(): Promise<{ name: string }[]> {
		return this.client.get<{ name: string }[]>(this.base)
	}

	/** Runs one argument-less agent command through the combined endpoint and returns its `result`. */
	async run<T = unknown>(command: AgentSimpleCommand): Promise<T> {
		const answer = await this.client.post<{ result: T }>(this.base, { command })
		return answer.result
	}

	/** Resolves when the agent answers. Any other outcome throws. */
	async ping(): Promise<void> {
		await this.client.post<unknown>(`${this.base}/ping`)
	}

	/** Version and supported commands, as the agent reports them. */
	async info(): Promise<Record<string, unknown>> {
		return this.get('info')
	}

	async osInfo(): Promise<AgentOsInfo> {
		return this.get('get-osinfo')
	}

	async hostName(): Promise<string> {
		const answer = await this.get<{ 'host-name'?: string }>('get-host-name')
		return answer['host-name'] ?? ''
	}

	/** Clock inside the guest, in nanoseconds since the epoch. */
	async time(): Promise<number> {
		return this.get('get-time')
	}

	async timezone(): Promise<{ zone?: string; offset: number }> {
		return this.get('get-timezone')
	}

	async users(): Promise<AgentUser[]> {
		return this.get('get-users')
	}

	async vcpus(): Promise<Record<string, unknown>[]> {
		return this.get('get-vcpus')
	}

	/** Mounted filesystems, with the disks behind them. */
	async filesystems(): Promise<AgentFilesystem[]> {
		return this.get('get-fsinfo')
	}

	async memoryBlocks(): Promise<Record<string, unknown>[]> {
		return this.get('get-memory-blocks')
	}

	async memoryBlockInfo(): Promise<Record<string, unknown>> {
		return this.get('get-memory-block-info')
	}

	/** Interfaces and addresses the guest sees, which the node does not otherwise know. */
	async networkInterfaces(): Promise<AgentNetworkInterface[]> {
		return this.get('network-get-interfaces')
	}

	/** `thawed` or `frozen`. */
	async fsfreezeStatus(): Promise<string> {
		return this.post('fsfreeze-status')
	}

	/** Quiesces filesystems so a snapshot or backup is consistent. Returns how many were frozen. */
	async fsfreezeFreeze(): Promise<number> {
		return this.post('fsfreeze-freeze')
	}

	/** Returns how many filesystems were thawed. */
	async fsfreezeThaw(): Promise<number> {
		return this.post('fsfreeze-thaw')
	}

	/** Discards unused blocks so a thin-provisioned disk shrinks. */
	async fstrim(): Promise<Record<string, unknown>> {
		return this.post('fstrim')
	}

	/** Asks the guest OS to shut down. The status endpoint is the usual way to stop a VM. */
	async shutdown(): Promise<void> {
		await this.post('shutdown')
	}

	async suspendDisk(): Promise<void> {
		await this.post('suspend-disk')
	}

	async suspendHybrid(): Promise<void> {
		await this.post('suspend-hybrid')
	}

	async suspendRam(): Promise<void> {
		await this.post('suspend-ram')
	}

	/** Sets a guest account's password. `crypted` passes an already hashed value. */
	async setUserPassword(params: AgentSetUserPasswordParams): Promise<void> {
		await this.client.post<unknown>(`${this.base}/set-user-password`, params)
	}

	/**
	 * Starts a command inside the guest and returns its pid. The command is an
	 * argv array; there is no shell, so a pipeline needs an explicit
	 * `['sh', '-c', '...']`.
	 */
	async startExec(
		command: readonly string[],
		options: { inputData?: string } = {},
	): Promise<number> {
		const params: Record<string, unknown> = { command: [...command] }
		if (options.inputData !== undefined) params['input-data'] = options.inputData
		const answer = await this.client.post<{ pid: number }>(`${this.base}/exec`, params)
		return answer.pid
	}

	/** Status and captured output of a pid started by startExec. */
	async execStatus(pid: number): Promise<AgentExecStatus> {
		const raw = await this.client.get<Record<string, unknown>>(`${this.base}/exec-status`, { pid })
		return normalizeExecStatus(raw)
	}

	/**
	 * Starts a command and polls until it exits.
	 *
	 * When the deadline passes first, the result comes back with
	 * `timedOut: true` and whatever output the agent had; the process keeps
	 * running inside the guest, and its pid is in `pid`.
	 */
	async exec(command: readonly string[], options: AgentExecOptions = {}): Promise<AgentExecResult> {
		const pid = await this.startExec(
			command,
			options.inputData === undefined ? {} : { inputData: options.inputData },
		)
		const pollOptions: PollOptions<AgentExecResult> = {
			done: (status) => status.exited,
			onTimeout: (status) => ({ ...status, timedOut: true }),
			timeoutMs: options.timeoutMs ?? 30_000,
			initialDelayMs: options.initialDelayMs ?? 50,
			maxDelayMs: options.maxDelayMs ?? 1000,
		}
		if (options.signal !== undefined) pollOptions.signal = options.signal
		return pollUntil(
			async () => ({ ...(await this.execStatus(pid)), pid, timedOut: false }),
			pollOptions,
		)
	}

	/**
	 * Runs a command and returns its stdout without trailing whitespace.
	 * Throws GuestCommandError when it exits non-zero or dies on a signal, and
	 * PveTimeoutError when it is still running at the deadline.
	 */
	async output(command: readonly string[], options: AgentExecOptions = {}): Promise<string> {
		const result = await this.exec(command, options)
		const what = command.join(' ')
		if (result.timedOut) {
			throw new PveTimeoutError({
				what: `'${what}' in guest ${this.vmid} to exit`,
				waitedMs: options.timeoutMs ?? 30_000,
				detail: `it is still running as pid ${result.pid}`,
			})
		}
		const exitCode = result.exitCode ?? (result.signal === undefined ? 0 : 128 + result.signal)
		if (exitCode !== 0) {
			throw new GuestCommandError({
				vmid: this.vmid,
				what,
				exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
			})
		}
		return result.stdout.trimEnd()
	}

	/**
	 * Reads a file from inside the guest as text. One call reads at most 16
	 * MiB; `count` lowers that, and `truncated` says whether the file went on.
	 */
	async fileRead(file: string, options: { count?: number } = {}): Promise<AgentFileContent> {
		const raw = await this.client.get<Record<string, unknown>>(`${this.base}/file-read`, {
			...options,
			file,
		})
		return {
			content: decodeAgentBytes(raw['content']),
			truncated: toBoolean(raw['truncated']),
			bytesRead: toOptionalNumber(raw['bytes-read']),
		}
	}

	/**
	 * Writes a file inside the guest, replacing it. The bytes go over as
	 * base64 built here, so any text or binary content survives the node.
	 */
	async fileWrite(file: string, content: string | Uint8Array): Promise<void> {
		const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
		await this.client.post<null>(`${this.base}/file-write`, {
			file,
			content: bytes.toString('base64'),
			encode: false,
		})
	}

	/** Every agent endpoint answers `{ result }`, with a null result for a command that returns nothing. */
	private async get<T>(command: string): Promise<T> {
		const answer = await this.client.get<{ result: T }>(`${this.base}/${command}`)
		return answer.result
	}

	private async post<T>(command: string): Promise<T> {
		const answer = await this.client.post<{ result: T }>(`${this.base}/${command}`)
		return answer.result
	}
}
