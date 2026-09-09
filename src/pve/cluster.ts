/**
 * The connected cluster: one client, one set of sessions, one `close()`.
 *
 * All state hangs off the instance. Two clusters in one process hold
 * separate clients, sockets and node shells.
 */

import { AccessApi } from '../access/access.ts'
import { ClusterApi, nextVmid } from '../cluster/cluster.ts'
import type { SocketFactory } from '../console/socket.ts'
import { SerialConsole, type SerialConsoleOptions } from '../console/terminal.ts'
import { VncSession, type VncSessionOptions } from '../console/vnc.ts'
import type { CredentialInput } from '../core/auth.ts'
import { PveClient, type RequestTrace } from '../core/client.ts'
import { PveConfigError } from '../core/errors.ts'
import type { TaskStatus, WaitOptions } from '../core/tasks.ts'
import {
	createContainer,
	createVm,
	listGuests,
	resolveGuest,
	type CreateContainerSpec as ContainerParams,
	type CreateVmSpec as VmParams,
	type ListGuestsOptions,
} from '../guest/discovery.ts'
import type { GuestRef, GuestSummary } from '../guest/types.ts'
import { listNodes, type NodeListEntry } from '../node/node.ts'
import { NodeShell, type NodeShellOptions, type TransportChoice } from '../shell/node-shell.ts'
import type { SshOptions } from '../shell/ssh.ts'
import type { ShellPolicy } from '../shell/types.ts'
import type { PveContext, SerialOpenOptions } from './context.ts'
import { PveContainer, PveVm, type PveGuest } from './guest.ts'
import { PveNode } from './node.ts'

/** Settings the cluster passes to every node shell it opens. */
export interface ShellDefaults {
	/** SSH settings. Setting `host` points every node shell at that one address. */
	ssh?: Partial<SshOptions>
	/** 'auto', the default, prefers ssh and falls back to the termproxy websocket. */
	transport?: TransportChoice
	/** Allow and deny patterns, and whether the built-in destructive patterns refuse a command. */
	policy?: ShellPolicy
}

export interface PveClusterOptions {
	/** Settings for the root shells this cluster opens on nodes. */
	shell?: ShellDefaults
	/** Opens the console WebSockets. Replaceable for tests. */
	socketFactory?: SocketFactory
}

export interface PveConnectOptions extends CredentialInput, PveClusterOptions {
	/** Abort a request that produces no response within this many milliseconds. */
	timeoutMs?: number
	/** Called before every API attempt, with the credential tier it chose. */
	onRequest?: (trace: RequestTrace) => void
}

/** What `GET /version` answers. */
export interface PveVersion extends Record<string, unknown> {
	version: string
	release: string
	repoid: string
}

export interface CreateVmSpec extends VmParams {
	/** Node to build the VM on. Defaults to PVE_NODE. */
	node?: string
}

export interface CreateContainerSpec extends ContainerParams {
	/** Node to build the container on. Defaults to PVE_NODE. */
	node?: string
}

/**
 * Sessions keyed by what they belong to. One open per key is in flight at a
 * time, a failed open leaves no entry behind, and an entry can forget itself
 * when the session underneath goes away.
 */
class SessionStore<Key, Session> {
	private readonly entries = new Map<Key, Promise<Session>>()

	open(key: Key, start: (forget: () => void) => Promise<Session>): Promise<Session> {
		const existing = this.entries.get(key)
		if (existing) return existing
		let opening: Promise<Session> | undefined
		const forget = (): void => {
			if (this.entries.get(key) === opening) this.entries.delete(key)
		}
		opening = start(forget).catch((error: unknown) => {
			forget()
			throw error
		})
		this.entries.set(key, opening)
		return opening
	}

	/** Removes the entry and resolves with its session, or undefined when there is none. */
	async take(key: Key): Promise<Session | undefined> {
		const pending = this.entries.get(key)
		if (!pending) return undefined
		this.entries.delete(key)
		return pending.catch(() => undefined)
	}

