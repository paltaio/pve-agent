import { afterEach, describe, expect, test } from 'bun:test'
import { PveTierError } from '../core/errors.ts'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { listNodes, NodeApi } from './node.ts'

afterEach(closeMockClients)

const UPID = 'UPID:ms01-0160:00000001:00000001:00000001:startall::root@pam:'

describe('listNodes', () => {
	test('reads the cluster-wide index', async () => {
		const mock = mockClient()
		mock.reply({ data: [{ node: 'ms01-0160', status: 'online' }] })
		expect(await listNodes(mock.client)).toHaveLength(1)
		expect(mock.last().path).toBe('/nodes')
	})
})

describe('NodeApi', () => {
	test('the reads hit their paths', async () => {
		const mock = mockClient()
		const node = new NodeApi(mock.client, 'ms01-0160')
		for (const [call, path, data] of [
			[() => node.status(), '/nodes/ms01-0160/status', { uptime: 1 }],
			[() => node.version(), '/nodes/ms01-0160/version', { version: '9.2.11' }],
			[() => node.getConfig({ property: 'acme' }), '/nodes/ms01-0160/config?property=acme', {}],
			[() => node.getDns(), '/nodes/ms01-0160/dns', { search: 'lan' }],
			[() => node.getTime(), '/nodes/ms01-0160/time', { timezone: 'UTC' }],
			[() => node.report(), '/nodes/ms01-0160/report', 'text'],
			[() => node.syslog({ limit: 5 }), '/nodes/ms01-0160/syslog?limit=5', []],
			[
				() => node.journal({ lastentries: 5, kernel: true }),
				'/nodes/ms01-0160/journal?lastentries=5&kernel=1',
				[],
			],
			[() => node.netstat(), '/nodes/ms01-0160/netstat', []],
			[() => node.capabilities(), '/nodes/ms01-0160/capabilities', []],
			[() => node.getSubscription(), '/nodes/ms01-0160/subscription', { status: 'notfound' }],
			[() => node.request('GET', '/status'), '/nodes/ms01-0160/status', {}],
		] as const) {
			mock.reply({ data })
			await call()
			expect([mock.last().method, mock.last().path]).toEqual(['GET', path])
		}
	})

	test('power and system settings', async () => {
		const mock = mockClient()
		const node = new NodeApi(mock.client, 'ms01-0160')

		await node.reboot()
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/nodes/ms01-0160/status'])
		expect(formObject(mock.last())).toEqual({ command: 'reboot' })
		await node.shutdown()
		expect(formObject(mock.last())).toEqual({ command: 'shutdown' })

		await node.setConfig({ description: 'edge node', 'startall-onboot-delay': 30 })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/nodes/ms01-0160/config'])
		expect(formObject(mock.last())).toEqual({
			description: 'edge node',
			'startall-onboot-delay': '30',
		})
		await node.setDns({ search: 'lan', dns1: '192.0.2.1' })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/nodes/ms01-0160/dns'])
		expect(formObject(mock.last())).toEqual({ search: 'lan', dns1: '192.0.2.1' })
		await node.setTimezone('UTC')
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/nodes/ms01-0160/time'])
		expect(formObject(mock.last())).toEqual({ timezone: 'UTC' })
	})

	test('setHosts sends the whole file with the digest from the read', async () => {
		const mock = mockClient()
		const node = new NodeApi(mock.client, 'ms01-0160')
		mock.reply({ data: { data: '127.0.0.1 localhost\n', digest: 'abc' } })
		const hosts = await node.getHosts()
		await node.setHosts(`${hosts.data}10.0.0.1 db\n`, { digest: hosts.digest })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/nodes/ms01-0160/hosts'])
		expect(formObject(mock.last())).toEqual({
			data: '127.0.0.1 localhost\n10.0.0.1 db\n',
			digest: 'abc',
		})
	})

	test('subscription and wake-on-lan', async () => {
		const mock = mockClient()
		const node = new NodeApi(mock.client, 'ms01-0160')
		await node.setSubscriptionKey('pve4c-0000000000')
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/nodes/ms01-0160/subscription'])
		expect(formObject(mock.last())).toEqual({ key: 'pve4c-0000000000' })
		await node.refreshSubscription({ force: true })
		expect(mock.last().method).toBe('POST')
		expect(formObject(mock.last())).toEqual({ force: '1' })
		await node.deleteSubscription()
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			'/nodes/ms01-0160/subscription',
		])
		mock.reply({ data: 'BC:24:11:00:00:01' })
		expect(await node.wakeOnLan()).toBe('BC:24:11:00:00:01')
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/nodes/ms01-0160/wakeonlan'])
	})

	test('the bulk guest actions return UPIDs', async () => {
		const mock = mockClient()
		const node = new NodeApi(mock.client, 'ms01-0160')
		for (const [call, path, body] of [
			[() => node.startAll({ force: true }), '/nodes/ms01-0160/startall', { force: '1' }],
			[() => node.stopAll({ timeout: 60 }), '/nodes/ms01-0160/stopall', { timeout: '60' }],
			[() => node.suspendAll({ vms: '110' }), '/nodes/ms01-0160/suspendall', { vms: '110' }],
			[
				() => node.migrateAll({ target: 'ms02-0066', 'with-local-disks': true }),
				'/nodes/ms01-0160/migrateall',
				{ target: 'ms02-0066', 'with-local-disks': '1' },
			],
		] as const) {
			mock.reply({ data: UPID })
			expect(await call()).toBe(UPID)
			expect([mock.last().method, mock.last().path]).toEqual(['POST', path])
			expect(formObject(mock.last())).toEqual(body)
		}
	})

	test('execute sends the commands as one JSON string on a root ticket', async () => {
		const mock = mockClient()
		mock.reply({ data: [{ status: 200, data: { uptime: 1 } }] })
		const results = await new NodeApi(mock.client, 'ms01-0160').execute([
			{ path: 'status', method: 'GET' },
			{ path: 'qemu/110/status/current', method: 'GET', args: {} },
		])
		expect(results[0]?.status).toBe(200)
		expect(mock.last().path).toBe('/nodes/ms01-0160/execute')
		expect(JSON.parse(formObject(mock.last())['commands'] ?? '')).toEqual([
			{ path: 'status', method: 'GET' },
			{ path: 'qemu/110/status/current', method: 'GET', args: {} },
		])
		expect(mock.last().headers['cookie']).toContain('PVEAuthCookie=')
	})

	test('execute without a root ticket fails before any request', async () => {
		const mock = mockClient({ ticket: false })
		await expect(
			new NodeApi(mock.client, 'ms01-0160').execute([{ path: 'status', method: 'GET' }]),
		).rejects.toBeInstanceOf(PveTierError)
		expect(mock.calls()).toHaveLength(0)
	})
})
