/**
 * Discovery for storage backends, run from one node.
 *
 * Each call asks the node what a remote server or the local system offers,
 * so a storage definition can be built from real values. They read only;
 * nothing is configured until a storage is created under `/storage`.
 */

import type { PveClient } from '../core/client.ts'
import type { NodesScanCifsGetParams, NodesScanPbsGetParams } from '../generated/types.ts'

export interface NfsExport extends Record<string, unknown> {
	path: string
	options: string
}

export interface CifsShare extends Record<string, unknown> {
	share: string
	description?: string
}

export interface IscsiTarget extends Record<string, unknown> {
	target: string
	portal: string
}

export interface ScannedVolumeGroup extends Record<string, unknown> {
	vg: string
	size: number
	free: number
}

export interface ScannedThinPool extends Record<string, unknown> {
	lv: string
	lv_size: number
	used: number
}

export interface ScannedZfsPool extends Record<string, unknown> {
	pool: string
}

export interface PbsDatastore extends Record<string, unknown> {
	store: string
	comment?: string
}

export class NodeScanApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/scan`
	}

	/** Exports an NFS server offers this node. */
	async nfs(server: string): Promise<NfsExport[]> {
		return this.client.get<NfsExport[]>(`${this.base}/nfs`, { server })
	}

	/** Shares a CIFS server offers. Without credentials only the guest-visible ones. */
	async cifs(params: NodesScanCifsGetParams): Promise<CifsShare[]> {
		return this.client.get<CifsShare[]>(`${this.base}/cifs`, params)
	}

	/** Targets an iSCSI portal advertises. */
	async iscsi(portal: string): Promise<IscsiTarget[]> {
		return this.client.get<IscsiTarget[]>(`${this.base}/iscsi`, { portal })
	}

	/** LVM volume groups on this node, including ones PVE does not manage. */
	async lvm(): Promise<ScannedVolumeGroup[]> {
		return this.client.get<ScannedVolumeGroup[]>(`${this.base}/lvm`)
	}

	/** Thin pools inside one volume group. */
	async lvmThin(vg: string): Promise<ScannedThinPool[]> {
		return this.client.get<ScannedThinPool[]>(`${this.base}/lvmthin`, { vg })
	}

	/**
	 * ZFS pools imported on this node, names only, in the shape a `zfspool`
	 * storage definition wants. `NodeDisksApi.listZfs` adds capacity and health.
	 */
	async zfs(): Promise<ScannedZfsPool[]> {
		return this.client.get<ScannedZfsPool[]>(`${this.base}/zfs`)
	}

	/**
	 * Datastores on a Proxmox Backup Server. `fingerprint` is needed when the
	 * server uses a self-signed certificate.
	 */
	async pbs(params: NodesScanPbsGetParams): Promise<PbsDatastore[]> {
		return this.client.get<PbsDatastore[]>(`${this.base}/pbs`, params)
	}
}
