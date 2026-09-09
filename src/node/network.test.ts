import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { NodeNetworkApi } from './network.ts'

afterEach(closeMockClients)

describe('NodeNetworkApi', () => {
	test('list normalizes flags and hyphenated keys and keeps raw', async () => {
		const mock = mockClient()
		mock.reply({
			data: [
				{
					iface: 'vmbr1',
					type: 'bridge',
					method: 'manual',
					families: ['inet'],
					exists: 1,
					active: 0,
					autostart: 1,
					bridge_ports: 'none',
					bridge_vlan_aware: 1,
					mtu: '9000',
					priority: 5,
					altnames: ['enx001122334455'],
				},
				{ iface: 'vmbr1.20', type: 'vlan', 'vlan-id': 20, 'vlan-raw-device': 'vmbr1' },
			],
		})
		const [bridge, vlan] = await new NodeNetworkApi(mock.client, 'ms01-0160').list({
			type: 'any_bridge',
		})
		expect(mock.last().path).toBe('/nodes/ms01-0160/network?type=any_bridge')
		expect(bridge).toMatchObject({
			iface: 'vmbr1',
			exists: true,
			active: false,
			autostart: true,
			bridgePorts: 'none',
			bridgeVlanAware: true,
			mtu: 9000,
			priority: 5,
			altnames: ['enx001122334455'],
		})
		expect(bridge?.raw['bridge_vlan_aware']).toBe(1)
		expect(vlan).toMatchObject({ vlanId: 20, vlanRawDevice: 'vmbr1', families: [], altnames: [] })
	})

	test('get reads one interface by name', async () => {
		const mock = mockClient()
		mock.reply({ data: { iface: 'vmbr0', type: 'bridge', cidr: '10.0.0.2/24' } })
		const iface = await new NodeNetworkApi(mock.client, 'ms01-0160').get('vmbr0')
		expect(mock.last().path).toBe('/nodes/ms01-0160/network/vmbr0')
		expect(iface.cidr).toBe('10.0.0.2/24')
	})

	test('create stages an interface with a POST on the collection', async () => {
		const mock = mockClient()
		await new NodeNetworkApi(mock.client, 'ms01-0160').create({
			iface: 'vmbr1',
			type: 'bridge',
			bridge_ports: 'nic3',
			autostart: true,
		})
		expect(mock.calls()).toHaveLength(1)
		expect([mock.last().method, mock.last().path]).toEqual(['POST', '/nodes/ms01-0160/network'])
		expect(formObject(mock.last())).toEqual({
			iface: 'vmbr1',
			type: 'bridge',
			bridge_ports: 'nic3',
			autostart: '1',
		})
	})

	test('update and deleteInterface address the interface path', async () => {
		const mock = mockClient()
		const net = new NodeNetworkApi(mock.client, 'ms01-0160')
		await net.update('vmbr1', { type: 'bridge', bridge_ports: 'nic3 nic4' })
		expect([mock.last().method, mock.last().path]).toEqual([
			'PUT',
			'/nodes/ms01-0160/network/vmbr1',
		])
		expect(formObject(mock.last())).toEqual({ type: 'bridge', bridge_ports: 'nic3 nic4' })

		await net.deleteInterface('vmbr1')
		expect([mock.last().method, mock.last().path]).toEqual([
			'DELETE',
			'/nodes/ms01-0160/network/vmbr1',
		])
	})

	test('staged reads the diff the node puts beside data', async () => {
		const mock = mockClient()
		const net = new NodeNetworkApi(mock.client, 'ms01-0160')

		mock.reply({ data: [], attribs: { changes: '--- interfaces\n+++ interfaces.new\n' } })
		const pending = await net.staged()
		expect(pending.changed).toBe(true)
		expect(pending.diff).toContain('interfaces.new')

		mock.reply({ data: [] })
		expect(await net.staged()).toEqual({ changed: false, diff: undefined })
	})

	test('apply is a PUT on the collection and returns a UPID', async () => {
		const mock = mockClient()
		const net = new NodeNetworkApi(mock.client, 'ms01-0160')
		mock.reply({ data: 'UPID:ms01-0160:00000001:00000001:00000001:srvreload:networking:root@pam:' })
		const upid = await net.apply({ regenerateFrr: false })
		expect(upid).toStartWith('UPID:')
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', '/nodes/ms01-0160/network'])
		expect(formObject(mock.last())).toEqual({ 'regenerate-frr': '0' })

		mock.reply({ data: 'UPID:ms01-0160:00000001:00000001:00000001:srvreload:networking:root@pam:' })
		await net.apply()
		expect(mock.last().body).toBe('')
	})

	test('revert deletes the staged file', async () => {
		const mock = mockClient()
		await new NodeNetworkApi(mock.client, 'ms01-0160').revert()
		expect([mock.last().method, mock.last().path]).toEqual(['DELETE', '/nodes/ms01-0160/network'])
	})
})
