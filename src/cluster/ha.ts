/**
 * High availability: resources, rules, groups and manager status.
 *
 * PVE 9 replaced HA groups with HA rules. On a cluster whose groups have been
 * migrated the group endpoints answer 500 with "ha groups have been migrated
 * to rules", so the group calls only work on a cluster still carrying an
 * unmigrated `/etc/pve/ha/groups.cfg`. Write node placement as a
 * node-affinity rule.
 *
 * A resource id is `vm:100` or `ct:110`. Every write here changes cluster
 * config and takes effect through the HA manager, so the call returns as soon
 * as the config is written, not when the resource has moved.
 */

import type { PveClient } from '../core/client.ts'
import { PveError } from '../core/errors.ts'
import {
	isRecord,
	parseTagList,
	toBoolean,
	toOptionalBoolean,
	toOptionalString,
} from '../core/values.ts'
import type {
	ClusterHaGroupsPostParams,
	ClusterHaGroupsPutParams,
	ClusterHaResourcesGetParams,
	ClusterHaRulesGetParams,
	HaResourceCreateParams,
	HaResourceUpdateParams,
	HaRuleCreateParams,
	HaRuleUpdateParams,
} from '../generated/types.ts'

export interface HaResource extends Record<string, unknown> {
	sid: string
	type: 'vm' | 'ct'
	state?: 'started' | 'stopped' | 'enabled' | 'disabled' | 'ignored'
	group?: string
	comment?: string
	max_restart?: number
	max_relocate?: number
	digest?: string
}

export interface HaGroup {
	group: string
	/** Comma-separated node list, each optionally `:priority`. */
	nodes: string
	/** The resource may run only on the listed nodes. */
	restricted: boolean | undefined
	/** Do not move the resource back when a higher-priority node returns. */
	nofailback: boolean | undefined
	comment: string | undefined
	digest: string | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeGroup(raw: Record<string, unknown>): HaGroup {
	return {
		group: String(raw['group'] ?? ''),
		nodes: String(raw['nodes'] ?? ''),
		restricted: toOptionalBoolean(raw['restricted']),
		nofailback: toOptionalBoolean(raw['nofailback']),
		comment: toOptionalString(raw['comment']),
		digest: toOptionalString(raw['digest']),
		raw,
	}
}

interface HaRuleBase {
	rule: string
	/** Resource ids the rule covers, such as `vm:100`. */
	resources: string[]
	disable: boolean
	comment: string | undefined
	digest: string | undefined
	/** Problems the manager found with the rule, keyed by field. */
	errors: Record<string, unknown> | undefined
	raw: Readonly<Record<string, unknown>>
}

/** Pins its resources to `nodes`. */
export interface HaNodeAffinityRule extends HaRuleBase {
	type: 'node-affinity'
	/** Node names, each optionally `:priority`. */
	nodes: string[]
	/** A resource stops rather than run on a node outside `nodes`. */
	strict: boolean
}

/** Keeps its resources together (`positive`) or apart (`negative`). */
export interface HaResourceAffinityRule extends HaRuleBase {
	type: 'resource-affinity'
	affinity: 'positive' | 'negative'
}

export type HaRule = HaNodeAffinityRule | HaResourceAffinityRule

/** Throws PveError when the rule type is one this module does not model. */
export function normalizeHaRule(raw: Record<string, unknown>): HaRule {
	const base: HaRuleBase = {
		rule: String(raw['rule'] ?? ''),
		resources: parseTagList(raw['resources']),
		disable: toBoolean(raw['disable']),
		comment: toOptionalString(raw['comment']),
		digest: toOptionalString(raw['digest']),
		errors: isRecord(raw['errors']) ? raw['errors'] : undefined,
		raw,
	}
	const type = raw['type']
	if (type === 'node-affinity') {
		return {
			...base,
			type,
			nodes: parseTagList(raw['nodes']),
			strict: toBoolean(raw['strict']),
		}
	}
	if (type === 'resource-affinity') {
		return {
			...base,
			type,
			affinity: raw['affinity'] === 'negative' ? 'negative' : 'positive',
		}
	}
	throw new PveError('api', `HA rule '${base.rule}' has unknown type '${String(type)}'`)
}

/** One row of the HA manager view: a quorum line, a node, or a service. */
export interface HaStatusEntry {
	id: string
	type: string
	node: string | undefined
	status: string | undefined
	quorate: boolean | undefined
	crm_state: string | undefined
	state: string | undefined
	sid: string | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeHaStatus(raw: Record<string, unknown>): HaStatusEntry {
	return {
		id: String(raw['id'] ?? ''),
		type: String(raw['type'] ?? ''),
		node: toOptionalString(raw['node']),
		status: toOptionalString(raw['status']),
		quorate: toOptionalBoolean(raw['quorate']),
		crm_state: toOptionalString(raw['crm_state']),
		state: toOptionalString(raw['state']),
		sid: toOptionalString(raw['sid']),
		raw,
	}
}

export class ClusterHaApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/** HA resources, optionally narrowed to `vm` or `ct`. Token tier. */
	async listResources(options: ClusterHaResourcesGetParams = {}): Promise<HaResource[]> {
		return this.client.get<HaResource[]>('/cluster/ha/resources', options)
	}

	/** One HA resource by sid, such as `vm:100`. Token tier. */
	async getResource(sid: string): Promise<HaResource> {
		return this.client.get<HaResource>(`/cluster/ha/resources/${encodeURIComponent(sid)}`)
	}

	/**
	 * Put a guest under HA management. `sid` is `vm:100`, `ct:110`, or a bare
	 * vmid with `type` given. Returns nothing.
	 */
	async createResource(params: HaResourceCreateParams): Promise<void> {
		await this.client.post<null>('/cluster/ha/resources', params)
	}

