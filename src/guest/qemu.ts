/**
 * One QEMU virtual machine, addressed by node and vmid.
 *
 * An endpoint marked `proxyTo: 'node'` is forwarded by whichever node
 * answers, so a handle reaches a VM on any node in the cluster. The power,
 * delete, clone, migrate, disk, template and snapshot calls return the UPID
 * of a worker task; hand it to `client.waitForTask`. The rest complete
 * before the call does.
 */

import type { PveClient } from '../core/client.ts'
import type {
	NodesQemuClonePostParams,
	NodesQemuDeleteParams,
	NodesQemuGetByNodeParams,
	NodesQemuMigratePostParams,
	NodesQemuMoveDiskPostParams,
	NodesQemuResizePutParams,
	NodesQemuRrddataGetParams,
	NodesQemuSnapshotPostParams,
	NodesQemuSpiceproxyPostParams,
	NodesQemuStatusRebootPostParams,
	NodesQemuStatusResetPostParams,
	NodesQemuStatusResumePostParams,
	NodesQemuStatusShutdownPostParams,
	NodesQemuStatusStartPostParams,
	NodesQemuStatusStopPostParams,
	NodesQemuStatusSuspendPostParams,
	NodesQemuTemplatePostParams,
	NodesQemuTermproxyPostParams,
	NodesQemuUnlinkPutParams,
	NodesQemuVncproxyPostParams,
	QemuConfigAsyncParams,
	QemuConfigParams,
} from '../generated/types.ts'
import { QemuAgent } from './agent.ts'
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
	normalizeMigratePreconditions,
	normalizePending,
	normalizeQemuConfig,
	normalizeSummary,
	type GuestConfigOptions,
	type GuestFeature,
	type GuestStatus,
	type GuestSummary,
	type MigratePreconditions,
	type PendingChange,
	type QemuConfig,
	type RrdPoint,
	type RunState,
} from './types.ts'

export type QemuStartParams = NodesQemuStatusStartPostParams
export type QemuStopParams = NodesQemuStatusStopPostParams
export type QemuShutdownParams = NodesQemuStatusShutdownPostParams
export type QemuRebootParams = NodesQemuStatusRebootPostParams
export type QemuResetParams = NodesQemuStatusResetPostParams
export type QemuSuspendParams = NodesQemuStatusSuspendPostParams
export type QemuResumeParams = NodesQemuStatusResumePostParams
export type QemuDeleteParams = NodesQemuDeleteParams
export type QemuCloneParams = NodesQemuClonePostParams
export type QemuMigrateParams = NodesQemuMigratePostParams
export type QemuSnapshotCreateParams = NodesQemuSnapshotPostParams

/** A disk key a VM can carry, such as scsi0, virtio1, efidisk0 or unused3. */
export type QemuDiskKey = NodesQemuMoveDiskPostParams['disk']

export type CloudinitDumpType = 'user' | 'network' | 'meta'

/**
 * Virtual machines on one node. `full: true` adds the status fields the node
 * otherwise leaves out. Needs VM.Audit on each VM.
 */
export async function listVms(
	client: PveClient,
	node: string,
	options: NodesQemuGetByNodeParams = {},
): Promise<GuestSummary[]> {
	const rows = await client.get<Record<string, unknown>[]>(
		`/nodes/${encodeURIComponent(node)}/qemu`,
		options,
	)
	return rows.map((row) => normalizeSummary(row, 'qemu', node))
}

export class QemuApi {
	readonly type = 'qemu' as const
	readonly client: PveClient
	readonly node: string
	readonly vmid: number
	/** The VM's API path, such as /nodes/pve1/qemu/100. */
	readonly path: string
	readonly snapshots: GuestSnapshotsApi<QemuSnapshotCreateParams>
	readonly firewall: GuestFirewallApi
	/** The guest agent. Every call needs `agent=1` and a running agent. */
	readonly agent: QemuAgent

	constructor(client: PveClient, node: string, vmid: number) {
		this.client = client
		this.node = node
		this.vmid = vmid
		this.path = guestPath({ node, vmid, type: 'qemu' })
		this.snapshots = new GuestSnapshotsApi(client, this.path)
		this.firewall = new GuestFirewallApi(client, this.path)
		this.agent = new QemuAgent(client, { node, vmid })
	}

	async status(): Promise<GuestStatus> {
		return getStatus(this.client, this)
	}

	/** Polls status until the VM reaches a run state. Throws PveTimeoutError. */
	async waitForRunState(state: RunState, options?: WaitForStateOptions): Promise<GuestStatus> {
		return waitForRunState(this.client, this, state, options)
	}

