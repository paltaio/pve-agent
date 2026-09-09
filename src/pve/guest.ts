/**
 * Handles for one guest.
 *
 * `PveVm` and `PveContainer` share what the two guest types have in common,
 * and each adds what only it has: a VM has a guest agent, a VNC console and
 * a reset button, while a container runs its commands through `pct exec` on
 * the node.
 *
 * Every lifecycle call here waits for the worker task and returns its final
 * status. Reach for `api` when the raw UPID is what you want.
 */

import { PveTaskError } from '../core/errors.ts'
import { pollUntil } from '../core/poll.ts'
import type { TaskStatus } from '../core/tasks.ts'
import type { QemuAgent } from '../guest/agent.ts'
import type { GuestFirewallApi } from '../guest/firewall.ts'
import type { WaitForStateOptions } from '../guest/lifecycle.ts'
import {
	LxcApi,
	type LxcCloneParams,
	type LxcDeleteParams,
	type LxcMigrateParams,
	type LxcRebootParams,
	type LxcShutdownParams,
	type LxcSnapshotCreateParams,
	type LxcStartParams,
	type LxcStopParams,
} from '../guest/lxc.ts'
import {
	QemuApi,
	type QemuCloneParams,
	type QemuDeleteParams,
	type QemuMigrateParams,
	type QemuRebootParams,
	type QemuResetParams,
	type QemuResumeParams,
	type QemuShutdownParams,
	type QemuSnapshotCreateParams,
	type QemuStartParams,
	type QemuStopParams,
	type QemuSuspendParams,
} from '../guest/qemu.ts'
import type { SnapshotDeleteOptions, SnapshotRollbackOptions } from '../guest/snapshots.ts'
import type {
	GuestConfigOptions,
	GuestRef,
	GuestSnapshot,
	GuestStatus,
	GuestType,
	LxcConfig,
	QemuConfig,
	RunState,
} from '../guest/types.ts'
import {
	openGuestOs,
	waitForAgent,
	type AnyGuestOs,
	type WaitForAgentOptions,
} from '../guest-os/guest-os.ts'
import type { LinuxGuest } from '../guest-os/linux.ts'
import type { LxcConfigParams, QemuConfigParams } from '../generated/types.ts'
import type { PctExecOptions } from '../shell/lxc.ts'
import type { NodeShell } from '../shell/node-shell.ts'
import type { CommandResult } from '../shell/types.ts'
import { GuestConsole, VmKvm } from './console.ts'
import type { PveContext } from './context.ts'

/** A guest handle of either type. Narrow it on `type`. */
export type PveGuest = PveVm | PveContainer

const LOCK_RETRY_MS = 45_000
const LOCK_TIMEOUT = /can't lock file/

type Attempt = { status: TaskStatus } | { error: PveTaskError }

abstract class PveGuestBase {
	abstract readonly type: GuestType
	/** The module handle underneath. Its lifecycle calls return a UPID instead of waiting. */
	abstract readonly api: QemuApi | LxcApi
	readonly node: string
	readonly vmid: number
	/** The serial console. Connects on the first call, not here. */
	readonly console: GuestConsole

	protected readonly context: PveContext
	protected readonly ref: Required<GuestRef>

	protected constructor(context: PveContext, ref: Required<GuestRef>) {
		this.context = context
		this.ref = ref
		this.node = ref.node
		this.vmid = ref.vmid
		this.console = new GuestConsole(context, ref)
	}

	/** The guest's API path, such as /nodes/pve1/lxc/110. */
	get path(): string {
		return this.api.path
	}

	/** Firewall rules, aliases, IP sets and options for this guest. */
	get firewall(): GuestFirewallApi {
		return this.api.firewall
	}

	/** Current status, with a QEMU pause folded into `runState`. Needs VM.Audit. */
	status(): Promise<GuestStatus> {
		return this.api.status()
	}

	/** Polls the guest until it reaches a run state, and returns that status. Throws PveTimeoutError. */
	waitFor(state: RunState, options?: WaitForStateOptions): Promise<GuestStatus> {
		return this.api.waitForRunState(state, options)
	}

	/** Snapshots, including the `current` pseudo-entry. Needs VM.Audit. */
	snapshots(): Promise<GuestSnapshot[]> {
		return this.api.snapshots.list()
	}

	/** Restores the guest to a snapshot and waits for the task. Needs VM.Snapshot.Rollback. */
	rollback(name: string, options?: SnapshotRollbackOptions): Promise<TaskStatus> {
		return this.runTask(this.api.snapshots.rollback(name, options))
	}

	/** Deletes a snapshot and waits for the task. Needs VM.Snapshot. */
	deleteSnapshot(name: string, options?: SnapshotDeleteOptions): Promise<TaskStatus> {
		return this.runTask(this.api.snapshots.delete(name, options))
	}

