/**
 * Shapes shared by QEMU virtual machines and LXC containers, and the
 * normalizers that build them from what the node answers.
 *
 * Booleans arrive as 0 and 1, tag lists as one delimited string, and an
 * optional field is absent. Each normalizer turns one answer into a stable
 * object and keeps the untouched response under `raw`.
 */

import { PveError } from '../core/errors.ts'
import {
	splitIndexedKey,
	type FormatOptions,
	type ParseOptions,
	type PropertyBag,
} from '../core/props.ts'
import { formatConfigValue, parseConfigValue } from '../core/schema.ts'
import {
	parseTagList,
	toBoolean,
	toOptionalBoolean,
	toOptionalNumber,
	toOptionalString,
} from '../core/values.ts'

export type GuestType = 'qemu' | 'lxc'

/** Everything needed to address one guest. */
export interface GuestRef {
	node: string
	vmid: number
	/** Defaults to qemu. */
	type?: GuestType
}

/**
 * Run state with a QEMU pause folded in. PVE reports `running` for a VM that
 * QEMU has paused, so `paused` comes from `qmpstatus`.
 */
export type RunState = 'running' | 'stopped' | 'paused'

/** The API path a guest hangs off, such as /nodes/ms01-0160/lxc/110. */
export function guestPath(ref: GuestRef): string {
	return `/nodes/${encodeURIComponent(ref.node)}/${ref.type ?? 'qemu'}/${ref.vmid}`
}

/** One row of a node guest index or of /cluster/resources. */
export interface GuestSummary extends GuestRef {
	type: GuestType
	name: string | undefined
	/** Run state as the node reported it, usually 'running' or 'stopped'. */
	status: string
	template: boolean
	tags: string[]
	uptime: number
	/** Fraction of one host CPU, 0 to maxcpu. */
	cpu: number | undefined
	maxcpu: number | undefined
	mem: number | undefined
	maxmem: number | undefined
	disk: number | undefined
	maxdisk: number | undefined
	pool: string | undefined
	/** HA state, present only for an HA managed guest. */
	hastate: string | undefined
	lock: string | undefined
	raw: Readonly<Record<string, unknown>>
}

/** A guest's current status, from status/current. */
export interface GuestStatus extends GuestRef {
	type: GuestType
	name: string | undefined
	/** Run state as the node reported it. */
	status: string
	runState: RunState
	/** Name of the task holding the config lock, when one holds it. */
	lock: string | undefined
	template: boolean
	tags: string[]
	uptime: number
	pid: number | undefined
	cpus: number | undefined
	cpu: number | undefined
	mem: number | undefined
	maxmem: number | undefined
	disk: number | undefined
	maxdisk: number | undefined
	haManaged: boolean
	/** QMP run state. QEMU only. */
	qmpStatus: string | undefined
	/** The config asks for a guest agent. QEMU only, and says nothing about whether the agent answers. */
	agentEnabled: boolean | undefined
	/** Machine type of the running VM. QEMU only, while running. */
	runningMachine: string | undefined
	/** QEMU version of the running VM. QEMU only, while running. */
	runningQemu: string | undefined
	raw: Readonly<Record<string, unknown>>
}

/** A config value straight off the node. Numbers stay numbers. */
export type GuestConfigValue = string | number

interface GuestConfigBase extends GuestRef {
	type: GuestType
	/** SHA1 of the config file. Pass it back as `digest` to reject a racing edit. */
	digest: string | undefined
	lock: string | undefined
	template: boolean
	tags: string[]
	description: string | undefined
	/** MiB. */
	memory: number | undefined
	cores: number | undefined
	onboot: boolean | undefined
	ostype: string | undefined
	/** `net0` and up, parsed. `model` names the card and `macaddr` its address. */
	nets: Readonly<Record<string, PropertyBag>>
	/** `unused0` and up, parsed. */
	unused: Readonly<Record<string, PropertyBag>>
	/** Every key the node returned, unmodified. */
	raw: Readonly<Record<string, GuestConfigValue>>
}

export interface QemuConfig extends GuestConfigBase {
	type: 'qemu'
	name: string | undefined
	sockets: number | undefined
	cpu: string | undefined
	bios: string | undefined
	machine: string | undefined
	scsihw: string | undefined
	boot: string | undefined
	vga: string | undefined
	/** The `agent` line parsed; `enabled` is its default key. */
	agent: PropertyBag | undefined
	/** ide, sata, scsi, virtio, efidisk0 and tpmstate0 entries, parsed. `file` is the volume. */
	disks: Readonly<Record<string, PropertyBag>>
}

