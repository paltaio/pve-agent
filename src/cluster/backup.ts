/**
 * Scheduled backup jobs, cluster wide.
 *
 * A job here is the schedule entry in `/etc/pve/jobs.cfg`. Running a backup
 * now is a node call that starts vzdump on that node.
 */

import type { PveClient } from '../core/client.ts'
import { toOptionalBoolean, toOptionalNumber, toOptionalString } from '../core/values.ts'
import type { BackupJobCreateParams, BackupJobUpdateParams } from '../generated/types.ts'

export type BackupMode = 'snapshot' | 'suspend' | 'stop'

const BACKUP_MODES: readonly BackupMode[] = ['snapshot', 'suspend', 'stop']

export interface BackupJob {
	id: string
	type: string | undefined
	enabled: boolean | undefined
	schedule: string | undefined
	storage: string | undefined
	mode: BackupMode | undefined
	/** True when the job covers every guest instead of a vmid list. */
	all: boolean | undefined
	/** Comma-separated vmid list, when the job names guests. */
	vmid: string | undefined
	pool: string | undefined
	node: string | undefined
	comment: string | undefined
	/** Epoch seconds of the next run, computed from the schedule. */
	nextRun: number | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeJob(raw: Record<string, unknown>): BackupJob {
	return {
		id: String(raw['id'] ?? ''),
		type: toOptionalString(raw['type']),
		enabled: toOptionalBoolean(raw['enabled']),
		schedule: toOptionalString(raw['schedule']),
		storage: toOptionalString(raw['storage']),
		mode: BACKUP_MODES.find((mode) => mode === raw['mode']),
		all: toOptionalBoolean(raw['all']),
		vmid: toOptionalString(raw['vmid']),
		pool: toOptionalString(raw['pool']),
		node: toOptionalString(raw['node']),
		comment: toOptionalString(raw['comment']),
		nextRun: toOptionalNumber(raw['next-run']),
		raw,
	}
}

/** One guest covered by a job, with the volumes vzdump would and would not take. */
export interface BackupIncludedVolume extends Record<string, unknown> {
	id: string
	name?: string
	type?: string
	children?: BackupIncludedVolume[]
}

export interface BackupIncludedVolumes {
	children: BackupIncludedVolume[]
}

/** A guest no backup job covers. */
export interface UnbackedGuest extends Record<string, unknown> {
	vmid: number
	type: 'qemu' | 'lxc'
	name?: string
}

export class ClusterBackupApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/** Every backup job, with the next run time of each. Token tier. */
	async list(): Promise<BackupJob[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/backup')
		return rows.map(normalizeJob)
	}

	async get(id: string): Promise<BackupJob> {
		return normalizeJob(
			await this.client.get<Record<string, unknown>>(`/cluster/backup/${encodeURIComponent(id)}`),
		)
	}

	/**
	 * Create a backup job. Give exactly one selection: `vmid`, `pool`, or
	 * `all: true` with an optional `exclude` list. `schedule` is a systemd
	 * calendar event. Returns nothing.
	 */
	async create(params: BackupJobCreateParams): Promise<void> {
		await this.client.post<null>('/cluster/backup', params)
	}

	/** Change a backup job. `delete` unsets keys. Returns nothing. */
	async update(id: string, params: BackupJobUpdateParams): Promise<void> {
		await this.client.put<null>(`/cluster/backup/${encodeURIComponent(id)}`, params)
	}

	async delete(id: string): Promise<void> {
		await this.client.delete<null>(`/cluster/backup/${encodeURIComponent(id)}`)
	}

	/**
	 * The guests a job matches and, per guest, which disks vzdump would include
	 * and which it would skip. Read this before trusting an `all: true` job to
	 * cover a guest's data. Token tier.
	 */
	async includedVolumes(id: string): Promise<BackupIncludedVolumes> {
		return this.client.get<BackupIncludedVolumes>(
			`/cluster/backup/${encodeURIComponent(id)}/included_volumes`,
		)
	}

	/** Guests no backup job covers. Token tier. */
	async notBackedUp(): Promise<UnbackedGuest[]> {
		return this.client.get<UnbackedGuest[]>('/cluster/backup-info/not-backed-up')
	}
}
