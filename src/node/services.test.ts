import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { isNodeService, NODE_SERVICES, NodeServicesApi } from './services.ts'

afterEach(closeMockClients)

describe('NodeServicesApi', () => {
	test('the unit list comes from the endpoint registry', () => {
		expect(NODE_SERVICES).toContain('pvedaemon')
		expect(NODE_SERVICES).toContain('systemd-timesyncd')
		expect(isNodeService('pvestatd')).toBe(true)
		expect(isNodeService('frr')).toBe(false)
	})

	test('list and state read the unit rows as the node sends them', async () => {
		const mock = mockClient()
		const services = new NodeServicesApi(mock.client, 'ms01-0160')

		mock.reply({ data: [{ service: 'pvedaemon', name: 'pvedaemon', desc: '', state: 'running' }] })
		const rows = await services.list()
		expect(mock.last().path).toBe('/nodes/ms01-0160/services')
		expect(rows[0]?.state).toBe('running')

		mock.reply({
			data: {
				service: 'pvestatd',
				name: 'pvestatd',
				desc: '',
				state: 'running',
				'unit-state': 'enabled',
			},
		})
		const state = await services.state('pvestatd')
		expect(mock.last().path).toBe('/nodes/ms01-0160/services/pvestatd/state')
		expect(state['unit-state']).toBe('enabled')
	})

	test('start, stop, restart and reload post to the action path and return a UPID', async () => {
		const mock = mockClient()
		const services = new NodeServicesApi(mock.client, 'ms01-0160')
		for (const [call, action] of [
			[() => services.start('cron'), 'start'],
			[() => services.stop('ksmtuned'), 'stop'],
			[() => services.restart('pveproxy'), 'restart'],
			[() => services.reload('pveproxy'), 'reload'],
		] as const) {
			mock.reply({ data: `UPID:ms01-0160:00000001:00000001:00000001:srv${action}:x:root@pam:` })
			expect(await call()).toStartWith('UPID:')
			expect(mock.last().method).toBe('POST')
			expect(mock.last().path).toEndWith(`/${action}`)
			expect(mock.last().path).toStartWith('/nodes/ms01-0160/services/')
		}
	})
})