	/**
	 * The VM config. By default this is the config the next start would use;
	 * `current: true` reads what the running VM was started with, and
	 * `snapshot` reads the config stored inside a snapshot. Needs VM.Audit.
	 */
	async getConfig(options: GuestConfigOptions = {}): Promise<QemuConfig> {
		const raw = await this.client.get<Record<string, unknown>>(`${this.path}/config`, options)
		return normalizeQemuConfig(raw, this)
	}

	/**
	 * Changes the config through the synchronous PUT. The change is on disk
	 * when the call returns. Use `setConfigAsync` when the change hotplugs a
	 * device or allocates storage. A disk is a config key: `scsi1: 'local-zfs:16'`
	 * allocates 16 GiB.
	 *
	 * `skiplock`, `args`, `hookscript` and a raw `host=` in `usb[n]` or
	 * `hostpci[n]` are honoured only for root@pam; the client throws
	 * PveTierError before sending when no root ticket is configured.
	 */
	async setConfig(params: QemuConfigParams): Promise<void> {
		await this.client.put<null>(`${this.path}/config`, params)
	}

	/**
	 * Changes the config through the asynchronous POST. Returns a UPID. Takes
	 * the same parameters as `setConfig` plus `background_delay`, which lets
	 * the node finish a quick change inline.
	 */
	async setConfigAsync(params: QemuConfigAsyncParams): Promise<string> {
		return this.client.post<string>(`${this.path}/config`, params)
	}

