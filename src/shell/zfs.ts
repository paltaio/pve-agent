/**
 * ZFS beyond what the storage API exposes.
 *
 * The API creates and destroys a pool and nothing else. Scrub, import and
 * export, vdev changes, trim, native encryption, datasets outside guest
 * volumes and send/receive all go through the shell. `zpool status` is a
 * tree; the -Hp output of the list commands is tab-separated and in bytes.
 */

import { PveShellPolicyError } from './errors.ts'
import { assertSafeInteger, shJoin, shQuote } from './escape.ts'
import type { NodeShell } from './node-shell.ts'
import type { CommandResult, RunOptions } from './types.ts'

export interface ZpoolListEntry {
	name: string
	sizeBytes: number
	allocatedBytes: number
	freeBytes: number
	fragmentationPercent: number
	capacityPercent: number
	dedupRatio: number
	health: string
	altroot: string | undefined
}

export interface ZpoolDevice {
	name: string
	state: string
	readErrors: number
	writeErrors: number
	checksumErrors: number
	/** Trailing text on the row, such as '(resilvering)' or 'too many errors'. */
	note: string | undefined
	children: readonly ZpoolDevice[]
}

export interface ZpoolStatus {
	name: string
	state: string
	/** The 'status:' paragraph, when the pool has one. */
	status: string | undefined
	/** The 'action:' paragraph, when the pool has one. */
	action: string | undefined
	/** The 'scan:' line, which carries scrub and resilver progress. */
	scan: string | undefined
	errors: string
	devices: readonly ZpoolDevice[]
	/** The block this record was parsed from. */
	raw: string
}

export type ZfsDatasetType = 'filesystem' | 'volume' | 'snapshot' | 'bookmark'

export interface ZfsDataset {
	name: string
	type: ZfsDatasetType
	usedBytes: number | undefined
	availableBytes: number | undefined
	referencedBytes: number | undefined
	mountpoint: string | undefined
	compression: string | undefined
	encryption: string | undefined
	/** 'available' once the key is loaded, 'unavailable' before that. */
	keyStatus: string | undefined
	origin: string | undefined
	/** Seconds since the epoch. */
	createdAt: number | undefined
}

export interface ListDatasetsOptions {
	target?: string
	/** Defaults to filesystems and volumes. */
	types?: readonly ZfsDatasetType[]
	/** Descend this many levels below the target. */
	depth?: number
	/** Descend all the way. Defaults to true; `depth` takes precedence. */
	recursive?: boolean
}

export interface CreateDatasetOptions {
	/** Create a volume of this size instead of a filesystem. */
	volumeSizeBytes?: number
	/** Properties passed as -o, which is where encryption settings go. */
	properties?: Readonly<Record<string, string>>
	/** Create missing parent datasets. */
	parents?: boolean
	/** Leave the new filesystem unmounted. */
	noMount?: boolean
	/** Passphrase or key fed to zfs on stdin, for keyformat=passphrase or raw. */
	keyMaterial?: string | Uint8Array
	timeoutMs?: number
}

export interface DestroyDatasetOptions {
	/** Destroy children as well. */
	recursive?: boolean
	/** Destroy clones and other dependents as well. */
	dependents?: boolean
	/** Print what would be destroyed and change nothing. */
	dryRun?: boolean
}

export interface ImportPoolOptions {
	searchDirs?: readonly string[]
	newName?: string
	force?: boolean
	altroot?: string
	mountpoint?: string
	noMount?: boolean
	timeoutMs?: number
}

interface Limits {
	timeoutMs?: number
	input?: string | Uint8Array
}

const DATASET_FIELDS =
	'name,type,used,available,referenced,mountpoint,compression,encryption,keystatus,origin,creation'

const DATASET_TYPES: readonly ZfsDatasetType[] = ['filesystem', 'volume', 'snapshot', 'bookmark']

export class ZfsShell {
	private readonly shell: NodeShell

	constructor(shell: NodeShell) {
		this.shell = shell
	}

	/** Every imported pool with its capacity figures. */
	async listPools(): Promise<readonly ZpoolListEntry[]> {
		const output = await this.shell.output(
			'zpool list -Hp -o name,size,alloc,free,fragmentation,capacity,dedupratio,health,altroot',
		)
		return rows(output).map((columns) => {
			const [name, size, alloc, free, frag, cap, dedup, health, altroot] = columns
			return {
				name: name ?? '',
				sizeBytes: Number(size),
				allocatedBytes: Number(alloc),
				freeBytes: Number(free),
				fragmentationPercent: Number(frag),
				capacityPercent: Number(cap),
				dedupRatio: Number(dedup),
				health: health ?? '',
				altroot: dashToUndefined(altroot),
			}
		})
	}

