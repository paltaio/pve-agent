/**
 * Worker tasks.
 *
 * Most mutating endpoints hand back a UPID instead of doing the work inline.
 * The UPID names the node that runs the task, which is what the status and log
 * endpoints need, so none of these take a node.
 */

import { PveConfigError, PveTaskError } from './errors.ts'
import { pollUntil, type PollOptions } from './poll.ts'
import { isRecord, toOptionalNumber, toOptionalString } from './values.ts'
import type { PveClient, RequestOptions } from './client.ts'

export interface ParsedUpid {
	/** The node running the worker. Status and log calls go to this node. */
	node: string
	pid: number
	pstart: number
	/** Task start, epoch seconds. */
	startTime: number
	/** Worker type, such as qmstart, vzdump, imgcopy. */
	type: string
	/** Object the task acts on, usually a vmid. Empty for cluster-wide tasks. */
	id: string
	user: string
	upid: string
}

export type TaskOutcome = 'ok' | 'warning' | 'error' | 'unknown'

export type TaskRunState = 'running' | 'stopped'

/**
 * One task, from `/nodes/{node}/tasks/{upid}/status`.
 *
 * That endpoint puts the run state in `status` and the exit status in
 * `exitstatus`. The list endpoints put the exit status in `status` and have no
 * run state. Both shapes come out as this one, so `status` is a run state and
 * `exitStatus` an exit status wherever a task is read.
 */
export interface TaskStatus {
	upid: string
	node: string
	type: string
	id: string
	user: string
	pid: number
	startTime: number
	status: TaskRunState
	/** Present once the task stopped: 'OK', 'WARNINGS: n', or an error line. */
	exitStatus: string | null
	outcome: TaskOutcome
}

/** One row of a task list, from `/cluster/tasks` or `/nodes/{node}/tasks`. */
export interface TaskListEntry {
	upid: string
	node: string
	type: string
	/** Object the task acts on, usually a vmid. Empty for cluster-wide tasks. */
	id: string
	user: string
	/** Absent on /cluster/tasks rows, which carry no pid. */
	pid: number | undefined
	/** Epoch seconds. */
	startTime: number
	/** Epoch seconds, absent while the task is still running. */
	endTime: number | undefined
	status: TaskRunState
	/** 'OK', 'WARNINGS: n', or an error line. Null while the task is running. */
	exitStatus: string | null
	outcome: TaskOutcome
	raw: Readonly<Record<string, unknown>>
}

/** A `{ n, t }` line from a log endpoint: task, syslog, firewall or replication. */
export interface PveLogLine {
	/** Line number, counting from the start of the log. */
	n: number
	/** The line itself, without a trailing newline. */
	t: string
}

export interface TaskLogOptions {
	/** First line to return, 0-based. */
	start?: number
	/** Maximum lines to return. 0 reads to the end of the log. */
	limit?: number
}

export interface WaitOptions {
	/** Give up after this long. Defaults to 10 minutes. */
	timeoutMs?: number
	/** First poll delay. Defaults to 200 ms. */
	initialDelayMs?: number
	/** Ceiling for the backoff. Defaults to 2000 ms. */
	maxDelayMs?: number
	/** Treat 'WARNINGS: n' as failure. Defaults to false, matching PVE. */
	failOnWarnings?: boolean
	/** How many log lines to attach to a PveTaskError. Defaults to 25. */
	errorLogLines?: number
	signal?: AbortSignal
	/** Called on every poll, for progress reporting. */
	onPoll?: (status: TaskStatus) => void
}

const UPID_RE =
	/^UPID:([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8,9}):([0-9A-Fa-f]{8}):([^:\s/]+):([^:\s/]*):([^:\s/]+):$/

/** True when the string is a well-formed UPID. */
export function isUpid(value: unknown): value is string {
	return typeof value === 'string' && UPID_RE.test(value)
}

/** Splits a UPID into its fields. Throws PveConfigError when the string is not one. */
export function parseUpid(upid: string): ParsedUpid {
	const match = UPID_RE.exec(upid)
	if (!match) {
		throw new PveConfigError(
			`'${upid}' is not a UPID. A UPID looks like UPID:node:PID:PSTART:STARTTIME:type:id:user: and comes back from the call that started the task.`,
		)
	}
	const [, node = '', pid = '', pstart = '', startTime = '', type = '', id = '', user = ''] = match
	return {
		node,
		pid: Number.parseInt(pid, 16),
		pstart: Number.parseInt(pstart, 16),
		startTime: Number.parseInt(startTime, 16),
		type,
		id,
		user,
		upid,
	}
}

/**
 * Classify an exit status the way PVE does. A run that logged warnings still
 * finished its work, so it is not an error.
 */
export function taskOutcome(exitStatus: string | null): TaskOutcome {
	if (!exitStatus) return 'unknown'
	if (exitStatus === 'OK') return 'ok'
	if (/^WARNINGS: \d+$/.test(exitStatus)) return 'warning'
	if (exitStatus === 'unexpected status') return 'unknown'
	return 'error'
}

