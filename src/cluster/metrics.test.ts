import { afterEach, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterMetricsApi } from './metrics.ts'

afterEach(closeMockClients)

test('a server row reads its port as a number and disable as a boolean', async () => {
	const mock = mockClient()
	mock.reply({
		data: [{ id: 'influx', type: 'influxdb', server: '10.0.0.9', port: '8086', disable: 1 }],
	})
	const [server] = await new ClusterMetricsApi(mock.client).listServers()
	expect(server?.port).toBe(8086)
	expect(server?.disable).toBe(true)
	expect(server?.raw['port']).toBe('8086')
})

test('server writes carry the id in the path, and export takes its filters', async () => {
	const mock = mockClient()
	const metrics = new ClusterMetricsApi(mock.client)
	await metrics.createServer('influx', { type: 'influxdb', server: '10.0.0.9', port: 8086 })
	expect([mock.last().method, mock.last().path]).toEqual(['POST', '/cluster/metrics/server/influx'])
	expect(formObject(mock.last())).toEqual({ type: 'influxdb', server: '10.0.0.9', port: '8086' })
	await metrics.updateServer('influx', { server: '10.0.0.9', port: 8086, disable: true })
	expect(mock.last().method).toBe('PUT')
	expect(formObject(mock.last())).toEqual({ server: '10.0.0.9', port: '8086', disable: '1' })
	await metrics.deleteServer('influx')
	expect([mock.last().method, mock.last().path]).toEqual([
		'DELETE',
		'/cluster/metrics/server/influx',
	])

	mock.reply({ data: { data: [] } })
	expect((await metrics.export({ 'local-only': true, 'start-time': 5 })).data).toEqual([])
	expect(mock.last().path).toBe('/cluster/metrics/export?local-only=1&start-time=5')
})
