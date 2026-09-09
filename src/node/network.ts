/**
 * Node network interfaces, and the staged edit they go through.
 *
 * PVE never edits `/etc/network/interfaces` in place. `create`, `update` and
 * `deleteInterface` write `/etc/network/interfaces.new` and change nothing on
 * the running node. `apply` runs `ifreload` against the staged file and then
 * promotes it; `revert` deletes it. Between the two, `staged()` reports
 * whether anything is waiting and what the diff looks like.
 *
 * `list` returns the staged file's interfaces once a change is pending, so an
 * interface read back after `create` shows up before it exists on the node.
 * `active` and `exists` come from the running system and stay false for a
 * staged interface.
 *
 * The endpoint has a fixed property set. Hook lines, policy routing, extra
 * static routes, VRFs, tunnels, ethtool settings and per-interface sysctls
 * have no parameter here, and an interface this API rewrites drops them.
 */

import type { PveClient } from '../core/client.ts'
import { toOptionalBoolean, toOptionalNumber, toOptionalString } from '../core/values.ts'
import type { NetworkCreateParams, NetworkUpdateParams } from '../generated/types.ts'
import { getEnvelope } from '../cluster/envelope.ts'

/** Interface types `create` accepts and `list` filters on. */
export type NetworkInterfaceType = NetworkCreateParams['type']

export type NetworkInterfaceFilter =
	| NetworkInterfaceType
	| 'any_bridge'
	| 'any_local_bridge'
	| 'include_sdn'

export interface NetworkInterface {
	iface: string
	type: string
	/** `loopback`, `manual`, `static`, `dhcp` or `auto`. */
	method: string | undefined
	method6: string | undefined
	families: string[]
	/** True when the interface is present on the running node. */
	exists: boolean | undefined
	/** True when the interface is up. */
	active: boolean | undefined
	autostart: boolean | undefined
	address: string | undefined
	netmask: string | undefined
	cidr: string | undefined
	gateway: string | undefined
	address6: string | undefined
	cidr6: string | undefined
	gateway6: string | undefined
	bridgePorts: string | undefined
	bridgeVlanAware: boolean | undefined
	bondMode: string | undefined
	slaves: string | undefined
	vlanId: number | undefined
	vlanRawDevice: string | undefined
	mtu: number | undefined
	comments: string | undefined
	/** Kernel-assigned alternative names, such as the udev-stable name. */
	altnames: string[]
	/** Order the interfaces are brought up in. */
	priority: number | undefined
	raw: Readonly<Record<string, unknown>>
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String) : []
}

function normalizeInterface(raw: Record<string, unknown>): NetworkInterface {
	return {
		iface: String(raw['iface'] ?? ''),
		type: String(raw['type'] ?? ''),
		method: toOptionalString(raw['method']),
		method6: toOptionalString(raw['method6']),
		families: stringList(raw['families']),
		exists: toOptionalBoolean(raw['exists']),
		active: toOptionalBoolean(raw['active']),
		autostart: toOptionalBoolean(raw['autostart']),
		address: toOptionalString(raw['address']),
		netmask: toOptionalString(raw['netmask']),
		cidr: toOptionalString(raw['cidr']),
		gateway: toOptionalString(raw['gateway']),
		address6: toOptionalString(raw['address6']),
		cidr6: toOptionalString(raw['cidr6']),
		gateway6: toOptionalString(raw['gateway6']),
		bridgePorts: toOptionalString(raw['bridge_ports']),
		bridgeVlanAware: toOptionalBoolean(raw['bridge_vlan_aware']),
		bondMode: toOptionalString(raw['bond_mode']),
		slaves: toOptionalString(raw['slaves']),
		vlanId: toOptionalNumber(raw['vlan-id']),
		vlanRawDevice: toOptionalString(raw['vlan-raw-device']),
		mtu: toOptionalNumber(raw['mtu']),
		comments: toOptionalString(raw['comments']),
		altnames: stringList(raw['altnames']),
		priority: toOptionalNumber(raw['priority']),
		raw,
	}
}

export interface StagedNetworkChanges {
	/** True when `/etc/network/interfaces.new` exists on the node. */
	changed: boolean
	/** Unified diff of the staged file against the running one, when staged. */
	diff: string | undefined
}

export class NodeNetworkApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/network`
	}

	/**
	 * Interfaces on the node, or the staged file's interfaces when an edit is
	 * pending. `type` narrows the list; `any_bridge` covers Linux and OVS
	 * bridges.
	 */
	async list(options: { type?: NetworkInterfaceFilter } = {}): Promise<NetworkInterface[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(this.base, options)
		return rows.map(normalizeInterface)
	}

	async get(iface: string): Promise<NetworkInterface> {
		return normalizeInterface(
			await this.client.get<Record<string, unknown>>(`${this.base}/${encodeURIComponent(iface)}`),
		)
	}

	/**
	 * Whether an edit is staged, and its diff. The node reports the diff as a
	 * `changes` key beside `data` in the response envelope.
	 */
	async staged(): Promise<StagedNetworkChanges> {
		const { attribs } = await getEnvelope<Record<string, unknown>[]>(this.client, this.base)
		const diff = attribs['changes']
		if (typeof diff === 'string' && diff !== '') return { changed: true, diff }
		return { changed: false, diff: undefined }
	}

	/**
	 * Stage a new interface. `type` decides which fields apply: a `bridge`
	 * takes `bridge_ports` and `bridge_vlan_aware`, a `bond` takes `slaves` and
	 * `bond_mode`, a `vlan` takes `vlan-id` and `vlan-raw-device`, and the OVS
	 * types take the `ovs_*` fields. Nothing changes on the node until `apply`.
	 */
	async create(params: NetworkCreateParams): Promise<void> {
		await this.client.post<null>(this.base, params)
	}

	/**
	 * Stage a change to an existing interface. `type` has to match the
	 * interface. `delete` takes a comma-separated list of keys to unset.
	 * Nothing changes on the node until `apply`.
	 */
	async update(iface: string, params: NetworkUpdateParams): Promise<void> {
		await this.client.put<null>(`${this.base}/${encodeURIComponent(iface)}`, params)
	}

	/** Stage the removal of an interface. Nothing changes on the node until `apply`. */
	async deleteInterface(iface: string): Promise<void> {
		await this.client.delete<null>(`${this.base}/${encodeURIComponent(iface)}`)
	}

	/**
	 * Apply the staged file with `ifreload -a`. This is the call that touches
	 * the running network, and a mistake in the staged config can cut the
	 * node's own management link, so read `staged().diff` first.
	 *
	 * `regenerateFrr: false` keeps the FRR config as it is. Returns a UPID.
	 */
	async apply(options?: { regenerateFrr?: boolean }): Promise<string> {
		const params =
			options?.regenerateFrr === undefined ? undefined : { 'regenerate-frr': options.regenerateFrr }
		return this.client.put<string>(this.base, params)
	}

	/** Delete the staged file. The running configuration was never touched. */
	async revert(): Promise<void> {
		await this.client.delete<null>(this.base)
	}
}