	/**
	 * Change an HA resource. `state: 'stopped'` keeps HA managing it while the
	 * guest stays off; `state: 'ignored'` leaves the guest alone entirely.
	 * Returns nothing.
	 */
	async updateResource(sid: string, params: HaResourceUpdateParams): Promise<void> {
		await this.client.put<null>(`/cluster/ha/resources/${encodeURIComponent(sid)}`, params)
	}

	/**
	 * Take a guest out of HA management. `purge` defaults to on, which also
	 * drops the resource from any rule that names it. Returns nothing.
	 */
	async deleteResource(sid: string, options: { purge?: boolean } = {}): Promise<void> {
		await this.client.delete<null>(`/cluster/ha/resources/${encodeURIComponent(sid)}`, options)
	}

	/**
	 * Ask the HA manager to migrate a resource to another node, keeping it
	 * running. The call queues the request and returns at once; watch
	 * `statusCurrent` for the result.
	 */
	async migrate(sid: string, node: string): Promise<void> {
		await this.client.post<null>(`/cluster/ha/resources/${encodeURIComponent(sid)}/migrate`, {
			node,
		})
	}

	/**
	 * Ask the HA manager to relocate a resource: stop it on the current node and
	 * start it on the target. Queued the same way as `migrate`.
	 */
	async relocate(sid: string, node: string): Promise<void> {
		await this.client.post<null>(`/cluster/ha/resources/${encodeURIComponent(sid)}/relocate`, {
			node,
		})
	}

	/** HA rules, optionally narrowed by type or by the resource they name. Token tier. */
	async listRules(options: ClusterHaRulesGetParams = {}): Promise<HaRule[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/ha/rules', options)
		return rows.map(normalizeHaRule)
	}

	async getRule(rule: string): Promise<HaRule> {
		return normalizeHaRule(
			await this.client.get<Record<string, unknown>>(
				`/cluster/ha/rules/${encodeURIComponent(rule)}`,
			),
		)
	}

	/**
	 * Create an HA rule. `type` picks the variant and the fields that go with
	 * it: `node-affinity` pins `resources` to `nodes`, each optionally
	 * `node:priority`, and a `strict` rule stops a resource when none of those
	 * nodes is available; `resource-affinity` keeps `resources` on one node
	 * with `affinity: 'positive'` or spreads them out with `'negative'`.
	 * Fails while the cluster still has unmigrated HA groups. Returns nothing.
	 */
	async createRule(params: HaRuleCreateParams): Promise<void> {
		await this.client.post<null>('/cluster/ha/rules', params)
	}

	/**
	 * Change an HA rule. `type` is required and has to match the rule.
	 * `delete` unsets keys. Returns nothing.
	 */
	async updateRule(rule: string, params: HaRuleUpdateParams): Promise<void> {
		await this.client.put<null>(`/cluster/ha/rules/${encodeURIComponent(rule)}`, params)
	}

	async deleteRule(rule: string): Promise<void> {
		await this.client.delete<null>(`/cluster/ha/rules/${encodeURIComponent(rule)}`)
	}

	/**
	 * HA groups. Answers 500 once the cluster has migrated its groups to rules,
	 * which PVE 9 does on upgrade. Use `listRules` instead.
	 */
	async listGroups(): Promise<HaGroup[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/ha/groups')
		return rows.map(normalizeGroup)
	}

	/** One HA group. Same migration caveat as `listGroups`. */
	async getGroup(group: string): Promise<HaGroup> {
		return normalizeGroup(
			await this.client.get<Record<string, unknown>>(
				`/cluster/ha/groups/${encodeURIComponent(group)}`,
			),
		)
	}

	/** Create an HA group. Same migration caveat as `listGroups`. */
	async createGroup(params: ClusterHaGroupsPostParams): Promise<void> {
		await this.client.post<null>('/cluster/ha/groups', params)
	}

	/** Change an HA group. Same migration caveat as `listGroups`. */
	async updateGroup(group: string, params: ClusterHaGroupsPutParams): Promise<void> {
		await this.client.put<null>(`/cluster/ha/groups/${encodeURIComponent(group)}`, params)
	}

	/** Delete an HA group. Same migration caveat as `listGroups`. */
	async deleteGroup(group: string): Promise<void> {
		await this.client.delete<null>(`/cluster/ha/groups/${encodeURIComponent(group)}`)
	}

	/**
	 * Manager view: one quorum row, one row per node running the LRM, and one
	 * row per managed service with its current and requested state. Token tier.
	 */
	async statusCurrent(): Promise<HaStatusEntry[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/ha/status/current')
		return rows.map(normalizeHaStatus)
	}

	/**
	 * Raw manager state: the master's service and node state machines plus each
	 * LRM's last status. Larger and less stable in shape than `statusCurrent`,
	 * and the place to look when a service is stuck. Token tier.
	 */
	async managerStatus(): Promise<Record<string, unknown>> {
		return this.client.get<Record<string, unknown>>('/cluster/ha/status/manager_status')
	}

	/**
	 * Release every watchdog in the cluster. `freeze` leaves services where
	 * they are, `ignore` hands them back to the node. Fencing stops until
	 * `arm` is called, so a failed node is not recovered.
	 */
	async disarm(resourceMode: 'freeze' | 'ignore'): Promise<void> {
		await this.client.post<null>('/cluster/ha/status/disarm-ha', { 'resource-mode': resourceMode })
	}

	/** Re-arm the HA stack after `disarm`. Returns nothing. */
	async arm(): Promise<void> {
		await this.client.post<null>('/cluster/ha/status/arm-ha')
	}
}
