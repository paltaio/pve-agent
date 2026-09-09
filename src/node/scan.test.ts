import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { NodeScanApi } from './scan.ts'

afterEach(closeMockClients)

describe('NodeScanApi', () => {
	test('every scan is a GET with its arguments in the query string', async () => {
		const mock = mockClient()
		const scan = new NodeScanApi(mock.client, 'ms01-0160')
		for (const [call, path] of [
			[() => scan.nfs('10.0.0.5'), '/nodes/ms01-0160/scan/nfs?server=10.0.0.5'],
			[
				() => scan.cifs({ server: '10.0.0.5', username: 'u', password: 'p', domain: 'WG' }),
				'/nodes/ms01-0160/scan/cifs?server=10.0.0.5&username=u&password=p&domain=WG',
			],
			[() => scan.iscsi('10.0.0.6:3260'), '/nodes/ms01-0160/scan/iscsi?portal=10.0.0.6%3A3260'],
			[() => scan.lvm(), '/nodes/ms01-0160/scan/lvm'],
			[() => scan.lvmThin('vg0'), '/nodes/ms01-0160/scan/lvmthin?vg=vg0'],
			[() => scan.zfs(), '/nodes/ms01-0160/scan/zfs'],
			[
				() => scan.pbs({ server: '10.0.0.7', username: 'root@pam', password: 'p', port: 8007 }),
				'/nodes/ms01-0160/scan/pbs?server=10.0.0.7&username=root%40pam&password=p&port=8007',
			],
		] as const) {
			mock.reply({ data: [] })
			await call()
			expect([mock.last().method, mock.last().path]).toEqual(['GET', path])
		}
	})
})
