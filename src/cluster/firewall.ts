/**
 * Firewall rules, options, security groups, aliases and IPSets at the
 * datacenter level.
 *
 * The rule endpoints have the same shape at every level of the tree, so
 * `FirewallRulesApi` is built from the path of one rule collection and serves
 * the cluster chain, a security group, a node and a guest alike. The row and
 * parameter shapes are declared here once for every level.
 *
 * Rules are addressed by position. A position shifts when a rule above it is
 * inserted or removed, so read the list again after a change rather than
 * caching an index. `PUT` with `moveto` reorders.
 */

import type { PveClient } from '../core/client.ts'
import { toBoolean, toOptionalNumber, toOptionalString } from '../core/values.ts'
import type {
	ClusterFirewallAliasesPostParams,
	ClusterFirewallAliasesPutParams,
	ClusterFirewallGroupsPostParams,
	ClusterFirewallIpsetPostByNameParams,
	ClusterFirewallIpsetPostParams,
	ClusterFirewallIpsetPutParams,
	ClusterFirewallOptionsPutParams,
	ClusterFirewallRefsGetParams,
	ClusterFirewallRulesPostParams,
	ClusterFirewallRulesPutParams,
} from '../generated/types.ts'

/** One rule of a chain. */
export interface FirewallRule {
	/** Position in the chain. It shifts when a rule above it moves. */
	pos: number
	/** `in`, `out`, `forward` or `group`. */
	type: string
	action: string
	/** A rule written without `enable` is stored disabled. */
	enable: boolean
	comment: string | undefined
	macro: string | undefined
	iface: string | undefined
	proto: string | undefined
	source: string | undefined
	dest: string | undefined
	sport: string | undefined
	dport: string | undefined
	log: string | undefined
	/** Every key the node returned, including the ones not modelled here. */
	raw: Readonly<Record<string, unknown>>
}

export function normalizeFirewallRule(raw: Record<string, unknown>): FirewallRule {
	return {
		pos: toOptionalNumber(raw['pos']) ?? 0,
		type: String(raw['type'] ?? ''),
		action: String(raw['action'] ?? ''),
		enable: toBoolean(raw['enable']),
		comment: toOptionalString(raw['comment']),
		macro: toOptionalString(raw['macro']),
		iface: toOptionalString(raw['iface']),
		proto: toOptionalString(raw['proto']),
		source: toOptionalString(raw['source']),
		dest: toOptionalString(raw['dest']),
		sport: toOptionalString(raw['sport']),
		dport: toOptionalString(raw['dport']),
		log: toOptionalString(raw['log']),
		raw,
	}
}

export type FirewallRuleCreateParams = ClusterFirewallRulesPostParams
export type FirewallRuleUpdateParams = ClusterFirewallRulesPutParams
export type FirewallOptionsParams = ClusterFirewallOptionsPutParams

export type FirewallPolicy = 'ACCEPT' | 'REJECT' | 'DROP'

/**
 * Firewall options as the API stores them, at any level of the tree. Flags
 * keep the node's own 0 and 1 spelling. The datacenter level carries the
 * `policy_*` defaults and `ebtables`; a node adds the conntrack and log
 * settings; a guest adds `dhcp`, `ipfilter`, `macfilter`, `ndp` and `radv`.
 */
export interface FirewallOptions extends Record<string, unknown> {
	enable?: number
	policy_in?: FirewallPolicy
	policy_out?: FirewallPolicy
	policy_forward?: FirewallPolicy
	log_ratelimit?: string
	ebtables?: number
	digest?: string
}

export interface FirewallAlias extends Record<string, unknown> {
	name: string
	cidr: string
	comment?: string
	digest?: string
	ipversion?: number
}

export interface FirewallSecurityGroup extends Record<string, unknown> {
	group: string
	comment?: string
	digest?: string
}

/** One IPSet. The collection endpoints name it `name`, not `group`. */
export interface FirewallIpset extends Record<string, unknown> {
	name: string
	comment?: string
	digest?: string
}

