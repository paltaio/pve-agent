/**
 * Helpers the example scripts share: the variables they read, the scratch
 * guests they create and remove, and the target VM they drive.
 */

import { basename } from 'node:path'
import { PveNotFoundError, PveVm, type PveCluster, type PveNode } from '../src/index.ts'

export const SECOND = 1000
export const MINUTE = 60 * SECOND

/** Every guest an example creates is named with this prefix, and only such a guest is removed. */
export const EXAMPLE_PREFIX = 'pve-agent-example-'

const LOGIN_PROMPT = /login: ?$/
const SERIAL_GETTY = 'serial-getty@ttyS0.service'

/** A variable the script reads; without a fallback it is required. */
export function env(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (value === undefined) {
		const script = basename(process.argv[1] ?? 'example.ts')
		console.error(`usage: ${name}=... PVE_ENV_FILE=./pve.env bun run examples/${script}`)
		process.exit(1)
	}
	return value
}

/**
 * Stops and purges the guest holding the vmid so the example starts and ends
 * without it. A guest named outside the example prefix is left alone and the
 * script exits, since the vmid then belongs to someone else.
 */
export async function removeGuest(cluster: PveCluster, vmid: number): Promise<void> {
	let guest
	try {
		guest = await cluster.guest(vmid)
	} catch (error) {
		if (error instanceof PveNotFoundError) return
		throw error
	}
	const name =
		guest instanceof PveVm ? (await guest.config()).name : (await guest.config()).hostname
	if (!name?.startsWith(EXAMPLE_PREFIX)) {
		console.error(
			`guest ${vmid} is named '${name ?? ''}', not '${EXAMPLE_PREFIX}*'; pick another PVE_VMID`,
		)
		process.exit(1)
	}
	if ((await guest.status()).runState !== 'stopped') {
		await guest.stop()
		await guest.waitFor('stopped', { timeoutMs: 2 * MINUTE })
	}
	await guest.delete({ purge: true, 'destroy-unreferenced-disks': true })
}

/** The newest alpine container template on a storage of the node. */
export async function alpineTemplate(node: PveNode, storage: string): Promise<string> {
	const templates = await node.api.storage.content(storage, { content: 'vztmpl' })
	const newest = templates
		.filter((volume) => volume.volid.includes('alpine'))
		.sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0))[0]
	if (newest === undefined) {
		console.error(`no alpine template on ${storage} of ${node.name}`)
		process.exit(1)
	}
	return newest.volid
}

/**
 * The VM the vmid names, running. With `agent` it also waits for the guest
 * agent to answer. A vmid that names a container ends the script.
 */
export async function runningVm(
	cluster: PveCluster,
	vmid: number,
	options: { agent?: boolean } = {},
): Promise<PveVm> {
	const vm = await cluster.guest(vmid)
	if (!(vm instanceof PveVm)) {
		console.error(`guest ${vmid} is a container; PVE_TARGET_VMID names a VM`)
		process.exit(1)
	}
	const status = await vm.status()
	if (status.runState === 'paused') await vm.resume()
	if (status.runState === 'stopped') await vm.start()
	await vm.waitFor('running', { timeoutMs: 2 * MINUTE })
	if (options.agent) await vm.waitForAgent({ timeoutMs: 3 * MINUTE })
	return vm
}

/**
 * Brings the serial console to a login prompt. A getty started by hand does
 * not survive a reboot, so when nothing answers the agent starts the unit
 * again; a shell an earlier login left behind is logged out.
 */
export async function reachLoginPrompt(vm: PveVm): Promise<void> {
	const serial = vm.console
	await serial.sendLine('')
	let screen: string
	try {
		screen = await serial.waitForText(/login:|\$ /, { timeoutMs: 15 * SECOND })
	} catch {
		await vm.waitForAgent({ timeoutMs: MINUTE })
		await vm.guest.output(['systemctl', 'start', SERIAL_GETTY])
		console.log(`started ${SERIAL_GETTY} through the agent`)
		screen = await serial.waitForText(/login:/, { timeoutMs: 30 * SECOND })
	}
	const lastLine = screen.trimEnd().split('\n').at(-1) ?? ''
	if (!LOGIN_PROMPT.test(lastLine)) await serial.sendLine('exit')
	await serial.waitForPrompt({ pattern: LOGIN_PROMPT, timeoutMs: 30 * SECOND })
}

/** The pattern a login prompt ends with, for waiting on it after a logout. */
export { LOGIN_PROMPT }
