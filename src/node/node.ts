/**
 * One node: its status, its system settings, and the subsystems that hang off
 * it.
 *
 * A `NodeApi` is a client plus a node name. Most node endpoints carry
 * `proxyTo: 'node'`, so whichever node the client talks to forwards the call
 * to the named one and a single client covers the cluster. A node that is not
 * a cluster member yet has nothing to forward to it, so it needs a client
 * built with `PveClient.fromEnv({ host })` pointed at it directly.
 */

import type { PveClient, HttpMethod, PveParams } from '../core/client.ts'
import type { PveLogLine } from '../core/tasks.ts'
import type {
	NodesConfigGetParams,
	NodesConfigPutParams,
	NodesDnsPutParams,
	NodesJournalGetParams,
	NodesMigrateallPostParams,
	NodesStartallPostParams,
	NodesStopallPostParams,
	NodesSuspendallPostParams,
	NodesSyslogGetParams,
} from '../generated/types.ts'
import { NodeAptApi } from './apt.ts'
import { NodeBackupApi } from './backup.ts'
import { NodeCertificatesApi } from './certificates.ts'
import { NodeDisksApi } from './disks.ts'
import { NodeFirewallApi } from './firewall.ts'
import { NodeHardwareApi } from './hardware.ts'
import { NodeNetworkApi } from './network.ts'
import { NodeReplicationApi } from './replication.ts'
import { NodeScanApi } from './scan.ts'
import { NodeServicesApi } from './services.ts'
import { NodeStorageApi } from './storage.ts'
import { NodeTasksApi } from './tasks.ts'

/** A row of `GET /nodes`. */
export interface NodeListEntry extends Record<string, unknown> {
	node: string
	status: 'online' | 'offline' | 'unknown'
	id: string
	type: 'node'
	level?: string
	cpu?: number
	maxcpu?: number
	mem?: number
	maxmem?: number
	disk?: number
	maxdisk?: number
	uptime?: number
	ssl_fingerprint?: string
}

/** `GET /nodes/{node}/status`, with the node's own 0 and 1 spelling in nested blobs. */
export interface NodeStatus extends Record<string, unknown> {
	uptime: number
	loadavg?: string[]
	cpu?: number
	wait?: number
	idle?: number
	kversion?: string
	pveversion?: string
	cpuinfo?: Record<string, unknown>
	memory?: { total: number; used: number; free: number }
	swap?: { total: number; used: number; free: number }
	rootfs?: { total: number; used: number; free: number; avail: number }
	ksm?: { shared: number }
	'boot-info'?: { mode: string; secureboot?: number }
	'current-kernel'?: Record<string, unknown>
}

export interface NodeVersion extends Record<string, unknown> {
	version: string
	release: string
	repoid: string
}

export interface NodeDnsSettings extends Record<string, unknown> {
	search?: string
	dns1?: string
	dns2?: string
	dns3?: string
}

export interface NodeTimeSettings extends Record<string, unknown> {
	/** Epoch seconds, UTC. */
	time: number
	/** Epoch seconds, shifted by the node's time zone offset. */
	localtime: number
	timezone: string
}

/** `/etc/hosts` as one blob, with the digest that guards an overwrite. */
export interface NodeHostsFile extends Record<string, unknown> {
	data: string
	digest?: string
}

/** One sub-call of a batch, in the order the batch listed them. */
export interface BatchCommand {
	/** Path below `nodes/{node}/`, such as `qemu/100/status/current`. */
	path: string
	method: HttpMethod
	args?: Record<string, unknown>
}

/** One sub-call's outcome. `data` on success, `message` on failure. */
export interface BatchResult extends Record<string, unknown> {
	status: number
	data?: unknown
	message?: string
	errors?: Record<string, string>
}

/** Every node in the cluster with its status and resource totals. */
export async function listNodes(client: PveClient): Promise<NodeListEntry[]> {
	return client.get<NodeListEntry[]>('/nodes')
}

