import { afterEach, describe, expect, test } from 'bun:test'
import { PveTierError } from '../core/errors.ts'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { NodeDisksApi } from './disks.ts'

afterEach(closeMockClients)

const UPID = 'UPID:ms02-0066:00000001:00000001:00000001:zfscreate::root@pam:'

describe('NodeDisksApi reads', () => {
	test('list normalizes the disk rows', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{
					devpath: '/dev/nvme0n1',
					size: 2000398934016,
					used: 'ZFS',
					model: 'Samsung SSD 990 PRO',
					serial: 'S6Z1NJ0W',
					type: 'nvme',
					health: 'PASSED',
					wearout: 97,
					gpt: 1,
					mounted: 0,
					osdid: -1,
					by_id_link: '/dev/disk/by-id/nvme-Samsung',
				},
				{ devpath: '/dev/sda', size: 1, type: 'tape', wearout: 'N/A', gpt: 0 },
			],
		})
		const [nvme, other] = await new NodeDisksApi(mock.client, 'ms01-0160').list({
			skipsmart: true,
			'include-partitions': false,
		})
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/list?skipsmart=1&include-partitions=0')
		expect(nvme).toMatchObject({
			devpath: '/dev/nvme0n1',
			type: 'nvme',
			wearout: 97,
			gpt: true,
			mounted: false,
			byIdLink: '/dev/disk/by-id/nvme-Samsung',
		})
		expect(nvme?.raw['gpt']).toBe(1)
		expect(other).toMatchObject({ type: undefined, wearout: undefined, gpt: false })
	})

	test('smart passes the device in the query string', async () => {
		const mock = mockClient()
		mock.reply({ data: { health: 'PASSED', type: 'text', text: 'ok' } })
		const smart = await new NodeDisksApi(mock.client, 'ms01-0160').smart('/dev/nvme0n1', {
			healthonly: true,
		})
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/smart?disk=%2Fdev%2Fnvme0n1&healthonly=1')
		expect(smart.health).toBe('PASSED')
	})

	test('getZfs walks the vdev tree and reads leaf as a boolean', async () => {
		const mock = mockClient()
		mock.reply({
			data: {
				name: 'rpool',
				state: 'ONLINE',
				leaf: 0,
				errors: 'No known data errors',
				scan: 'scrub repaired 0B',
				children: [
					{
						name: 'mirror-0',
						leaf: 0,
						children: [{ name: 'nvme0n1p3', leaf: 1, read: 0, write: 0, cksum: 0 }, 'bad'],
					},
				],
			},
		})
		const pool = await new NodeDisksApi(mock.client, 'ms01-0160').getZfs('rpool')
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/zfs/rpool')
		expect(pool.leaf).toBe(false)
		expect(pool.errors).toBe('No known data errors')
		expect(pool.children[0]?.children).toHaveLength(1)
		expect(pool.children[0]?.children[0]).toMatchObject({ name: 'nvme0n1p3', leaf: true, read: 0 })
	})

	test('the other lists hit their paths', async () => {
		const mock = mockClient()
		const disks = new NodeDisksApi(mock.client, 'ms01-0160')
		for (const [call, path] of [
			[() => disks.listZfs(), '/nodes/ms01-0160/disks/zfs'],
			[() => disks.listLvm(), '/nodes/ms01-0160/disks/lvm'],
			[() => disks.listLvmThin(), '/nodes/ms01-0160/disks/lvmthin'],
			[() => disks.listDirectories(), '/nodes/ms01-0160/disks/directory'],
		] as const) {
			mock.reply({ data: [] })
			await call()
			expect([mock.last().method, mock.last().path]).toEqual(['GET', path])
		}
	})
})

describe('NodeDisksApi writes', () => {
	test('zfs create sends the layout the API supports', async () => {
		const mock = mockClient()
		mock.reply({ data: UPID })
		expect(
			await new NodeDisksApi(mock.client, 'ms02-0066').createZfs({
				name: 'tank2',
				devices: '/dev/nvme3n1,/dev/nvme4n1',
				raidlevel: 'mirror',
				ashift: 12,
				add_storage: true,
			}),
		).toBe(UPID)
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/nodes/ms02-0066/disks/zfs'])
		expect(formObject(mock.last())).toEqual({
			name: 'tank2',
			devices: '/dev/nvme3n1,/dev/nvme4n1',
			raidlevel: 'mirror',
			ashift: '12',
			add_storage: '1',
		})
	})

	test('zfs destroy puts the cleanup flags in the query string', async () => {
		const mock = mockClient()
		mock.reply({ data: UPID })
		await new NodeDisksApi(mock.client, 'ms02-0066').deleteZfs('tank2', {
			'cleanup-config': true,
			'cleanup-disks': true,
		})
		expect(mock.last().method).toBe('DELETE')
		expect(mock.last().path).toBe(
			'/nodes/ms02-0066/disks/zfs/tank2?cleanup-config=1&cleanup-disks=1',
		)
	})

	test('wipedisk needs a root@pam ticket', async () => {
		const mock = mockClient({ ticket: false })
		await expect(
			new NodeDisksApi(mock.client, 'ms01-0160').wipe('/dev/nvme1n1'),
		).rejects.toBeInstanceOf(PveTierError)
		expect(mock.calls()).toHaveLength(0)
	})

	test('initgpt, lvm, thin pool and directory writes', async () => {
		const mock = mockClient()
		const disks = new NodeDisksApi(mock.client, 'ms01-0160')

		mock.reply({ data: UPID })
		await disks.initGpt('/dev/nvme1n1')
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/initgpt')
		expect(formObject(mock.last())).toEqual({ disk: '/dev/nvme1n1' })

		mock.reply({ data: UPID })
		await disks.createLvm({ name: 'vg0', device: '/dev/nvme1n1', add_storage: true })
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/lvm')
		expect(formObject(mock.last())).toEqual({
			name: 'vg0',
			device: '/dev/nvme1n1',
			add_storage: '1',
		})
		mock.reply({ data: UPID })
		await disks.deleteLvm('vg0', { 'cleanup-config': true })
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/lvm/vg0?cleanup-config=1')

		mock.reply({ data: UPID })
		await disks.createLvmThin({ name: 'thin0', device: '/dev/nvme1n1' })
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/lvmthin')
		expect(formObject(mock.last())).toEqual({ name: 'thin0', device: '/dev/nvme1n1' })
		mock.reply({ data: UPID })
		await disks.deleteLvmThin('thin0', { 'volume-group': 'vg0' })
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/lvmthin/thin0?volume-group=vg0')

		mock.reply({ data: UPID })
		await disks.createDirectory({ name: 'media', device: '/dev/nvme1n1', filesystem: 'xfs' })
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/directory')
		expect(formObject(mock.last())).toEqual({
			name: 'media',
			device: '/dev/nvme1n1',
			filesystem: 'xfs',
		})
		mock.reply({ data: UPID })
		await disks.deleteDirectory('media', { 'cleanup-disks': true })
		expect(mock.last().path).toBe('/nodes/ms01-0160/disks/directory/media?cleanup-disks=1')
	})
})
