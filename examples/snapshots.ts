/**
 * Snapshots a scratch VM, changes its config, rolls the change back and
 * deletes the snapshot and the VM.
 *
 *   PVE_ENV_FILE=./pve.env PVE_STORAGE=local-zfs bun run examples/snapshots.ts
 *
 * Reads PVE_NODE (default: the PVE_NODE of the env file), PVE_STORAGE
 * (default local-zfs) and PVE_VMID (default 9011). A guest already holding
 * PVE_VMID is deleted first, and the VM is deleted before the script exits,
 * after a failure too.
 */

import pve, { PveNotFoundError, type PveCluster } from '../src/index.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND

function env(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback
	if (value === undefined) {
		console.error(`usage: ${name}=... PVE_ENV_FILE=./pve.env bun run examples/snapshots.ts`)
		process.exit(1)
	}
	return value
}

const STORAGE = env('PVE_STORAGE', 'local-zfs')
const VMID = Number(env('PVE_VMID', '9011'))

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
	name: 'pve-agent-example-snapshots',
	memory: '512',
	cores: 1,
	ostype: 'l26',
	scsihw: 'virtio-scsi-single',
	scsi0: `${STORAGE}:1`,
})
console.log(`created ${vm.path}`)

try {
	await vm.snapshot('s1', { description: 'memory 512' })
	console.log('snapshot s1 taken')

	await vm.configure({ memory: '768' })
	console.log(`memory ${(await vm.config()).memory}`)

	for (const snapshot of await vm.snapshots()) {
		console.log(
			`snapshot ${snapshot.name} current ${snapshot.current} parent ${snapshot.parent ?? '-'} description ${snapshot.description ?? '-'}`,
		)
	}

	await vm.rollback('s1')
	const memory = (await vm.config()).memory
	console.log(`rolled back to s1, memory ${memory}`)
	if (memory !== 512) throw new Error(`memory is ${memory} after the rollback, expected 512`)

	await vm.deleteSnapshot('s1')
	const names = (await vm.snapshots()).map((snapshot) => snapshot.name)
	console.log(`snapshots after delete ${names.join(' ')}`)
} finally {
	await removeGuest(cluster, VMID)
	console.log(`deleted ${VMID}`)
}