export interface LxcConfig extends GuestConfigBase {
	type: 'lxc'
	hostname: string | undefined
	/** MiB. */
	swap: number | undefined
	arch: string | undefined
	unprivileged: boolean
	features: PropertyBag | undefined
	/** The root volume parsed; `volume` names it. */
	rootfs: PropertyBag | undefined
	/** `mp0` and up, parsed. */
	mounts: Readonly<Record<string, PropertyBag>>
}

export type GuestConfig = QemuConfig | LxcConfig

export interface GuestConfigOptions {
	/** Read the running values rather than the pending ones. */
	current?: boolean
	/** Read the config as it was inside this snapshot. */
	snapshot?: string
}

/** One row of the pending endpoint. */
export interface PendingChange {
	key: string
	/** Value in the running guest. */
	value: GuestConfigValue | undefined
	/** Value that takes effect at the next start. */
	pending: GuestConfigValue | undefined
	/** 1 for a queued delete, 2 for a queued force-delete. */
	delete: number | undefined
	raw: Readonly<Record<string, unknown>>
}

export interface GuestSnapshot {
	name: string
	/** PVE stores a description with a trailing newline, so this rarely matches what was sent. */
	description: string | undefined
	/** Epoch seconds. Absent on the `current` pseudo-entry. */
	snaptime: number | undefined
	/** Snapshot this one branched from. */
	parent: string | undefined
	/** True for the pseudo-entry PVE adds for the live config. */
	current: boolean
	/** The snapshot carries RAM state. QEMU only. */
	vmstate: boolean | undefined
	/** The guest was running when the snapshot was taken. */
	running: boolean | undefined
	raw: Readonly<Record<string, unknown>>
}

export interface GuestFeature {
	hasFeature: boolean
	/** Nodes the feature is available on, for a shared-storage guest. */
	nodes: string[]
}

/** What GET migrate answers: where the guest could go and what blocks the rest. */
export interface MigratePreconditions {
	running: boolean
	/** Present for a running guest. */
	allowedNodes: string[] | undefined
	/** Node name to the reasons it is refused. Present for a running guest. */
	notAllowedNodes: Readonly<Record<string, unknown>> | undefined
	/** Volumes on local storage that a migration has to copy. */
	localDisks: Readonly<Record<string, unknown>>[]
	/** Passed-through devices that block a live migration. QEMU only. */
	localResources: string[]
	raw: Readonly<Record<string, unknown>>
}

/** One sample from rrddata. Keys vary by guest type and PVE version. */
export interface RrdPoint {
	/** Epoch seconds. */
	time: number
	[metric: string]: number | undefined
}

function configTemplatePath(type: GuestType): string {
	return `/nodes/{node}/${type}/{vmid}/config`
}

/**
 * Parses a config value such as `net0` into its sub-keys, using the format the
 * schema registers for that parameter. An indexed key resolves to its family.
 */
export function parseGuestConfigValue(
	type: GuestType,
	key: string,
	value: string,
	options?: ParseOptions,
): PropertyBag {
	return parseConfigValue('PUT', configTemplatePath(type), key, value, options)
}

/** Builds a config value from sub-keys, ordered the way PVE orders them. */
export function formatGuestConfigValue(
	type: GuestType,
	key: string,
	bag: PropertyBag,
	options?: FormatOptions,
): string {
	return formatConfigValue('PUT', configTemplatePath(type), key, bag, options)
}

interface RawSummary {
	vmid?: number | string
	name?: string
	status?: string
	template?: number | boolean
	tags?: string
	uptime?: number
	cpu?: number
	cpus?: number
	maxcpu?: number
	mem?: number
	maxmem?: number
	disk?: number
	maxdisk?: number
	pool?: string
	hastate?: string
	lock?: string
	node?: string
	type?: string
	[key: string]: unknown
}

/**
 * One index row into a GuestSummary. A node index omits `node` and `type`, so
 * both are passed in; a /cluster/resources row carries its own and they win.
 */
export function normalizeSummary(raw: RawSummary, type: GuestType, node: string): GuestSummary {
	const vmid = toOptionalNumber(raw.vmid)
	// Falling back to 0 would build paths such as /nodes/ms01/qemu/0 and send them.
	if (vmid === undefined) {
		throw new PveError('api', `A ${type} index row on ${node} carries no usable vmid`)
	}
	return {
		type: raw.type === 'qemu' || raw.type === 'lxc' ? raw.type : type,
		node: raw.node ?? node,
		vmid,
		name: toOptionalString(raw.name),
		status: raw.status ?? 'unknown',
		template: toBoolean(raw.template),
		tags: parseTagList(raw.tags),
		uptime: toOptionalNumber(raw.uptime) ?? 0,
		cpu: toOptionalNumber(raw.cpu),
		// A node index calls the CPU count `cpus`; /cluster/resources calls it `maxcpu`.
		maxcpu: toOptionalNumber(raw.maxcpu) ?? toOptionalNumber(raw.cpus),
		mem: toOptionalNumber(raw.mem),
		maxmem: toOptionalNumber(raw.maxmem),
		disk: toOptionalNumber(raw.disk),
		maxdisk: toOptionalNumber(raw.maxdisk),
		pool: toOptionalString(raw.pool),
		hastate: toOptionalString(raw.hastate),
		lock: toOptionalString(raw.lock),
		raw,
	}
}

