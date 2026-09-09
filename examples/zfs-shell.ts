/**
 * ZFS, systemd and apt through the root shell on a node. Reads by default;
 * with PVE_ZFS_WRITE=1 it also creates, snapshots and destroys a dataset.
 *
 *   PVE_ENV_FILE=./pve.env bun run examples/zfs-shell.ts
 *   PVE_ZFS_WRITE=1 PVE_ENV_FILE=./pve.env bun run examples/zfs-shell.ts
 *
 * Reads PVE_NODE (default: the PVE_NODE of the env file), PVE_ZFS_POOL
 * (default rpool) and PVE_ZFS_WRITE. The shell needs an SSH key for root on
 * the node, or a root@pam ticket in the env file.
 *
 * The cluster's shell refuses `zfs destroy`, so the write path opens a
 * second shell with the destructive patterns allowed and uses it for the
 * destroy alone.
 */

import pve, { NodeShell } from '../src/index.ts'
import { env, EXAMPLE_PREFIX } from './support.ts'

function gib(bytes: number | undefined): string {
	return bytes === undefined ? '-' : `${(bytes / 1024 ** 3).toFixed(1)}G`
}

const POOL = env('PVE_ZFS_POOL', 'rpool')
const WRITE = process.env['PVE_ZFS_WRITE'] === '1'
const DATASET = `${POOL}/${EXAMPLE_PREFIX}dataset`

await using cluster = await pve.connect()
const node = cluster.node(process.env['PVE_NODE'])
const shell = await node.shell
console.log(`shell ${node.name} ${shell.kind}`)

for (const pool of await shell.zfs.listPools()) {
	console.log(
		`pool ${pool.name} ${pool.health} ${gib(pool.allocatedBytes)}/${gib(pool.sizeBytes)} ${pool.capacityPercent}% used ${pool.fragmentationPercent}% fragmented`,
	)
}

for (const status of await shell.zfs.poolStatus(POOL)) {
	console.log(
		`status ${status.name} ${status.state} errors ${status.errors} scan ${status.scan ?? '-'}`,
	)
	for (const device of status.devices) {
		console.log(
			`  ${device.name} ${device.state} read ${device.readErrors} write ${device.writeErrors} cksum ${device.checksumErrors}`,
		)
	}
}

for (const dataset of await shell.zfs.listDatasets({ target: POOL, depth: 1 })) {
	console.log(
		`dataset ${dataset.name} ${dataset.type} used ${gib(dataset.usedBytes)} avail ${gib(dataset.availableBytes)} compression ${dataset.compression ?? '-'}`,
	)
}

const pvestatd = await shell.systemd.status('pvestatd')
console.log(
	`systemd pvestatd ${pvestatd.activeState} ${pvestatd.subState} pid ${pvestatd.mainPid} restarts ${pvestatd.restarts}`,
)

console.log(
	`apt pve-manager ${(await shell.apt.installedVersion('pve-manager')) ?? 'not installed'}`,
)

if (WRITE) {
	const destructive = await NodeShell.open({
		node: node.name,
		client: cluster.client,
		policy: { destructive: 'allow' },
	})
	try {
		const existing = await shell.zfs.listDatasets({ target: POOL, depth: 1 })
		if (existing.some((dataset) => dataset.name === DATASET)) {
			await destructive.zfs.destroyDataset(DATASET, { recursive: true })
			console.log(`destroyed leftover ${DATASET}`)
		}

		await shell.zfs.createDataset(DATASET, { properties: { compression: 'lz4' } })
		console.log(`created ${DATASET}`)

		await shell.zfs.snapshot(`${DATASET}@s1`)
		const snapshots = await shell.zfs.listSnapshots(DATASET)
		console.log(`snapshots ${snapshots.map((snapshot) => snapshot.name).join(' ')}`)
	} finally {
		await destructive.zfs.destroyDataset(DATASET, { recursive: true })
		console.log(`destroyed ${DATASET}`)
		await destructive.close()
	}
} else {
	console.log('write path skipped, set PVE_ZFS_WRITE=1 to create, snapshot and destroy a dataset')
}
