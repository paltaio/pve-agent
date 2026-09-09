/**
 * vzdump on one node.
 *
 * `run` starts a backup immediately. A scheduled backup is a cluster job
 * under `/cluster/backup`; this is the manual path.
 */

import type { PveClient } from '../core/client.ts'
import type { VzdumpParams } from '../generated/types.ts'

export class NodeBackupApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/vzdump`
	}

	/**
	 * Back up guests on this node now. Select with `vmid`, `pool`, or
	 * `all: true` plus an `exclude` list. `mode` picks `snapshot` (the
	 * default, guest keeps running), `suspend` or `stop`. `storage` names
	 * where the archive goes; without it the vzdump default applies.
	 *
	 * `job-id` is accepted only from root@pam. Returns a UPID.
	 */
	async run(params?: VzdumpParams): Promise<string> {
		return this.client.post<string>(this.base, params)
	}

	/**
	 * The vzdump defaults this node would use, after `/etc/vzdump.conf` and
	 * the storage's own settings are merged.
	 *
	 * Name the storage. Without one the handler resolves the node's first
	 * storage and fails when that one does not take `backup` content.
	 */
	async defaults(options?: { storage?: string }): Promise<Record<string, unknown>> {
		return this.client.get<Record<string, unknown>>(`${this.base}/defaults`, options)
	}

	/**
	 * The guest config stored inside a backup archive, as the text saved at
	 * backup time. `volume` is the archive's volume id.
	 */
	async extractConfig(volume: string): Promise<string> {
		return this.client.get<string>(`${this.base}/extractconfig`, { volume })
	}
}
