import { afterEach, describe, expect, test } from 'bun:test'
import { PveTierError } from '../core/errors.ts'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { listContainers, LxcApi } from './lxc.ts'

afterEach(closeMockClients)

const path = '/nodes/ms01-0160/lxc/9000'
const upid = 'UPID:ms01:00000001:00000001:00000001:vzstart:9000:agents@pve:'

describe('LxcApi', () => {
	test('binds the sub-objects to the container path and has no agent or reset', () => {
		const mock = mockClient()
		const ct = new LxcApi(mock.client, 'ms01-0160', 9000)
		expect(ct.type).toBe('lxc')
		expect(ct.path).toBe(path)
		expect(ct.snapshots.path).toBe(`${path}/snapshot`)
		expect(ct.firewall.rules.path).toBe(`${path}/firewall/rules`)
		expect('agent' in ct).toBe(false)
		expect('reset' in ct).toBe(false)
		expect('setConfigAsync' in ct).toBe(false)
	})

	test('sends the power calls LXC has', async () => {
		const mock = mockClient()
		const ct = new LxcApi(mock.client, 'ms01-0160', 9000)
		for (let i = 0; i < 6; i += 1) mock.reply({ data: upid })

		expect(await ct.start({ debug: true })).toBe(upid)
		await ct.stop({ 'overrule-shutdown': true })
		await ct.shutdown({ timeout: 30 })
		await ct.reboot()
		await ct.suspend()
		await ct.resume()

		expect(mock.calls().map((call) => `${call.method} ${call.path}`)).toEqual([
			`POST ${path}/status/start`,
			`POST ${path}/status/stop`,
			`POST ${path}/status/shutdown`,
			`POST ${path}/status/reboot`,
			`POST ${path}/status/suspend`,
			`POST ${path}/status/resume`,
		])
		expect(formObject(mock.calls()[0] ?? mock.last())).toEqual({ debug: '1' })
	})

	test('reads status and config into normalized rows', async () => {
		const mock = mockClient()
		const ct = new LxcApi(mock.client, 'ms01-0160', 9000)

		mock.reply({ data: { status: 'running', ha: { managed: 0 } } })
		expect((await ct.status()).runState).toBe('running')
		expect(mock.last().path).toBe(`${path}/status/current`)

		mock.reply({
			data: { hostname: 'ct', unprivileged: 1, rootfs: 'ms01-vms:subvol-9000-disk-0,size=1G' },
		})
		const config = await ct.getConfig({ snapshot: 's1' })
		expect(mock.last().path).toBe(`${path}/config?snapshot=s1`)
		expect(config.hostname).toBe('ct')
		expect(config.unprivileged).toBe(true)
		expect(config.rootfs?.['size']).toBe('1G')
	})

	test('writes config through the synchronous PUT only', async () => {
		const mock = mockClient()
		const ct = new LxcApi(mock.client, 'ms01-0160', 9000)

		await ct.setConfig({ memory: 512, mp0: 'local-zfs:8,mp=/data' })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', `${path}/config`])
		expect(formObject(mock.last())).toEqual({ memory: '512', mp0: 'local-zfs:8,mp=/data' })

		await ct.deleteConfigKeys('mp0', { digest: 'd' })
		expect(formObject(mock.last())).toEqual({ digest: 'd', delete: 'mp0' })

		await ct.revertPending(['memory'])
		expect(formObject(mock.last())).toEqual({ revert: 'memory' })
	})

	test('sends the volume, clone, migrate and template calls', async () => {
		const mock = mockClient()
		const ct = new LxcApi(mock.client, 'ms01-0160', 9000)

		await ct.toTemplate()
		await ct.interfaces()
		await ct.moveVolume({ volume: 'mp0', storage: 'local-zfs', delete: true })
		await ct.resize({ disk: 'rootfs', size: '32G' })
		await ct.clone({ newid: 9010 })
		await ct.migrate({ target: 'ms02-0066', restart: true })
		mock.reply({ data: { running: 0, 'allowed-nodes': ['ms02-0066'] } })
		const pre = await ct.migratePreconditions()
		mock.reply({ data: upid })
		await ct.delete({ purge: true, force: true })

		expect(mock.calls().map((call) => `${call.method} ${call.path}`)).toEqual([
			`POST ${path}/template`,
			`GET ${path}/interfaces`,
			`POST ${path}/move_volume`,
			`PUT ${path}/resize`,
			`POST ${path}/clone`,
			`POST ${path}/migrate`,
			`GET ${path}/migrate`,
			`DELETE ${path}?purge=1&force=1`,
		])
		expect(formObject(mock.calls()[2] ?? mock.last())).toEqual({
			volume: 'mp0',
			storage: 'local-zfs',
			delete: '1',
		})
		expect(pre.allowedNodes).toEqual(['ms02-0066'])
	})

	test('separates a volume mount point from a bind mount point on a token-only client', async () => {
		const mock = mockClient({ ticket: false })
		const ct = new LxcApi(mock.client, 'ms01-0160', 9000)

		await ct.setConfig({ mp0: 'local-zfs:8,mp=/data' })
		expect(mock.calls()).toHaveLength(1)

		await expect(ct.setConfig({ mp1: '/srv/host,mp=/srv' })).rejects.toBeInstanceOf(PveTierError)
		await expect(ct.setConfig({ features: 'fuse=1' })).rejects.toThrow(/features/)
		expect(mock.calls()).toHaveLength(1)
	})
})

describe('listContainers', () => {
	test('normalizes the node index', async () => {
		const mock = mockClient()
		mock.reply({ data: [{ vmid: 110, name: 'ct', status: 'running', cpus: 4, tags: 'x' }] })
		const [ct] = await listContainers(mock.client, 'ms02-0078')
		expect(mock.last().path).toBe('/nodes/ms02-0078/lxc')
		expect(ct).toMatchObject({ type: 'lxc', node: 'ms02-0078', vmid: 110, maxcpu: 4, tags: ['x'] })
	})
})
