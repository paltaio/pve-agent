/**
 * The firewall of one guest: its rule chain, options, aliases, IPSets, log
 * and references. QEMU and LXC register the same subtree with the same
 * parameters, so one class serves both and is handed the guest's base path.
 * The parameter types name the QEMU declarations.
 */

import type { PveClient } from '../core/client.ts'
import type { PveLogLine } from '../core/tasks.ts'
import {
	FirewallRulesApi,
	normalizeFirewallIpsetEntry,
	type FirewallAlias,
	type FirewallIpset,
	type FirewallIpsetEntry,
	type FirewallOptions,
	type FirewallRef,
} from '../cluster/firewall.ts'
import type {
	NodesQemuFirewallAliasesPostParams,
	NodesQemuFirewallAliasesPutParams,
	NodesQemuFirewallIpsetPostByNodeVmidNameParams,
	NodesQemuFirewallIpsetPostByNodeVmidParams,
	NodesQemuFirewallIpsetPutParams,
	NodesQemuFirewallLogGetParams,
	NodesQemuFirewallOptionsPutParams,
	NodesQemuFirewallRefsGetParams,
} from '../generated/types.ts'

export type {
	FirewallAlias,
	FirewallIpset,
	FirewallIpsetEntry,
	FirewallOptions,
	FirewallRef,
	FirewallRule,
	FirewallRuleCreateParams,
	FirewallRuleUpdateParams,
} from '../cluster/firewall.ts'

export type GuestFirewallOptionsParams = NodesQemuFirewallOptionsPutParams
export type GuestFirewallAliasCreateParams = NodesQemuFirewallAliasesPostParams
export type GuestFirewallAliasUpdateParams = NodesQemuFirewallAliasesPutParams
export type GuestFirewallIpsetCreateParams = NodesQemuFirewallIpsetPostByNodeVmidParams
export type GuestFirewallIpsetEntryCreateParams = NodesQemuFirewallIpsetPostByNodeVmidNameParams
export type GuestFirewallIpsetEntryUpdateParams = NodesQemuFirewallIpsetPutParams
export type GuestFirewallLogOptions = NodesQemuFirewallLogGetParams
export type GuestFirewallRefsOptions = NodesQemuFirewallRefsGetParams

/**
 * Every call is synchronous and returns no UPID. Reads need VM.Audit, writes
 * need VM.Config.Network; an API token reaches all of them.
 */
export class GuestFirewallApi {
	/** This guest's rule chain, with the same shape as the datacenter one. */
	readonly rules: FirewallRulesApi

	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, guestPath: string) {
		this.client = client
		this.base = `${guestPath}/firewall`
		this.rules = new FirewallRulesApi(client, `${this.base}/rules`)
	}

	/** Per-guest settings, with the node's own 0 and 1 spelling and the digest for guarded writes. */
	async getOptions(): Promise<FirewallOptions> {
		return this.client.get<FirewallOptions>(`${this.base}/options`)
	}

	/** Change per-guest settings. `enable: true` turns the guest firewall on. `delete` unsets keys. */
	async setOptions(params: GuestFirewallOptionsParams): Promise<void> {
		await this.client.put<null>(`${this.base}/options`, params)
	}

	async listAliases(): Promise<FirewallAlias[]> {
		return this.client.get<FirewallAlias[]>(`${this.base}/aliases`)
	}

	async getAlias(name: string): Promise<FirewallAlias> {
		return this.client.get<FirewallAlias>(this.aliasPath(name))
	}

	async createAlias(params: GuestFirewallAliasCreateParams): Promise<void> {
		await this.client.post<null>(`${this.base}/aliases`, params)
	}

	/** Change an alias, or rename it with `rename`. */
	async updateAlias(name: string, params: GuestFirewallAliasUpdateParams): Promise<void> {
		await this.client.put<null>(this.aliasPath(name), params)
	}

	async deleteAlias(name: string, options: { digest?: string } = {}): Promise<void> {
		await this.client.delete<null>(this.aliasPath(name), options)
	}

	async listIpsets(): Promise<FirewallIpset[]> {
		return this.client.get<FirewallIpset[]>(`${this.base}/ipset`)
	}

	/** Create an IPSet, or rename one with `rename`. */
	async createIpset(params: GuestFirewallIpsetCreateParams): Promise<void> {
		await this.client.post<null>(`${this.base}/ipset`, params)
	}

	/** Delete an IPSet. Pass `force` to drop it while it still holds entries. */
	async deleteIpset(name: string, options: { force?: boolean } = {}): Promise<void> {
		await this.client.delete<null>(this.ipsetPath(name), options)
	}

	async listIpsetEntries(name: string): Promise<FirewallIpsetEntry[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(this.ipsetPath(name))
		return rows.map(normalizeFirewallIpsetEntry)
	}

	/** Add a CIDR, IP or alias to an IPSet. */
	async addIpsetEntry(name: string, params: GuestFirewallIpsetEntryCreateParams): Promise<void> {
		await this.client.post<null>(this.ipsetPath(name), params)
	}

	async getIpsetEntry(name: string, cidr: string): Promise<FirewallIpsetEntry> {
		const raw = await this.client.get<Record<string, unknown>>(this.ipsetEntryPath(name, cidr))
		return normalizeFirewallIpsetEntry(raw)
	}

	/** Change the comment or the nomatch flag of one IPSet entry. */
	async updateIpsetEntry(
		name: string,
		cidr: string,
		params: GuestFirewallIpsetEntryUpdateParams,
	): Promise<void> {
		await this.client.put<null>(this.ipsetEntryPath(name, cidr), params)
	}

	async deleteIpsetEntry(
		name: string,
		cidr: string,
		options: { digest?: string } = {},
	): Promise<void> {
		await this.client.delete<null>(this.ipsetEntryPath(name, cidr), options)
	}

	/** Firewall log lines for this guest, oldest first. Only rules with `log` set appear. */
	async log(options: GuestFirewallLogOptions = {}): Promise<PveLogLine[]> {
		return this.client.get<PveLogLine[]>(`${this.base}/log`, options)
	}

	/** Aliases and IPSets a rule on this guest may refer to, at guest and datacenter scope. */
	async listRefs(options: GuestFirewallRefsOptions = {}): Promise<FirewallRef[]> {
		return this.client.get<FirewallRef[]>(`${this.base}/refs`, options)
	}

	private aliasPath(name: string): string {
		return `${this.base}/aliases/${encodeURIComponent(name)}`
	}

	private ipsetPath(name: string): string {
		return `${this.base}/ipset/${encodeURIComponent(name)}`
	}

	private ipsetEntryPath(name: string, cidr: string): string {
		return `${this.ipsetPath(name)}/${encodeURIComponent(cidr)}`
	}
}
