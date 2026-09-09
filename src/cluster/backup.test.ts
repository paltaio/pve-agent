import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterBackupApi } from './backup.ts'

afterEach(closeMockClients)

test('a job row reads its flags as booleans and next-run as nextRun', async () => {
	const mock = mockClient()
	mock.reply({
		data: [
			{
				id: 'nightly',
				enabled: 1,
				all: 0,
				vmid: '101,110',
				mode: 'snapshot',
				'next-run': 1700000000,
			},
			{ id: 'odd', mode: 'something-new' },
		],
	})
	const [job, odd] = await new ClusterBackupApi(mock.client).list()
	expect(mock.last().path).toBe('/cluster/backup')
	expect(job?.enabled).toBe(true)
	expect(job?.all).toBe(false)
	expect(job?.mode).toBe('snapshot')
	expect(job?.nextRun).toBe(1700000000)
	expect(job?.raw['next-run']).toBe(1700000000)
	expect(odd?.mode).toBeUndefined()
})

test('create, update and delete', async () => {
	const mock = mockClient()
	const backup = new ClusterBackupApi(mock.client)
	await backup.create({ id: 'nightly', all: true, storage: 'n5-backups', schedule: '03:00' })
	expect([mock.last().method, mock.last().path]).toEqual(['POST', '/cluster/backup'])
	expect(formObject(mock.last())).toEqual({
		id: 'nightly',
		all: '1',
		storage: 'n5-backups',
		schedule: '03:00',
	})
	await backup.update('nightly', { enabled: false, delete: 'comment' })
	expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/cluster/backup/nightly'])
	expect(formObject(mock.last())).toEqual({ enabled: '0', delete: 'comment' })
	await backup.delete('nightly')
	expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/cluster/backup/nightly'])
})

test('included_volumes and not-backed-up', async () => {
	const mock = mockClient()
	const backup = new ClusterBackupApi(mock.client)
	mock.reply({ data: { children: [] } })
	expect((await backup.includedVolumes('daily-n5')).children).toEqual([])
	expect(mock.last().path).toBe('/cluster/backup/daily-n5/included_volumes')
	mock.reply({ data: [{ vmid: 101, type: 'qemu' }] })
	expect((await backup.notBackedUp())[0]?.vmid).toBe(101)
	expect(mock.last().path).toBe('/cluster/backup-info/not-backed-up')
})
