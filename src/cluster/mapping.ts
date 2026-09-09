/**
 * Hardware and directory mappings.
 *
 * A mapping gives one cluster-wide id to a device that has a different address
 * on each node, so a guest can reference `mapping=gpu0` and stay migratable.
 * A guest config that names a raw `host=` address instead needs a root@pam
 * ticket; a `mapping=` entry does not.
 *
 * `map` is an array of property strings, one per node, such as
 * `node=ms01-0160,path=0000:01:00.0,id=10de:2482`.
 */

import type { PveClient } from '../core/client.ts'
import type {
	ClusterMappingDirPostParams,
	ClusterMappingDirPutParams,
	ClusterMappingPciPostParams,
	ClusterMappingPciPutParams,
	ClusterMappingUsbPostParams,
	ClusterMappingUsbPutParams,
} from '../generated/types.ts'

export interface HardwareMapping extends Record<string, unknown> {
	id: string
	description?: string
	map?: string[]
	/** Per-node problems, present when `check-node` was passed to the list call. */
	checks?: Record<string, unknown>[]
	error?: Record<string, unknown>
}

export type MappingKind = 'pci' | 'usb' | 'dir'

/** CRUD over one mapping kind: `pci`, `usb` or `dir`. */
export class MappingKindApi<TCreate extends object, TUpdate extends object> {
	readonly client: PveClient
	readonly kind: MappingKind

	constructor(client: PveClient, kind: MappingKind) {
		this.client = client
		this.kind = kind
	}

	/**
	 * Mappings of this kind. `check-node` asks the API to verify each mapping
	 * against that node's real hardware and report mismatches in `checks`.
	 * Token tier.
	 */
	async list(options: { 'check-node'?: string } = {}): Promise<HardwareMapping[]> {
		return this.client.get<HardwareMapping[]>(`/cluster/mapping/${this.kind}`, options)
	}

	async get(id: string): Promise<HardwareMapping> {
		return this.client.get<HardwareMapping>(
			`/cluster/mapping/${this.kind}/${encodeURIComponent(id)}`,
		)
	}

	/** Create a mapping. Returns nothing. */
	async create(params: TCreate): Promise<void> {
		await this.client.post<null>(`/cluster/mapping/${this.kind}`, params)
	}

	/**
	 * Replace a mapping's fields. `map` is replaced wholesale, so send every
	 * node entry the mapping should keep. Returns nothing.
	 */
	async update(id: string, params: TUpdate): Promise<void> {
		await this.client.put<null>(`/cluster/mapping/${this.kind}/${encodeURIComponent(id)}`, params)
	}

	/** Delete a mapping. Guests still referencing it fail to start. */
	async delete(id: string): Promise<void> {
		await this.client.delete<null>(`/cluster/mapping/${this.kind}/${encodeURIComponent(id)}`)
	}
}

export class ClusterMappingApi {
	/** PCI device mappings, used by `hostpci[n]` with `mapping=`. */
	readonly pci: MappingKindApi<ClusterMappingPciPostParams, ClusterMappingPciPutParams>
	/** USB device mappings, used by `usb[n]` with `mapping=`. */
	readonly usb: MappingKindApi<ClusterMappingUsbPostParams, ClusterMappingUsbPutParams>
	/** Host directory mappings, used by container mount points. */
	readonly dir: MappingKindApi<ClusterMappingDirPostParams, ClusterMappingDirPutParams>

	constructor(client: PveClient) {
		this.pci = new MappingKindApi(client, 'pci')
		this.usb = new MappingKindApi(client, 'usb')
		this.dir = new MappingKindApi(client, 'dir')
	}
}
