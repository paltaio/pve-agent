/**
 * Shared pieces of the live suite, which runs against the `palta` cluster.
 *
 * Run it from the repository root with:
 *
 *   set -a; . ./pve.env; set +a; PVE_LIVE=1 PVE_ENV_FILE=./pve.env bun test test/live
 *
 * PVE_LIVE_ALL=1 adds the Windows and macOS guest groups, which boot and shut
 * down whole desktops. Without PVE_LIVE every live test is reported as skipped.
 *
 * The connection variables come from the env file through the library. The
 * guest login password is PVE_GUEST_PASSWORD, read from the environment after
 * the file is sourced, or from the same file when it was not.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pve, {
	PveNotFoundError,
	type PveCluster,
	type PveConnectOptions,
	type PveGuest,
	type PveVm,
} from '../../src/index.ts'

export const LIVE = Boolean(process.env['PVE_LIVE'])
export const LIVE_ALL = LIVE && Boolean(process.env['PVE_LIVE_ALL'])

export const SECOND = 1000
export const MINUTE = 60 * SECOND

export const SCRATCH_NODE = 'ms01-0160'
export const SCRATCH_STORAGE = 'ms01-vms'
export const SCRATCH_BRIDGE = 'vmbr1'
export const SCRATCH_POOL = 'rpool'
export const TEMPLATE_STORAGE = 'local'
export const SCRATCH_PREFIX = 'pve-agent-test-'
export const SCRATCH_VM = 9001
export const SCRATCH_CT = 9002

export const TARGET_NODE = 'ms02-0078'
export const TARGET_VM = 101
export const TARGET_USER = 'debian'
export const LIBRARY_CT = 110
export const WINDOWS_VM = 107
export const MACOS_VM = 102

export const CLUSTER_VERSION = '9.2.11'

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

function envFilePath(): string {
	return process.env['PVE_ENV_FILE'] ?? resolve('pve.env')
}

/** Connects through the public entry point, pointing it at PVE_ENV_FILE when set. */
export function connectLive(options: PveConnectOptions = {}): Promise<PveCluster> {
	const envFile = process.env['PVE_ENV_FILE']
	return pve.connect(envFile === undefined ? options : { ...options, envFile })
}

/** The password of the login user inside the target VM. */
export function guestPassword(): string {
	const fromEnv = process.env['PVE_GUEST_PASSWORD']
	if (fromEnv) return fromEnv
	for (const rawLine of readFileSync(envFilePath(), 'utf8').split(/\r?\n/)) {
		const match = ENV_LINE.exec(rawLine.trim())
		if (match?.[1] === 'PVE_GUEST_PASSWORD' && match[2]) {
			return match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
		}
	}
	throw new Error(`PVE_GUEST_PASSWORD is neither in the environment nor in ${envFilePath()}`)
}

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

/** Stops and purges a scratch guest when it exists, so a run starts and ends without it. */
export async function removeScratchGuest(cluster: PveCluster, vmid: number): Promise<void> {
	const guest = await findGuest(cluster, vmid)
	if (!guest) return
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

/** The alpine container template on the scratch node's template storage. */
export async function alpineTemplate(cluster: PveCluster): Promise<string> {
	const volumes = await cluster
		.node(SCRATCH_NODE)
		.api.storage.content(TEMPLATE_STORAGE, { content: 'vztmpl' })
	const alpine = volumes.find((volume) => volume.volid.includes('alpine'))
	if (!alpine) {
		throw new Error(`No alpine template on ${TEMPLATE_STORAGE} of ${SCRATCH_NODE}`)
	}
	return alpine.volid
}