/** Folds a QMP pause into the run state; everything else follows `status`. */
export function toRunState(status: string | undefined, qmpStatus?: string): RunState {
	if (qmpStatus === 'paused' || qmpStatus === 'prelaunch') return 'paused'
	if (status === 'running') return 'running'
	if (status === 'paused' || status === 'suspended') return 'paused'
	return 'stopped'
}

export function normalizeStatus(
	raw: Readonly<Record<string, unknown>>,
	ref: Required<GuestRef>,
): GuestStatus {
	const qmpStatus = toOptionalString(raw['qmpstatus'])
	const status = toOptionalString(raw['status']) ?? 'unknown'
	const ha = raw['ha']
	return {
		type: ref.type,
		node: ref.node,
		vmid: ref.vmid,
		name: toOptionalString(raw['name']),
		status,
		runState: toRunState(status, qmpStatus),
		lock: toOptionalString(raw['lock']),
		template: toBoolean(raw['template']),
		tags: parseTagList(raw['tags']),
		uptime: toOptionalNumber(raw['uptime']) ?? 0,
		pid: toOptionalNumber(raw['pid']),
		cpus: toOptionalNumber(raw['cpus']),
		cpu: toOptionalNumber(raw['cpu']),
		mem: toOptionalNumber(raw['mem']),
		maxmem: toOptionalNumber(raw['maxmem']),
		disk: toOptionalNumber(raw['disk']),
		maxdisk: toOptionalNumber(raw['maxdisk']),
		haManaged: toBoolean(isRecord(ha) ? ha['managed'] : undefined),
		qmpStatus,
		agentEnabled: toOptionalBoolean(raw['agent']),
		runningMachine: toOptionalString(raw['running-machine']),
		runningQemu: toOptionalString(raw['running-qemu']),
		raw,
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sub-keys the schema does not list are kept rather than refused, so a newer node still reads. */
const CONFIG_PARSE: ParseOptions = { strictKeys: false }

const QEMU_DISK_FAMILIES = ['ide', 'sata', 'scsi', 'virtio', 'efidisk', 'tpmstate'] as const

function configValues(raw: Readonly<Record<string, unknown>>): Record<string, GuestConfigValue> {
	const values: Record<string, GuestConfigValue> = {}
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined || value === null) continue
		values[key] = typeof value === 'number' ? value : String(value)
	}
	return values
}

/** Every member of the given indexed families, parsed, in family and index order. */
function parseFamilies(
	type: GuestType,
	values: Readonly<Record<string, GuestConfigValue>>,
	families: readonly string[],
): Record<string, PropertyBag> {
	const found: { key: string; base: string; index: number; value: string }[] = []
	for (const [key, value] of Object.entries(values)) {
		const split = splitIndexedKey(key)
		if (!split || !families.includes(split.base)) continue
		found.push({ key, base: split.base, index: split.index, value: String(value) })
	}
	found.sort((a, b) => a.base.localeCompare(b.base) || a.index - b.index)
	const parsed: Record<string, PropertyBag> = {}
	for (const entry of found) {
		parsed[entry.key] = parseGuestConfigValue(type, entry.key, entry.value, CONFIG_PARSE)
	}
	return parsed
}

function parseSingle(
	type: GuestType,
	values: Readonly<Record<string, GuestConfigValue>>,
	key: string,
): PropertyBag | undefined {
	const value = values[key]
	return value === undefined
		? undefined
		: parseGuestConfigValue(type, key, String(value), CONFIG_PARSE)
}

/** `memory` arrives as a number, or as the `current=N` property string newer nodes write. */
function readMemory(
	type: GuestType,
	values: Readonly<Record<string, GuestConfigValue>>,
): number | undefined {
	const value = values['memory']
	if (value === undefined) return undefined
	if (typeof value === 'number') return value
	return toOptionalNumber(parseGuestConfigValue(type, 'memory', value, CONFIG_PARSE)['current'])
}

