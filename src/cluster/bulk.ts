/**
 * Cluster-wide bulk guest actions.
 *
 * Each call starts one worker task that walks the selected guests with a pool
 * of workers, and returns its UPID. The task lands on the node that took the
 * request, so `waitForTask` reaches it wherever the guests live.
 *
 * `vms` selects guests by vmid; leaving it out means every guest the caller
 * may act on.
 */

import type { PveClient } from '../core/client.ts'
import type {
	ClusterBulkActionGuestMigratePostParams,
	ClusterBulkActionGuestShutdownPostParams,
	ClusterBulkActionGuestStartPostParams,
	ClusterBulkActionGuestSuspendPostParams,
} from '../generated/types.ts'

export class ClusterBulkApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/**
	 * Migrate guests to `target`. `online` keeps running VMs up, and
	 * `with-local-disks` copies local volumes along with the guest. Returns a
	 * UPID.
	 */
	async migrate(params: ClusterBulkActionGuestMigratePostParams): Promise<string> {
		return this.client.post<string>('/cluster/bulk-action/guest/migrate', params)
	}

	/** Start or resume guests. `timeout` is per guest. Returns a UPID. */
	async start(params?: ClusterBulkActionGuestStartPostParams): Promise<string> {
		return this.client.post<string>('/cluster/bulk-action/guest/start', params)
	}

	/**
	 * Shut guests down. `force-stop` defaults to on and pulls the plug on a
	 * guest that has not stopped within `timeout` seconds. Returns a UPID.
	 */
	async shutdown(params?: ClusterBulkActionGuestShutdownPostParams): Promise<string> {
		return this.client.post<string>('/cluster/bulk-action/guest/shutdown', params)
	}

	/**
	 * Suspend guests. `to-disk` writes the memory state to `statestorage` and
	 * releases the RAM; without it the guests stay paused in memory. Returns a
	 * UPID.
	 */
	async suspend(params?: ClusterBulkActionGuestSuspendPostParams): Promise<string> {
		return this.client.post<string>('/cluster/bulk-action/guest/suspend', params)
	}
}
