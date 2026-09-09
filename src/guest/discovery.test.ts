import { afterEach, describe, expect, test } from 'bun:test'
import { PveNotFoundError } from '../core/errors.ts'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import {
	createContainer,
	createVm,
	findGuest,
	guestHandle,
	listGuests,
	openGuest,
	resolveGuest,
} from './discovery.ts'
import { LxcApi } from './lxc.ts'
import { QemuApi } from './qemu.ts'

afterEach(closeMockClients)

// Rows shaped like the live /cluster/resources answer.
const resources = [
	{
		id: 'lxc/110',
		type: 'lxc',
		vmid: 110,
		node: 'ms02-0078',
		name: 'image-library',
		status: 'running',
		template: 0,
		maxcpu: 4,
	},
	{
		id: 'qemu/100',
		type: 'qemu',
		vmid: 100,
		node: 'ms01-0160',
		name: 'builder',
		status: 'stopped',
		template: 0,
		tags: 'ci;linux',
	},
	{
		id: 'qemu/9001',
		type: 'qemu',
		vmid: 9001,
		node: 'ms01-0160',
		name: 'golden',
		status: 'stopped',
		template: 1,
	},
	{ id: 'node/ms01-0160', type: 'node', node: 'ms01-0160' },
]

const stoppedTask = {
	upid: 'UPID:ms01-0160:00001234:00000001:68B00000:qmcreate:9001:agents@pve:',
	node: 'ms01-0160',
	pid: 4660,
	pstart: 1,
	starttime: 1756000000,
	type: 'qmcreate',
	id: '9001',
	user: 'agents@pve',
	status: 'stopped',
	exitstatus: 'OK',
}

describe('listing', () => {
	test('keeps containers and virtual machines in one listing sorted by vmid', async () => {
		const mock = mockClient()
		mock.reply({ data: resources })
		const guests = await listGuests(mock.client)
		expect(mock.last().path).toBe('/cluster/resources?type=vm')
		expect(guests.map((guest) => `${guest.type}/${guest.vmid}`)).toEqual([
			'qemu/100',
			'lxc/110',
			'qemu/9001',
		])
	})

	test('filters by type, node, tag, status and template', async () => {
		const mock = mockClient()
		for (let i = 0; i < 5; i += 1) mock.reply({ data: resources })
		expect(await listGuests(mock.client, { type: 'lxc' })).toHaveLength(1)
		expect(await listGuests(mock.client, { node: 'ms01-0160' })).toHaveLength(2)
		expect(await listGuests(mock.client, { tag: 'ci' })).toHaveLength(1)
		expect(await listGuests(mock.client, { status: 'running' })).toHaveLength(1)
		expect(await listGuests(mock.client, { excludeTemplates: true })).toHaveLength(2)
	})
})

describe('resolving a vmid', () => {
	test('finds the node and type of a guest, or nothing', async () => {
		const mock = mockClient()
		mock.reply({ data: resources })
		mock.reply({ data: resources })
		expect(await findGuest(mock.client, 110)).toMatchObject({ type: 'lxc', node: 'ms02-0078' })
		expect(await findGuest(mock.client, 9999)).toBeUndefined()
	})

	test('opens a vmid as a handle of the right class', async () => {
		const mock = mockClient()
		mock.reply({ data: resources })
		mock.reply({ data: resources })
		const ct = await openGuest(mock.client, 110)
		const vm = await openGuest(mock.client, 100)
		expect(ct).toBeInstanceOf(LxcApi)
		expect(ct.path).toBe('/nodes/ms02-0078/lxc/110')
		expect(vm).toBeInstanceOf(QemuApi)
		expect(guestHandle(mock.client, { node: 'ms01-0160', vmid: 5 })).toBeInstanceOf(QemuApi)
	})

	test('names the vmid when the cluster has no such guest', async () => {
		const mock = mockClient()
		mock.reply({ data: resources })
		mock.reply({ data: resources })
		await expect(resolveGuest(mock.client, 9999)).rejects.toBeInstanceOf(PveNotFoundError)
		await expect(resolveGuest(mock.client, 9999)).rejects.toThrow(/vmid 9999/)
	})
})

describe('creating guests', () => {
	test('createVm picks the next id, posts, waits for the task and returns the handle', async () => {
		const mock = mockClient()
		mock.reply({ data: '9001' })
		mock.reply({ data: stoppedTask.upid })
		mock.reply({ data: stoppedTask })
		const vm = await createVm(mock.client, 'ms01-0160', {
			name: 'demo',
			memory: '512',
			scsi0: 'ms01-vms:1',
		})
		expect(vm).toBeInstanceOf(QemuApi)
		expect(vm.vmid).toBe(9001)
		expect(mock.calls().map((call) => `${call.method} ${call.path}`)).toEqual([
			'GET /cluster/nextid',
			'POST /nodes/ms01-0160/qemu',
			`GET /nodes/ms01-0160/tasks/${encodeURIComponent(stoppedTask.upid)}/status`,
		])
		expect(formObject(mock.calls()[1] ?? mock.last())).toEqual({
			name: 'demo',
			memory: '512',
			scsi0: 'ms01-vms:1',
			vmid: '9001',
		})
	})

	test('createContainer keeps a given vmid and sends unprivileged explicitly', async () => {
		const mock = mockClient()
		mock.reply({ data: stoppedTask.upid })
		mock.reply({ data: stoppedTask })
		const ct = await createContainer(mock.client, 'ms01-0160', {
			vmid: 9002,
			ostemplate: 'local:vztmpl/alpine.tar.xz',
			rootfs: 'ms01-vms:1',
		})
		expect(ct).toBeInstanceOf(LxcApi)
		expect(ct.vmid).toBe(9002)
		expect(mock.calls()[0]?.path).toBe('/nodes/ms01-0160/lxc')
		expect(formObject(mock.calls()[0] ?? mock.last())).toEqual({
			unprivileged: '1',
			ostemplate: 'local:vztmpl/alpine.tar.xz',
			rootfs: 'ms01-vms:1',
			vmid: '9002',
		})
	})

	test('createContainer leaves unprivileged alone on a restore or when set', async () => {
		const mock = mockClient()
		mock.reply({ data: stoppedTask.upid })
		mock.reply({ data: stoppedTask })
		await createContainer(mock.client, 'ms01-0160', {
			vmid: 9002,
			ostemplate: 'backup:backup/vzdump-lxc-110.tar.zst',
			restore: true,
		})
		expect(formObject(mock.calls()[0] ?? mock.last())).not.toHaveProperty('unprivileged')

		mock.reply({ data: stoppedTask.upid })
		mock.reply({ data: stoppedTask })
		await createContainer(mock.client, 'ms01-0160', {
			vmid: 9002,
			ostemplate: 'local:vztmpl/alpine.tar.xz',
			unprivileged: false,
		})
		expect(formObject(mock.calls()[2] ?? mock.last())['unprivileged']).toBe('0')
	})
})
