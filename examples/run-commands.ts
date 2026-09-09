/**
 * Runs commands inside guests: through the QEMU guest agent and the OS helper
 * of a running Linux VM, and through pct exec on a scratch container.
 *
 *   PVE_ENV_FILE=./pve.env PVE_TARGET_VMID=100 PVE_STORAGE=local-zfs bun run examples/run-commands.ts
 *
 * Reads PVE_TARGET_VMID, a Linux VM with the guest agent installed; it is
 * started when stopped and left running. The container part reads PVE_NODE
 * (default: the PVE_NODE of the env file), PVE_STORAGE (default local-zfs),
 * PVE_TEMPLATE_STORAGE (default local), PVE_VMID (default 9012) and
 * PVE_BRIDGE (default vmbr1). An example guest already holding PVE_VMID is
 * deleted first, and the container is deleted before the script exits, after
 * a failure too. pct exec needs a root shell on the node: an SSH key for
 * root, or a root@pam ticket in the env file.
 */

import pve from '../src/index.ts'
import { alpineTemplate, env, EXAMPLE_PREFIX, MINUTE, removeGuest, runningVm } from './support.ts'

const TARGET_VMID = Number(env('PVE_TARGET_VMID'))
const STORAGE = env('PVE_STORAGE', 'local-zfs')
const TEMPLATE_STORAGE = env('PVE_TEMPLATE_STORAGE', 'local')
const VMID = Number(env('PVE_VMID', '9012'))
const BRIDGE = env('PVE_BRIDGE', 'vmbr1')

await using cluster = await pve.connect()

const target = await runningVm(cluster, TARGET_VMID, { agent: true })
console.log(`vm ${target.vmid} on ${target.node} running`)

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

const file = `/tmp/${EXAMPLE_PREFIX}${process.pid}.txt`
const content = `round trip ${Date.now()}\n`
await agent.fileWrite(file, content)
const read = await agent.fileRead(file)
await agent.output(['rm', file])
if (read.content !== content) throw new Error(`${file} read back ${JSON.stringify(read.content)}`)
console.log(`agent file ${file} round trip ${read.bytesRead} bytes`)

const node = cluster.node(process.env['PVE_NODE'])
const ostemplate = await alpineTemplate(node, TEMPLATE_STORAGE)

await removeGuest(cluster, VMID)
const ct = await cluster.createContainer({
	node: node.name,
	vmid: VMID,
	hostname: `${EXAMPLE_PREFIX}ct`,
	ostemplate,
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