	/**
	 * Removes config keys. Synchronous. A disk key removed this way is kept as
	 * `unused[n]` unless `force` is set.
	 */
	async deleteConfigKeys(
		keys: string | readonly string[],
		options: { force?: boolean; digest?: string } = {},
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

	/**
	 * Clears a stale config lock by deleting the `lock` key with `skiplock`,
	 * which the handler honours only for root@pam.
	 */
	async unlock(): Promise<void> {
		await this.setConfig({ delete: 'lock', skiplock: true })
	}

	async start(params: QemuStartParams = {}): Promise<string> {
		return powerAction(this.client, this, 'start', params)
	}

	/** Kills the QEMU process at once, which the guest OS never learns about. */
	async stop(params: QemuStopParams = {}): Promise<string> {
		return powerAction(this.client, this, 'stop', params)
	}

	/** Sends an ACPI power button event and waits for the OS. */
	async shutdown(params: QemuShutdownParams = {}): Promise<string> {
		return powerAction(this.client, this, 'shutdown', params)
	}

	/** Shuts the VM down and starts it again, applying pending changes. */
	async reboot(params: QemuRebootParams = {}): Promise<string> {
		return powerAction(this.client, this, 'reboot', params)
	}

	/** The reset button, as opposed to an OS reboot. LXC has no counterpart. */
	async reset(params: QemuResetParams = {}): Promise<string> {
		return powerAction(this.client, this, 'reset', params)
	}

	/** Pauses the VM. With `todisk: true` the RAM is written to storage and the VM stops. */
	async suspend(params: QemuSuspendParams = {}): Promise<string> {
		return powerAction(this.client, this, 'suspend', params)
	}

	async resume(params: QemuResumeParams = {}): Promise<string> {
		return powerAction(this.client, this, 'resume', params)
	}

	/**
	 * Deletes the VM and every volume it owns. Returns a UPID. Needs
	 * VM.Allocate. The VM has to be stopped. `purge` also drops it from backup
	 * jobs, replication jobs and HA.
	 */
	async delete(params: QemuDeleteParams = {}): Promise<string> {
		return destroyGuest(this.client, this, params)
	}

	/**
	 * Copies the VM to a new vmid. Returns a UPID. Needs VM.Clone. Without
	 * `full` a template is copied as a linked clone; a normal VM is always
	 * copied in full.
	 */
	async clone(params: QemuCloneParams): Promise<string> {
		return this.client.post<string>(`${this.path}/clone`, params)
	}

	/**
	 * Moves the VM to another node. Returns a UPID. Needs VM.Migrate.
	 * `online: true` migrates a running VM live. `force`, `migration_type`
	 * and `migration_network` are honoured only for root@pam.
	 */
	async migrate(params: QemuMigrateParams): Promise<string> {
		return this.client.post<string>(`${this.path}/migrate`, params)
	}

	/** Nodes this VM could migrate to, plus local disks and devices that block it. */
	async migratePreconditions(target?: string): Promise<MigratePreconditions> {
		const raw = await this.client.get<Record<string, unknown>>(
			`${this.path}/migrate`,
			target === undefined ? {} : { target },
		)
		return normalizeMigratePreconditions(raw)
	}

	/**
	 * Moves one disk to another storage, or reassigns it to another VM with
	 * `target-vmid`. Returns a UPID. The original stays as `unused[n]` unless
	 * `delete` is set.
	 */
	async moveDisk(params: NodesQemuMoveDiskPostParams): Promise<string> {
		return this.client.post<string>(`${this.path}/move_disk`, params)
	}

	/**
	 * Grows a disk. Returns a UPID. `size` is absolute, or relative with a
	 * leading `+`, as in `'+8G'`. Shrinking is refused.
	 */
	async resize(params: NodesQemuResizePutParams): Promise<string> {
		return this.client.put<string>(`${this.path}/resize`, params)
	}

	/**
	 * Detaches disks. Synchronous. Each disk becomes `unused[n]`; `force: true`
	 * deletes the volume instead. Also the way to drop an existing `unused[n]`.
	 */
	async unlink(
		disks: string | readonly string[],
		options: Omit<NodesQemuUnlinkPutParams, 'idlist'> = {},
	): Promise<void> {
		await this.client.put<null>(`${this.path}/unlink`, { ...options, idlist: joinKeyList(disks) })
	}

	/**
	 * Converts the VM into a template, which makes its disks read-only.
	 * Returns a UPID. `disk` converts a single disk instead of all of them.
	 */
	async toTemplate(params: NodesQemuTemplatePostParams = {}): Promise<string> {
		return this.client.post<string>(`${this.path}/template`, params)
	}

	/**
	 * Sends one key event to the VM's console. Synchronous. The key uses the
	 * QEMU monitor spelling, such as `'ret'`, `'ctrl-alt-delete'` or `'kp_5'`.
	 */
	async sendKey(key: string, options: { skiplock?: boolean } = {}): Promise<void> {
		await this.client.put<null>(`${this.path}/sendkey`, { ...options, key })
	}

	/**
	 * Runs an HMP monitor command and returns its output text.
	 *
	 * PVE maps a small set of HMP commands onto normal VM privileges and
	 * refuses everything else for anyone but root@pam. The registry cannot
	 * tell which is which, so an unmapped command reaches the node and comes
	 * back as PvePermissionError.
	 */
	async monitor(command: string): Promise<string> {
		return this.client.post<string>(`${this.path}/monitor`, { command })
	}

	/**
	 * Cloud-init keys, comparing the drive attached now (`value`) against what
	 * a regenerate would produce (`pending`).
	 */
	async cloudinit(): Promise<PendingChange[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(`${this.path}/cloudinit`)
		return normalizePending(rows)
	}

	/** Rebuilds the cloud-init drive from the current config. Synchronous. The guest reads it at the next boot. */
	async regenerateCloudinit(): Promise<void> {
		await this.client.put<null>(`${this.path}/cloudinit`)
	}

	/** The generated cloud-init user, network or meta document, as text. */
	async cloudinitDump(type: CloudinitDumpType): Promise<string> {
		return this.client.get<string>(`${this.path}/cloudinit/dump`, { type })
	}

	/** Whether snapshot, clone or copy is available on this VM's storage. */
	async feature(feature: 'snapshot' | 'clone' | 'copy', snapname?: string): Promise<GuestFeature> {
		const raw = await this.client.get<Record<string, unknown>>(
			`${this.path}/feature`,
			snapname === undefined ? { feature } : { feature, snapname },
		)
		return normalizeFeature(raw)
	}

	/**
	 * Metric samples for the VM. Throws PveNotFoundError while the RRD file
	 * does not exist yet, which is the case for the first minute after the VM
	 * is created.
	 */
	async rrddata(options: NodesQemuRrddataGetParams): Promise<RrdPoint[]> {
		return this.client.get<RrdPoint[]>(`${this.path}/rrddata`, options)
	}

	/** Spawns a VNC proxy worker. The console module wraps this with the credential handling the socket needs. */
	async vncProxy(params: NodesQemuVncproxyPostParams = {}): Promise<Record<string, unknown>> {
		return this.client.post<Record<string, unknown>>(`${this.path}/vncproxy`, params)
	}

	/** Spawns a terminal proxy on the VM's serial console. */
	async termProxy(params: NodesQemuTermproxyPostParams = {}): Promise<Record<string, unknown>> {
		return this.client.post<Record<string, unknown>>(`${this.path}/termproxy`, params)
	}

	/** SPICE connection settings for a VM with a SPICE display. */
	async spiceProxy(params: NodesQemuSpiceproxyPostParams = {}): Promise<Record<string, unknown>> {
		return this.client.post<Record<string, unknown>>(`${this.path}/spiceproxy`, params)
	}
}
