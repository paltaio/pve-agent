import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PveNode } from '../../src/index.ts'
import {
	CLUSTER_VERSION,
	has,
	LIVE,
	liveSession,
	MINUTE,
	SCRATCH_BRIDGE,
	SCRATCH_NODE,
	SCRATCH_POOL,
	SCRATCH_STORAGE,
	SECOND,
} from './support.ts'

const session = liveSession()
const node = (): PveNode => session.cluster().node(SCRATCH_NODE)

describe.skipIf(!LIVE || !has.scratchNode)(`node ${SCRATCH_NODE}`, () => {
	beforeAll(() => session.open(), MINUTE)
	afterAll(() => session.close(), MINUTE)

	test(
		'status and version',
		async () => {
			const status = await node().status()
			expect(status.uptime).toBeGreaterThan(0)
			expect(status.pveversion).toContain(CLUSTER_VERSION)
			expect(status.memory?.total).toBeGreaterThan(0)
			const version = await node().api.version()
			expect(version.version).toBe(CLUSTER_VERSION)
		},
		30 * SECOND,
	)

	test.skipIf(!has.bridge)(
		'the network lists the scratch bridge as active',
		async () => {
			const interfaces = await node().api.network.list()
			const bridge = interfaces.find((entry) => entry.iface === SCRATCH_BRIDGE)
			expect(bridge?.type).toBe('bridge')
			expect(bridge?.active).toBe(true)
		},
		30 * SECOND,
	)

	test.skipIf(!has.storage || !has.pool)(
		'storage, disks and zfs pools',
		async () => {
			const storages = await node().api.storage.list()
			expect(storages.map((entry) => entry.storage)).toContain(SCRATCH_STORAGE)
			const disks = await node().api.disks.list()
			expect(disks.length).toBeGreaterThan(0)
			expect(disks.every((disk) => disk.devpath.startsWith('/dev/'))).toBe(true)
			const pools = await node().api.disks.listZfs()
			expect(pools.map((pool) => pool.name)).toContain(SCRATCH_POOL)
		},
		MINUTE,
	)

	test(
		'apt versions include the manager package',
		async () => {
			const versions = await node().api.apt.versions()
			const manager = versions.find((entry) => entry.Package === 'pve-manager')
			// Version is the candidate once an upgrade is available; OldVersion is what is installed.
			expect(manager?.OldVersion ?? manager?.Version).toContain(CLUSTER_VERSION)
		},
		30 * SECOND,
	)

	test(
		'the daemon is running',
		async () => {
			const services = await node().api.services.list()
			const daemon = services.find((entry) => entry.name === 'pvedaemon')
			expect(daemon?.state).toBe('running')
		},
		30 * SECOND,
	)

	test(
		'pci devices are listed',
		async () => {
			const devices = await node().api.hardware.listPci()
			expect(devices.length).toBeGreaterThan(0)
			expect(devices.every((device) => device.id.length > 0)).toBe(true)
		},
		30 * SECOND,
	)

	test(
		'a task page and the status of its first task',
		async () => {
			const page = await node().api.tasks.page({ limit: 5 })
			expect(page.tasks.length).toBeGreaterThan(0)
			expect(page.tasks.length).toBeLessThanOrEqual(5)
			const [first] = page.tasks
			if (!first) throw new Error('The task page is empty')
			const status = await node().api.tasks.status(first.upid)
			expect(status.upid).toBe(first.upid)
			expect(status.node).toBe(SCRATCH_NODE)
		},
		30 * SECOND,
	)

	test(
		'dns settings',
		async () => {
			const dns = await node().api.getDns()
			expect(dns.dns1 ?? dns.search).toBeDefined()
		},
		30 * SECOND,
	)
})
