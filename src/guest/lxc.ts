/**
 * One LXC container, addressed by node and vmid.
 *
 * Two differences from QEMU shape this file. The config endpoint exists only
 * as a synchronous PUT, so there is no asynchronous form. And a container has
 * no guest agent, so no API call runs a command inside one; that goes through
 * `pct exec` on the node. The power, delete, clone, migrate, volume and
 * snapshot calls return the UPID of a worker task; hand it to
 * `client.waitForTask`.
 */

import type { PveClient } from '../core/client.ts'
import type {
	LxcConfigParams,
	NodesLxcClonePostParams,
	NodesLxcDeleteParams,
	NodesLxcMigratePostParams,
	NodesLxcMoveVolumePostParams,
	NodesLxcResizePutParams,
	NodesLxcRrddataGetParams,
	NodesLxcSnapshotPostParams,
	NodesLxcSpiceproxyPostParams,
	NodesLxcStatusRebootPostParams,
	NodesLxcStatusShutdownPostParams,
	NodesLxcStatusStartPostParams,
	NodesLxcStatusStopPostParams,
	NodesLxcTermproxyPostParams,
	NodesLxcVncproxyPostParams,
} from '../generated/types.ts'
import { GuestFirewallApi } from './firewall.ts'
import {
	destroyGuest,
	getStatus,
	powerAction,
	waitForRunState,
	type WaitForStateOptions,
} from './lifecycle.ts'
import { GuestSnapshotsApi } from './snapshots.ts'
import {
	guestPath,
	joinKeyList,
	normalizeFeature,
	normalizeLxcConfig,
	normalizeMigratePreconditions,
	normalizePending,
	normalizeSummary,
	type GuestConfigOptions,
	type GuestFeature,
	type GuestStatus,
	type GuestSummary,
	type LxcConfig,
	type MigratePreconditions,
	type PendingChange,
	type RrdPoint,
	type RunState,
} from './types.ts'

export type LxcStartParams = NodesLxcStatusStartPostParams
export type LxcStopParams = NodesLxcStatusStopPostParams
export type LxcShutdownParams = NodesLxcStatusShutdownPostParams
export type LxcRebootParams = NodesLxcStatusRebootPostParams
export type LxcDeleteParams = NodesLxcDeleteParams
export type LxcCloneParams = NodesLxcClonePostParams
export type LxcMigrateParams = NodesLxcMigratePostParams
export type LxcMoveVolumeParams = NodesLxcMoveVolumePostParams
export type LxcResizeParams = NodesLxcResizePutParams
export type LxcSnapshotCreateParams = NodesLxcSnapshotPostParams
export type LxcRrdOptions = NodesLxcRrddataGetParams
export type LxcVncProxyParams = NodesLxcVncproxyPostParams
export type LxcTermProxyParams = NodesLxcTermproxyPostParams
export type LxcSpiceProxyParams = NodesLxcSpiceproxyPostParams

/** A volume key a container can carry: rootfs, mp0..mp255 or unused0..unused255. */
export type LxcVolumeKey = NodesLxcMoveVolumePostParams['volume']

/** One interface as the running container itself sees it. */
export interface LxcInterface extends Record<string, unknown> {
	name: string
	hwaddr: string
	/** Primary IPv4 address in CIDR form, when the interface has one. */
	inet?: string
	inet6?: string
	'ip-addresses'?: { 'ip-address': string; 'ip-address-type': string; prefix: string | number }[]
}

/** Containers on one node. Needs VM.Audit on each container. */
export async function listContainers(client: PveClient, node: string): Promise<GuestSummary[]> {
	const rows = await client.get<Record<string, unknown>[]>(`/nodes/${encodeURIComponent(node)}/lxc`)
	return rows.map((row) => normalizeSummary(row, 'lxc', node))
}

export class LxcApi {
	readonly type = 'lxc' as const
	readonly client: PveClient
	readonly node: string
	readonly vmid: number
	/** The container's API path, such as /nodes/ms02-0078/lxc/110. */
	readonly path: string
	readonly snapshots: GuestSnapshotsApi<LxcSnapshotCreateParams>
	readonly firewall: GuestFirewallApi

	constructor(client: PveClient, node: string, vmid: number) {
		this.client = client
		this.node = node
		this.vmid = vmid
		this.path = guestPath({ node, vmid, type: 'lxc' })
		this.snapshots = new GuestSnapshotsApi(client, this.path)
		this.firewall = new GuestFirewallApi(client, this.path)
	}

	async status(): Promise<GuestStatus> {
		return getStatus(this.client, this)
	}

	/** Polls status until the container reaches a run state. Throws PveTimeoutError. */
	async waitForRunState(state: RunState, options?: WaitForStateOptions): Promise<GuestStatus> {
		return waitForRunState(this.client, this, state, options)
	}

	/**
	 * The container config. `current: true` reads what the running container
	 * was started with, and `snapshot` reads the config stored inside a
	 * snapshot. Needs VM.Audit.
	 */
	async getConfig(options: GuestConfigOptions = {}): Promise<LxcConfig> {
		const raw = await this.client.get<Record<string, unknown>>(`${this.path}/config`, options)
		return normalizeLxcConfig(raw, this)
	}

	/**
	 * Changes the config. The change is on disk when the call returns. The
	 * endpoint takes no `skiplock`: a container holding a config lock refuses
	 * every write until `pct unlock` clears it. A mount point is a config key:
	 * `mp1: 'local-zfs:16,mp=/var/cache'`. A bind or device mount point,
	 * `dev[n]`, `hookscript` and any `features` beyond `nesting` are honoured
	 * only for root@pam.
	 */
	async setConfig(params: LxcConfigParams): Promise<void> {
		await this.client.put<null>(`${this.path}/config`, params)
	}

