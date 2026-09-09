/**
 * Storage replication jobs.
 *
 * A job id is `<vmid>-<number>`, such as `110-0`. Replication needs a ZFS
 * storage with the same name on source and target. The per-run state and log
 * live on the node.
 */

import type { PveClient } from '../core/client.ts'
import { toOptionalBoolean, toOptionalNumber, toOptionalString } from '../core/values.ts'
import type { ReplicationJobCreateParams, ReplicationJobUpdateParams } from '../generated/types.ts'

export interface ReplicationJob {
	id: string
	type: 'local'
	source: string | undefined
	target: string | undefined
	guest: number | undefined
	jobnum: number | undefined
	schedule: string | undefined
	/** Transfer ceiling in MiB/s. */
	rate: number | undefined
	comment: string | undefined
	disable: boolean | undefined
	digest: string | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeJob(raw: Record<string, unknown>): ReplicationJob {
	return {
		id: String(raw['id'] ?? ''),
		type: 'local',
		source: toOptionalString(raw['source']),
		target: toOptionalString(raw['target']),
		guest: toOptionalNumber(raw['guest']),
		jobnum: toOptionalNumber(raw['jobnum']),
		schedule: toOptionalString(raw['schedule']),
		rate: toOptionalNumber(raw['rate']),
		comment: toOptionalString(raw['comment']),
		disable: toOptionalBoolean(raw['disable']),
		digest: toOptionalString(raw['digest']),
		raw,
	}
}

export class ClusterReplicationApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/** Every replication job in the cluster. Token tier. */
	async list(): Promise<ReplicationJob[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/replication')
		return rows.map(normalizeJob)
	}

	async get(id: string): Promise<ReplicationJob> {
		return normalizeJob(
			await this.client.get<Record<string, unknown>>(
				`/cluster/replication/${encodeURIComponent(id)}`,
			),
		)
	}

	/**
	 * Create a replication job. `id` is `<vmid>-<number>`, `target` is the node
	 * receiving the copy, `schedule` is a systemd calendar event and defaults to
	 * every 15 minutes. Returns nothing.
	 */
	async create(params: ReplicationJobCreateParams): Promise<void> {
		await this.client.post<null>('/cluster/replication', params)
	}

	/** Change a replication job. `delete` unsets keys. Returns nothing. */
	async update(id: string, params: ReplicationJobUpdateParams): Promise<void> {
		await this.client.put<null>(`/cluster/replication/${encodeURIComponent(id)}`, params)
	}

	/**
	 * Mark a job for removal. The job is deleted once the next run has cleaned
	 * up the target; `keep` leaves the replicated volumes in place and `force`
	 * drops the job even when the cleanup cannot run. Returns nothing.
	 */
	async delete(id: string, options: { keep?: boolean; force?: boolean } = {}): Promise<void> {
		await this.client.delete<null>(`/cluster/replication/${encodeURIComponent(id)}`, options)
	}
}
