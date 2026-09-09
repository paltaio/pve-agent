/**
 * Scheduled jobs other than backup: realm sync, plus the schedule parser.
 */

import type { PveClient } from '../core/client.ts'
import { toOptionalBoolean, toOptionalNumber, toOptionalString } from '../core/values.ts'
import type {
	ClusterJobsRealmSyncPostParams,
	ClusterJobsRealmSyncPutParams,
} from '../generated/types.ts'

export type RealmSyncScope = 'users' | 'groups' | 'both'

const SYNC_SCOPES: readonly RealmSyncScope[] = ['users', 'groups', 'both']

export interface RealmSyncJob {
	id: string
	realm: string | undefined
	schedule: string | undefined
	enabled: boolean | undefined
	comment: string | undefined
	scope: RealmSyncScope | undefined
	/** Comma-separated list of `acl`, `entry` and `properties`. */
	removeVanished: string | undefined
	/** Epoch seconds of the next run, computed from the schedule. */
	nextRun: number | undefined
	lastRunState: string | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeSyncJob(raw: Record<string, unknown>): RealmSyncJob {
	return {
		id: String(raw['id'] ?? ''),
		realm: toOptionalString(raw['realm']),
		schedule: toOptionalString(raw['schedule']),
		enabled: toOptionalBoolean(raw['enabled']),
		comment: toOptionalString(raw['comment']),
		scope: SYNC_SCOPES.find((scope) => scope === raw['scope']),
		removeVanished: toOptionalString(raw['remove-vanished']),
		nextRun: toOptionalNumber(raw['next-run']),
		lastRunState: toOptionalString(raw['last-run-state']),
		raw,
	}
}

export class ClusterJobsApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/** Realm sync jobs, with the next and last run of each. Token tier. */
	async listRealmSync(): Promise<RealmSyncJob[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/jobs/realm-sync')
		return rows.map(normalizeSyncJob)
	}

	async getRealmSync(id: string): Promise<RealmSyncJob> {
		return normalizeSyncJob(
			await this.client.get<Record<string, unknown>>(
				`/cluster/jobs/realm-sync/${encodeURIComponent(id)}`,
			),
		)
	}

	/**
	 * Create a realm sync job. `scope` picks users, groups or both, and
	 * `remove-vanished` takes a comma-separated list of `acl`, `entry` and
	 * `properties` naming what to drop when it disappears upstream. Returns
	 * nothing.
	 */
	async createRealmSync(id: string, params: ClusterJobsRealmSyncPostParams): Promise<void> {
		await this.client.post<null>(`/cluster/jobs/realm-sync/${encodeURIComponent(id)}`, params)
	}

	/** Change a realm sync job. `delete` unsets keys. Returns nothing. */
	async updateRealmSync(id: string, params: ClusterJobsRealmSyncPutParams): Promise<void> {
		await this.client.put<null>(`/cluster/jobs/realm-sync/${encodeURIComponent(id)}`, params)
	}

	async deleteRealmSync(id: string): Promise<void> {
		await this.client.delete<null>(`/cluster/jobs/realm-sync/${encodeURIComponent(id)}`)
	}

	/**
	 * Next run times for a systemd calendar event, without saving anything.
	 * Use it to check a `schedule` string before writing it into a job.
	 * Returns epoch seconds, `iterations` of them, starting at `starttime`.
	 */
	async analyzeSchedule(
		schedule: string,
		options: { iterations?: number; starttime?: number } = {},
	): Promise<{ timestamp: number }[]> {
		return this.client.get<{ timestamp: number }[]>('/cluster/jobs/schedule-analyze', {
			schedule,
			...options,
		})
	}
}
