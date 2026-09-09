import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { StorageConfigApi } from './storage.ts'

afterEach(closeMockClients)

test('a definition reads its flags as booleans and prune-backups as pruneBackups', async () => {
	const mock = mockClient()
	mock.reply({
		data: [
			{
				storage: 'tank-vms',
				type: 'zfspool',
				pool: 'tank/vms',
				shared: 0,
				'prune-backups': 'keep-last=3',
			},
		],
	})
	const [row] = await new StorageConfigApi(mock.client).list({ type: 'zfspool' })
	expect(mock.last().path).toBe('/storage?type=zfspool')
	expect(row?.shared).toBe(false)
	expect(row?.disable).toBeUndefined()
	expect(row?.pruneBackups).toBe('keep-last=3')
	expect(row?.raw['shared']).toBe(0)
})

test('create returns the stored config; update and delete address the storage', async () => {
	const mock = mockClient()
	const storage = new StorageConfigApi(mock.client)
	mock.reply({ data: { storage: 'archive', type: 'nfs' } })
	const created = await storage.create({
		storage: 'archive',
		type: 'nfs',
		server: '10.10.10.1',
		export: '/array/archive',
		content: 'backup',
	})
	expect(created['storage']).toBe('archive')
	expect([mock.last().method, mock.last().path]).toEqual(['POST', '/storage'])
	expect(formObject(mock.last())).toEqual({
		storage: 'archive',
		type: 'nfs',
		server: '10.10.10.1',
		export: '/array/archive',
		content: 'backup',
	})
	mock.reply({ data: {} })
	await storage.update('archive', { disable: true, delete: 'nodes' })
	expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/storage/archive'])
	expect(formObject(mock.last())).toEqual({ disable: '1', delete: 'nodes' })
	await storage.delete('archive')
	expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/storage/archive'])
})
