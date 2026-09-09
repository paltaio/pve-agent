/**
 * Builds an LXC container from the newest alpine template on the node, reads
 * its config back, starts it, runs a command inside through pct, stops it and
 * deletes it.
 *
 *   PVE_ENV_FILE=./pve.env PVE_STORAGE=local-zfs bun run examples/create-container.ts
 *
 * Reads PVE_NODE (default: the PVE_NODE of the env file), PVE_STORAGE
 * (default local-zfs), PVE_TEMPLATE_STORAGE (default local), PVE_VMID
 * (default 9012) and PVE_BRIDGE (default vmbr1). A guest already holding
 * PVE_VMID is deleted first, and the container is deleted before the script
 * exits, after a failure too. Running a command inside needs a root shell on
 * the node: an SSH key for root, or a root@pam ticket in the env file.
 */

import pve, { PveNotFoundError, type PveCluster, type VolumeEntry } from '../src/index.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND

function env(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (value === undefined) {
		console.error(`usage: ${name}=... PVE_ENV_FILE=./pve.env bun run examples/create-container.ts`)
		process.exit(1)
	}
	return value
}

const STORAGE = env('PVE_STORAGE', 'local-zfs')
const TEMPLATE_STORAGE = env('PVE_TEMPLATE_STORAGE', 'local')
const VMID = Number(env('PVE_VMID', '9012'))
const BRIDGE = env('PVE_BRIDGE', 'vmbr1')

async function removeGuest(cluster: PveCluster, vmid: number): Promise<void> {
	let guest
	try {
		guest = await cluster.guest(vmid)
	} catch (error) {
		if (error instanceof PveNotFoundError) return
		throw error
	}
	if ((await guest.status()).runState !== 'stopped') {
		await guest.stop()
		await guest.waitFor('stopped', { timeoutMs: 2 * MINUTE })
	}
	await guest.delete({ purge: true, 'destroy-unreferenced-disks': true })
}

await using cluster = await pve.connect()
const node = cluster.node(process.env['PVE_NODE'])

let template: VolumeEntry | undefined
for (const volume of await node.api.storage.content(TEMPLATE_STORAGE, { content: 'vztmpl' })) {
	if (!volume.volid.includes('alpine')) continue
	if (template === undefined || (volume.ctime ?? 0) > (template.ctime ?? 0)) template = volume
}
if (template === undefined) {
	console.error(`no alpine template on ${TEMPLATE_STORAGE} of ${node.name}`)
	process.exit(1)
}
console.log(`template ${template.volid}`)

await removeGuest(cluster, VMID)

const ct = await cluster.createContainer({
	node: node.name,
	vmid: VMID,
	hostname: 'pve-agent-example-ct',
	ostemplate: template.volid,
	rootfs: `${STORAGE}:1`,
	memory: 256,
	cores: 1,
	unprivileged: true,
	net0: `name=eth0,bridge=${BRIDGE}`,
})
console.log(`created ${ct.path}`)

try {
	const config = await ct.config()
	console.log(
		`config hostname ${config.hostname} memory ${config.memory} unprivileged ${config.unprivileged} rootfs ${config.rootfs?.['volume']}`,
	)

	await ct.start()
	await ct.waitFor('running', { timeoutMs: MINUTE })
	console.log('running')

	const release = await ct.exec('cat /etc/os-release')
	const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(release.stdout)?.[1] ?? '-'
	console.log(`pct exec exit ${release.exitCode} os ${pretty}`)

	await ct.stop()
	await ct.waitFor('stopped', { timeoutMs: MINUTE })
	console.log('stopped')
} finally {
	await removeGuest(cluster, VMID)
	console.log(`deleted ${VMID}`)
}