	/** `zpool status` parsed into a device tree, for one pool or all of them. */
	async poolStatus(
		pool?: string,
		options: { verbose?: boolean } = {},
	): Promise<readonly ZpoolStatus[]> {
		const argv = ['zpool', 'status']
		if (options.verbose) argv.push('-v')
		if (pool !== undefined) argv.push(pool)
		return parseZpoolStatus(await this.shell.output(shJoin(argv)))
	}

	/** Properties of a pool. */
	async getPoolProperties(
		pool: string,
		properties: readonly string[] = ['all'],
	): Promise<Record<string, string>> {
		return parseKeyValueRows(
			await this.shell.output(
				shJoin(['zpool', 'get', '-Hp', '-o', 'property,value', properties.join(','), pool]),
			),
		)
	}

	/** Set one pool property. */
	setPoolProperty(pool: string, name: string, value: string): Promise<CommandResult> {
		return this.run(['zpool', 'set', `${name}=${value}`, pool])
	}

	/** Datasets under a target, or every dataset when none is given. */
	async listDatasets(options: ListDatasetsOptions = {}): Promise<readonly ZfsDataset[]> {
		const types = options.types ?? ['filesystem', 'volume']
		const argv = ['zfs', 'list', '-Hp', '-t', types.join(','), '-o', DATASET_FIELDS]
		if (options.depth !== undefined) {
			argv.push('-d', String(assertSafeInteger(options.depth, 'depth')))
		} else if (options.recursive !== false) argv.push('-r')
		if (options.target !== undefined) argv.push(options.target)
		return parseDatasetRows(await this.shell.output(shJoin(argv)))
	}

	/**
	 * Snapshots of a dataset, of its whole subtree with `recursive`, or every
	 * snapshot on the node when no target is given.
	 */
	async listSnapshots(
		target?: string,
		options: { recursive?: boolean } = {},
	): Promise<readonly ZfsDataset[]> {
		const argv = ['zfs', 'list', '-Hp', '-t', 'snapshot', '-o', DATASET_FIELDS]
		if (target !== undefined) argv.push(...(options.recursive ? ['-r'] : ['-d', '1']), target)
		return parseDatasetRows(await this.shell.output(shJoin(argv)))
	}

	/** Properties of a dataset, volume or snapshot. Pass names to narrow the query. */
	async getProperties(
		target: string,
		properties: readonly string[] = ['all'],
	): Promise<Record<string, string>> {
		return parseKeyValueRows(
			await this.shell.output(
				shJoin(['zfs', 'get', '-Hp', '-o', 'property,value', properties.join(','), target]),
			),
		)
	}

	/** Set one dataset property. */
	setProperty(target: string, name: string, value: string): Promise<CommandResult> {
		return this.run(['zfs', 'set', `${name}=${value}`, target])
	}