	/** The `description` field of the config, which the web UI shows as notes. */
	async notes(): Promise<string | undefined> {
		return (await this.api.getConfig()).description
	}

	/** Replaces the `description` field of the config. Needs VM.Config.Options. */
	async setNotes(text: string): Promise<void> {
		await this.api.setConfig({ description: text })
	}

	/** Closes the console sessions this guest holds. Leaves the guest running. */
	async closeSessions(): Promise<void> {
		await Promise.all([
			this.context.closeVncSession(this.vmid),
			this.context.closeSerialConsole(this.vmid),
		])
	}

	protected async runTask(call: Promise<string>): Promise<TaskStatus> {
		return this.context.client.waitForTask(await call)
	}

	/**
	 * Posts the call and waits for its task, posting again for up to 45 s
	 * while the task fails on the guest's config lock. The node takes that
	 * lock before it changes anything, so a task that lost it did nothing.
	 * After a stop, qmeventd's `qm cleanup` holds it for up to 30 s once a
	 * QEMU process with the same vmid is running again, which a delete and
	 * recreate of one vmid runs into on the next power call.
	 */
	protected async retryOnLock(call: () => Promise<string>): Promise<TaskStatus> {
		const attempt = await pollUntil<Attempt>(
			async () => {
				try {
					return { status: await this.runTask(call()) }
				} catch (error) {
					if (error instanceof PveTaskError && LOCK_TIMEOUT.test(error.exitStatus ?? '')) {
						return { error }
					}
					throw error
				}
			},
			{
				done: (value) => 'status' in value,
				onTimeout: (value) => {
					if ('error' in value) throw value.error
					return value
				},
				timeoutMs: LOCK_RETRY_MS,
			},
		)
		if ('error' in attempt) throw attempt.error
		return attempt.status
	}

	/** Closes the consoles first: a destroyed guest's sockets go away underneath them. */
	protected async destroy(call: () => Promise<string>): Promise<TaskStatus> {
		await this.closeSessions()
		return this.retryOnLock(call)
	}
}

/** One QEMU virtual machine. */
export class PveVm extends PveGuestBase {
	readonly type = 'qemu' as const
	readonly api: QemuApi
	/** The QEMU guest agent. Every call needs `agent=1` in the config and a running agent. */
	readonly guest: QemuAgent
	/** Keyboard, mouse and screen over VNC. Connects on the first call, not here. */
	readonly kvm: VmKvm

	private osHandle: Promise<AnyGuestOs> | undefined

	constructor(context: PveContext, node: string, vmid: number) {
		super(context, { type: 'qemu', node, vmid })
		this.api = new QemuApi(context.client, node, vmid)
		this.guest = this.api.agent
		this.kvm = new VmKvm(context, this.ref)
	}

	/**
	 * The OS helper for whatever runs inside, picked from the config or by
	 * asking the agent. Opened on the first await and kept; a failed open is
	 * retried on the next await.
	 */
	get os(): Promise<AnyGuestOs> {
		this.osHandle ??= openGuestOs(this.api).catch((error: unknown) => {
			this.osHandle = undefined
			throw error
		})
		return this.osHandle
	}

	/** The config the next start would use. Needs VM.Audit. */
	config(options?: GuestConfigOptions): Promise<QemuConfig> {
		return this.api.getConfig(options)
	}

	/**
	 * Changes the config through the synchronous PUT. Use `api.setConfigAsync`
	 * for a change that hotplugs a device or allocates storage. Needs VM.Config.*.
	 */
	async configure(params: QemuConfigParams): Promise<void> {
		await this.api.setConfig(params)
	}

	/** Starts the VM and waits for the task. Needs VM.PowerMgmt. */
	start(params?: QemuStartParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.start(params))
	}

	/** Kills the QEMU process without telling the OS, and waits for the task. Needs VM.PowerMgmt. */
	stop(params?: QemuStopParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.stop(params))
	}

	/** Sends an ACPI power button event and waits for the OS to halt. Needs VM.PowerMgmt. */
	shutdown(params?: QemuShutdownParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.shutdown(params))
	}

	/** Shuts the VM down and starts it again, applying pending changes. Needs VM.PowerMgmt. */
	reboot(params?: QemuRebootParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.reboot(params))
	}

	/** The reset button, as opposed to an OS reboot. Needs VM.PowerMgmt. */
	reset(params?: QemuResetParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.reset(params))
	}

	/** Pauses the VM. `todisk: true` writes the RAM to storage and stops it. Needs VM.PowerMgmt. */
	suspend(params?: QemuSuspendParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.suspend(params))
	}

	/** Resumes a paused VM and waits for the task. Needs VM.PowerMgmt. */
	resume(params?: QemuResumeParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.resume(params))
	}

	/**
	 * Deletes the stopped VM and every volume it owns. `purge` also drops it
	 * from backup jobs, replication jobs and HA. Needs VM.Allocate.
	 */
	delete(params?: QemuDeleteParams): Promise<TaskStatus> {
		return this.destroy(() => this.api.delete(params))
	}

	/** Takes a snapshot and waits for the task. `vmstate: true` also saves RAM. Needs VM.Snapshot. */
	snapshot(name: string, params?: Omit<QemuSnapshotCreateParams, 'snapname'>): Promise<TaskStatus> {
		return this.runTask(this.api.snapshots.create(name, params))
	}

	/** Copies the VM to a new vmid and waits for the task. Needs VM.Clone. */
	clone(params: QemuCloneParams): Promise<TaskStatus> {
		return this.runTask(this.api.clone(params))
	}

	/** Moves the VM to another node and waits for the task. `online: true` migrates live. Needs VM.Migrate. */
	migrate(params: QemuMigrateParams): Promise<TaskStatus> {
		return this.runTask(this.api.migrate(params))
	}

	/** Polls the guest agent until it answers. Throws PveTimeoutError when the deadline passes. */
	waitForAgent(options?: WaitForAgentOptions): Promise<void> {
		return waitForAgent(this.guest, options)
	}
}

