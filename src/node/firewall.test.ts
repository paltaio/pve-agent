import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { NodeFirewallApi } from './firewall.ts'

afterEach(closeMockClients)

describe('NodeFirewallApi', () => {
	// FirewallRulesApi is shared with the datacenter chain; this pins it to the
	// node's rule path.
	test('rules drive the shared rule wrapper on the node path', async () => {
		const mock = mockClient()
		const firewall = new NodeFirewallApi(mock.client, 'ms01-0160')

		mock.reply({ data: [{ pos: 0, type: 'in', action: 'ACCEPT', enable: 1 }] })
		const [rule] = await firewall.rules.list()
		expect([mock.last().method, mock.last().path]).toEqual([
			'GET',
			'/nodes/ms01-0160/firewall/rules',
		])
		expect(rule?.enable).toBe(true)

		await firewall.rules.create({ type: 'in', action: 'ACCEPT', dport: '8006' })
		expect([mock.last().method, mock.last().path]).toEqual([
			'POST',
			'/nodes/ms01-0160/firewall/rules',
		])
		expect(formObject(mock.last())).toEqual({ type: 'in', action: 'ACCEPT', dport: '8006' })

		await firewall.rules.delete(0, { digest: 'd1' })
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			'/nodes/ms01-0160/firewall/rules/0?digest=d1',
		])
	})

	test('options are read as the node sends them and written as a PUT', async () => {
		const mock = mockClient()
		const firewall = new NodeFirewallApi(mock.client, 'ms01-0160')

		mock.reply({ data: { enable: 1, log_level_in: 'nolog' } })
		expect(await firewall.getOptions()).toEqual({ enable: 1, log_level_in: 'nolog' })
		expect(mock.last().path).toBe('/nodes/ms01-0160/firewall/options')

		await firewall.setOptions({ enable: false })
		expect([mock.last().method, mock.last().path]).toEqual([
			'PUT',
			'/nodes/ms01-0160/firewall/options',
		])
		expect(formObject(mock.last())).toEqual({ enable: '0' })
	})

	test('log and logPage read the lines, and logPage adds the total', async () => {
		const mock = mockClient()
		const firewall = new NodeFirewallApi(mock.client, 'ms01-0160')

		mock.reply({ data: [{ n: 1, t: 'drop' }] })
		expect(await firewall.log({ limit: 200 })).toEqual([{ n: 1, t: 'drop' }])
		expect(mock.last().path).toBe('/nodes/ms01-0160/firewall/log?limit=200')

		mock.reply({ data: [{ n: 1, t: 'drop' }], attribs: { total: '12' } })
		expect(await firewall.logPage({ since: 5 })).toEqual({
			lines: [{ n: 1, t: 'drop' }],
			total: 12,
		})
		expect(mock.last().path).toBe('/nodes/ms01-0160/firewall/log?since=5')
	})
})