	/** Removes every entry and resolves with the sessions that opened. */
	async drain(): Promise<Session[]> {
		const pending = [...this.entries.values()]
		this.entries.clear()
		const settled = await Promise.allSettled(pending)
		const sessions: Session[] = []
		for (const result of settled) {
			if (result.status === 'fulfilled') sessions.push(result.value)
		}
		return sessions
	}
}

export class PveCluster implements PveContext {
	readonly client: PveClient
	/** Cluster-wide endpoints: status, resources, HA, backup, firewall, pools. */
	readonly api: ClusterApi
	/** Users, groups, roles, ACLs, tokens and realms. */
	readonly access: AccessApi

	private readonly shellDefaults: ShellDefaults
	private readonly socketFactory: SocketFactory | undefined
	private readonly shells = new SessionStore<string, NodeShell>()
	private readonly vncSessions = new SessionStore<number, VncSession>()
	private readonly serialConsoles = new SessionStore<number, SerialConsole>()

	constructor(client: PveClient, options: PveClusterOptions = {}) {
		this.client = client
		this.api = new ClusterApi(client)
		this.access = new AccessApi(client)
		this.shellDefaults = options.shell ?? {}
		this.socketFactory = options.socketFactory
	}

	/** What console.log prints: where the client points, not every session it holds. */
	[Symbol.for('nodejs.util.inspect.custom')](): string {
		return `PveCluster { url: '${this.client.baseUrl}' }`
	}

	/** Manager version, release and repository id of the node the client talks to. */
	version(): Promise<PveVersion> {
		return this.client.get<PveVersion>('/version')
	}

	/** Every node in the cluster with its status and resource totals. */
	nodes(): Promise<NodeListEntry[]> {
		return listNodes(this.client)
	}

	/**
	 * A handle for one node. Sends nothing. Defaults to PVE_NODE and throws
	 * PveConfigError when neither a name nor PVE_NODE is set.
	 */
	node(name?: string): PveNode {
		return new PveNode(this, this.nodeName(name))
	}

	/** Every guest in the cluster, both types, sorted by vmid. One GET to /cluster/resources. */
	list(options?: ListGuestsOptions): Promise<GuestSummary[]> {
		return listGuests(this.client, options)
	}

	/**
	 * A handle for a vmid anywhere in the cluster, of whichever type the guest
	 * turned out to be. Costs one GET to /cluster/resources; use `vm` or
	 * `container` when the node is already known. Throws PveNotFoundError
	 * when no node holds the vmid.
	 */
	async guest(vmid: number): Promise<PveGuest> {
		const summary = await resolveGuest(this.client, vmid)
		return summary.type === 'qemu'
			? new PveVm(this, summary.node, summary.vmid)
			: new PveContainer(this, summary.node, summary.vmid)
	}

	/** A VM handle for a known node and vmid. Sends nothing. */
	vm(vmid: number, node?: string): PveVm {
		return new PveVm(this, this.nodeName(node), vmid)
	}

	/** A container handle for a known node and vmid. Sends nothing. */
	container(vmid: number, node?: string): PveContainer {
		return new PveContainer(this, this.nodeName(node), vmid)
	}

	/**
	 * The lowest free vmid at or above 100, or a check that `vmid` itself is
	 * free. Throws PveApiError when the vmid is taken. Only true at the moment
	 * of the call.
	 */
	nextId(vmid?: number): Promise<number> {
		return nextVmid(this.client, vmid)
	}

	/**
	 * Creates a virtual machine, waits for the create task and returns a
	 * handle. Disks are config keys: `scsi0: 'local-zfs:32'` allocates 32 GiB.
	 * `start: true` boots it as part of the same task. Needs VM.Allocate on
	 * /vms plus Datastore.AllocateSpace on each storage the config touches.
	 */
	async createVm(spec: CreateVmSpec): Promise<PveVm> {
		const { node, ...params } = spec
		const api = await createVm(this.client, this.nodeName(node), params)
		return new PveVm(this, api.node, api.vmid)
	}

