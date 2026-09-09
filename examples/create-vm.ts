/**
 * Builds a VM, reads its config back, boots it, takes a screenshot of the
 * firmware screen, stops it and deletes it.
 *
 *   PVE_ENV_FILE=./pve.env PVE_STORAGE=local-zfs bun run examples/create-vm.ts
 *
 * Reads PVE_NODE (default: the PVE_NODE of the env file), PVE_STORAGE
 * (default local-zfs), PVE_VMID (default 9011), PVE_BRIDGE (default vmbr1)
 * and PVE_SHOT, a PNG path the screenshot is written to when set. A guest
 * already holding PVE_VMID is deleted first, and the VM is deleted before
 * the script exits, after a failure too.
 */

import pve, { PveNotFoundError, type PveCluster } from '../src/index.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND

function env(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (value === undefined) {
		console.error(`usage: ${name}=... PVE_ENV_FILE=./pve.env bun run examples/create-vm.ts`)
		process.exit(1)
	}
	return value
}

const STORAGE = env('PVE_STORAGE', 'local-zfs')
const VMID = Number(env('PVE_VMID', '9011'))
const BRIDGE = env('PVE_BRIDGE', 'vmbr1')
const SHOT = process.env['PVE_SHOT']

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
const node = cluster.node(process.env['PVE_NODE']).name

await removeGuest(cluster, VMID)

const vm = await cluster.createVm({
	node,
	vmid: VMID,
	name: 'pve-agent-example-vm',
	memory: '512',
	cores: 1,
	ostype: 'l26',
	scsihw: 'virtio-scsi-single',
	scsi0: `${STORAGE}:1`,
	net0: `virtio,bridge=${BRIDGE}`,
})
console.log(`created ${vm.path}`)

try {
	const config = await vm.config()
	console.log(
		`config memory ${config.memory} cores ${config.cores} ostype ${config.ostype} scsihw ${config.scsihw}`,
	)
	console.log(
		`config scsi0 ${config.disks['scsi0']?.['file']} size ${config.disks['scsi0']?.['size']}`,
	)
	console.log(
		`config net0 ${config.nets['net0']?.['model']} bridge ${config.nets['net0']?.['bridge']} mac ${config.nets['net0']?.['macaddr']}`,
	)

	await vm.start()
	const running = await vm.waitFor('running', { timeoutMs: MINUTE })
	console.log(`running pid ${running.pid} qemu ${running.runningQemu}`)

	if (SHOT !== undefined) {
		// The firmware paints its 720x400 text screen a few seconds after the
		// start task ends.
		await vm.kvm.waitForScreen((frame) => frame.width === 720 && frame.height === 400, {
			timeoutMs: 30 * SECOND,
		})
		const shot = await vm.kvm.screenshot({ format: 'png', fresh: true })
		await Bun.write(SHOT, shot.data)
		console.log(`screenshot ${SHOT} ${shot.width}x${shot.height} ${shot.data.length} bytes`)
	}

	await vm.stop()
	await vm.waitFor('stopped', { timeoutMs: MINUTE })
	console.log('stopped')
} finally {
	await removeGuest(cluster, VMID)
	console.log(`deleted ${VMID}`)
}
