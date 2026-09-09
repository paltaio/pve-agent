/**
 * Local disks, and the storage backends PVE can build on them.
 *
 * Everything here except the reads is destructive and runs as a worker task,
 * so the return value is a UPID.
 *
 * For ZFS the API covers create and destroy. There is no endpoint for scrub,
 * import, export, add, attach, detach, replace, trim, upgrade, property set,
 * dataset create or native encryption; an existing pool can be listed, read
 * and removed, nothing else.
 */

import type { PveClient } from '../core/client.ts'
import { toBoolean, toOptionalBoolean, toOptionalNumber, toOptionalString } from '../core/values.ts'
import type {
	NodesDisksDirectoryDeleteParams,
	NodesDisksDirectoryPostParams,
	NodesDisksListGetParams,
	NodesDisksLvmDeleteParams,
	NodesDisksLvmPostParams,
	NodesDisksLvmthinDeleteParams,
	NodesDisksLvmthinPostParams,
	NodesDisksZfsDeleteParams,
	ZfsCreateParams,
} from '../generated/types.ts'

export type DiskType = 'ssd' | 'hdd' | 'nvme' | 'usb'

export interface DiskEntry {
	devpath: string
	size: number
	/** `unknown`, `unused`, `partitions`, `LVM`, `ZFS`, `mounted`, or a storage id. */
	used: string | undefined
	model: string | undefined
	serial: string | undefined
	vendor: string | undefined
	type: DiskType | undefined
	health: string | undefined
	/** Percent of write endurance left. Absent on a disk that does not report it. */
	wearout: number | undefined
	rpm: number | undefined
	/** True when the disk carries a GPT label. */
	gpt: boolean | undefined
	mounted: boolean | undefined
	/** Parent device of a partition, when `include-partitions` was set. */
	parent: string | undefined
	osdid: number | undefined
	wwn: string | undefined
	byIdLink: string | undefined
	raw: Readonly<Record<string, unknown>>
}

function diskType(value: unknown): DiskType | undefined {
	return value === 'ssd' || value === 'hdd' || value === 'nvme' || value === 'usb'
		? value
		: undefined
}

function normalizeDisk(raw: Record<string, unknown>): DiskEntry {
	return {
		devpath: String(raw['devpath'] ?? ''),
		size: toOptionalNumber(raw['size']) ?? 0,
		used: toOptionalString(raw['used']),
		model: toOptionalString(raw['model']),
		serial: toOptionalString(raw['serial']),
		vendor: toOptionalString(raw['vendor']),
		type: diskType(raw['type']),
		health: toOptionalString(raw['health']),
		wearout: toOptionalNumber(raw['wearout']),
		rpm: toOptionalNumber(raw['rpm']),
		gpt: toOptionalBoolean(raw['gpt']),
		mounted: toOptionalBoolean(raw['mounted']),
		parent: toOptionalString(raw['parent']),
		osdid: toOptionalNumber(raw['osdid']),
		wwn: toOptionalString(raw['wwn']),
		byIdLink: toOptionalString(raw['by_id_link']),
		raw,
	}
}

export interface SmartAttribute extends Record<string, unknown> {
	id?: number
	name?: string
	value?: string
	worst?: string
	threshold?: string
	raw?: string
	flags?: string
	fail?: string
}

/** SMART data as smartctl reports it: attributes for ATA, text for NVMe and SAS. */
export interface SmartHealth extends Record<string, unknown> {
	health: string
	type?: 'ata' | 'text'
	attributes?: SmartAttribute[]
	text?: string
	wearout?: number
}

export interface ZpoolSummary extends Record<string, unknown> {
	name: string
	health: string
	size: number
	alloc: number
	free: number
	frag: number
	dedup: number
}

/** A vdev tree node. Leaves are devices; the rest are mirrors, raidz and the pool. */
export interface ZpoolVdev {
	name: string
	state: string | undefined
	/** True for a device, false for a mirror, a raidz or the pool itself. */
	leaf: boolean
	read: number | undefined
	write: number | undefined
	cksum: number | undefined
	msg: string | undefined
	children: ZpoolVdev[]
	raw: Readonly<Record<string, unknown>>
}