export interface FirewallIpsetEntry {
	cidr: string
	comment: string | undefined
	/** The entry excludes its range from the set instead of adding it. */
	nomatch: boolean
	digest: string | undefined
	raw: Readonly<Record<string, unknown>>
}

export function normalizeFirewallIpsetEntry(raw: Record<string, unknown>): FirewallIpsetEntry {
	return {
		cidr: String(raw['cidr'] ?? ''),
		comment: toOptionalString(raw['comment']),
		nomatch: toBoolean(raw['nomatch']),
		digest: toOptionalString(raw['digest']),
		raw,
	}
}

export interface FirewallMacro {
	macro: string
	descr: string
}

export interface FirewallRef {
	type: 'alias' | 'ipset'
	name: string
	ref: string
	comment?: string
	/** Which level the name resolves against, `dc` or `guest`. */
	scope?: string
}

/**
 * The rules of one collection, such as `/cluster/firewall/rules`,
 * `/nodes/ms01-0160/firewall/rules` or `/cluster/firewall/groups/web`. A
 * rule is addressed as `<collection>/<pos>`.
 */
export class FirewallRulesApi {
	readonly client: PveClient
	/** Path of the rule collection, without a trailing slash. */
	readonly path: string

	constructor(client: PveClient, path: string) {
		this.client = client
		this.path = path
	}

	/** Rules in chain order, position 0 first. Token tier. */
	async list(): Promise<FirewallRule[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(this.path)
		return rows.map(normalizeFirewallRule)
	}

	/** One rule by position. Token tier. */
	async get(pos: number): Promise<FirewallRule> {
		return normalizeFirewallRule(
			await this.client.get<Record<string, unknown>>(`${this.path}/${pos}`),
		)
	}

	/**
	 * Insert a rule at the top of the chain. The handler always prepends and
	 * ignores `pos`, so move the rule afterwards with `update(0, { moveto })`.
	 * A rule created without `enable` is written disabled. Returns nothing.
	 */
	async create(params: FirewallRuleCreateParams): Promise<void> {
		await this.client.post<null>(this.path, params)
	}

	/**
	 * Change a rule in place. `moveto` moves it to another position instead.
	 * `digest` from the list guards against a concurrent edit. Returns nothing.
	 */
	async update(pos: number, params: FirewallRuleUpdateParams): Promise<void> {
		await this.client.put<null>(`${this.path}/${pos}`, params)
	}

	/** Remove a rule by position. Returns nothing. */
	async delete(pos: number, options: { digest?: string } = {}): Promise<void> {
		await this.client.delete<null>(`${this.path}/${pos}`, options)
	}
}

/** Datacenter firewall: the cluster rule chain, security groups, aliases, IPSets. */
export class ClusterFirewallApi {
	readonly client: PveClient
	readonly rules: FirewallRulesApi

	constructor(client: PveClient) {
		this.client = client
		this.rules = new FirewallRulesApi(client, '/cluster/firewall/rules')
	}

	/** Datacenter firewall options, including the default policies. Token tier. */
	async getOptions(): Promise<FirewallOptions> {
		return this.client.get<FirewallOptions>('/cluster/firewall/options')
	}

	/**
	 * Change datacenter firewall options. `enable: 0` turns the firewall
	 * off cluster-wide. `delete` takes a comma-separated list of keys to unset.
	 * Returns nothing.
	 */
	async setOptions(params: FirewallOptionsParams): Promise<void> {
		await this.client.put<null>('/cluster/firewall/options', params)
	}

	/** Security groups defined at the datacenter level. Token tier. */
	async listGroups(): Promise<FirewallSecurityGroup[]> {
		return this.client.get<FirewallSecurityGroup[]>('/cluster/firewall/groups')
	}

	/** Create a security group, or rename one with `rename`. Returns nothing. */
	async createGroup(params: ClusterFirewallGroupsPostParams): Promise<void> {
		await this.client.post<null>('/cluster/firewall/groups', params)
	}

	/** Delete a security group. It has to be empty and unreferenced first. */
	async deleteGroup(group: string): Promise<void> {
		await this.client.delete<null>(`/cluster/firewall/groups/${encodeURIComponent(group)}`)
	}

