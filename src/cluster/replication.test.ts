import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterReplicationApi } from './replication.ts'

afterEach(closeMockClients)

test('a job row reads disable as a boolean and keeps the raw answer', async () => {
	const mock = mockClient()
	mock.reply({ data: [{ id: '110-0', guest: 110, jobnum: 0, target: 'ms02-0066', disable: '1' }] })
	const [job] = await new ClusterReplicationApi(mock.client).list()
	expect(job?.disable).toBe(true)
	expect(job?.guest).toBe(110)
	expect(job?.type).toBe('local')
	expect(job?.raw['disable']).toBe('1')
})

test('create, update and the delete flags in the URL', async () => {
	const mock = mockClient()
	const replication = new ClusterReplicationApi(mock.client)
	await replication.create({ id: '110-0', target: 'ms02-0066', type: 'local' })
	expect([mock.last().method, mock.last().path]).toEqual(['POST', '/cluster/replication'])
	expect(formObject(mock.last())).toEqual({ id: '110-0', target: 'ms02-0066', type: 'local' })
	await replication.update('110-0', { schedule: '*/30' })
	expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/cluster/replication/110-0'])
	expect(formObject(mock.last())).toEqual({ schedule: '*/30' })
	// The API server reads a body only for POST and PUT, so DELETE flags go in the query string.
	await replication.delete('110-0', { keep: true })
	expect([mock.last().method, mock.last().path]).toEqual([
		'DELETE',
		'/cluster/replication/110-0?keep=1',
	])
	expect(mock.last().body).toBe('')
})