	/**
	 * Creates a container, waits for the create task and returns a handle.
	 * `ostemplate` names the template volume and `rootfs` the storage and
	 * size, as in `'local-zfs:8'`. A fresh container is unprivileged unless
	 * the spec says otherwise. Needs VM.Allocate on /vms plus
	 * Datastore.AllocateSpace on the rootfs storage.
	 */
	async createContainer(spec: CreateContainerSpec): Promise<PveContainer> {
		const { node, ...params } = spec
		const api = await createContainer(this.client, this.nodeName(node), params)
		return new PveContainer(this, api.node, api.vmid)
	}

	/** Waits for a worker task by UPID and returns its final status. Throws PveTaskError on failure. */
	waitForTask(upid: string, options?: WaitOptions): Promise<TaskStatus> {
		return this.client.waitForTask(upid, options)
	}

	nodeShell(node: string): Promise<NodeShell> {
		return this.shells.open(node, async (forget) => {
			const options: NodeShellOptions = { node, client: this.client }
			if (this.shellDefaults.ssh) options.ssh = this.shellDefaults.ssh
			if (this.shellDefaults.transport) options.transport = this.shellDefaults.transport
			if (this.shellDefaults.policy) options.policy = this.shellDefaults.policy
			const shell = await NodeShell.open(options)
			shell.onClose(forget)
			return shell
		})
	}

	async closeNodeShell(node: string): Promise<void> {
		await (await this.shells.take(node))?.close()
	}

	vncSession(ref: Required<GuestRef>): Promise<VncSession> {
		return this.vncSessions.open(ref.vmid, async (forget) => {
			const options: VncSessionOptions = { client: this.client, ...ref }
			if (this.socketFactory) options.socketFactory = this.socketFactory
			const session = new VncSession(options)
			session.once('close', forget)
			await session.connect()
			return session
		})
	}

	async closeVncSession(vmid: number): Promise<void> {
		;(await this.vncSessions.take(vmid))?.close()
	}

	serialConsole(ref: Required<GuestRef>, options: SerialOpenOptions = {}): Promise<SerialConsole> {
		return this.serialConsoles.open(ref.vmid, async (forget) => {
			const consoleOptions: SerialConsoleOptions = { ...options, client: this.client, ...ref }
			if (this.socketFactory) consoleOptions.socketFactory = this.socketFactory
			const serial = new SerialConsole(consoleOptions)
			serial.once('close', forget)
			await serial.connect()
			return serial
		})
	}

	async closeSerialConsole(vmid: number): Promise<void> {
		;(await this.serialConsoles.take(vmid))?.close()
	}

	/**
	 * Closes every VNC session, serial console and node shell this cluster
	 * opened, then releases the client. Safe to call more than once.
	 */
	async close(): Promise<void> {
		const [vnc, serial, shells] = await Promise.all([
			this.vncSessions.drain(),
			this.serialConsoles.drain(),
			this.shells.drain(),
		])
		for (const session of vnc) session.close()
		for (const item of serial) item.close()
		await Promise.allSettled(shells.map((shell) => shell.close()))
		this.client.close()
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close()
	}

	private nodeName(name?: string): string {
		const resolved = name ?? this.client.defaultNode
		if (resolved === undefined) {
			throw new PveConfigError(
				'No node named and no default configured. Pass a node name, or set PVE_NODE.',
			)
		}
		return resolved
	}
}

/**
 * Builds a cluster from explicit values, the environment and a pve.env file,
 * then checks the credentials with one GET /version. Opens no socket and no
 * shell.
 */
export async function connect(options: PveConnectOptions = {}): Promise<PveCluster> {
	const { shell, socketFactory, ...clientOptions } = options
	const clusterOptions: PveClusterOptions = {}
	if (shell) clusterOptions.shell = shell
	if (socketFactory) clusterOptions.socketFactory = socketFactory
	const cluster = new PveCluster(PveClient.fromEnv(clientOptions), clusterOptions)
	try {
		await cluster.version()
	} catch (error) {
		await cluster.close()
		throw error
	}
	return cluster
}
