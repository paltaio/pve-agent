import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { ClusterHaApi, normalizeHaRule } from './ha.ts'

afterEach(closeMockClients)

describe('resources', () => {
	test('list, get and the writes address the resource by sid', async () => {
		const mock = mockClient()
		const ha = new ClusterHaApi(mock.client)
		mock.reply({ data: [{ sid: 'ct:110', type: 'ct', state: 'started' }] })
		expect((await ha.listResources({ type: 'ct' }))[0]?.sid).toBe('ct:110')
		expect(mock.last().path).toBe('/cluster/ha/resources?type=ct')

		mock.reply({ data: { sid: 'ct:110', type: 'ct' } })
		await ha.getResource('ct:110')
		expect(mock.last().path).toBe('/cluster/ha/resources/ct%3A110')

		await ha.createResource({ sid: 'ct:110', state: 'started', max_restart: 2 })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/cluster/ha/resources'])
		expect(formObject(mock.last())).toEqual({ sid: 'ct:110', state: 'started', max_restart: '2' })

		await ha.updateResource('ct:110', { state: 'ignored', delete: 'comment' })
		expect([mock.last().method, mock.last().path]).toEqual([
			'PUT',
			'/cluster/ha/resources/ct%3A110',
		])
		expect(formObject(mock.last())).toEqual({ state: 'ignored', delete: 'comment' })

		await ha.migrate('ct:110', 'ms02-0066')
		expect(mock.last().path).toBe('/cluster/ha/resources/ct%3A110/migrate')
		expect(formObject(mock.last())).toEqual({ node: 'ms02-0066' })
		await ha.relocate('ct:110', 'ms02-0066')
		expect(mock.last().path).toBe('/cluster/ha/resources/ct%3A110/relocate')
	})

	test('purge travels in the URL, not the body', async () => {
		const mock = mockClient()
		await new ClusterHaApi(mock.client).deleteResource('vm:100', { purge: false })
		expect(mock.last().method).toBe('DELETE')
		expect(mock.last().path).toBe('/cluster/ha/resources/vm%3A100?purge=0')
		expect(mock.last().body).toBe('')
	})
})

describe('rules', () => {
	test('a row narrows on type', () => {
		const affinity = normalizeHaRule({
			rule: 'db-on-ms02',
			type: 'node-affinity',
			resources: 'ct:110,vm:101',
			nodes: 'ms02-0078:2,ms02-0066:1',
			strict: 1,
			disable: 0,
		})
		expect(affinity.type).toBe('node-affinity')
		expect(affinity.resources).toEqual(['ct:110', 'vm:101'])
		if (affinity.type === 'node-affinity') {
			expect(affinity.nodes).toEqual(['ms02-0078:2', 'ms02-0066:1'])
			expect(affinity.strict).toBe(true)
		}

		const apart = normalizeHaRule({
			rule: 'keep-apart',
			type: 'resource-affinity',
			resources: 'vm:100,vm:101',
			affinity: 'negative',
			errors: { resources: 'vm:100 is not managed' },
		})
		expect(apart.type).toBe('resource-affinity')
		if (apart.type === 'resource-affinity') expect(apart.affinity).toBe('negative')
		expect(apart.disable).toBe(false)
		expect(apart.errors).toEqual({ resources: 'vm:100 is not managed' })
	})

	test('an unknown rule type keeps the base fields and names the type', () => {
		const rule = normalizeHaRule({ rule: 'x', type: 'time-affinity', resources: 'vm:100' })
		expect(rule.type).toBe('other')
		if (rule.type === 'other') expect(rule.ruleType).toBe('time-affinity')
		expect(rule.resources).toEqual(['vm:100'])
	})

	test('list filters, and each branch sends its own discriminator', async () => {
		const mock = mockClient()
		const ha = new ClusterHaApi(mock.client)
		mock.reply({ data: [] })
		await ha.listRules({ resource: 'ct:110' })
		expect(mock.last().path).toBe('/cluster/ha/rules?resource=ct%3A110')

		await ha.createRule({
			type: 'node-affinity',
			rule: 'db-on-ms02',
			resources: 'ct:110',
			nodes: 'ms02-0078:2,ms02-0066:1',
			strict: true,
		})
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/cluster/ha/rules'])
		expect(formObject(mock.last())).toEqual({
			type: 'node-affinity',
			rule: 'db-on-ms02',
			resources: 'ct:110',
			nodes: 'ms02-0078:2,ms02-0066:1',
			strict: '1',
		})

		await ha.createRule({
			type: 'resource-affinity',
			rule: 'keep-apart',
			resources: 'vm:100,vm:101',
			affinity: 'negative',
		})
		expect(formObject(mock.last())).toEqual({
			type: 'resource-affinity',
			rule: 'keep-apart',
			resources: 'vm:100,vm:101',
			affinity: 'negative',
		})

		await ha.updateRule('db-apart', {
			type: 'resource-affinity',
			affinity: 'negative',
			digest: 'd1',
		})
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/cluster/ha/rules/db-apart'])
		expect(formObject(mock.last())).toEqual({
			type: 'resource-affinity',
			affinity: 'negative',
			digest: 'd1',
		})
		await ha.deleteRule('db-apart')
		expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/cluster/ha/rules/db-apart'])
	})
})

describe('groups and manager', () => {
	test('a group row reads its flags as booleans', async () => {
		const mock = mockClient()
		mock.reply({ data: [{ group: 'ms02', nodes: 'ms02-0066,ms02-0078', restricted: 1 }] })
		const [group] = await new ClusterHaApi(mock.client).listGroups()
		expect(group?.restricted).toBe(true)
		expect(group?.nofailback).toBeUndefined()
	})

	test('group writes still reach the deprecated endpoints', async () => {
		const mock = mockClient()
		const ha = new ClusterHaApi(mock.client)
		await ha.createGroup({ group: 'ms02', nodes: 'ms02-0066,ms02-0078' })
		expect(mock.last().path).toBe('/cluster/ha/groups')
		expect(formObject(mock.last())).toEqual({ group: 'ms02', nodes: 'ms02-0066,ms02-0078' })
		await ha.updateGroup('ms02', { nofailback: true })
		expect(mock.last().path).toBe('/cluster/ha/groups/ms02')
		expect(formObject(mock.last())).toEqual({ nofailback: '1' })
		await ha.deleteGroup('ms02')
		expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/cluster/ha/groups/ms02'])
	})

	test('status rows, arm and disarm', async () => {
		const mock = mockClient()
		const ha = new ClusterHaApi(mock.client)
		mock.reply({ data: [{ id: 'quorum', type: 'quorum', quorate: 1, status: 'OK' }] })
		expect((await ha.statusCurrent())[0]?.quorate).toBe(true)
		expect(mock.last().path).toBe('/cluster/ha/status/current')
		await ha.disarm('freeze')
		expect(mock.last().path).toBe('/cluster/ha/status/disarm-ha')
		expect(formObject(mock.last())).toEqual({ 'resource-mode': 'freeze' })
		await ha.arm()
		expect(mock.last().path).toBe('/cluster/ha/status/arm-ha')
	})
})
