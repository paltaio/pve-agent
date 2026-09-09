/**
 * Storage definitions in `/etc/pve/storage.cfg`.
 *
 * These calls edit the cluster-wide definition of a storage: its type, where
 * it lives, which content it takes and which nodes may use it. They do not
 * touch the data. Listing volumes, uploading, and per-node availability are
 * node calls.
 *
 * Creating a ZFS pool storage assumes the pool already exists on the node.
 */

import type { PveClient } from '../core/client.ts'
import { toOptionalBoolean, toOptionalString } from '../core/values.ts'
import type {
	StorageCreateParams,
	StorageGetParams,
	StorageUpdateParams,
} from '../generated/types.ts'

/** The storage types PVE ships. A third-party plugin reports its own name. */
export type StorageType = NonNullable<StorageGetParams['type']>

export interface StorageConfig {
	storage: string
	type: string
	/** Comma-separated: `images`, `rootdir`, `vztmpl`, `iso`, `backup`, `snippets`, `import`. */
	content: string | undefined
	/** Comma-separated node names. Absent means every node. */
	nodes: string | undefined
	disable: boolean | undefined
	shared: boolean | undefined
	path: string | undefined
	pool: string | undefined
	server: string | undefined
	export: string | undefined
	digest: string | undefined
	/** Retention rules, as a property string. */
	pruneBackups: string | undefined
	/** Every key the node returned, including the plugin-specific ones. */
	raw: Readonly<Record<string, unknown>>
}

function normalizeStorage(raw: Record<string, unknown>): StorageConfig {
	return {
		storage: String(raw['storage'] ?? ''),
		type: String(raw['type'] ?? ''),
		content: toOptionalString(raw['content']),
		nodes: toOptionalString(raw['nodes']),
		disable: toOptionalBoolean(raw['disable']),
		shared: toOptionalBoolean(raw['shared']),
		path: toOptionalString(raw['path']),
		pool: toOptionalString(raw['pool']),
		server: toOptionalString(raw['server']),
		export: toOptionalString(raw['export']),
		digest: toOptionalString(raw['digest']),
		pruneBackups: toOptionalString(raw['prune-backups']),
		raw,
	}
}

export class StorageConfigApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/** Storage definitions, optionally one type only. Token tier. */
	async list(options: { type?: StorageType } = {}): Promise<StorageConfig[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/storage', options)
		return rows.map(normalizeStorage)
	}

	/** One storage definition. Token tier. */
	async get(storage: string): Promise<StorageConfig> {
		return normalizeStorage(
			await this.client.get<Record<string, unknown>>(`/storage/${encodeURIComponent(storage)}`),
		)
	}

	/**
	 * Define a storage. `type` decides which other fields apply: `dir` wants
	 * `path`, `zfspool` wants `pool`, `nfs` wants `server` and `export`.
	 * `content` has to list every kind the storage should accept, and `nodes`
	 * restricts it to the nodes that can reach it. Returns the stored config,
	 * including any generated password file location.
	 */
	async create(params: StorageCreateParams): Promise<Record<string, unknown>> {
		return this.client.post<Record<string, unknown>>('/storage', params)
	}

	/**
	 * Change a storage definition. `delete` unsets keys, and `digest` from the
	 * list guards against a concurrent edit. Returns the stored config.
	 */
	async update(storage: string, params: StorageUpdateParams): Promise<Record<string, unknown>> {
		return this.client.put<Record<string, unknown>>(
			`/storage/${encodeURIComponent(storage)}`,
			params,
		)
	}

	/**
	 * Remove a storage definition. The data stays where it is; only the entry
	 * in `storage.cfg` goes away. Returns nothing.
	 */
	async delete(storage: string): Promise<void> {
		await this.client.delete<null>(`/storage/${encodeURIComponent(storage)}`)
	}
}
