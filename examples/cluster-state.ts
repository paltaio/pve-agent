/**
 * Prints the state of the cluster: version, nodes, guests, storage per node,
 * the network interfaces of one node, the cluster firewall options, and the
 * HA resource and backup job counts. Sends GET requests only.
 *
 *   PVE_ENV_FILE=./pve.env bun run examples/cluster-state.ts
 *
 * Reads PVE_NODE for the node whose interfaces are listed. Without it the
 * PVE_NODE of the env file is used.
 */

import pve from '../src/index.ts'

function gib(bytes: number | undefined): string {
	return bytes === undefined ? '-' : `${(bytes / 1024 ** 3).toFixed(1)}G`
}

function percent(fraction: number | undefined): string {
	return fraction === undefined ? '-' : `${(fraction * 100).toFixed(1)}%`
}

await using cluster = await pve.connect()

const version = await cluster.version()
console.log(`pve-manager ${version.version} release ${version.release} repoid ${version.repoid}`)

const nodes = await cluster.nodes()
for (const entry of nodes) {
	console.log(
		`node ${entry.node} ${entry.status} cpu ${percent(entry.cpu)} mem ${gib(entry.mem)}/${gib(entry.maxmem)}`,
	)
}

const guests = await cluster.list()
for (const guest of guests) {
	console.log(
		`guest ${guest.vmid} ${guest.type} ${guest.node} ${guest.name ?? '-'} ${guest.status}`,
	)
}
console.log(`guests ${guests.length}`)

for (const entry of nodes) {
	if (entry.status !== 'online') continue
	for (const storage of await cluster.node(entry.node).api.storage.list()) {
		console.log(
			`storage ${entry.node} ${storage.storage} ${storage.type} ${gib(storage.used)}/${gib(storage.total)} active ${storage.active ?? false}`,
		)
	}
}

const node = cluster.node(process.env['PVE_NODE'])
for (const iface of await node.api.network.list()) {
	console.log(
		`interface ${node.name} ${iface.iface} ${iface.type} ${iface.cidr ?? iface.address ?? '-'} active ${iface.active ?? false}`,
	)
}

const firewall = await cluster.api.firewall.getOptions()
console.log(
	`firewall enable ${firewall.enable ?? 0} policy_in ${firewall.policy_in ?? '-'} policy_out ${firewall.policy_out ?? '-'}`,
)

const [ha, backups] = await Promise.all([cluster.api.ha.listResources(), cluster.api.backup.list()])
console.log(`ha resources ${ha.length} backup jobs ${backups.length}`)