	/** The rule chain inside one security group. */
	group(group: string): FirewallRulesApi {
		return new FirewallRulesApi(
			this.client,
			`/cluster/firewall/groups/${encodeURIComponent(group)}`,
		)
	}

	/** Named IP or network aliases usable in `source` and `dest`. Token tier. */
	async listAliases(): Promise<FirewallAlias[]> {
		return this.client.get<FirewallAlias[]>('/cluster/firewall/aliases')
	}

	async getAlias(name: string): Promise<FirewallAlias> {
		return this.client.get<FirewallAlias>(`/cluster/firewall/aliases/${encodeURIComponent(name)}`)
	}

	/** Create an alias. Returns nothing. */
	async createAlias(params: ClusterFirewallAliasesPostParams): Promise<void> {
		await this.client.post<null>('/cluster/firewall/aliases', params)
	}

	/** Change an alias, or rename it with `rename`. Returns nothing. */
	async updateAlias(name: string, params: ClusterFirewallAliasesPutParams): Promise<void> {
		await this.client.put<null>(`/cluster/firewall/aliases/${encodeURIComponent(name)}`, params)
	}

	async deleteAlias(name: string, options: { digest?: string } = {}): Promise<void> {
		await this.client.delete<null>(`/cluster/firewall/aliases/${encodeURIComponent(name)}`, options)
	}

	/** IPSets defined at the datacenter level. Token tier. */
	async listIpsets(): Promise<FirewallIpset[]> {
		return this.client.get<FirewallIpset[]>('/cluster/firewall/ipset')
	}

	/** Create an IPSet, or rename one with `rename`. Returns nothing. */
	async createIpset(params: ClusterFirewallIpsetPostParams): Promise<void> {
		await this.client.post<null>('/cluster/firewall/ipset', params)
	}

	/** Delete an IPSet. Pass `force` to drop it while it still holds entries. */
	async deleteIpset(name: string, options: { force?: boolean } = {}): Promise<void> {
		await this.client.delete<null>(`/cluster/firewall/ipset/${encodeURIComponent(name)}`, options)
	}

	/** Entries of one IPSet. Token tier. */
	async listIpsetEntries(name: string): Promise<FirewallIpsetEntry[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(
			`/cluster/firewall/ipset/${encodeURIComponent(name)}`,
		)
		return rows.map(normalizeFirewallIpsetEntry)
	}

	/** Add a CIDR, IP or alias to an IPSet. Returns nothing. */
	async addIpsetEntry(name: string, params: ClusterFirewallIpsetPostByNameParams): Promise<void> {
		await this.client.post<null>(`/cluster/firewall/ipset/${encodeURIComponent(name)}`, params)
	}

	/** Change the comment or the nomatch flag of one IPSet entry. Returns nothing. */
	async updateIpsetEntry(
		name: string,
		cidr: string,
		params: ClusterFirewallIpsetPutParams,
	): Promise<void> {
		await this.client.put<null>(
			`/cluster/firewall/ipset/${encodeURIComponent(name)}/${encodeURIComponent(cidr)}`,
			params,
		)
	}

	async deleteIpsetEntry(
		name: string,
		cidr: string,
		options: { digest?: string } = {},
	): Promise<void> {
		await this.client.delete<null>(
			`/cluster/firewall/ipset/${encodeURIComponent(name)}/${encodeURIComponent(cidr)}`,
			options,
		)
	}

	/** Macros the `macro` rule field accepts, with their descriptions. Token tier. */
	async listMacros(): Promise<FirewallMacro[]> {
		return this.client.get<FirewallMacro[]>('/cluster/firewall/macros')
	}

	/**
	 * Aliases and IPSets that `source` and `dest` may reference, cluster-wide.
	 * Use it to check a name before writing a rule that would be rejected.
	 */
	async listRefs(options: ClusterFirewallRefsGetParams = {}): Promise<FirewallRef[]> {
		return this.client.get<FirewallRef[]>('/cluster/firewall/refs', options)
	}
}