	/** Removes config keys. A volume key removed this way becomes `unused[n]`. */
	async deleteConfigKeys(
		keys: string | readonly string[],
		options: { digest?: string } = {},
	): Promise<void> {
		await this.setConfig({ ...options, delete: joinKeyList(keys) })
	}

	/** Drops queued changes for these keys, restoring the running values. */
	async revertPending(keys: string | readonly string[]): Promise<void> {
		await this.setConfig({ revert: joinKeyList(keys) })
	}

	/** Config changes queued for the next start. Needs VM.Audit. */
	async pending(): Promise<PendingChange[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(`${this.path}/pending`)
		return normalizePending(rows)
	}

	async start(params: LxcStartParams = {}): Promise<string> {
		return powerAction(this.client, this, 'start', params)
	}

	/** Kills every process in the container at once. */
	async stop(params: LxcStopParams = {}): Promise<string> {
		return powerAction(this.client, this, 'stop', params)
	}

	/** Asks the container's init to shut down. */
	async shutdown(params: LxcShutdownParams = {}): Promise<string> {
		return powerAction(this.client, this, 'shutdown', params)
	}

	/** Shuts the container down and starts it again, applying pending changes. */
	async reboot(params: LxcRebootParams = {}): Promise<string> {
		return powerAction(this.client, this, 'reboot', params)
	}

	/** Freezes the container. PVE marks this experimental. */
	async suspend(): Promise<string> {
		return powerAction(this.client, this, 'suspend')
	}

	async resume(): Promise<string> {
		return powerAction(this.client, this, 'resume')
	}

	/**
	 * Deletes the container and every volume it owns. Returns a UPID. Needs
	 * VM.Allocate. `force: true` deletes a running container; `purge` also
	 * drops it from backup jobs, replication jobs and HA.
	 */
	async delete(params: LxcDeleteParams = {}): Promise<string> {
		return destroyGuest(this.client, this, params)
	}

	/** Copies the container to a new vmid. Returns a UPID. Without `full` a template is copied as a linked clone. */
	async clone(params: LxcCloneParams): Promise<string> {
		return this.client.post<string>(`${this.path}/clone`, params)
	}

	/**
	 * Moves the container to another node. Returns a UPID. A running container
	 * needs `restart: true`, which stops it, moves it and starts it again;
	 * `online` alone applies to a container on shared storage.
	 */
	async migrate(params: LxcMigrateParams): Promise<string> {
		return this.client.post<string>(`${this.path}/migrate`, params)
	}

	/** Nodes this container could migrate to, and what blocks the rest. */
	async migratePreconditions(target?: string): Promise<MigratePreconditions> {
		const raw = await this.client.get<Record<string, unknown>>(
			`${this.path}/migrate`,
			target === undefined ? {} : { target },
		)
		return normalizeMigratePreconditions(raw)
	}

	/**
	 * Moves one volume to another storage, or reassigns it to another
	 * container with `target-vmid`. Returns a UPID. The original stays as
	 * `unused[n]` unless `delete` is set.
	 */
	async moveVolume(params: LxcMoveVolumeParams): Promise<string> {
		return this.client.post<string>(`${this.path}/move_volume`, params)
	}

	/**
	 * Grows a volume. Returns a UPID. `size` is absolute, or relative with a
	 * leading `+`, as in `'+8G'`. Shrinking is refused.
	 */
	async resize(params: LxcResizeParams): Promise<string> {
		return this.client.put<string>(`${this.path}/resize`, params)
	}

	/**
	 * Interfaces and addresses as the running container reports them. The
	 * container counterpart of the QEMU agent's network query, needing no
	 * agent. Empty for a stopped container.
	 */
	async interfaces(): Promise<LxcInterface[]> {
		return this.client.get<LxcInterface[]>(`${this.path}/interfaces`)
	}

	/** Converts the container into a template. Synchronous, and answers null rather than a UPID. */
	async toTemplate(): Promise<void> {
		await this.client.post<null>(`${this.path}/template`)
	}

	/** Whether snapshot, clone or copy is available on this container's storage. */
	async feature(feature: 'snapshot' | 'clone' | 'copy', snapname?: string): Promise<GuestFeature> {
		const raw = await this.client.get<Record<string, unknown>>(
			`${this.path}/feature`,
			snapname === undefined ? { feature } : { feature, snapname },
		)
		return normalizeFeature(raw)
	}

	/**
	 * Metric samples for the container. Throws PveNotFoundError while the RRD
	 * file does not exist yet, which is the case for the first minute after
	 * the container is created.
	 */
	async rrddata(options: LxcRrdOptions): Promise<RrdPoint[]> {
		return this.client.get<RrdPoint[]>(`${this.path}/rrddata`, options)
	}

	/** Spawns a VNC proxy worker. The console module wraps this with the credential handling the socket needs. */
	async vncProxy(params: LxcVncProxyParams = {}): Promise<Record<string, unknown>> {
		return this.client.post<Record<string, unknown>>(`${this.path}/vncproxy`, params)
	}

	/** Spawns a terminal proxy on the container's console. */
	async termProxy(params: LxcTermProxyParams = {}): Promise<Record<string, unknown>> {
		return this.client.post<Record<string, unknown>>(`${this.path}/termproxy`, params)
	}

	async spiceProxy(params: LxcSpiceProxyParams = {}): Promise<Record<string, unknown>> {
		return this.client.post<Record<string, unknown>>(`${this.path}/spiceproxy`, params)
	}
}
