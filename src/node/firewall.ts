/**
 * Host firewall of one node: its rule chain, its options and its log.
 *
 * The node chain runs after the datacenter chain. Turning the firewall off
 * here leaves the datacenter rules in place and the other way round, so read
 * both when a packet is not going where it should.
 */

import type { PveClient } from '../core/client.ts'
import type { PveLogLine } from '../core/tasks.ts'
import { getEnvelope } from '../cluster/envelope.ts'
import { toOptionalNumber } from '../core/values.ts'
import { FirewallRulesApi } from '../cluster/firewall.ts'
import type {
	NodesFirewallLogGetParams,
	NodesFirewallOptionsPutParams,
} from '../generated/types.ts'

export interface FirewallLogPage {
	lines: PveLogLine[]
	/** Lines matching the filter before `start` and `limit`. */
	total: number | undefined
}

export class NodeFirewallApi {
	/** The node's own rule chain, with the same shape as the datacenter one. */
	readonly rules: FirewallRulesApi

	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/firewall`
		this.rules = new FirewallRulesApi(client, `${this.base}/rules`)
	}

	/**
	 * Host firewall options: the enable flag, log levels, conntrack limits and
	 * the synflood protection settings, with the node's own 0 and 1 spelling.
	 */
	async getOptions(): Promise<Record<string, unknown>> {
		return this.client.get<Record<string, unknown>>(`${this.base}/options`)
	}

	/**
	 * Change host firewall options. `enable: false` stops this node applying
	 * any firewall rules, including the datacenter ones. `delete` unsets keys.
	 */
	async setOptions(params: NodesFirewallOptionsPutParams): Promise<void> {
		await this.client.put<null>(`${this.base}/options`, params)
	}

	/**
	 * Firewall log lines, newest last, with the total count the node reports
	 * beside `data` for paging. Only rules with `log` set to a level other
	 * than `nolog` appear.
	 */
	async log(options?: NodesFirewallLogGetParams): Promise<FirewallLogPage> {
		const { data, attribs } = await getEnvelope<PveLogLine[]>(
			this.client,
			`${this.base}/log`,
			options,
		)
		return { lines: data, total: toOptionalNumber(attribs['total']) }
	}
}