function configBase(
	raw: Readonly<Record<string, unknown>>,
	values: Readonly<Record<string, GuestConfigValue>>,
	ref: Required<GuestRef>,
): GuestConfigBase {
	return {
		type: ref.type,
		node: ref.node,
		vmid: ref.vmid,
		digest: toOptionalString(raw['digest']),
		lock: toOptionalString(raw['lock']),
		template: toBoolean(raw['template']),
		tags: parseTagList(raw['tags']),
		description: toOptionalString(raw['description']),
		memory: readMemory(ref.type, values),
		cores: toOptionalNumber(raw['cores']),
		onboot: toOptionalBoolean(raw['onboot']),
		ostype: toOptionalString(raw['ostype']),
		nets: parseFamilies(ref.type, values, ['net']),
		unused: parseFamilies(ref.type, values, ['unused']),
		raw: values,
	}
}

export function normalizeQemuConfig(
	raw: Readonly<Record<string, unknown>>,
	ref: Omit<GuestRef, 'type'>,
): QemuConfig {
	const values = configValues(raw)
	return {
		...configBase(raw, values, { node: ref.node, vmid: ref.vmid, type: 'qemu' }),
		type: 'qemu',
		name: toOptionalString(raw['name']),
		sockets: toOptionalNumber(raw['sockets']),
		cpu: toOptionalString(raw['cpu']),
		bios: toOptionalString(raw['bios']),
		machine: toOptionalString(raw['machine']),
		scsihw: toOptionalString(raw['scsihw']),
		boot: toOptionalString(raw['boot']),
		vga: toOptionalString(raw['vga']),
		agent: parseSingle('qemu', values, 'agent'),
		disks: parseFamilies('qemu', values, QEMU_DISK_FAMILIES),
	}
}

export function normalizeLxcConfig(
	raw: Readonly<Record<string, unknown>>,
	ref: Omit<GuestRef, 'type'>,
): LxcConfig {
	const values = configValues(raw)
	return {
		...configBase(raw, values, { node: ref.node, vmid: ref.vmid, type: 'lxc' }),
		type: 'lxc',
		hostname: toOptionalString(raw['hostname']),
		swap: toOptionalNumber(raw['swap']),
		arch: toOptionalString(raw['arch']),
		unprivileged: toBoolean(raw['unprivileged']),
		features: parseSingle('lxc', values, 'features'),
		rootfs: parseSingle('lxc', values, 'rootfs'),
		mounts: parseFamilies('lxc', values, ['mp']),
	}
}

function normalizeConfigValue(value: unknown): GuestConfigValue | undefined {
	if (value === undefined || value === null) return undefined
	return typeof value === 'number' ? value : String(value)
}

export function normalizePending(rows: readonly Record<string, unknown>[]): PendingChange[] {
	return rows.map((row) => ({
		key: String(row['key'] ?? ''),
		value: normalizeConfigValue(row['value']),
		pending: normalizeConfigValue(row['pending']),
		delete: toOptionalNumber(row['delete']),
		raw: row,
	}))
}

/**
 * Snapshot rows in the order the node lists them. PVE appends a pseudo-entry
 * named `current` for the live config, which is flagged rather than dropped so
 * a caller can show the snapshot tree the way the web UI does.
 */
export function normalizeSnapshots(rows: readonly Record<string, unknown>[]): GuestSnapshot[] {
	return rows.map((row) => {
		const name = String(row['name'] ?? '')
		return {
			name,
			description: toOptionalString(row['description']),
			snaptime: toOptionalNumber(row['snaptime']),
			parent: toOptionalString(row['parent']),
			current: name === 'current',
			vmstate: toOptionalBoolean(row['vmstate']),
			running: toOptionalBoolean(row['running']),
			raw: row,
		}
	})
}

export function normalizeFeature(raw: Readonly<Record<string, unknown>>): GuestFeature {
	const nodes = raw['nodes']
	return {
		hasFeature: toBoolean(raw['hasFeature']),
		nodes: Array.isArray(nodes) ? nodes.map(String) : [],
	}
}

/** QEMU spells the keys `allowed_nodes`; LXC spells them `allowed-nodes`. Both are read. */
export function normalizeMigratePreconditions(
	raw: Readonly<Record<string, unknown>>,
): MigratePreconditions {
	const allowed = raw['allowed_nodes'] ?? raw['allowed-nodes']
	const refused = raw['not_allowed_nodes'] ?? raw['not-allowed-nodes']
	const disks = raw['local_disks'] ?? raw['local-disks']
	const resources = raw['local_resources'] ?? raw['local-resources']
	return {
		running: toBoolean(raw['running']),
		allowedNodes: Array.isArray(allowed) ? allowed.map(String) : undefined,
		notAllowedNodes: isRecord(refused) ? refused : undefined,
		localDisks: Array.isArray(disks) ? disks.filter(isRecord) : [],
		localResources: Array.isArray(resources) ? resources.map(String) : [],
		raw,
	}
}

/** PVE takes a delete or revert list as one comma-separated string. */
export function joinKeyList(value: string | readonly string[]): string {
	return typeof value === 'string' ? value : value.join(',')
}
