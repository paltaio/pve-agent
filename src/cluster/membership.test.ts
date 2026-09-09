import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterMembershipApi } from './membership.ts'

afterEach(closeMockClients)

test('every read goes out on the token', async () => {
	const mock = mockClient()
	const membership = new ClusterMembershipApi(mock.client)

	mock.reply({ data: [] })
	await membership.nodes()
	expect(mock.last().path).toBe('/cluster/config/nodes')
	expect(mock.last().headers['authorization']).toMatch(/^PVEAPIToken=/)

	mock.reply({ data: {} })
	await membership.totem()
	expect(mock.last().path).toBe('/cluster/config/totem')

	mock.reply({ data: {} })
	await membership.qdevice()
	expect(mock.last().path).toBe('/cluster/config/qdevice')

	mock.reply({ data: 1 })
	await membership.apiVersion()
	expect(mock.last().path).toBe('/cluster/config/apiversion')

	mock.reply({ data: {} })
	await membership.joinInfo({ node: 'ms01-0160' })
	expect(mock.last().path).toBe('/cluster/config/join?node=ms01-0160')
	expect(mock.calls().every((call) => call.method === 'GET')).toBe(true)
	expect(mock.calls()).toHaveLength(5)
})
