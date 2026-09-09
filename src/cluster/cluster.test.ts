import { afterEach, describe, expect, test } from 'bun:test'
import { PveError } from '../core/errors.ts'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterApi, nextVmid } from './cluster.ts'

afterEach(closeMockClients)

describe('status and resources', () => {
	test('status reads the quorum and locality flags as booleans', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{ id: 'cluster', type: 'cluster', name: 'palta', nodes: 3, quorate: 1, version: 4 },
				{ id: 'node/ms02-0066', type: 'node', name: 'ms02-0066', local: 1, online: 1, nodeid: 2 },
			],
		})
		const [cluster, node] = await new ClusterApi(mock.client).status()
		expect(mock.last().path).toBe('/cluster/status')
		expect(cluster?.quorate).toBe(true)
		expect(cluster?.nodes).toBe(3)
		expect(node?.local).toBe(true)
		expect(node?.online).toBe(true)
		expect(node?.quorate).toBeUndefined()
		expect(node?.raw['local']).toBe(1)
	})

	test('resources passes the type filter and normalizes guest rows', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{ id: 'lxc/110', type: 'lxc', node: 'ms02-0078', vmid: 110, template: 0, tags: 'prod;db' },
			],
		})
		const [row] = await new ClusterApi(mock.client).resources({ type: 'vm' })
		expect(mock.last().path).toBe('/cluster/resources?type=vm')
		expect(row?.template).toBe(false)
		expect(row?.tags).toEqual(['prod', 'db'])
		expect(row?.raw['template']).toBe(0)
	})

	test('guestNodes maps every guest vmid to its type and node', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{ id: 'qemu/101', type: 'qemu', node: 'ms02-0078', vmid: 101 },
				{ id: 'lxc/110', type: 'lxc', node: 'ms02-0066', vmid: 110 },
				{ id: 'storage/ms01-0160/local', type: 'storage', node: 'ms01-0160' },
			],
		})
		const guests = await new ClusterApi(mock.client).guestNodes()
		expect(mock.last().path).toBe('/cluster/resources?type=vm')
		expect([...guests.keys()]).toEqual([101, 110])
		expect(guests.get(101)).toEqual({ vmid: 101, type: 'qemu', node: 'ms02-0078' })
		expect(guests.get(110)?.type).toBe('lxc')
	})
})

describe('nextid', () => {
	test('reads the JSON string the handler sends as a number', async () => {
		const mock = mockClient()
		mock.reply({ data: '100' })
		expect(await new ClusterApi(mock.client).nextId()).toBe(100)
		expect(mock.last().path).toBe('/cluster/nextid')
	})

	test('asserts a vmid through the query string', async () => {
		const mock = mockClient()
		mock.reply({ data: 9000 })
		expect(await nextVmid(mock.client, 9000)).toBe(9000)
		expect(mock.last().path).toBe('/cluster/nextid?vmid=9000')
	})

	test('rejects an answer that is not a number', async () => {
		const mock = mockClient()
		mock.reply({ data: 'nope' })
		await expect(nextVmid(mock.client)).rejects.toBeInstanceOf(PveError)
	})
})

describe('tasks, log and options', () => {
	test('a task row carries its exit status in exitStatus', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{
					upid: 'UPID:a:1:1:1:vzdump::root@pam:',
					node: 'a',
					starttime: 10,
					endtime: 20,
					status: 'OK',
				},
				{ upid: 'UPID:b:1:1:1:vzdump::root@pam:', node: 'b', starttime: 30 },
			],
		})
		const [done, running] = await new ClusterApi(mock.client).tasks()
		expect(mock.last().path).toBe('/cluster/tasks')
		expect(done?.exitStatus).toBe('OK')
		expect(done?.outcome).toBe('ok')
		expect(running?.status).toBe('running')
		expect(running?.exitStatus).toBeNull()
	})

	test('log caps the line count through max', async () => {
		const mock = mockClient()
		mock.reply({ data: [] })
		await new ClusterApi(mock.client).log({ max: 5 })
		expect(mock.last().path).toBe('/cluster/log?max=5')
	})

	test('options are read raw and written as form fields', async () => {
		const mock = mockClient()
		mock.reply({ data: { keyboard: 'en-us', migration: 'type=secure' } })
		const cluster = new ClusterApi(mock.client)
		expect((await cluster.getOptions())['keyboard']).toBe('en-us')
		await cluster.setOptions({ migration: 'type=secure', keyboard: 'en-us' })
		expect(mock.last().method).toBe('PUT')
		expect(mock.last().path).toBe('/cluster/options')
		expect(formObject(mock.last())).toEqual({ migration: 'type=secure', keyboard: 'en-us' })
	})
})
