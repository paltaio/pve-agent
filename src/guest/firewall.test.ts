import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import type {
	NodesLxcFirewallAliasesPostParams,
	NodesLxcFirewallOptionsPutParams,
	NodesLxcFirewallRulesPostParams,
	NodesLxcFirewallRulesPutParams,
	NodesQemuFirewallAliasesPostParams,
	NodesQemuFirewallOptionsPutParams,
	NodesQemuFirewallRulesPostParams,
	NodesQemuFirewallRulesPutParams,
} from '../generated/types.ts'
import { GuestFirewallApi } from './firewall.ts'

afterEach(closeMockClients)

const guest = '/nodes/ms01-0160/qemu/9000'

describe('GuestFirewallApi', () => {
	test('rules drive the shared rule wrapper on the guest path', async () => {
		const mock = mockClient()
		const firewall = new GuestFirewallApi(mock.client, guest)

		mock.reply({ data: [{ pos: 0, type: 'in', action: 'ACCEPT', enable: 1 }] })
		const [rule] = await firewall.rules.list()
		expect([mock.last().method, mock.last().path]).toEqual(['GET', `${guest}/firewall/rules`])
		expect(rule?.enable).toBe(true)

		await firewall.rules.create({ type: 'in', action: 'ACCEPT', dport: '22' })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', `${guest}/firewall/rules`])

		await firewall.rules.delete(0, { digest: 'abc' })
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			`${guest}/firewall/rules/0?digest=abc`,
		])
	})

	test('options are read as the node sends them and written as a PUT', async () => {
		const mock = mockClient()
		const firewall = new GuestFirewallApi(mock.client, guest)

		mock.reply({ data: { enable: 1, policy_in: 'DROP', dhcp: 1 } })
		expect(await firewall.getOptions()).toEqual({ enable: 1, policy_in: 'DROP', dhcp: 1 })
		expect(mock.last().path).toBe(`${guest}/firewall/options`)

		await firewall.setOptions({ enable: true, policy_in: 'DROP' })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', `${guest}/firewall/options`])
		expect(formObject(mock.last())).toEqual({ enable: '1', policy_in: 'DROP' })
	})

	test('aliases and IPSets encode their names and CIDRs in the path', async () => {
		const mock = mockClient()
		const firewall = new GuestFirewallApi(mock.client, guest)

		await firewall.createAlias({ name: 'gw', cidr: '10.0.0.1' })
		await firewall.updateAlias('gw', { cidr: '10.0.0.2', rename: 'gateway' })
		await firewall.deleteAlias('gateway', { digest: 'd' })
		await firewall.createIpset({ name: 'blocklist' })
		await firewall.addIpsetEntry('blocklist', { cidr: '10.0.0.0/8', nomatch: true })
		mock.reply({ data: [{ cidr: '10.0.0.0/8', nomatch: 1 }] })
		const [entry] = await firewall.listIpsetEntries('blocklist')
		await firewall.deleteIpsetEntry('blocklist', '10.0.0.0/8')
		await firewall.deleteIpset('blocklist', { force: true })

		expect(mock.calls().map((call) => `${call.method} ${call.path}`)).toEqual([
			`POST ${guest}/firewall/aliases`,
			`PUT ${guest}/firewall/aliases/gw`,
			`DELETE ${guest}/firewall/aliases/gateway?digest=d`,
			`POST ${guest}/firewall/ipset`,
			`POST ${guest}/firewall/ipset/blocklist`,
			`GET ${guest}/firewall/ipset/blocklist`,
			`DELETE ${guest}/firewall/ipset/blocklist/10.0.0.0%2F8`,
			`DELETE ${guest}/firewall/ipset/blocklist?force=1`,
		])
		expect(entry?.nomatch).toBe(true)
	})

	test('log and refs pass their filters as a query', async () => {
		const mock = mockClient()
		const firewall = new GuestFirewallApi(mock.client, guest)

		mock.reply({ data: [{ n: 1, t: 'drop' }] })
		expect(await firewall.log({ limit: 100 })).toEqual([{ n: 1, t: 'drop' }])
		expect(mock.last().path).toBe(`${guest}/firewall/log?limit=100`)

		mock.reply({ data: [{ type: 'alias', name: 'gw', ref: 'gw', scope: 'guest' }] })
		const refs = await firewall.listRefs({ type: 'alias' })
		expect(refs[0]?.name).toBe('gw')
		expect(mock.last().path).toBe(`${guest}/firewall/refs?type=alias`)
	})

	test('the LXC firewall parameter sets are assignable to the QEMU ones', () => {
		// One class serves both guest types, so the declarations have to agree.
		const rulePost = (params: NodesQemuFirewallRulesPostParams): string => params.type
		const rulePut = (params: NodesQemuFirewallRulesPutParams): string | undefined => params.action
		const aliasPost = (params: NodesQemuFirewallAliasesPostParams): string => params.name
		const options = (params: NodesQemuFirewallOptionsPutParams): boolean | undefined =>
			params.enable
		const lxcRulePost: NodesLxcFirewallRulesPostParams = { type: 'in', action: 'ACCEPT' }
		const lxcRulePut: NodesLxcFirewallRulesPutParams = { action: 'DROP' }
		const lxcAlias: NodesLxcFirewallAliasesPostParams = { name: 'a', cidr: '10.0.0.0/8' }
		const lxcOptions: NodesLxcFirewallOptionsPutParams = { enable: true }
		expect(rulePost(lxcRulePost)).toBe('in')
		expect(rulePut(lxcRulePut)).toBe('DROP')
		expect(aliasPost(lxcAlias)).toBe('a')
		expect(options(lxcOptions)).toBe(true)
	})
})
