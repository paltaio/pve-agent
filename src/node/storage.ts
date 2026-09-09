/**
 * Storage as one node sees it: availability, free space, volumes, uploads.
 *
 * A storage's definition is cluster config under `/storage`; these calls work
 * with what is on it from this node. A volume id is `storage:path`, such as
 * `local:iso/debian.iso`, and goes into the path URL-encoded.
 */

import type { PveClient, SignedRequest } from '../core/client.ts'
import {
	isRecord,
	toBoolean,
	toOptionalBoolean,
	toOptionalNumber,
	toOptionalString,
} from '../core/values.ts'
import type {
	NodesStorageContentGetByNodeStorageParams,
	NodesStorageContentPostByNodeStorageParams,
	NodesStorageContentPostByNodeStorageVolumeParams,
	NodesStorageContentPutParams,
	NodesStorageDownloadUrlPostParams,
	NodesStorageGetByNodeParams,
	NodesStoragePrunebackupsDeleteParams,
	NodesStorageUploadPostParams,
} from '../generated/types.ts'

export interface StorageStatusEntry {
	storage: string
	type: string
	/** Comma-separated content types the storage takes. */
	content: string
	/** True when the storage is reachable from this node right now. */
	active: boolean | undefined
	/** False when the definition sets `disable`. */
	enabled: boolean | undefined
	shared: boolean | undefined
	total: number | undefined
	used: number | undefined
	avail: number | undefined
	usedFraction: number | undefined
	raw: Readonly<Record<string, unknown>>
}

export interface StorageStatus {
	type: string
	content: string
	total: number
	used: number
	avail: number
	enabled: boolean | undefined
	active: boolean | undefined
	shared: boolean | undefined
	raw: Readonly<Record<string, unknown>>
}

export interface VolumeEntry {
	volid: string
	content: string
	size: number
	format: string | undefined
	vmid: number | undefined
	/** Epoch seconds the volume was created. */
	ctime: number | undefined
	notes: string | undefined
	/** A protected backup is skipped by pruning. */
	protected: boolean | undefined
	used: number | undefined
	parent: string | undefined
	/** Verification state of a backup on a Proxmox Backup Server storage. */
	verification: Readonly<Record<string, unknown>> | undefined
	raw: Readonly<Record<string, unknown>>
}

export interface VolumeAttributes {
	path: string
	size: number
	used: number | undefined
	format: string | undefined
	notes: string | undefined
	protected: boolean | undefined
	raw: Readonly<Record<string, unknown>>
}

export interface PruneCandidate {
	volid: string
	ctime: number
	type: string
	vmid: number | undefined
	/** `keep`, `remove`, `protected` or `renamed`. */
	mark: string
	raw: Readonly<Record<string, unknown>>
}

