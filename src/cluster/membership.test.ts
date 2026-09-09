import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterMembershipApi } from './membership.ts'

afterEach(closeMockClients)

test('every read goes out on the token', async () => {
	const mock = mockClient()
	const membership = new ClusterMembershipApi(mock.client)

	mock.reply({ data: [{ node: 'ms01-0160', name: 'ms01-0160', nodeid: '1', quorum_votes: '1' }] })
	expect((await membership.nodes())[0]?.nodeid).toBe('1')
	expect(mock.last().path).toBe('/cluster/config/nodes')
	expect(mock.last().headers['authorization']).toMatch(/^PVEAPIToken=/)

	mock.reply({ data: { cluster_name: 'palta', config_version: '4' } })
	expect((await membership.totem()).cluster_name).toBe('palta')
	expect(mock.last().path).toBe('/cluster/config/totem')

	mock.reply({ data: {} })
	expect(await membership.qdevice()).toEqual({})
	expect(mock.last().path).toBe('/cluster/config/qdevice')

	mock.reply({ data: 1 })
	expect(await membership.apiVersion()).toBe(1)
	expect(mock.last().path).toBe('/cluster/config/apiversion')

	mock.reply({ data: { config_digest: 'd', nodelist: [], preferred_node: 'ms01-0160', totem: {} } })
	expect((await membership.joinInfo({ node: 'ms01-0160' })).preferred_node).toBe('ms01-0160')
	expect(mock.last().path).toBe('/cluster/config/join?node=ms01-0160')
	expect(mock.calls()).toHaveLength(5)
})