/** One LXC container. */
export class PveContainer extends PveGuestBase {
	readonly type = 'lxc' as const
	readonly api: LxcApi

	private osHandle: Promise<LinuxGuest> | undefined

	constructor(context: PveContext, node: string, vmid: number) {
		super(context, { type: 'lxc', node, vmid })
		this.api = new LxcApi(context.client, node, vmid)
	}

	/**
	 * The root shell on the container's node, with `pct` on it for file
	 * transfer, `df`, mount and unlock. Opened on the first await and shared
	 * with everything else on that node.
	 */
	get shell(): Promise<NodeShell> {
		return this.context.nodeShell(this.node)
	}

	/**
	 * The Linux helper for the container, running through `pct exec` on the
	 * node. Opened on the first await and kept; a failed open is retried on
	 * the next await.
	 */
	get os(): Promise<LinuxGuest> {
		this.osHandle ??= this.openOs().catch((error: unknown) => {
			this.osHandle = undefined
			throw error
		})
		return this.osHandle
	}

	/**
	 * Runs a command line inside the container through `pct exec` and returns
	 * its exit code and output. A stopped container makes pct exit 255.
	 */
	async exec(command: string, options?: PctExecOptions): Promise<CommandResult> {
		return (await this.shell).pct.exec(this.vmid, command, options)
	}

	/** The config the next start would use. Needs VM.Audit. */
	config(options?: GuestConfigOptions): Promise<LxcConfig> {
		return this.api.getConfig(options)
	}

	/** Changes the config. A container holding a config lock refuses every write. Needs VM.Config.*. */
	async configure(params: LxcConfigParams): Promise<void> {
		await this.api.setConfig(params)
	}

	/** Starts the container and waits for the task. Needs VM.PowerMgmt. */
	start(params?: LxcStartParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.start(params))
	}

	/** Kills the container without telling its init, and waits for the task. Needs VM.PowerMgmt. */
	stop(params?: LxcStopParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.stop(params))
	}

	/** Asks the container's init to halt and waits for the task. Needs VM.PowerMgmt. */
	shutdown(params?: LxcShutdownParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.shutdown(params))
	}

	/** Shuts the container down and starts it again, applying pending changes. Needs VM.PowerMgmt. */
	reboot(params?: LxcRebootParams): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.reboot(params))
	}

	/** Freezes the container and waits for the task. Needs VM.PowerMgmt. */
	suspend(): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.suspend())
	}

	/** Thaws a frozen container and waits for the task. Needs VM.PowerMgmt. */
	resume(): Promise<TaskStatus> {
		return this.retryOnLock(() => this.api.resume())
	}

	/**
	 * Deletes the stopped container and every volume it owns. `purge` also
	 * drops it from backup jobs, replication jobs and HA. Needs VM.Allocate.
	 */
	delete(params?: LxcDeleteParams): Promise<TaskStatus> {
		return this.destroy(() => this.api.delete(params))
	}

	/** Takes a snapshot and waits for the task. Needs VM.Snapshot. */
	snapshot(name: string, params?: Omit<LxcSnapshotCreateParams, 'snapname'>): Promise<TaskStatus> {
		return this.runTask(this.api.snapshots.create(name, params))
	}

	/** Copies the container to a new vmid and waits for the task. Needs VM.Clone. */
	clone(params: LxcCloneParams): Promise<TaskStatus> {
		return this.runTask(this.api.clone(params))
	}

	/** Moves the container to another node and waits for the task. Needs VM.Migrate. */
	migrate(params: LxcMigrateParams): Promise<TaskStatus> {
		return this.runTask(this.api.migrate(params))
	}

	private async openOs(): Promise<LinuxGuest> {
		return openGuestOs(this.api, { shell: await this.shell })
	}
}