export class NodeApi {
	readonly client: PveClient
	readonly node: string
	readonly network: NodeNetworkApi
	readonly storage: NodeStorageApi
	readonly disks: NodeDisksApi
	readonly firewall: NodeFirewallApi
	readonly apt: NodeAptApi
	readonly certificates: NodeCertificatesApi
	readonly services: NodeServicesApi
	readonly hardware: NodeHardwareApi
	readonly scan: NodeScanApi
	readonly tasks: NodeTasksApi
	readonly replication: NodeReplicationApi
	/** vzdump on this node. */
	readonly backup: NodeBackupApi

	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.node = node
		this.base = `/nodes/${encodeURIComponent(node)}`
		this.network = new NodeNetworkApi(client, node)
		this.storage = new NodeStorageApi(client, node)
		this.disks = new NodeDisksApi(client, node)
		this.firewall = new NodeFirewallApi(client, node)
		this.apt = new NodeAptApi(client, node)
		this.certificates = new NodeCertificatesApi(client, node)
		this.services = new NodeServicesApi(client, node)
		this.hardware = new NodeHardwareApi(client, node)
		this.scan = new NodeScanApi(client, node)
		this.tasks = new NodeTasksApi(client, node)
		this.replication = new NodeReplicationApi(client, node)
		this.backup = new NodeBackupApi(client, node)
	}

	/**
	 * Uptime, load, CPU and memory use, kernel and PVE versions, root
	 * filesystem usage and boot mode.
	 */
	async status(): Promise<NodeStatus> {
		return this.client.get<NodeStatus>(`${this.base}/status`)
	}

	/** Reboot the node. Guests are not shut down first. */
	async reboot(): Promise<void> {
		await this.client.post<null>(`${this.base}/status`, { command: 'reboot' })
	}

	/** Power the node off. Guests are not shut down first. */
	async shutdown(): Promise<void> {
		await this.client.post<null>(`${this.base}/status`, { command: 'shutdown' })
	}

	/** API version, release and repository id of this node. */
	async version(): Promise<NodeVersion> {
		return this.client.get<NodeVersion>(`${this.base}/version`)
	}

	/**
	 * Node configuration: `acme`, `acmedomain[n]`, `ballooning-target`,
	 * `description`, `location`, `startall-onboot-delay` and `wakeonlan`.
	 * Kernel, sysctl and boot parameters are not here. `property` returns one
	 * key instead of all.
	 */
	async getConfig(options?: NodesConfigGetParams): Promise<Record<string, unknown>> {
		return this.client.get<Record<string, unknown>>(`${this.base}/config`, options)
	}

	/**
	 * Change node configuration. `acme` and `wakeonlan` are property strings;
	 * build them with `formatConfigValue('PUT', '/nodes/{node}/config', key,
	 * bag)`. `delete` unsets keys.
	 */
	async setConfig(params: NodesConfigPutParams): Promise<void> {
		await this.client.put<null>(`${this.base}/config`, params)
	}

	/** Search domain and up to three nameservers. */
	async getDns(): Promise<NodeDnsSettings> {
		return this.client.get<NodeDnsSettings>(`${this.base}/dns`)
	}

	/**
	 * Rewrite `/etc/resolv.conf`. `search` is required, and the three
	 * nameserver slots are the whole of what the API can set.
	 */
	async setDns(params: NodesDnsPutParams): Promise<void> {
		await this.client.put<null>(`${this.base}/dns`, params)
	}

	/** `/etc/hosts` as one string, with its digest. */
	async getHosts(): Promise<NodeHostsFile> {
		return this.client.get<NodeHostsFile>(`${this.base}/hosts`)
	}

	/**
	 * Replace `/etc/hosts` wholesale. There is no per-entry call: read the
	 * file with `getHosts`, edit the text, and send all of it back. Pass the
	 * `digest` from the read so a concurrent change is caught rather than
	 * overwritten.
	 */
	async setHosts(data: string, options: { digest?: string | undefined } = {}): Promise<void> {
		await this.client.post<null>(`${this.base}/hosts`, { data, ...options })
	}

	/** Node clock and time zone. */
	async getTime(): Promise<NodeTimeSettings> {
		return this.client.get<NodeTimeSettings>(`${this.base}/time`)
	}

	/**
	 * Set the time zone. The clock itself is not settable through the API; it
	 * comes from chrony or systemd-timesyncd.
	 */
	async setTimezone(timezone: string): Promise<void> {
		await this.client.put<null>(`${this.base}/time`, { timezone })
	}

	/**
	 * The node's own diagnostic report: package versions, storage, network,
	 * cluster state and more, as one block of text. Large.
	 */
	async report(): Promise<string> {
		return this.client.get<string>(`${this.base}/report`)
	}

	/**
	 * System log lines. `service` narrows to one unit; `since` and `until` take
	 * dates the node's journalctl understands.
	 */
	async syslog(options?: NodesSyslogGetParams): Promise<PveLogLine[]> {
		return this.client.get<PveLogLine[]>(`${this.base}/syslog`, options)
	}

	/**
	 * Journal entries as raw lines, with cursors for paging. `lastentries`
	 * takes the newest n; `startcursor` and `endcursor` walk from a known
	 * point.
	 */
	async journal(options?: NodesJournalGetParams): Promise<string[]> {
		return this.client.get<string[]>(`${this.base}/journal`, options)
	}

	/** Per-guest network counters read from the tap devices. */
	async netstat(): Promise<Record<string, unknown>[]> {
		return this.client.get<Record<string, unknown>[]>(`${this.base}/netstat`)
	}

	/** What this node's CPU and QEMU support: machine types, CPU models, flags. */
	async capabilities(): Promise<Record<string, unknown>[]> {
		return this.client.get<Record<string, unknown>[]>(`${this.base}/capabilities`)
	}

	/** Subscription status and level. */
	async getSubscription(): Promise<Record<string, unknown>> {
		return this.client.get<Record<string, unknown>>(`${this.base}/subscription`)
	}

	/** Store a subscription key on this node. */
	async setSubscriptionKey(key: string): Promise<void> {
		await this.client.put<null>(`${this.base}/subscription`, { key })
	}

	/** Re-check the stored key against the server. */
	async refreshSubscription(options?: { force?: boolean }): Promise<void> {
		await this.client.post<null>(`${this.base}/subscription`, options)
	}

	/** Remove the subscription key. */
	async deleteSubscription(): Promise<void> {
		await this.client.delete<null>(`${this.base}/subscription`)
	}

	/**
	 * Send a wake-on-LAN packet to this node. The call runs on another node, so
	 * it works while the target is off; the target needs `wakeonlan` set in
	 * its node config. Returns the MAC address the packet went to.
	 */
	async wakeOnLan(): Promise<string> {
		return this.client.post<string>(`${this.base}/wakeonlan`)
	}

	/**
	 * Start guests on this node. By default only those with `onboot` set;
	 * `force` starts the rest as well, and `vms` limits it to a vmid list.
	 * Returns a UPID.
	 */
	async startAll(params?: NodesStartallPostParams): Promise<string> {
		return this.client.post<string>(`${this.base}/startall`, params)
	}

	/**
	 * Stop every guest on this node. `force-stop` defaults to on and kills a
	 * guest still running after `timeout` seconds. Returns a UPID.
	 */
	async stopAll(params?: NodesStopallPostParams): Promise<string> {
		return this.client.post<string>(`${this.base}/stopall`, params)
	}

	/** Suspend every VM on this node. Returns a UPID. */
	async suspendAll(params?: NodesSuspendallPostParams): Promise<string> {
		return this.client.post<string>(`${this.base}/suspendall`, params)
	}

	/**
	 * Move every guest on this node to `target`, the usual way to empty a node
	 * before maintenance. `with-local-disks` copies local volumes too, which
	 * makes it much slower. Returns a UPID.
	 */
	async migrateAll(params: NodesMigrateallPostParams): Promise<string> {
		return this.client.post<string>(`${this.base}/migrateall`, params)
	}

	/**
	 * Run several API calls on this node in one request.
	 *
	 * Each command names an API path below `nodes/{node}/` with a method and
	 * arguments; the node runs them in order, re-checking permissions for
	 * each. A failing command does not stop the rest: its entry carries the
	 * status and message instead of data. Nothing outside the API is
	 * reachable.
	 *
	 * The handler compares the caller against root@pam, so the call needs a
	 * root ticket. Returns one result per command, in the order given.
	 */
	async execute(commands: readonly BatchCommand[]): Promise<BatchResult[]> {
		return this.client.post<BatchResult[]>(`${this.base}/execute`, {
			commands: JSON.stringify(commands),
		})
	}

	/** Raw request against this node, for a path with no wrapper. */
	async request<T>(method: HttpMethod, path: string, params?: PveParams): Promise<T> {
		return this.client.request<T>(method, `${this.base}${path}`, params)
	}
}
