/**
 * Corosync cluster membership, read side.
 *
 * Creating a cluster, joining one and editing the node list are registered
 * with no permissions block, so their handlers accept only a root@pam ticket.
 * Those calls go through `PveClient` directly.
 */

import type { PveClient } from '../core/client.ts'

export interface CorosyncNode extends Record<string, unknown> {
	node: string
	name: string
	nodeid: string
	quorum_votes: string
	ring0_addr?: string
	ring1_addr?: string
}

export interface CorosyncTotem extends Record<string, unknown> {
	cluster_name?: string
	config_version?: string
	ip_version?: string
	link_mode?: string
	secauth?: string
	version?: string
	interface?: Record<string, Record<string, string>>
}

/** What a joining node needs: the address list, the fingerprints and the config. */
export interface ClusterJoinInfo extends Record<string, unknown> {
	config_digest: string
	nodelist: {
		name: string
		nodeid: string
		quorum_votes: string
		pve_addr: string
		/** TLS fingerprint of that node, which a join sends back as `fingerprint`. */
		pve_fp: string
		ring0_addr?: string
		ring1_addr?: string
	}[]
	preferred_node: string
	totem: CorosyncTotem
}

export class ClusterMembershipApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/** Corosync node list with each node's ring addresses. Token tier. */
	async nodes(): Promise<CorosyncNode[]> {
		return this.client.get<CorosyncNode[]>('/cluster/config/nodes')
	}

	/** Corosync totem settings, including the configured links. Token tier. */
	async totem(): Promise<CorosyncTotem> {
		return this.client.get<CorosyncTotem>('/cluster/config/totem')
	}

	/**
	 * QDevice status. An empty object means no external quorum device is
	 * configured. Token tier.
	 */
	async qdevice(): Promise<Record<string, unknown>> {
		return this.client.get<Record<string, unknown>>('/cluster/config/qdevice')
	}

	/** Version of the join API this node speaks. Token tier. */
	async apiVersion(): Promise<number> {
		return this.client.get<number>('/cluster/config/apiversion')
	}

	/**
	 * The information a node needs to join this cluster: addresses,
	 * fingerprints and the totem config. `node` picks which member's address
	 * is preferred. Token tier.
	 */
	async joinInfo(options: { node?: string } = {}): Promise<ClusterJoinInfo> {
		return this.client.get<ClusterJoinInfo>('/cluster/config/join', options)
	}
}
