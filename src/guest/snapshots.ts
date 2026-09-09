/**
 * Snapshots of one guest. QEMU and LXC register the same subtree, so one
 * class serves both and is handed the guest's base path.
 */

import type { PveClient } from '../core/client.ts'
import { normalizeSnapshots, type GuestSnapshot } from './types.ts'

export interface SnapshotDeleteOptions {
	/** Drop the snapshot from the config even when removing its disk state fails. */
	force?: boolean
}

export interface SnapshotRollbackOptions {
	/** Start the guest once the rollback finishes. */
	start?: boolean
}

export class GuestSnapshotsApi<CreateParams extends { snapname: string }> {
	readonly client: PveClient
	/** Path of the snapshot collection, without a trailing slash. */
	readonly path: string

	constructor(client: PveClient, guestPath: string) {
		this.client = client
		this.path = `${guestPath}/snapshot`
	}

	/** Every snapshot plus the `current` pseudo-entry. Needs VM.Audit. */
	async list(): Promise<GuestSnapshot[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(this.path)
		return normalizeSnapshots(rows)
	}

	/**
	 * Takes a snapshot. Returns a UPID. Needs VM.Snapshot. On a VM,
	 * `vmstate: true` also saves RAM, so the rollback resumes a running VM
	 * where it left off.
	 */
	async create(name: string, params?: Omit<CreateParams, 'snapname'>): Promise<string> {
		return this.client.post<string>(this.path, { ...params, snapname: name })
	}

	/** The config stored inside a snapshot. Needs VM.Audit. */
	async config(name: string): Promise<Record<string, unknown>> {
		return this.client.get<Record<string, unknown>>(`${this.entryPath(name)}/config`)
	}

	/**
	 * Rewrites a snapshot's description. Synchronous. The node stores it with a
	 * trailing newline, so reading it back gives `description + '\n'`.
	 */
	async update(name: string, params: { description?: string }): Promise<void> {
		await this.client.put<null>(`${this.entryPath(name)}/config`, params)
	}

	/** Restores the guest to a snapshot, discarding everything since. Returns a UPID. Needs VM.Snapshot.Rollback. */
	async rollback(name: string, options: SnapshotRollbackOptions = {}): Promise<string> {
		return this.client.post<string>(`${this.entryPath(name)}/rollback`, options)
	}

	/** Deletes a snapshot. Returns a UPID. Needs VM.Snapshot. */
	async delete(name: string, options: SnapshotDeleteOptions = {}): Promise<string> {
		return this.client.delete<string>(this.entryPath(name), options)
	}

	private entryPath(name: string): string {
		return `${this.path}/${encodeURIComponent(name)}`
	}
}
