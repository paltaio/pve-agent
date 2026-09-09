/**
 * Cluster-wide calls: status, resources, tasks, log, options and the next
 * free vmid, plus a sub-object per area: HA, backup jobs, replication, bulk
 * actions, the datacenter firewall, mappings, metrics, notifications, other
 * jobs, corosync membership, storage definitions and pools.
 *
 * Every endpoint here answers on any node, so one `ClusterApi` covers the
 * whole cluster.
 */

import type { PveClient } from '../core/client.ts'
import { PveError } from '../core/errors.ts'
import { normalizeTaskListEntry, type TaskListEntry } from '../core/tasks.ts'
import {
	parseTagList,
	toBoolean,
	toOptionalBoolean,
	toOptionalNumber,
	toOptionalString,
} from '../core/values.ts'
import type { ClusterOptionsPutParams, ClusterResourcesGetParams } from '../generated/types.ts'
import { ClusterBackupApi } from './backup.ts'
import { ClusterBulkApi } from './bulk.ts'
import { ClusterFirewallApi } from './firewall.ts'
import { ClusterHaApi } from './ha.ts'
import { ClusterJobsApi } from './jobs.ts'
import { ClusterMappingApi } from './mapping.ts'
import { ClusterMembershipApi } from './membership.ts'
import { ClusterMetricsApi } from './metrics.ts'
import { ClusterNotificationsApi } from './notifications.ts'
import { PoolsApi } from './pools.ts'
import { ClusterReplicationApi } from './replication.ts'
import { StorageConfigApi } from './storage.ts'

/** A row of `/cluster/status`: one `cluster` entry, then one per node. */
export interface ClusterStatusEntry {
	id: string
	type: 'cluster' | 'node'
	name: string
	/** Cluster rows only. Number of members. */
	nodes: number | undefined
	/** Cluster rows only. False means writes to /etc/pve are blocked. */
	quorate: boolean | undefined
	/** Cluster rows only. Config version. */
	version: number | undefined
	/** Node rows only. Corosync node id. */
	nodeid: number | undefined
	ip: string | undefined
	/** Node rows only. True for the node that answered the call. */
	local: boolean | undefined
	online: boolean | undefined
	level: string | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeStatusEntry(raw: Record<string, unknown>): ClusterStatusEntry {
	return {
		id: String(raw['id'] ?? ''),
		type: raw['type'] === 'cluster' ? 'cluster' : 'node',
		name: String(raw['name'] ?? ''),
		nodes: toOptionalNumber(raw['nodes']),
		quorate: toOptionalBoolean(raw['quorate']),
		version: toOptionalNumber(raw['version']),
		nodeid: toOptionalNumber(raw['nodeid']),
		ip: toOptionalString(raw['ip']),
		local: toOptionalBoolean(raw['local']),
		online: toOptionalBoolean(raw['online']),
		level: toOptionalString(raw['level']),
		raw,
	}
}

/** A row of `/cluster/resources`. */
export interface ClusterResource {
	id: string
	/** `node`, `storage`, `qemu`, `lxc`, `pool` or `sdn`. */
	type: string
	node: string | undefined
	vmid: number | undefined
	name: string | undefined
	status: string | undefined
	storage: string | undefined
	pool: string | undefined
	/** Guest rows only. */
	template: boolean
	tags: string[]
	maxcpu: number | undefined
	maxmem: number | undefined
	maxdisk: number | undefined
	cpu: number | undefined
	mem: number | undefined
	disk: number | undefined
	uptime: number | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeResource(raw: Record<string, unknown>): ClusterResource {
	return {
		id: String(raw['id'] ?? ''),
		type: String(raw['type'] ?? ''),
		node: toOptionalString(raw['node']),
		vmid: toOptionalNumber(raw['vmid']),
		name: toOptionalString(raw['name']),
		status: toOptionalString(raw['status']),
		storage: toOptionalString(raw['storage']),
		pool: toOptionalString(raw['pool']),
		template: toBoolean(raw['template']),
		tags: parseTagList(raw['tags']),
		maxcpu: toOptionalNumber(raw['maxcpu']),
		maxmem: toOptionalNumber(raw['maxmem']),
		maxdisk: toOptionalNumber(raw['maxdisk']),
		cpu: toOptionalNumber(raw['cpu']),
		mem: toOptionalNumber(raw['mem']),
		disk: toOptionalNumber(raw['disk']),
		uptime: toOptionalNumber(raw['uptime']),
		raw,
	}
}

/** Where a guest lives, from one `/cluster/resources` read. */
export interface GuestLocation {
	vmid: number
	type: 'qemu' | 'lxc'
	node: string
}

/** A row of the cluster log. */
export interface ClusterLogEntry extends Record<string, unknown> {
	uid: number
	time: number
	node: string
	pid: number
	tag: string
	pri: number
	user: string
	id?: string
	msg: string
}

/**
 * The lowest free vmid at or above 100, or a check that `vmid` itself is
 * free. Throws PveApiError when the vmid is taken.
 *
 * The schema declares the answer an integer and the handler sends a JSON
 * string, so it is read as either and returned as a number.
 */
export async function nextVmid(client: PveClient, vmid?: number): Promise<number> {
	const answer = await client.get<string | number>(
		'/cluster/nextid',
		vmid === undefined ? undefined : { vmid },
	)
	const parsed = toOptionalNumber(answer)
	if (parsed === undefined) {
		throw new PveError('api', `/cluster/nextid answered '${String(answer)}', which is not a vmid`)
	}
	return parsed
}

export class ClusterApi {
	readonly client: PveClient
	readonly ha: ClusterHaApi
	readonly backup: ClusterBackupApi
	readonly replication: ClusterReplicationApi
	readonly bulk: ClusterBulkApi
	readonly firewall: ClusterFirewallApi
	readonly mapping: ClusterMappingApi
	readonly metrics: ClusterMetricsApi
	readonly notifications: ClusterNotificationsApi
	readonly jobs: ClusterJobsApi
	readonly membership: ClusterMembershipApi
	/** Storage definitions in `storage.cfg`, not the data on them. */
	readonly storage: StorageConfigApi
	readonly pools: PoolsApi

