import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterFirewallApi, FirewallRulesApi, normalizeFirewallRule } from './firewall.ts'

afterEach(closeMockClients)

describe('rules', () => {
	test('a rule written without enable reads as disabled', () => {
		expect(normalizeFirewallRule({ pos: 0, type: 'in', action: 'ACCEPT' }).enable).toBe(false)
		expect(
			normalizeFirewallRule({ pos: '1', type: 'in', action: 'DROP', enable: '1' }),
		).toMatchObject({
			pos: 1,
			enable: true,
		})
	})

	test('a chain is addressed as collection then position', async () => {
		const mock = mockClient()
		const rules = new FirewallRulesApi(mock.client, '/nodes/ms01-0160/firewall/rules')
		mock.reply({ data: [{ pos: 0, type: 'in', action: 'ACCEPT', enable: 1 }] })
		expect((await rules.list())[0]?.enable).toBe(true)
		expect(mock.last().path).toBe('/nodes/ms01-0160/firewall/rules')
		mock.reply({ data: { pos: 2, type: 'in', action: 'DROP' } })
		expect((await rules.get(2)).pos).toBe(2)
		expect(mock.last().path).toBe('/nodes/ms01-0160/firewall/rules/2')
	})

	test('an insert, a reorder and a guarded delete', async () => {
		const mock = mockClient()
		const rules = new ClusterFirewallApi(mock.client).rules
		await rules.create({ type: 'in', action: 'ACCEPT', dport: '22', enable: 1 })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/cluster/firewall/rules'])
		expect(formObject(mock.last())).toEqual({
			type: 'in',
			action: 'ACCEPT',
			dport: '22',
			enable: '1',
		})
		await rules.update(0, { moveto: 3 })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/cluster/firewall/rules/0'])
		expect(formObject(mock.last())).toEqual({ moveto: '3' })
		await rules.delete(2, { digest: 'abc' })
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			'/cluster/firewall/rules/2?digest=abc',
		])
	})

	test('a security group chain has no /rules segment', async () => {
		const mock = mockClient()
		const firewall = new ClusterFirewallApi(mock.client)
		mock.reply({ data: [] })
		await firewall.group('web').list()
		expect(mock.last().path).toBe('/cluster/firewall/groups/web')
		await firewall.group('web').create({ type: 'in', action: 'ACCEPT' })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/cluster/firewall/groups/web'])
		await firewall.group('web').delete(2, { digest: 'abc' })
		expect(mock.last().path).toBe('/cluster/firewall/groups/web/2?digest=abc')
	})
})

describe('options, groups, aliases, ipsets', () => {
	test('options are read raw and written as form fields', async () => {
		const mock = mockClient()
		const firewall = new ClusterFirewallApi(mock.client)
		mock.reply({ data: { enable: 1, policy_in: 'DROP' } })
		const options = await firewall.getOptions()
		expect(options.enable).toBe(1)
		expect(options.policy_in).toBe('DROP')
		await firewall.setOptions({ enable: 0, delete: 'log_ratelimit' })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/cluster/firewall/options'])
		expect(formObject(mock.last())).toEqual({ enable: '0', delete: 'log_ratelimit' })
	})

	test('security groups and aliases', async () => {
		const mock = mockClient()
		const firewall = new ClusterFirewallApi(mock.client)
		await firewall.createGroup({ group: 'web', comment: 'web tier' })
		expect(mock.last().path).toBe('/cluster/firewall/groups')
		expect(formObject(mock.last())).toEqual({ group: 'web', comment: 'web tier' })
		await firewall.deleteGroup('web')
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			'/cluster/firewall/groups/web',
		])

		await firewall.createAlias({ name: 'lan', cidr: '192.168.80.0/24' })
		expect(mock.last().path).toBe('/cluster/firewall/aliases')
		expect(formObject(mock.last())).toEqual({ name: 'lan', cidr: '192.168.80.0/24' })
		await firewall.updateAlias('lan', { cidr: '192.168.81.0/24', rename: 'lan2' })
		expect(mock.last().path).toBe('/cluster/firewall/aliases/lan')
		expect(formObject(mock.last())).toEqual({ cidr: '192.168.81.0/24', rename: 'lan2' })
		await firewall.deleteAlias('lan2', { digest: 'd1' })
		expect(mock.last().path).toBe('/cluster/firewall/aliases/lan2?digest=d1')
	})

	test('ipsets and their entries', async () => {
		const mock = mockClient()
		const firewall = new ClusterFirewallApi(mock.client)
		// The collection endpoint names an IPSet `name`; only a security group has `group`.
		mock.reply({ data: [{ name: 'blocked', comment: 'noisy hosts' }] })
		expect((await firewall.listIpsets())[0]?.name).toBe('blocked')

		await firewall.createIpset({ name: 'blocked' })
		expect(mock.last().path).toBe('/cluster/firewall/ipset')
		expect(formObject(mock.last())).toEqual({ name: 'blocked' })

		mock.reply({ data: [{ cidr: '10.0.0.5', nomatch: 1 }, { cidr: '10.0.0.0/8' }] })
		const [excluded, included] = await firewall.listIpsetEntries('blocked')
		expect(mock.last().path).toBe('/cluster/firewall/ipset/blocked')
		expect(excluded?.nomatch).toBe(true)
		expect(included?.nomatch).toBe(false)
		expect(excluded?.raw['nomatch']).toBe(1)

		await firewall.addIpsetEntry('blocked', { cidr: '10.0.0.5', nomatch: true })
		expect(mock.last().path).toBe('/cluster/firewall/ipset/blocked')
		expect(formObject(mock.last())).toEqual({ cidr: '10.0.0.5', nomatch: '1' })
		await firewall.updateIpsetEntry('blocked', '10.0.0.5', { comment: 'noisy' })
		expect(mock.last().path).toBe('/cluster/firewall/ipset/blocked/10.0.0.5')
		expect(formObject(mock.last())).toEqual({ comment: 'noisy' })
		await firewall.deleteIpsetEntry('blocked', '10.0.0.0/8')
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			'/cluster/firewall/ipset/blocked/10.0.0.0%2F8',
		])
		await firewall.deleteIpset('blocked', { force: true })
		expect(mock.last().path).toBe('/cluster/firewall/ipset/blocked?force=1')
	})

	test('macros and refs', async () => {
		const mock = mockClient()
		const firewall = new ClusterFirewallApi(mock.client)
		mock.reply({ data: [{ macro: 'SSH', descr: 'Secure shell traffic' }] })
		expect((await firewall.listMacros())[0]?.macro).toBe('SSH')
		expect(mock.last().path).toBe('/cluster/firewall/macros')
		mock.reply({ data: [] })
		await firewall.listRefs({ type: 'alias' })
		expect(mock.last().path).toBe('/cluster/firewall/refs?type=alias')
	})
})
