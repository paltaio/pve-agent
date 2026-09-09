import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import type { NodesQemuSnapshotPostParams } from '../generated/types.ts'
import { GuestSnapshotsApi } from './snapshots.ts'

afterEach(closeMockClients)

describe('GuestSnapshotsApi', () => {
	test('lists and flags the current pseudo-entry', async () => {
		const mock = mockClient()
		const snapshots = new GuestSnapshotsApi(mock.client, '/nodes/ms01-0160/qemu/9000')
		mock.reply({
			data: [
				{ name: 's1', snaptime: 1 },
				{ name: 'current', running: 1 },
			],
		})
		const rows = await snapshots.list()
		expect(mock.last().path).toBe('/nodes/ms01-0160/qemu/9000/snapshot')
		expect(rows.map((row) => row.current)).toEqual([false, true])
	})

	test('sends the snapshot calls with the name in the path', async () => {
		const mock = mockClient()
		const snapshots = new GuestSnapshotsApi<NodesQemuSnapshotPostParams>(
			mock.client,
			'/nodes/ms01-0160/qemu/9000',
		)

		await snapshots.create('base', { vmstate: true, description: 'clean install' })
		expect([mock.last().method, mock.last().path]).toEqual([
			'POST',
			'/nodes/ms01-0160/qemu/9000/snapshot',
		])
		expect(formObject(mock.last())).toEqual({
			vmstate: '1',
			description: 'clean install',
			snapname: 'base',
		})

		mock.reply({ data: { memory: 512 } })
		expect(await snapshots.config('base')).toEqual({ memory: 512 })
		expect(mock.last().path).toBe('/nodes/ms01-0160/qemu/9000/snapshot/base/config')

		await snapshots.update('base', { description: 'still good' })
		expect([mock.last().method, mock.last().path]).toEqual([
			'PUT',
			'/nodes/ms01-0160/qemu/9000/snapshot/base/config',
		])

		await snapshots.rollback('base', { start: true })
		expect([mock.last().method, mock.last().path]).toEqual([
			'POST',
			'/nodes/ms01-0160/qemu/9000/snapshot/base/rollback',
		])
		expect(formObject(mock.last())).toEqual({ start: '1' })

		await snapshots.delete('a b', { force: true })
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			'/nodes/ms01-0160/qemu/9000/snapshot/a%20b?force=1',
		])
		expect(mock.last().body).toBe('')
	})
})
