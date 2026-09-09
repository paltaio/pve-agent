/**
 * Builds an LXC container from the newest alpine template on the node, reads
 * its config back, starts it, runs a command inside through pct, stops it and
 * deletes it.
 *
 *   PVE_ENV_FILE=./pve.env PVE_STORAGE=local-zfs bun run examples/create-container.ts
 *
 * Reads PVE_NODE (default: the PVE_NODE of the env file), PVE_STORAGE
 * (default local-zfs), PVE_TEMPLATE_STORAGE (default local), PVE_VMID
 * (default 9012) and PVE_BRIDGE (default vmbr1). An example guest already
 * holding PVE_VMID is deleted first, and the container is deleted before the
 * script exits, after a failure too. Running a command inside needs a root
 * shell on the node: an SSH key for root, or a root@pam ticket in the env
 * file.
 */

import pve from '../src/index.ts'
import { alpineTemplate, env, EXAMPLE_PREFIX, MINUTE, removeGuest } from './support.ts'

const STORAGE = env('PVE_STORAGE', 'local-zfs')
const TEMPLATE_STORAGE = env('PVE_TEMPLATE_STORAGE', 'local')
const VMID = Number(env('PVE_VMID', '9012'))
const BRIDGE = env('PVE_BRIDGE', 'vmbr1')

await using cluster = await pve.connect()
const node = cluster.node(process.env['PVE_NODE'])

const ostemplate = await alpineTemplate(node, TEMPLATE_STORAGE)
console.log(`template ${ostemplate}`)

await removeGuest(cluster, VMID)

const ct = await cluster.createContainer({
	node: node.name,
	vmid: VMID,
	hostname: `${EXAMPLE_PREFIX}ct`,
	ostemplate,
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
