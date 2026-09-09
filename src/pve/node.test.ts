import { afterEach, describe, expect, test } from 'bun:test'
import { closeMockClients, mockClient } from '../core/test-support/api-mock.ts'
import { NodeApi } from '../node/node.ts'
import { PveCluster, type PveClusterOptions } from './cluster.ts'
import { fakeSsh } from './test-support.ts'

afterEach(closeMockClients)

function fixture(options: PveClusterOptions = {}) {
	const mock = mockClient()
	return { ...mock, cluster: new PveCluster(mock.client, options) }
}

describe('a node handle', () => {
	test('binds the node api and sends nothing', () => {
		const { cluster, requests } = fixture()
		const node = cluster.node('ms01-0160')
		expect(node.name).toBe('ms01-0160')
		expect(node.api).toBeInstanceOf(NodeApi)
		expect(node.api.node).toBe('ms01-0160')
		expect(requests).toEqual([])
	})

	test('status reads the node status', async () => {
		const { cluster, reply, last } = fixture()
		reply({ data: { uptime: 1234, pveversion: 'pve-manager/9.2.11' } })
		expect((await cluster.node('ms01-0160').status()).uptime).toBe(1234)
		expect(last().path).toBe('/nodes/ms01-0160/status')
	})

	test('tasks lists the node tasks with the options given', async () => {
		const { cluster, reply, last } = fixture()
		reply({
			data: [
				{
					upid: 'UPID:ms01-0160:0007A1F2:0121C6B4:65F4A0E2:qmstart:9000:root@pam:',
					type: 'qmstart',
					status: 'OK',
				},
			],
		})
		const { tasks } = await cluster.node('ms01-0160').tasks({ limit: 5 })
		expect(tasks.map((task) => task.type)).toEqual(['qmstart'])
		expect(last().path).toBe('/nodes/ms01-0160/tasks?limit=5')
	})

	test('shell opens the root shell once and shares it with the cluster', async () => {
		const ssh = fakeSsh({ hostname: { stdout: 'ms01-0160\n' } })
		const { cluster, requests } = fixture({ shell: { ssh: { spawn: ssh.spawn } } })
		const node = cluster.node('ms01-0160')
		const shell = await node.shell
		expect(await shell.output('hostname')).toBe('ms01-0160')
		expect(await node.shell).toBe(shell)
		expect(await cluster.nodeShell('ms01-0160')).toBe(shell)
		expect(shell.kind).toBe('ssh')
		expect(requests).toEqual([])
	})
})