	constructor(client: PveClient) {
		this.client = client
		this.ha = new ClusterHaApi(client)
		this.backup = new ClusterBackupApi(client)
		this.replication = new ClusterReplicationApi(client)
		this.bulk = new ClusterBulkApi(client)
		this.firewall = new ClusterFirewallApi(client)
		this.mapping = new ClusterMappingApi(client)
		this.metrics = new ClusterMetricsApi(client)
		this.notifications = new ClusterNotificationsApi(client)
		this.jobs = new ClusterJobsApi(client)
		this.membership = new ClusterMembershipApi(client)
		this.storage = new StorageConfigApi(client)
		this.pools = new PoolsApi(client)
	}

	/**
	 * Quorum state plus one row per node with its corosync id and address.
	 * `quorate: false` on the cluster row means writes to `/etc/pve` are
	 * blocked. Token tier.
	 */
	async status(): Promise<ClusterStatusEntry[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/status')
		return rows.map(normalizeStatusEntry)
	}

	/**
	 * Every guest, node, storage and pool in one call, each with the node it
	 * lives on. The answer comes from the status cache pvestatd refreshes every
	 * few seconds, so a guest changed a moment ago can still show its previous
	 * state. Token tier.
	 */
	async resources(options: ClusterResourcesGetParams = {}): Promise<ClusterResource[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/resources', options)
		return rows.map(normalizeResource)
	}

	/**
	 * Every guest in the cluster keyed by vmid, with its type and node. One
	 * GET; the cheapest way to find which node holds a vmid. A guest the
	 * caller may not audit is absent. Token tier.
	 */
	async guestNodes(): Promise<Map<number, GuestLocation>> {
		const guests = new Map<number, GuestLocation>()
		for (const row of await this.resources({ type: 'vm' })) {
			if (row.type !== 'qemu' && row.type !== 'lxc') continue
			if (row.vmid === undefined || row.node === undefined) continue
			guests.set(row.vmid, { vmid: row.vmid, type: row.type, node: row.node })
		}
		return guests
	}

	/** Recent tasks from every node, newest first. Token tier. */
	async tasks(): Promise<TaskListEntry[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/tasks')
		return rows.map(normalizeTaskListEntry)
	}

	/** Cluster log, newest first. `max` caps the number of lines. Token tier. */
	async log(options: { max?: number } = {}): Promise<ClusterLogEntry[]> {
		return this.client.get<ClusterLogEntry[]>('/cluster/log', options)
	}

	/**
	 * The lowest free vmid. Pass one to assert it is free instead: the call
	 * fails when it is taken. The answer is only true at the moment of the
	 * call, so create the guest right after. Token tier.
	 */
	async nextId(vmid?: number): Promise<number> {
		return nextVmid(this.client, vmid)
	}

	/**
	 * Datacenter options: migration network and type, keyboard, MAC prefix,
	 * HA and CRS settings, notification defaults. Flags keep the node's own 0
	 * and 1 spelling. Without `Sys.Audit` on `/` the answer is partial. Token
	 * tier.
	 */
	async getOptions(): Promise<Record<string, unknown>> {
		return this.client.get<Record<string, unknown>>('/cluster/options')
	}

	/**
	 * Change datacenter options. Several fields are property strings, such as
	 * `migration: 'type=secure,network=10.10.12.0/24'`; build them with
	 * `formatConfigValue('PUT', '/cluster/options', 'migration', bag)`.
	 * `delete` unsets keys. Returns nothing.
	 */
	async setOptions(params: ClusterOptionsPutParams): Promise<void> {
		await this.client.put<null>('/cluster/options', params)
	}
}