function taskPath(upid: string, suffix: string): string {
	return `/nodes/${parseUpid(upid).node}/tasks/${encodeURIComponent(upid)}${suffix}`
}

/** Current status of one task. */
export async function getTaskStatus(
	client: PveClient,
	upid: string,
	options: RequestOptions = {},
): Promise<TaskStatus> {
	const parsed = parseUpid(upid)
	const raw = await client.get<unknown>(taskPath(upid, '/status'), undefined, options)
	const row = isRecord(raw) ? raw : {}
	const exitStatus = toOptionalString(row['exitstatus']) ?? null
	return {
		upid,
		node: toOptionalString(row['node']) ?? parsed.node,
		type: toOptionalString(row['type']) ?? parsed.type,
		id: toOptionalString(row['id']) ?? parsed.id,
		user: toOptionalString(row['user']) ?? parsed.user,
		pid: toOptionalNumber(row['pid']) ?? parsed.pid,
		startTime: toOptionalNumber(row['starttime']) ?? parsed.startTime,
		status: row['status'] === 'running' ? 'running' : 'stopped',
		exitStatus,
		outcome: taskOutcome(exitStatus),
	}
}

/**
 * One task list row, with the exit status moved out of `status`. A row has no
 * run state of its own: the task has stopped once it reports an end time or an
 * exit status.
 */
export function normalizeTaskListEntry(raw: object): TaskListEntry {
	const row: Readonly<Record<string, unknown>> = isRecord(raw) ? raw : {}
	const exitStatus = toOptionalString(row['status']) ?? null
	const endTime = toOptionalNumber(row['endtime'])
	return {
		upid: toOptionalString(row['upid']) ?? '',
		node: toOptionalString(row['node']) ?? '',
		type: toOptionalString(row['type']) ?? '',
		id: toOptionalString(row['id']) ?? '',
		user: toOptionalString(row['user']) ?? '',
		pid: toOptionalNumber(row['pid']),
		startTime: toOptionalNumber(row['starttime']) ?? 0,
		endTime,
		status: endTime === undefined && exitStatus === null ? 'running' : 'stopped',
		exitStatus,
		outcome: taskOutcome(exitStatus),
		raw: row,
	}
}

/**
 * Lines from a task log, oldest first.
 *
 * The endpoint caps a request at 50 lines when no limit is given, so an omitted
 * limit is sent as 0, which reads the whole log.
 */
export async function getTaskLog(
	client: PveClient,
	upid: string,
	options: TaskLogOptions = {},
): Promise<string[]> {
	const lines = await client.get<unknown>(taskPath(upid, '/log'), {
		start: options.start ?? 0,
		limit: options.limit ?? 0,
	})
	if (!Array.isArray(lines)) return []
	return lines.flatMap((line: unknown) =>
		isRecord(line) && typeof line['t'] === 'string' ? [line['t']] : [],
	)
}

/** Asks the node to stop a running task. */
export async function stopTask(client: PveClient, upid: string): Promise<void> {
	await client.delete<null>(taskPath(upid, ''))
}

/**
 * Poll until the task stops.
 *
 * Throws PveTaskError carrying the real exit status and the tail of the task
 * log, so the caller sees why the task failed rather than that it failed. A run
 * that outlives the timeout throws too, with `timedOut` set and no exit status;
 * the worker is still going, and `stopTask` ends it.
 */
export async function waitForTask(
	client: PveClient,
	upid: string,
	options: WaitOptions = {},
): Promise<TaskStatus> {
	const timeoutMs = options.timeoutMs ?? 10 * 60_000
	const errorLogLines = options.errorLogLines ?? 25
	// Carried into each status call so an abort lands during the request too,
	// not only while the wait sleeps between polls.
	const requestOptions: RequestOptions = options.signal ? { signal: options.signal } : {}

	const { initialDelayMs, maxDelayMs, onPoll, signal } = options
	const pollOptions: PollOptions<TaskStatus> = {
		...(initialDelayMs === undefined ? {} : { initialDelayMs }),
		...(maxDelayMs === undefined ? {} : { maxDelayMs }),
		...(onPoll === undefined ? {} : { onPoll }),
		...(signal === undefined ? {} : { signal }),
		done: (value) => value.status === 'stopped',
		onTimeout: (value) => {
			throw new PveTaskError({
				upid,
				exitStatus: null,
				timedOut: true,
				detail: `still ${value.status} after ${Math.round(timeoutMs / 1000)}s; poll it with getTaskStatus or end it with stopTask`,
			})
		},
		timeoutMs,
	}

	const status = await pollUntil(() => getTaskStatus(client, upid, requestOptions), pollOptions)

	const failed =
		status.outcome === 'error' ||
		status.outcome === 'unknown' ||
		(status.outcome === 'warning' && options.failOnWarnings === true)
	if (!failed) return status

	let log: string[] = []
	if (errorLogLines > 0) {
		try {
			log = (await getTaskLog(client, upid)).slice(-errorLogLines)
		} catch {
			// The log can be gone already; the exit status still explains the failure.
		}
	}
	throw new PveTaskError({ upid, exitStatus: status.exitStatus, log })
}
