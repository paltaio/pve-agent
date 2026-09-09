/**
 * APT: the package index, repository entries and changelogs.
 *
 * The API refreshes the index and reads what it finds. There is no endpoint
 * that installs, upgrades or removes a package; the GUI upgrade button opens
 * a shell running `pveupgrade`.
 */

import type { PveClient } from '../core/client.ts'
import type {
	NodesAptRepositoriesPostParams,
	NodesAptUpdatePostParams,
} from '../generated/types.ts'

export interface AptUpdate extends Record<string, unknown> {
	Package: string
	Title?: string
	Description?: string
	Version: string
	OldVersion?: string
	Origin?: string
	Priority?: string
	Section?: string
	Arch?: string
	/** Present when the update carries a security notice. */
	NotifyStatus?: string
}

export interface AptVersion extends Record<string, unknown> {
	Package: string
	Version?: string
	OldVersion?: string
	CurrentState?: string
	Arch?: string
	Section?: string
	Title?: string
	RunningKernel?: string
	ManagerVersion?: string
}

export interface AptRepositoryFile extends Record<string, unknown> {
	path: string
	'file-type': 'list' | 'sources'
	repositories: Record<string, unknown>[]
	digest?: number[]
}

/**
 * The repository view as the node builds it. Every nested member keeps the
 * node's own 0 and 1 spelling for flags.
 */
export interface AptRepositories extends Record<string, unknown> {
	files: AptRepositoryFile[]
	errors: Record<string, unknown>[]
	digest: string
	infos: Record<string, unknown>[]
	/** `status` is 1 when the standard repository is configured on this node. */
	'standard-repos': { handle: string; name: string; status?: number }[]
}

export class NodeAptApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/apt`
	}

	/**
	 * Packages with a newer candidate version, from the index as it stands.
	 * Run `update` first for a current answer.
	 */
	async listUpdates(): Promise<AptUpdate[]> {
		return this.client.get<AptUpdate[]>(`${this.base}/update`)
	}

	/**
	 * Refresh the package index, which is `apt-get update` and nothing more.
	 * `notify` sends the configured notification when new updates appear.
	 * Returns a UPID.
	 */
	async update(options?: NodesAptUpdatePostParams): Promise<string> {
		return this.client.post<string>(`${this.base}/update`, options)
	}

	/** Versions of the Proxmox packages, as `pveversion -v` prints them. */
	async versions(): Promise<AptVersion[]> {
		return this.client.get<AptVersion[]>(`${this.base}/versions`)
	}

	/** Configured repositories per file, with the standard Proxmox repositories and their status. */
	async repositories(): Promise<AptRepositories> {
		return this.client.get<AptRepositories>(`${this.base}/repositories`)
	}

	/**
	 * Enable or disable one repository entry. `path` is the file it lives in
	 * and `index` its position in that file, both from `repositories`. Adding
	 * or editing a repository has no endpoint.
	 */
	async setRepository(params: NodesAptRepositoriesPostParams): Promise<void> {
		await this.client.post<null>(`${this.base}/repositories`, params)
	}

	/** Changelog of one package, for the candidate version or a named one. */
	async changelog(name: string, options: { version?: string } = {}): Promise<string> {
		return this.client.get<string>(`${this.base}/changelog`, { name, ...options })
	}
}
