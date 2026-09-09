/**
 * Shared pieces of the live suite, which runs against a real cluster.
 *
 * Run it from the repository root with:
 *
 *   set -a; . ./pve.env; set +a; PVE_LIVE=1 PVE_ENV_FILE=./pve.env bun test test/live
 *
 * PVE_LIVE_ALL=1 adds the Windows and macOS guest groups, which boot and shut
 * down whole desktops. Without PVE_LIVE every live test is reported as skipped.
 *
 * The connection variables come from the env file through the library.
 * PVE_GUEST_PASSWORD, the login password of the target VM's user, is read from
 * the process environment only, so source the env file before running.
 *
 * Every cluster-specific name and vmid is a PVE_LIVE_* variable with the
 * default written next to it below. The suite probes the cluster once at
 * load and reports a test as skipped when the fixture it needs is absent.
 */

import pve, {
	PveNotFoundError,
	PveVm,
	type GuestSummary,
	type PveCluster,
	type PveConnectOptions,
	type PveGuest,
} from '../../src/index.ts'

export const LIVE = Boolean(process.env['PVE_LIVE'])
export const LIVE_ALL = LIVE && Boolean(process.env['PVE_LIVE_ALL'])

export const SECOND = 1000
export const MINUTE = 60 * SECOND

function setting(name: string, fallback: string): string {
	return process.env[`PVE_LIVE_${name}`] || fallback
}

function numberSetting(name: string, fallback: number): number {
	const value = Number(setting(name, String(fallback)))
	if (!Number.isInteger(value)) throw new Error(`PVE_LIVE_${name} is not an integer`)
	return value
}

/** The node the scratch guests, the dataset and the shell tests use. */
export const SCRATCH_NODE = setting('SCRATCH_NODE', 'ms01-0160')
export const SCRATCH_STORAGE = setting('STORAGE', 'ms01-vms')
export const SCRATCH_BRIDGE = setting('BRIDGE', 'vmbr1')
export const SCRATCH_POOL = setting('POOL', 'rpool')
export const TEMPLATE_STORAGE = setting('TEMPLATE_STORAGE', 'local')
export const SCRATCH_PREFIX = 'pve-agent-test-'
export const SCRATCH_VM = numberSetting('SCRATCH_VM', 9001)
export const SCRATCH_CT = numberSetting('SCRATCH_CT', 9002)

/** A running Linux VM with the guest agent, a serial getty and a login user. */
export const TARGET_NODE = setting('TARGET_NODE', 'ms02-0078')
export const TARGET_VM = numberSetting('TARGET_VM', 101)
export const TARGET_USER = setting('TARGET_USER', 'debian')
/** The VNC screen size of the target VM's desktop, as `WIDTHxHEIGHT`. */
export const TARGET_SCREEN = setting('SCREEN', '1280x800')
/** A container that is read and never changed. */
export const LIBRARY_CT = numberSetting('CT', 110)
/** Desktop VMs that are normally off; only the PVE_LIVE_ALL groups boot them. */
export const WINDOWS_VM = numberSetting('WINDOWS_VM', 107)
export const MACOS_VM = numberSetting('MACOS_VM', 102)

export const CLUSTER_VERSION = setting('VERSION', '9.2.11')

/** Connects through the public entry point, pointing it at PVE_ENV_FILE when set. */
export function connectLive(options: PveConnectOptions = {}): Promise<PveCluster> {
	const envFile = process.env['PVE_ENV_FILE']
	return pve.connect(envFile === undefined ? options : { ...options, envFile })
}

/** The password of the login user inside the target VM, from the environment. */
export function guestPassword(): string {
	const password = process.env['PVE_GUEST_PASSWORD']
	if (!password) throw new Error('PVE_GUEST_PASSWORD is not set; source the env file first')
	return password
}

export interface LiveFixtures {
	/** Names of the online nodes. */
	nodes: string[]
	/** Every guest in the cluster, by vmid. */
	guests: Map<number, GuestSummary>
	/** Storage ids visible on the scratch node. */
	storages: string[]
	/** ZFS pools on the scratch node. */
	pools: string[]
	/** Bridge names on the scratch node. */
	bridges: string[]
	/** The newest alpine container template on the template storage of the scratch node. */
	alpineTemplate: string | undefined
}

const NO_FIXTURES: LiveFixtures = {
	nodes: [],
	guests: new Map(),
	storages: [],
	pools: [],
	bridges: [],
	alpineTemplate: undefined,
}