	/**
	 * Create a dataset or a volume. Native encryption is set through
	 * `properties`, with the key material passed on stdin when the keyformat
	 * needs one.
	 */
	createDataset(name: string, options: CreateDatasetOptions = {}): Promise<CommandResult> {
		const argv = ['zfs', 'create']
		if (options.parents) argv.push('-p')
		if (options.noMount) argv.push('-u')
		argv.push(...propertyFlags(options.properties))
		if (options.volumeSizeBytes !== undefined) {
			argv.push('-V', String(assertSafeInteger(options.volumeSizeBytes, 'volumeSizeBytes')))
		}
		argv.push(name)
		return this.run(argv, {
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.keyMaterial === undefined ? {} : { input: options.keyMaterial }),
		})
	}

	/**
	 * Destroy a dataset, volume or snapshot, and with `recursive` every child.
	 * A pool root is refused: that is `zpool destroy`, which the API covers.
	 */
	destroyDataset(name: string, options: DestroyDatasetOptions = {}): Promise<CommandResult> {
		if (!/[/@#]/.test(name)) {
			throw new PveShellPolicyError({
				command: `zfs destroy ${shQuote(name)}`,
				reason: `'${name}' is a pool root; destroyDataset takes a dataset, volume or snapshot`,
			})
		}
		const argv = ['zfs', 'destroy']
		if (options.recursive) argv.push('-r')
		if (options.dependents) argv.push('-R')
		if (options.dryRun) argv.push('-n', '-v')
		argv.push(name)
		return this.run(argv)
	}

	/** Rename a dataset or snapshot. A filesystem moves its mountpoint with it. */
	renameDataset(
		from: string,
		to: string,
		options: { parents?: boolean } = {},
	): Promise<CommandResult> {
		return this.run(['zfs', 'rename', ...(options.parents ? ['-p'] : []), from, to])
	}

	/** Take a snapshot. Name it 'dataset@label'. */
	snapshot(name: string, options: { recursive?: boolean } = {}): Promise<CommandResult> {
		return this.run(['zfs', 'snapshot', ...(options.recursive ? ['-r'] : []), name])
	}

	/**
	 * Roll a dataset back to a snapshot. Every change since the snapshot is
	 * lost, and with `destroyNewer` so are the snapshots taken after it.
	 */
	rollback(snapshot: string, options: { destroyNewer?: boolean } = {}): Promise<CommandResult> {
		return this.run(['zfs', 'rollback', ...(options.destroyNewer ? ['-r'] : []), snapshot])
	}

	/** Clone a snapshot into a new dataset. */
	clone(
		snapshot: string,
		target: string,
		options: { properties?: Readonly<Record<string, string>>; parents?: boolean } = {},
	): Promise<CommandResult> {
		const argv = ['zfs', 'clone']
		if (options.parents) argv.push('-p')
		argv.push(...propertyFlags(options.properties), snapshot, target)
		return this.run(argv)
	}

	/**
	 * Load the encryption key for a dataset. Without `keyMaterial` the key
	 * comes from the dataset's keylocation.
	 */
	loadKey(
		target: string,
		options: { recursive?: boolean; keyLocation?: string; keyMaterial?: string | Uint8Array } = {},
	): Promise<CommandResult> {
		const argv = ['zfs', 'load-key']
		if (options.recursive) argv.push('-r')
		if (options.keyMaterial !== undefined) argv.push('-L', 'prompt')
		else if (options.keyLocation !== undefined) argv.push('-L', options.keyLocation)
		argv.push(target)
		return this.run(argv, options.keyMaterial === undefined ? {} : { input: options.keyMaterial })
	}

	/** Unload an encryption key. The dataset is unreadable until it is loaded again. */
	unloadKey(target: string, options: { recursive?: boolean } = {}): Promise<CommandResult> {
		return this.run(['zfs', 'unload-key', ...(options.recursive ? ['-r'] : []), target])
	}

	/**
	 * Replace the encryption key or change the key format. The old key stops
	 * opening the dataset.
	 */
	changeKey(
		target: string,
		options: {
			properties?: Readonly<Record<string, string>>
			inheritFromParent?: boolean
			keyMaterial?: string | Uint8Array
		} = {},
	): Promise<CommandResult> {
		const argv = ['zfs', 'change-key']
		if (options.inheritFromParent) argv.push('-i')
		argv.push(...propertyFlags(options.properties), target)
		return this.run(argv, options.keyMaterial === undefined ? {} : { input: options.keyMaterial })
	}

	/** Start, pause or stop a scrub. */
	scrub(pool: string, options: { stop?: boolean; pause?: boolean } = {}): Promise<CommandResult> {
		const flags = options.stop ? ['-s'] : options.pause ? ['-p'] : []
		return this.run(['zpool', 'scrub', ...flags, pool])
	}

	/** The scan line for a pool, which reports scrub and resilver progress. */
	async scrubStatus(pool: string): Promise<string | undefined> {
		const [status] = await this.poolStatus(pool)
		return status?.scan
	}

	/** Start, suspend or cancel a trim. */
	trim(
		pool: string,
		options: { devices?: readonly string[]; stop?: boolean; suspend?: boolean } = {},
	): Promise<CommandResult> {
		const flags = options.stop ? ['-c'] : options.suspend ? ['-s'] : []
		return this.run(['zpool', 'trim', ...flags, pool, ...(options.devices ?? [])])
	}

	/** Import a pool, or list what is importable when no pool is named. */
	importPool(pool?: string, options: ImportPoolOptions = {}): Promise<CommandResult> {
		const argv = ['zpool', 'import']
		for (const dir of options.searchDirs ?? []) argv.push('-d', dir)
		if (options.force) argv.push('-f')
		if (options.noMount) argv.push('-N')
		if (options.altroot !== undefined) argv.push('-R', options.altroot)
		if (options.mountpoint !== undefined) argv.push('-o', `mountpoint=${options.mountpoint}`)
		if (pool !== undefined) argv.push(pool)
		if (options.newName !== undefined) argv.push(options.newName)
		return this.run(argv, options)
	}

	/** Export a pool, which unmounts everything on it. */
	exportPool(
		pool: string,
		options: { force?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		return this.run(['zpool', 'export', ...(options.force ? ['-f'] : []), pool], options)
	}

	/** Add vdevs to a pool. Most pool layouts cannot remove a vdev again. */
	addVdev(
		pool: string,
		specification: readonly string[],
		options: { force?: boolean } = {},
	): Promise<CommandResult> {
		return this.run(['zpool', 'add', ...(options.force ? ['-f'] : []), pool, ...specification])
	}

	/** Attach a device to an existing vdev, turning it into a mirror. The new device is overwritten. */
	attachDevice(
		pool: string,
		existingDevice: string,
		newDevice: string,
		options: { force?: boolean } = {},
	): Promise<CommandResult> {
		const flags = options.force ? ['-f'] : []
		return this.run(['zpool', 'attach', ...flags, pool, existingDevice, newDevice])
	}

	/** Detach a device from a mirror. */
	detachDevice(pool: string, device: string): Promise<CommandResult> {
		return this.run(['zpool', 'detach', pool, device])
	}

	/** Replace a device, resilvering onto the new one. The new device is overwritten. */
	replaceDevice(
		pool: string,
		oldDevice: string,
		newDevice: string,
		options: { force?: boolean } = {},
	): Promise<CommandResult> {
		const flags = options.force ? ['-f'] : []
		return this.run(['zpool', 'replace', ...flags, pool, oldDevice, newDevice])
	}

	/** Take a device offline. */
	offlineDevice(
		pool: string,
		device: string,
		options: { temporary?: boolean } = {},
	): Promise<CommandResult> {
		return this.run(['zpool', 'offline', ...(options.temporary ? ['-t'] : []), pool, device])
	}

	/** Bring a device back online. */
	onlineDevice(
		pool: string,
		device: string,
		options: { expand?: boolean } = {},
	): Promise<CommandResult> {
		return this.run(['zpool', 'online', ...(options.expand ? ['-e'] : []), pool, device])
	}

	/** Enable new on-disk features on a pool. Older ZFS releases stop importing it. */
	upgradePool(pool: string): Promise<CommandResult> {
		return this.run(['zpool', 'upgrade', pool])
	}

	/** Write a snapshot stream to a file on the node, replacing the file. */
	sendToFile(
		snapshot: string,
		nodePath: string,
		options: {
			incrementalFrom?: string
			raw?: boolean
			recursive?: boolean
			timeoutMs?: number
		} = {},
	): Promise<CommandResult> {
		const argv = ['zfs', 'send']
		if (options.raw) argv.push('-w')
		if (options.recursive) argv.push('-R')
		if (options.incrementalFrom !== undefined) argv.push('-i', options.incrementalFrom)
		argv.push(snapshot)
		return this.shell.run(`${shJoin(argv)} > ${shQuote(nodePath)}`, runOptions(options))
	}

	/**
	 * Read a snapshot stream from a file on the node into a dataset. With
	 * `force` the target is rolled back to match the stream.
	 */
	receiveFromFile(
		target: string,
		nodePath: string,
		options: { force?: boolean; unmounted?: boolean; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const argv = ['zfs', 'recv']
		if (options.force) argv.push('-F')
		if (options.unmounted) argv.push('-u')
		argv.push(target)
		return this.shell.run(`${shJoin(argv)} < ${shQuote(nodePath)}`, runOptions(options))
	}

	private run(argv: readonly string[], limits: Limits = {}): Promise<CommandResult> {
		return this.shell.run(shJoin(argv), runOptions(limits))
	}
}

function runOptions(limits: Limits): RunOptions {
	const options: RunOptions = { check: true }
	if (limits.timeoutMs !== undefined) options.timeoutMs = limits.timeoutMs
	if (limits.input !== undefined) options.input = limits.input
	return options
}

function propertyFlags(properties: Readonly<Record<string, string>> | undefined): string[] {
	return Object.entries(properties ?? {}).flatMap(([key, value]) => ['-o', `${key}=${value}`])
}

/** Parse the text of `zpool status` into one record per pool. */
export function parseZpoolStatus(output: string): readonly ZpoolStatus[] {
	const blocks: string[] = []
	let current: string[] = []
	for (const line of output.split('\n')) {
		if (/^\s*pool:\s/.test(line) && current.length > 0) {
			blocks.push(current.join('\n'))
			current = []
		}
		current.push(line)
	}
	if (current.some((line) => line.trim().length > 0)) blocks.push(current.join('\n'))

	return blocks
		.map((block) => parseStatusBlock(block))
		.filter((status): status is ZpoolStatus => status !== undefined)
}

function parseStatusBlock(block: string): ZpoolStatus | undefined {
	const fields: Record<string, string[]> = {}
	const configLines: string[] = []
	let field: string | undefined
	let inConfig = false

	for (const line of block.split('\n')) {
		const match = /^\s*([a-z]+):\s?(.*)$/.exec(line)
		if (match?.[1] !== undefined) {
			field = match[1]
			inConfig = field === 'config'
			if (!inConfig) fields[field] = [match[2] ?? '']
			continue
		}
		if (inConfig) {
			configLines.push(line)
			continue
		}
		if (field !== undefined && line.trim().length > 0) fields[field]?.push(line.trim())
	}

	const name = joinField(fields['pool'])
	if (name === undefined) return undefined

	return {
		name,
		state: joinField(fields['state']) ?? '',
		status: joinField(fields['status']),
		action: joinField(fields['action']),
		scan: joinField(fields['scan']),
		errors: joinField(fields['errors']) ?? '',
		devices: parseDeviceTree(configLines),
		raw: block,
	}
}

function joinField(value: readonly string[] | undefined): string | undefined {
	const text = value?.join(' ').trim() ?? ''
	return text.length > 0 ? text : undefined
}

interface MutableDevice extends ZpoolDevice {
	children: MutableDevice[]
}

/** The indented NAME/STATE/READ/WRITE/CKSUM table becomes a tree by indent depth. */
function parseDeviceTree(lines: readonly string[]): readonly ZpoolDevice[] {
	const roots: MutableDevice[] = []
	const stack: { indent: number; device: MutableDevice }[] = []
	let seenHeader = false

	for (const raw of lines) {
		const line = raw.replace(/\t/g, '')
		if (line.trim().length === 0) {
			if (seenHeader) break
			continue
		}
		if (!seenHeader) {
			seenHeader = /^\s*NAME\s+STATE\b/.test(line)
			continue
		}
		const indent = line.length - line.trimStart().length
		const [name, state, read, write, cksum, ...rest] = line.trim().split(/\s+/)
		if (name === undefined || state === undefined) continue

		const device: MutableDevice = {
			name,
			state,
			readErrors: Number(read ?? 0),
			writeErrors: Number(write ?? 0),
			checksumErrors: Number(cksum ?? 0),
			note: rest.length > 0 ? rest.join(' ') : undefined,
			children: [],
		}

		let parent = stack.at(-1)
		while (parent !== undefined && parent.indent >= indent) {
			stack.pop()
			parent = stack.at(-1)
		}
		if (parent === undefined) roots.push(device)
		else parent.device.children.push(device)
		stack.push({ indent, device })
	}
	return roots
}

/** Parse the tab-separated rows of `zfs list -Hp` with the field set this module asks for. */
export function parseDatasetRows(output: string): readonly ZfsDataset[] {
	return rows(output).map((columns) => {
		const [
			name,
			type,
			used,
			available,
			referenced,
			mountpoint,
			compression,
			encryption,
			keystatus,
			origin,
			creation,
		] = columns
		return {
			name: name ?? '',
			type: datasetType(type),
			usedBytes: numberOrUndefined(used),
			availableBytes: numberOrUndefined(available),
			referencedBytes: numberOrUndefined(referenced),
			mountpoint: dashToUndefined(mountpoint),
			compression: dashToUndefined(compression),
			encryption: dashToUndefined(encryption),
			keyStatus: dashToUndefined(keystatus),
			origin: dashToUndefined(origin),
			createdAt: numberOrUndefined(creation),
		}
	})
}

function datasetType(value: string | undefined): ZfsDatasetType {
	const known = DATASET_TYPES.find((type) => type === value)
	return known ?? 'filesystem'
}

function parseKeyValueRows(output: string): Record<string, string> {
	const properties: Record<string, string> = {}
	for (const [key, ...rest] of rows(output)) {
		if (key !== undefined) properties[key] = rest.join('\t')
	}
	return properties
}

function rows(output: string): string[][] {
	return output
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => line.split('\t'))
}

function dashToUndefined(value: string | undefined): string | undefined {
	return value === undefined || value === '' || value === '-' ? undefined : value
}

function numberOrUndefined(value: string | undefined): number | undefined {
	if (value === undefined || value === '' || value === '-') return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : undefined
}