export interface ZpoolDetail extends ZpoolVdev {
	errors: string | undefined
	/** The last scrub or resilver line from `zpool status`. */
	scan: string | undefined
	status: string | undefined
	action: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeVdev(raw: Record<string, unknown>): ZpoolVdev {
	const children = raw['children']
	return {
		name: String(raw['name'] ?? ''),
		state: toOptionalString(raw['state']),
		leaf: toBoolean(raw['leaf']),
		read: toOptionalNumber(raw['read']),
		write: toOptionalNumber(raw['write']),
		cksum: toOptionalNumber(raw['cksum']),
		msg: toOptionalString(raw['msg']),
		children: Array.isArray(children) ? children.filter(isRecord).map(normalizeVdev) : [],
		raw,
	}
}

function normalizeZpool(raw: Record<string, unknown>): ZpoolDetail {
	return {
		...normalizeVdev(raw),
		errors: toOptionalString(raw['errors']),
		scan: toOptionalString(raw['scan']),
		status: toOptionalString(raw['status']),
		action: toOptionalString(raw['action']),
	}
}

export interface LvmVolumeGroup extends Record<string, unknown> {
	name: string
	size: number
	free: number
	leaf?: number
	children?: Record<string, unknown>[]
}

export interface LvmThinPool extends Record<string, unknown> {
	lv: string
	vg: string
	lv_size: number
	used: number
	metadata_size: number
	metadata_used: number
}

export interface DirectoryStorage extends Record<string, unknown> {
	device: string
	path: string
	type: string
	unitfile: string
	options?: string
}

export class NodeDisksApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/disks`
	}

	/**
	 * Physical disks with size, model and what is using each one. `type:
	 * 'unused'` returns only the disks free to build on, which is the set the
	 * create calls accept. `skipsmart` makes the call much faster on a node
	 * with many disks.
	 */
	async list(options?: NodesDisksListGetParams): Promise<DiskEntry[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(`${this.base}/list`, options)
		return rows.map(normalizeDisk)
	}

	/**
	 * SMART data for one disk, by device path such as `/dev/nvme0n1`.
	 * `healthonly` returns just the overall verdict.
	 */
	async smart(disk: string, options: { healthonly?: boolean } = {}): Promise<SmartHealth> {
		return this.client.get<SmartHealth>(`${this.base}/smart`, { disk, ...options })
	}

	/** Write a fresh GPT label to a disk, erasing its partition table. Returns a UPID. */
	async initGpt(disk: string, options: { uuid?: string } = {}): Promise<string> {
		return this.client.post<string>(`${this.base}/initgpt`, { disk, ...options })
	}

	/**
	 * Wipe a disk or partition. Destroys everything on it. The handler
	 * compares the caller against root@pam, so the call needs a root ticket.
	 * Returns a UPID.
	 */
	async wipe(disk: string): Promise<string> {
		return this.client.put<string>(`${this.base}/wipedisk`, { disk })
	}

	/** ZFS pools imported on this node, with capacity and health. */
	async listZfs(): Promise<ZpoolSummary[]> {
		return this.client.get<ZpoolSummary[]>(`${this.base}/zfs`)
	}

	/** One pool's vdev tree with per-device error counters and the last scrub line. */
	async getZfs(name: string): Promise<ZpoolDetail> {
		return normalizeZpool(
			await this.client.get<Record<string, unknown>>(
				`${this.base}/zfs/${encodeURIComponent(name)}`,
			),
		)
	}

	/**
	 * Create a ZFS pool from unused disks. `devices` is a comma-separated list
	 * of device paths, `raidlevel` picks the vdev layout, `ashift` defaults to
	 * 12, and `add_storage` also writes a `zfspool` entry into `storage.cfg`.
	 *
	 * This is the only pool layout the API can build: one vdev group of the
	 * chosen level, with no encryption, no log or cache device and no custom
	 * properties. Returns a UPID.
	 */
	async createZfs(params: ZfsCreateParams): Promise<string> {
		return this.client.post<string>(`${this.base}/zfs`, params)
	}

	/**
	 * Destroy a ZFS pool and everything on it. `cleanup-config` also removes
	 * the storage entry, `cleanup-disks` wipes the member disks. Returns a UPID.
	 */
	async deleteZfs(name: string, options?: NodesDisksZfsDeleteParams): Promise<string> {
		return this.client.delete<string>(`${this.base}/zfs/${encodeURIComponent(name)}`, options)
	}

	/** LVM volume groups on this node, as one tree rooted at the node. */
	async listLvm(): Promise<LvmVolumeGroup> {
		return this.client.get<LvmVolumeGroup>(`${this.base}/lvm`)
	}

	/** Create an LVM volume group on one unused disk. Returns a UPID. */
	async createLvm(params: NodesDisksLvmPostParams): Promise<string> {
		return this.client.post<string>(`${this.base}/lvm`, params)
	}

	/** Remove an LVM volume group. Returns a UPID. */
	async deleteLvm(name: string, options?: NodesDisksLvmDeleteParams): Promise<string> {
		return this.client.delete<string>(`${this.base}/lvm/${encodeURIComponent(name)}`, options)
	}

	/** LVM thin pools on this node. */
	async listLvmThin(): Promise<LvmThinPool[]> {
		return this.client.get<LvmThinPool[]>(`${this.base}/lvmthin`)
	}

	/** Create an LVM thin pool on one unused disk. Returns a UPID. */
	async createLvmThin(params: NodesDisksLvmthinPostParams): Promise<string> {
		return this.client.post<string>(`${this.base}/lvmthin`, params)
	}

	/** Remove an LVM thin pool. `volume-group` names the group it lives in. Returns a UPID. */
	async deleteLvmThin(name: string, options: NodesDisksLvmthinDeleteParams): Promise<string> {
		return this.client.delete<string>(`${this.base}/lvmthin/${encodeURIComponent(name)}`, options)
	}

	/** Directory storages PVE created and mounts through a systemd unit. */
	async listDirectories(): Promise<DirectoryStorage[]> {
		return this.client.get<DirectoryStorage[]>(`${this.base}/directory`)
	}

	/**
	 * Put a filesystem on an unused disk and mount it at `/mnt/pve/<name>`
	 * through a generated systemd mount unit. Returns a UPID.
	 */
	async createDirectory(params: NodesDisksDirectoryPostParams): Promise<string> {
		return this.client.post<string>(`${this.base}/directory`, params)
	}

	/** Unmount a managed directory and remove its mount unit. Returns a UPID. */
	async deleteDirectory(name: string, options?: NodesDisksDirectoryDeleteParams): Promise<string> {
		return this.client.delete<string>(`${this.base}/directory/${encodeURIComponent(name)}`, options)
	}
}