export interface FileRestoreEntry {
	/** Base64-encoded path inside the archive, as the download call takes it. */
	filepath: string
	/** The entry's own name. */
	text: string
	/** `f` for a file, `d` for a directory, `v` for a virtual entry. */
	type: string
	/** True for a file; a directory has entries below it. */
	leaf: boolean
	size: number | undefined
	mtime: number | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeStatusEntry(raw: Record<string, unknown>): StorageStatusEntry {
	return {
		storage: String(raw['storage'] ?? ''),
		type: String(raw['type'] ?? ''),
		content: String(raw['content'] ?? ''),
		active: toOptionalBoolean(raw['active']),
		enabled: toOptionalBoolean(raw['enabled']),
		shared: toOptionalBoolean(raw['shared']),
		total: toOptionalNumber(raw['total']),
		used: toOptionalNumber(raw['used']),
		avail: toOptionalNumber(raw['avail']),
		usedFraction: toOptionalNumber(raw['used_fraction']),
		raw,
	}
}

function normalizeStatus(raw: Record<string, unknown>): StorageStatus {
	return {
		type: String(raw['type'] ?? ''),
		content: String(raw['content'] ?? ''),
		total: toOptionalNumber(raw['total']) ?? 0,
		used: toOptionalNumber(raw['used']) ?? 0,
		avail: toOptionalNumber(raw['avail']) ?? 0,
		enabled: toOptionalBoolean(raw['enabled']),
		active: toOptionalBoolean(raw['active']),
		shared: toOptionalBoolean(raw['shared']),
		raw,
	}
}

function normalizeVolume(raw: Record<string, unknown>): VolumeEntry {
	const verification = raw['verification']
	return {
		volid: String(raw['volid'] ?? ''),
		content: String(raw['content'] ?? ''),
		size: toOptionalNumber(raw['size']) ?? 0,
		format: toOptionalString(raw['format']),
		vmid: toOptionalNumber(raw['vmid']),
		ctime: toOptionalNumber(raw['ctime']),
		notes: toOptionalString(raw['notes']),
		protected: toOptionalBoolean(raw['protected']),
		used: toOptionalNumber(raw['used']),
		parent: toOptionalString(raw['parent']),
		verification: isRecord(verification) ? verification : undefined,
		raw,
	}
}

function normalizeVolumeAttributes(raw: Record<string, unknown>): VolumeAttributes {
	return {
		path: String(raw['path'] ?? ''),
		size: toOptionalNumber(raw['size']) ?? 0,
		used: toOptionalNumber(raw['used']),
		format: toOptionalString(raw['format']),
		notes: toOptionalString(raw['notes']),
		protected: toOptionalBoolean(raw['protected']),
		raw,
	}
}

function normalizePruneCandidate(raw: Record<string, unknown>): PruneCandidate {
	return {
		volid: String(raw['volid'] ?? ''),
		ctime: toOptionalNumber(raw['ctime']) ?? 0,
		type: String(raw['type'] ?? ''),
		vmid: toOptionalNumber(raw['vmid']),
		mark: String(raw['mark'] ?? ''),
		raw,
	}
}

function normalizeFileRestoreEntry(raw: Record<string, unknown>): FileRestoreEntry {
	return {
		filepath: String(raw['filepath'] ?? ''),
		text: String(raw['text'] ?? ''),
		type: String(raw['type'] ?? ''),
		leaf: toBoolean(raw['leaf']),
		size: toOptionalNumber(raw['size']),
		mtime: toOptionalNumber(raw['mtime']),
		raw,
	}
}

export class NodeStorageApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/storage`
	}

	private storagePath(storage: string, suffix = ''): string {
		return `${this.base}/${encodeURIComponent(storage)}${suffix}`
	}

	private volumePath(storage: string, volume: string): string {
		return this.storagePath(storage, `/content/${encodeURIComponent(volume)}`)
	}

	/**
	 * Storages visible to this node with their space usage. `enabled: true`
	 * drops the disabled ones, `content` filters by content type, and `target`
	 * reports whether each is also available on that other node, which is what
	 * a migration check needs.
	 */
	async list(options?: NodesStorageGetByNodeParams): Promise<StorageStatusEntry[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(this.base, options)
		return rows.map(normalizeStatusEntry)
	}

	/** Space and activation state of one storage on this node. */
	async status(storage: string): Promise<StorageStatus> {
		return normalizeStatus(
			await this.client.get<Record<string, unknown>>(this.storagePath(storage, '/status')),
		)
	}

	/**
	 * Volumes on a storage. `content` narrows to one kind (`images`, `rootdir`,
	 * `iso`, `vztmpl`, `backup`, `snippets`, `import`) and `vmid` to one guest.
	 */
	async content(
		storage: string,
		options?: NodesStorageContentGetByNodeStorageParams,
	): Promise<VolumeEntry[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(
			this.storagePath(storage, '/content'),
			options,
		)
		return rows.map(normalizeVolume)
	}

	/** Size, format and on-disk path of one volume. */
	async volume(storage: string, volume: string): Promise<VolumeAttributes> {
		return normalizeVolumeAttributes(
			await this.client.get<Record<string, unknown>>(this.volumePath(storage, volume)),
		)
	}

	/**
	 * Allocate a disk image on a storage. `size` takes a suffix, `1G` or
	 * `512M`. Returns the new volume id.
	 */
	async allocate(
		storage: string,
		params: NodesStorageContentPostByNodeStorageParams,
	): Promise<string> {
		return this.client.post<string>(this.storagePath(storage, '/content'), params)
	}

	/** Set a backup's notes or its protected flag. */
	async updateVolume(
		storage: string,
		volume: string,
		params: NodesStorageContentPutParams,
	): Promise<void> {
		await this.client.put<null>(this.volumePath(storage, volume), params)
	}

	/**
	 * Delete a volume. `delay` waits that many seconds for the storage to
	 * release it first. Returns a UPID.
	 */
	async deleteVolume(
		storage: string,
		volume: string,
		options?: { delay?: number },
	): Promise<string> {
		return this.client.delete<string>(this.volumePath(storage, volume), options)
	}

	/**
	 * Copy a volume to another storage or node.
	 *
	 * The handler compares the caller against root@pam, so the call needs a
	 * root ticket. PVE marks it experimental; a guest disk is better moved with
	 * the guest's own move-disk call. Returns a UPID.
	 */
	async copyVolume(
		storage: string,
		volume: string,
		params: NodesStorageContentPostByNodeStorageVolumeParams,
	): Promise<string> {
		return this.client.post<string>(this.volumePath(storage, volume), params)
	}

	/**
	 * Have the node fetch a file over HTTP into a storage: an ISO, a container
	 * template, an OVA or a disk image. The download runs on the node, so the
	 * bytes never pass through this process. `checksum` with
	 * `checksum-algorithm` is verified before the file is kept. Returns a UPID.
	 */
	async downloadUrl(storage: string, params: NodesStorageDownloadUrlPostParams): Promise<string> {
		return this.client.post<string>(this.storagePath(storage, '/download-url'), params)
	}

	/**
	 * Upload a local file to a storage as an ISO, container template or import
	 * image.
	 *
	 * The node streams the body to a temporary file and moves it into place,
	 * copying it over SSH first when the storage is not local to the node that
	 * took the request. `downloadUrl` is the better path when the file is
	 * already reachable by URL. Returns a UPID.
	 */
	async upload(storage: string, file: Blob, params: NodesStorageUploadPostParams): Promise<string> {
		// The server parses the multipart stream field by field in a fixed
		// order: content, checksum-algorithm, checksum, then the file part,
		// which has to be named 'filename'. Anything else fails the parse.
		const form = new FormData()
		form.append('content', params.content)
		if (params['checksum-algorithm'])
			form.append('checksum-algorithm', params['checksum-algorithm'])
		if (params.checksum) form.append('checksum', params.checksum)
		form.append('filename', file, params.filename)

		return this.client.post<string>(this.storagePath(storage, '/upload'), undefined, {
			body: form,
		})
	}

	/**
	 * What a prune would remove, without removing anything. Each candidate is
	 * marked `keep`, `remove`, `protected` or `renamed`.
	 */
	async prunePreview(
		storage: string,
		options?: NodesStoragePrunebackupsDeleteParams,
	): Promise<PruneCandidate[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(
			this.storagePath(storage, '/prunebackups'),
			options,
		)
		return rows.map(normalizePruneCandidate)
	}

	/**
	 * Delete backups the retention rules do not keep. Without `prune-backups`
	 * the storage's own retention setting applies. Returns a UPID.
	 */
	async pruneBackups(
		storage: string,
		options?: NodesStoragePrunebackupsDeleteParams,
	): Promise<string> {
		return this.client.delete<string>(this.storagePath(storage, '/prunebackups'), options)
	}

	/**
	 * Files inside a backup, for single-file restore. `filepath` is `/` for the
	 * top level and the base64 path of an entry below that. Works on Proxmox
	 * Backup Server storages and on vzdump archives the node can mount.
	 */
	async fileRestoreList(
		storage: string,
		volume: string,
		filepath: string,
	): Promise<FileRestoreEntry[]> {
		const rows = await this.client.get<Record<string, unknown>[]>(
			this.storagePath(storage, '/file-restore/list'),
			{ volume, filepath },
		)
		return rows.map(normalizeFileRestoreEntry)
	}

	/**
	 * URL and headers for downloading one file or directory out of a backup.
	 *
	 * The response is the file itself, so the caller fetches `url` with
	 * `headers`. `tar` returns a tar stream instead of a zip for a directory.
	 */
	async fileRestoreDownload(
		storage: string,
		volume: string,
		filepath: string,
		options: { tar?: boolean } = {},
	): Promise<SignedRequest> {
		return this.client.signRequest('GET', this.storagePath(storage, '/file-restore/download'), {
			volume,
			filepath,
			...options,
		})
	}

	/**
	 * Guest parameters derived from an importable volume, such as an ESXi VM or
	 * an OVA on an import storage, in the shape a guest create call takes.
	 */
	async importMetadata(storage: string, volume: string): Promise<Record<string, unknown>> {
		return this.client.get<Record<string, unknown>>(this.storagePath(storage, '/import-metadata'), {
			volume,
		})
	}
}
