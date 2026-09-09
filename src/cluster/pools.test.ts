import { afterEach, expect, test } from 'bun:test'
import { PveNotFoundError } from '../core/errors.ts'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { PoolsApi } from './pools.ts'

afterEach(closeMockClients)

test('reads, writes and deletes go through the collection endpoint', async () => {
	const mock = mockClient()
	const pools = new PoolsApi(mock.client)

	mock.reply({ data: [{ poolid: 'infra/db', members: [] }] })
	expect((await pools.get('infra/db')).poolid).toBe('infra/db')
	expect(mock.last().path).toBe('/pools?poolid=infra%2Fdb')

	mock.reply({ data: [{ poolid: 'infra/db', members: [] }] })
	await pools.get('infra/db', { type: 'lxc' })
	expect(mock.last().path).toBe('/pools?poolid=infra%2Fdb&type=lxc')

	await pools.create({ poolid: 'infra', comment: 'infra guests' })
	expect([mock.last().method, mock.last().path]).toEqual(['POST', '/pools'])
	expect(formObject(mock.last())).toEqual({ poolid: 'infra', comment: 'infra guests' })

	await pools.update({ poolid: 'infra/db', vms: '110', 'allow-move': true })
	expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/pools'])
	expect(formObject(mock.last())).toEqual({ poolid: 'infra/db', vms: '110', 'allow-move': '1' })

	await pools.delete('infra/db')
	expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/pools?poolid=infra%2Fdb'])
	expect(mock.last().body).toBe('')
})

test('an empty answer for a named pool is a not-found', async () => {
	const mock = mockClient()
	mock.reply({ data: [] })
	await expect(new PoolsApi(mock.client).get('missing')).rejects.toBeInstanceOf(PveNotFoundError)
	mock.reply({ data: [] })
	await expect(new PoolsApi(mock.client).get('missing')).rejects.toThrow(/missing/)
})
