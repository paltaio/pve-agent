/**
 * Resource pools.
 *
 * A pool groups guests and storages so an ACL can be granted once on
 * `/pool/<id>` instead of per guest. A nested pool is written with a slash,
 * `infra/db`, and only the collection endpoints understand it: the
 * `/pools/{poolid}` forms are deprecated and break on a nested id, so every
 * call here goes through `/pools` with `poolid` as a parameter.
 */

import type { PveClient } from '../core/client.ts'
import { PveNotFoundError } from '../core/errors.ts'
import type { PoolsGetParams, PoolsPostParams, PoolsPutParams } from '../generated/types.ts'

export type PoolMemberType = NonNullable<PoolsGetParams['type']>

export interface PoolMember extends Record<string, unknown> {
	id: string
	type: PoolMemberType
	node?: string
	vmid?: number
	storage?: string
}

export interface Pool extends Record<string, unknown> {
	poolid: string
	comment?: string
	/** Present only when one pool was asked for by id. */
	members?: PoolMember[]
}

export type PoolCreateParams = PoolsPostParams
export type PoolUpdateParams = PoolsPutParams

export class PoolsApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/** Every pool the caller may audit, without members. Token tier. */
	async list(): Promise<Pool[]> {
		return this.client.get<Pool[]>('/pools')
	}

	/**
	 * One pool with its members. `type` narrows the member list to `qemu`,
	 * `lxc` or `storage`. Throws PveNotFoundError when no such pool exists.
	 * Token tier.
	 */
	async get(poolid: string, options: { type?: PoolMemberType } = {}): Promise<Pool> {
		const found = await this.client.get<Pool[]>('/pools', { poolid, ...options })
		const pool = found[0]
		if (!pool) {
			throw new PveNotFoundError({
				method: 'GET',
				path: '/pools',
				detail: `pool '${poolid}' does not exist`,
			})
		}
		return pool
	}

	/** Create an empty pool. A nested id needs its parent to exist. Returns nothing. */
	async create(params: PoolCreateParams): Promise<void> {
		await this.client.post<null>('/pools', params)
	}

	/**
	 * Add or remove pool members. `vms` and `storage` are comma-separated lists;
	 * `delete: true` removes those members instead of adding them. A guest
	 * belongs to one pool at a time, so moving it out of another pool needs
	 * `allow-move`. Returns nothing.
	 */
	async update(params: PoolUpdateParams): Promise<void> {
		await this.client.put<null>('/pools', params)
	}

	/** Delete a pool. It has to be empty and have no child pools. Returns nothing. */
	async delete(poolid: string): Promise<void> {
		await this.client.delete<null>('/pools', { poolid })
	}
}
