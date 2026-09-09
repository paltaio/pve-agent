/**
 * Replication as one node runs it: per-job state, log and manual trigger.
 *
 * The job definitions are cluster config under `/cluster/replication`. What
 * is here is what happened on this node.
 */

import type { PveClient } from '../core/client.ts'
import type { PveLogLine } from '../core/tasks.ts'
import { toOptionalBoolean, toOptionalNumber, toOptionalString } from '../core/values.ts'
import { getEnvelope } from '../cluster/envelope.ts'
import type {
	NodesReplicationGetByNodeParams,
	NodesReplicationLogGetParams,
} from '../generated/types.ts'

export interface ReplicationLogPage {
	lines: PveLogLine[]
	/** Lines in the log before `start` and `limit`. */
	total: number | undefined
}

export interface ReplicationStatus {
	id: string
	guest: number | undefined
	jobnum: number | undefined
	type: string | undefined
	source: string | undefined
	target: string | undefined
	schedule: string | undefined
	disable: boolean | undefined
	/** Epoch seconds of the last attempt. */
	lastTry: number | undefined
	/** Epoch seconds of the last attempt that succeeded. */
	lastSync: number | undefined
	nextSync: number | undefined
	/** Seconds the last run took. */
	duration: number | undefined
	/** Consecutive failures. */
	failCount: number | undefined
	/** Set when the last run failed. */
	error: string | undefined
	/** Set while a run is in flight. */
	pid: number | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeReplication(raw: Record<string, unknown>): ReplicationStatus {
	return {
		id: String(raw['id'] ?? ''),
		guest: toOptionalNumber(raw['guest']),
		jobnum: toOptionalNumber(raw['jobnum']),
		type: toOptionalString(raw['type']),
		source: toOptionalString(raw['source']),
		target: toOptionalString(raw['target']),
		schedule: toOptionalString(raw['schedule']),
		disable: toOptionalBoolean(raw['disable']),
		lastTry: toOptionalNumber(raw['last_try']),
		lastSync: toOptionalNumber(raw['last_sync']),
		nextSync: toOptionalNumber(raw['next_sync']),
		duration: toOptionalNumber(raw['duration']),
		failCount: toOptionalNumber(raw['fail_count']),
		error: toOptionalString(raw['error']),
		pid: toOptionalNumber(raw['pid']),
		raw,
	}
}

export class NodeReplicationApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/replication`
	}

	private jobPath(id: string, suffix: string): string {
		return `${this.base}/${encodeURIComponent(id)}${suffix}`
	}

	/**
	 * State of every replication job on this node, or one guest's. A non-zero
	 * `failCount` with an `error` is a job that needs attention.
	 */
	async list(options?: NodesReplicationGetByNodeParams): Promise<ReplicationStatus[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(this.base, options)
		return rows.map(normalizeReplication)
	}

	async status(id: string): Promise<ReplicationStatus> {
		return normalizeReplication(
			await this.client.get<Record<string, unknown>>(this.jobPath(id, '/status')),
		)
	}

	/**
	 * Log of the last run of one job, oldest line first, with the total count
	 * the node reports beside `data` for paging.
	 */
	async log(id: string, options?: NodesReplicationLogGetParams): Promise<ReplicationLogPage> {
		const { data, attribs } = await getEnvelope<PveLogLine[]>(
			this.client,
			this.jobPath(id, '/log'),
			options,
		)
		return { lines: data, total: toOptionalNumber(attribs['total']) }
	}

	/** Run a job now instead of waiting for its schedule. Returns a UPID. */
	async runNow(id: string): Promise<string> {
		return this.client.post<string>(this.jobPath(id, '/schedule_now'))
	}
}