async function probeFixtures(): Promise<LiveFixtures> {
	await using cluster = await connectLive()
	const nodes = (await cluster.nodes())
		.filter((entry) => entry.status === 'online')
		.map((entry) => entry.node)
	const guests = new Map((await cluster.list()).map((guest) => [guest.vmid, guest]))
	if (!nodes.includes(SCRATCH_NODE)) return { ...NO_FIXTURES, nodes, guests }

	const node = cluster.node(SCRATCH_NODE)
	const [storages, pools, interfaces] = await Promise.all([
		node.api.storage.list(),
		node.api.disks.listZfs(),
		node.api.network.list({ type: 'bridge' }),
	])
	const storageIds = storages.map((entry) => entry.storage)
	let alpineTemplate: string | undefined
	if (storageIds.includes(TEMPLATE_STORAGE)) {
		const templates = await node.api.storage.content(TEMPLATE_STORAGE, { content: 'vztmpl' })
		alpineTemplate = templates
			.filter((volume) => volume.volid.includes('alpine'))
			.sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0))[0]?.volid
	}
	return {
		nodes,
		guests,
		storages: storageIds,
		pools: pools.map((pool) => pool.name),
		bridges: interfaces.map((entry) => entry.iface),
		alpineTemplate,
	}
}

/** What the cluster holds, probed once per run. Empty without PVE_LIVE. */
export const fixtures: LiveFixtures = LIVE ? await probeFixtures() : NO_FIXTURES

function guestIs(vmid: number, type: 'qemu' | 'lxc', node?: string): boolean {
	const guest = fixtures.guests.get(vmid)
	return guest?.type === type && (node === undefined || guest.node === node)
}

/** Which fixtures the cluster holds; a test whose fixture is missing is skipped. */
export const has = {
	scratchNode: fixtures.nodes.includes(SCRATCH_NODE),
	targetNode: fixtures.nodes.includes(TARGET_NODE),
	storage: fixtures.storages.includes(SCRATCH_STORAGE),
	pool: fixtures.pools.includes(SCRATCH_POOL),
	bridge: fixtures.bridges.includes(SCRATCH_BRIDGE),
	alpineTemplate: fixtures.alpineTemplate !== undefined,
	targetVm: guestIs(TARGET_VM, 'qemu', TARGET_NODE),
	libraryCt: guestIs(LIBRARY_CT, 'lxc'),
	windowsVm: guestIs(WINDOWS_VM, 'qemu', TARGET_NODE),
	macosVm: guestIs(MACOS_VM, 'qemu', TARGET_NODE),
}

/** Everything a scratch VM needs: the node, its storage and its bridge. */
export const hasScratchVm = has.scratchNode && has.storage && has.bridge
/** A scratch container also needs the alpine template. */
export const hasScratchCt = hasScratchVm && has.alpineTemplate

export interface LiveSession {
	/** Connects. Call from beforeAll. */
	open(): Promise<PveCluster>
	/** The connected cluster. Throws when open has not run. */
	cluster(): PveCluster
	/** Closes the cluster. Call from afterAll. */
	close(): Promise<void>
}

/** One connection per test file, opened in beforeAll and closed in afterAll. */
export function liveSession(options: PveConnectOptions = {}): LiveSession {
	let current: PveCluster | undefined
	return {
		async open() {
			current = await connectLive(options)
			return current
		},
		cluster() {
			if (!current) throw new Error('The live session is not open')
			return current
		},
		async close() {
			const closing = current
			current = undefined
			await closing?.close()
		},
	}
}

/** Resolves with the guest handle, or undefined when no node holds the vmid. */
export async function findGuest(cluster: PveCluster, vmid: number): Promise<PveGuest | undefined> {
	try {
		return await cluster.guest(vmid)
	} catch (error) {
		if (error instanceof PveNotFoundError) return undefined
		throw error
	}
}

/**
 * Stops and purges a scratch guest when it exists, so a run starts and ends
 * without it. A guest holding the vmid under another name is left alone and
 * reported, since the vmid then belongs to someone else.
 */
export async function removeScratchGuest(cluster: PveCluster, vmid: number): Promise<void> {
	const guest = await findGuest(cluster, vmid)
	if (!guest) return
	const name =
		guest instanceof PveVm ? (await guest.config()).name : (await guest.config()).hostname
	if (!name?.startsWith(SCRATCH_PREFIX)) {
		throw new Error(
			`Guest ${vmid} is named '${name ?? ''}', not '${SCRATCH_PREFIX}*'; pick another scratch vmid`,
		)
	}
	if ((await guest.status()).runState !== 'stopped') {
		await guest.stop()
		await guest.waitFor('stopped', { timeoutMs: 2 * MINUTE })
	}
	await guest.delete({ purge: true, 'destroy-unreferenced-disks': true })
}

export function waitForAgent(vm: PveVm, timeoutMs = 3 * MINUTE): Promise<void> {
	return vm.waitForAgent({ timeoutMs })
}

/** Brings a VM to running with its agent answering, starting or resuming it when needed. */
export async function ensureRunning(vm: PveVm): Promise<void> {
	const status = await vm.status()
	if (status.runState === 'paused') {
		await vm.resume()
	} else if (status.runState === 'stopped') {
		await vm.start()
	}
	await vm.waitFor('running', { timeoutMs: 2 * MINUTE })
	await waitForAgent(vm)
}

/** The alpine container template the probe found. */
export function alpineTemplate(): string {
	if (fixtures.alpineTemplate === undefined) {
		throw new Error(`No alpine template on ${TEMPLATE_STORAGE} of ${SCRATCH_NODE}`)
	}
	return fixtures.alpineTemplate
}
