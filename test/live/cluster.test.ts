import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PveCluster } from '../../src/index.ts'
import {
	has,
	LIBRARY_CT,
	LIVE,
	liveSession,
	MINUTE,
	SCRATCH_STORAGE,
	SECOND,
	TARGET_VM,
} from './support.ts'

const TEST_POOL = 'pve-agent-test'

const session = liveSession()

async function removeTestPool(cluster: PveCluster): Promise<void> {
	const pools = await cluster.api.pools.list()
	if (!pools.some((pool) => pool.poolid === TEST_POOL)) return
	const pool = await cluster.api.pools.get(TEST_POOL)
	const vms = (pool.members ?? []).flatMap((member) =>
		member.vmid === undefined ? [] : [String(member.vmid)],
	)
	if (vms.length > 0) {
		await cluster.api.pools.update({ poolid: TEST_POOL, vms: vms.join(','), delete: true })
	}
	await cluster.api.pools.delete(TEST_POOL)
}

describe.skipIf(!LIVE)('cluster', () => {
	beforeAll(async () => {
		const cluster = await session.open()
		await removeTestPool(cluster)
	}, MINUTE)
	afterAll(async () => {
		await removeTestPool(session.cluster())
		await session.close()
	}, MINUTE)

	test(
		'the status reports every node and a quorate cluster',
		async () => {
			const cluster = session.cluster()
			const entries = await cluster.nodes()
			const rows = await cluster.api.status()
			const summary = rows.find((row) => row.type === 'cluster')
			expect(summary?.nodes).toBe(entries.length)
			expect(summary?.quorate).toBe(true)
			const online = rows.filter((row) => row.type === 'node' && row.online === true)
			expect(online.map((row) => row.name).sort()).toEqual(
				entries
					.filter((entry) => entry.status === 'online')
					.map((entry) => entry.node)
					.sort(),
			)
		},
		30 * SECOND,
	)

	test.skipIf(!has.targetVm || !has.libraryCt)(
		'the resources include the target guests',
		async () => {
			const vmids = (await session.cluster().api.resources({ type: 'vm' })).map((row) => row.vmid)
			expect(vmids).toContain(TARGET_VM)
			expect(vmids).toContain(LIBRARY_CT)
		},
		30 * SECOND,
	)

	test(
		'nextId is a free vmid',
		async () => {
			const vmid = await session.cluster().nextId()
			expect(Number.isInteger(vmid)).toBe(true)
			expect(vmid).toBeGreaterThanOrEqual(100)
		},
		30 * SECOND,
	)

	test.skipIf(!has.storage)(
		'the storage definitions include the scratch storage',
		async () => {
			const definitions = await session.cluster().api.storage.list()
			const scratch = definitions.find((entry) => entry.storage === SCRATCH_STORAGE)
			expect(scratch?.type.length).toBeGreaterThan(0)
			expect(definitions.every((entry) => entry.storage.length > 0)).toBe(true)
		},
		30 * SECOND,
	)

	test(
		'HA, backup, replication and firewall lists answer with typed rows',
		async () => {
			const api = session.cluster().api
			const [ha, backups, replication, rules] = await Promise.all([
				api.ha.listResources(),
				api.backup.list(),
				api.replication.list(),
				api.firewall.rules.list(),
			])
			for (const resource of ha) expect(resource.sid).toMatch(/^(vm|ct):\d+$/)
			for (const job of backups) expect(job.id.length).toBeGreaterThan(0)
			for (const job of replication) expect(job.id).toMatch(/^\d+-\d+$/)
			rules.forEach((rule, index) => expect(rule.pos).toBe(index))
		},
		30 * SECOND,
	)

	test.skipIf(!has.targetVm)(
		'a pool is created, filled, emptied and deleted',
		async () => {
			const pools = session.cluster().api.pools
			await pools.create({ poolid: TEST_POOL, comment: 'live suite scratch pool' })
			await pools.update({ poolid: TEST_POOL, vms: String(TARGET_VM) })
			const filled = await pools.get(TEST_POOL, { type: 'qemu' })
			expect(filled.members?.map((member) => member.vmid)).toContain(TARGET_VM)

			await pools.update({ poolid: TEST_POOL, vms: String(TARGET_VM), delete: true })
			const emptied = await pools.get(TEST_POOL)
			expect(emptied.members ?? []).toHaveLength(0)

			await pools.delete(TEST_POOL)
			const remaining = await pools.list()
			expect(remaining.some((pool) => pool.poolid === TEST_POOL)).toBe(false)
		},
		MINUTE,
	)
})
