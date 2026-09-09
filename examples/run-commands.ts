/**
 * Runs commands inside guests: through the QEMU guest agent and the OS helper
 * of a running Linux VM, and through pct exec on a scratch container.
 *
 *   PVE_ENV_FILE=./pve.env PVE_TARGET_VMID=101 PVE_STORAGE=local-zfs bun run examples/run-commands.ts
 *
 * Reads PVE_TARGET_VMID, a Linux VM with the guest agent installed; it is
 * started when stopped and left running. The container part reads PVE_NODE
 * (default: the PVE_NODE of the env file), PVE_STORAGE (default local-zfs),
 * PVE_TEMPLATE_STORAGE (default local), PVE_VMID (default 9012) and
 * PVE_BRIDGE (default vmbr1). A guest already holding PVE_VMID is deleted
 * first, and the container is deleted before the script exits, after a
 * failure too. pct exec needs a root shell on the node: an SSH key for
 * root, or a root@pam ticket in the env file.
 */

import pve, { PveNotFoundError, PveVm, type PveCluster, type VolumeEntry } from '../src/index.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND

function env(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (value === undefined) {
		console.error(`usage: ${name}=... PVE_ENV_FILE=./pve.env bun run examples/run-commands.ts`)
		process.exit(1)
	}
	return value
}

const TARGET_VMID = Number(env('PVE_TARGET_VMID'))
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

const target = await cluster.guest(TARGET_VMID)
if (!(target instanceof PveVm)) {
	console.error(`guest ${TARGET_VMID} is a container; PVE_TARGET_VMID names a VM`)
	process.exit(1)
}
const status = await target.status()
console.log(`vm ${target.vmid} on ${target.node} ${status.runState}`)
if (status.runState === 'paused') await target.resume()
if (status.runState === 'stopped') await target.start()
await target.waitFor('running', { timeoutMs: 2 * MINUTE })
await target.waitForAgent({ timeoutMs: 3 * MINUTE })

const agent = target.guest
await agent.ping()
const info = await agent.osInfo()
console.log(
	`agent os ${info['pretty-name'] ?? info.name ?? '-'} kernel ${info['kernel-release'] ?? '-'}`,
)
console.log(`agent uname ${await agent.output(['uname', '-a'])}`)

const os = await target.os
const uid = await os.run('id -u')
console.log(`os run id -u exit ${uid.exitCode} stdout ${uid.stdout.trim()}`)
const script = await os.sh(
	['set -e', 'for word in one two; do echo "$word"; done', 'uname -m'].join('\n'),
)
console.log(`os sh exit ${script.exitCode} stdout ${script.stdout.trim().split('\n').join(' ')}`)

const file = `/tmp/pve-agent-example-${process.pid}.txt`
const content = `round trip ${Date.now()}\n`
await agent.fileWrite(file, content)
const read = await agent.fileRead(file)
await agent.output(['rm', file])
if (read.content !== content) throw new Error(`${file} read back ${JSON.stringify(read.content)}`)
console.log(`agent file ${file} round trip ${read.bytesRead} bytes`)

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

await removeGuest(cluster, VMID)
const ct = await cluster.createContainer({
	node: node.name,
	vmid: VMID,
	hostname: 'pve-agent-example-ct',
	ostemplate: template.volid,
	rootfs: `${STORAGE}:1`,
	memory: 256,
	unprivileged: true,
	net0: `name=eth0,bridge=${BRIDGE}`,
})
console.log(`created ${ct.path}`)
try {
	await ct.start()
	await ct.waitFor('running', { timeoutMs: MINUTE })
	const uname = await ct.exec('uname -a')
	console.log(`ct exec exit ${uname.exitCode} stdout ${uname.stdout.trim()}`)
} finally {
	await removeGuest(cluster, VMID)
	console.log(`deleted ${VMID}`)
}
