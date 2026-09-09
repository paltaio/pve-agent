import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterBulkApi } from './bulk.ts'

afterEach(closeMockClients)

test('a vms array repeats the key', async () => {
	const mock = mockClient()
	mock.reply({ data: 'UPID:node:1:1:1:stopall::root@pam:' })
	const upid = await new ClusterBulkApi(mock.client).shutdown({ vms: [110, 120], timeout: 60 })
	expect(upid).toBe('UPID:node:1:1:1:stopall::root@pam:')
	expect(mock.last().path).toBe('/cluster/bulk-action/guest/shutdown')
	expect(mock.last().body).toBe('vms=110&vms=120&timeout=60')
})

test('start, suspend and migrate reach their endpoints', async () => {
	const mock = mockClient()
	const bulk = new ClusterBulkApi(mock.client)
	mock.reply({ data: 'UPID:node:1:1:1:startall::root@pam:' })
	await bulk.start({ 'max-workers': 2 })
	expect(mock.last().path).toBe('/cluster/bulk-action/guest/start')
	expect(formObject(mock.last())).toEqual({ 'max-workers': '2' })

	mock.reply({ data: 'UPID:node:1:1:1:suspendall::root@pam:' })
	await bulk.suspend({ 'to-disk': true, statestorage: 'tank-vms' })
	expect(mock.last().path).toBe('/cluster/bulk-action/guest/suspend')
	expect(formObject(mock.last())).toEqual({ 'to-disk': '1', statestorage: 'tank-vms' })

	mock.reply({ data: 'UPID:node:1:1:1:migrateall::root@pam:' })
	await bulk.migrate({ target: 'ms02-0066', online: true })
	expect(mock.last().path).toBe('/cluster/bulk-action/guest/migrate')
	expect(formObject(mock.last())).toEqual({ target: 'ms02-0066', online: '1' })
})
