import { afterEach, describe, expect, test } from 'bun:test'
import { PveAuthError, PveConfigError, PveNotFoundError } from '../core/errors.ts'
import { closeMockClients, formFields, mockClient } from '../core/test-support/api-mock.ts'
import type { GuestRef } from '../guest/types.ts'
import { PveShellCredentialError, PveShellTransportError } from '../shell/errors.ts'
import { connect, PveCluster } from './cluster.ts'
import { PveContainer, PveVm } from './guest.ts'
import {
	clusterFixture,
	DONE,
	fakeSockets,
	fakeSsh,
	TERM_PROXY,
	UPID,
	VNC_PROXY,
} from './test-support.ts'

afterEach(closeMockClients)
const VM_9000: Required<GuestRef> = { type: 'qemu', node: 'ms01-0160', vmid: 9000 }

/** A cluster over the recording client, with an optional default node so `node()` resolves. */
/** Credentials that point `connect` at a mock server instead of the environment. */
function credentialsFor(baseUrl: string) {
	const url = new URL(baseUrl)
	return {
		host: url.hostname,
		port: Number(url.port),
		verifySsl: false,
		tokenId: 'agents@pve!ci',
		tokenSecret: 'secret',
		envFile: '/nonexistent/pve.env',
	}
}

describe('connecting', () => {
	test('connect checks the credentials with one GET /version', async () => {
		const mock = mockClient()
		mock.reply({ data: { version: '9.2.11', release: '9.2', repoid: 'f6997e698c79' } })
		const cluster = await connect(credentialsFor(mock.client.baseUrl))
		expect(cluster.client.baseUrl).toBe(mock.client.baseUrl)
		expect(mock.calls().map((call) => `${call.method} ${call.path}`)).toEqual(['GET /version'])
		await cluster.close()
	})

	test('connect rethrows a refused credential after closing the cluster', async () => {
		const mock = mockClient()
		mock.reply({ status: 401, body: 'authentication failure' })
		await expect(connect(credentialsFor(mock.client.baseUrl))).rejects.toBeInstanceOf(PveAuthError)
	})

	test('version reads GET /version', async () => {
		const { cluster, reply, last } = clusterFixture()
		reply({ data: { version: '9.2.11', release: '9.2', repoid: 'f6997e698c79' } })
		expect((await cluster.version()).version).toBe('9.2.11')
		expect(last().path).toBe('/version')
	})

	test('nodes reads GET /nodes', async () => {
		const { cluster, reply, last } = clusterFixture()
		reply({ data: [{ node: 'ms01-0160', status: 'online' }] })
		expect((await cluster.nodes()).map((entry) => entry.node)).toEqual(['ms01-0160'])
		expect(last().path).toBe('/nodes')
	})

	test('node falls back to the configured default', () => {
		const { cluster } = clusterFixture({ node: 'ms01-0160' })
		expect(cluster.node().name).toBe('ms01-0160')
		expect(cluster.node('ms02-0066').name).toBe('ms02-0066')
	})

	test('node without a name or a default names the variable to set', () => {
		const { cluster } = clusterFixture()
		expect(() => cluster.node()).toThrow(PveConfigError)
		expect(() => cluster.node()).toThrow(/PVE_NODE/)
	})
})

describe('guest handles', () => {
	test('vm and container build without sending anything', () => {
		const { cluster, requests } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		const ct = cluster.container(9001, 'ms02-0066')
		expect(vm).toBeInstanceOf(PveVm)
		expect(vm.type).toBe('qemu')
		expect(vm.path).toBe('/nodes/ms01-0160/qemu/9000')
		expect(ct).toBeInstanceOf(PveContainer)
		expect(ct.node).toBe('ms02-0066')
		expect(ct.path).toBe('/nodes/ms02-0066/lxc/9001')
		expect(requests).toEqual([])
	})

	test('guest resolves the node and the type from the cluster', async () => {
		const { cluster, reply, last } = clusterFixture()
		reply({ data: [{ type: 'lxc', node: 'ms02-0078', vmid: 110, status: 'running' }] })
		const guest = await cluster.guest(110)
		expect(guest).toBeInstanceOf(PveContainer)
		expect(guest.type).toBe('lxc')
		expect(guest.node).toBe('ms02-0078')
		expect(last().path.startsWith('/cluster/resources')).toBe(true)
	})

	test('a vmid no node holds is an error, not an empty handle', async () => {
		const { cluster, reply } = clusterFixture()
		reply({ data: [] })
		reply({ data: [] })
		await expect(cluster.guest(9042)).rejects.toBeInstanceOf(PveNotFoundError)
		await expect(cluster.guest(9042)).rejects.toThrow(/9042/)
	})

	test('list filters the cluster resources', async () => {
		const { cluster, reply } = clusterFixture()
		reply({
			data: [
				{ type: 'qemu', node: 'ms01-0160', vmid: 101, status: 'running' },
				{ type: 'lxc', node: 'ms02-0078', vmid: 110, status: 'running' },
				{ type: 'storage', node: 'ms01-0160', storage: 'local' },
			],
		})
		const guests = await cluster.list({ type: 'lxc' })
		expect(guests.map((guest) => guest.vmid)).toEqual([110])
	})

	test('nextId reads the lowest free vmid', async () => {
		const { cluster, reply, last } = clusterFixture()
		reply({ data: '9000' })
		expect(await cluster.nextId()).toBe(9000)
		expect(last().path.startsWith('/cluster/nextid')).toBe(true)
	})

	test('waitForTask polls the task and returns its final status', async () => {
		const { cluster, reply, requests } = clusterFixture()
		reply({ data: { status: 'running' } })
		reply({ data: { ...DONE, upid: UPID } })
		const status = await cluster.waitForTask(UPID, { initialDelayMs: 1 })
		expect(status.outcome).toBe('ok')
		expect(requests).toHaveLength(2)
	})
})

describe('creating guests', () => {
	test('createVm claims the next free vmid, sends no node key and waits', async () => {
		const { cluster, reply, requests } = clusterFixture()
		reply({ data: '9000' })
		reply({ data: UPID })
		reply({ data: DONE })
		const vm = await cluster.createVm({
			node: 'ms01-0160',
			name: 'probe',
			memory: '1024',
			scsi0: 'ms01-vms:8',
		})
		expect(vm).toBeInstanceOf(PveVm)
		expect(vm.vmid).toBe(9000)
		expect(vm.node).toBe('ms01-0160')
		expect(requests[0]?.path.startsWith('/cluster/nextid')).toBe(true)
		expect(requests[1]?.path).toBe('/nodes/ms01-0160/qemu')
		const create = requests[1]
		if (!create) throw new Error('no create request')
		const fields = formFields(create)
		expect(fields.get('vmid')).toBe('9000')
		expect(fields.get('scsi0')).toBe('ms01-vms:8')
		expect(fields.has('node')).toBe(false)
		expect(requests[2]?.path).toContain('/tasks/')
	})

	test('createVm keeps an explicit vmid and defaults the node', async () => {
		const { cluster, reply, requests } = clusterFixture({ node: 'ms01-0160' })
		reply({ data: UPID })
		reply({ data: DONE })
		const vm = await cluster.createVm({ vmid: 9005, memory: '512' })
		expect(vm.vmid).toBe(9005)
		expect(requests[0]?.path).toBe('/nodes/ms01-0160/qemu')
	})

	test('createContainer sends unprivileged unless the spec sets it', async () => {
		const { cluster, reply, requests } = clusterFixture({ node: 'ms01-0160' })
		reply({ data: UPID })
		reply({ data: DONE })
		const ct = await cluster.createContainer({
			vmid: 9010,
			ostemplate: 'local:vztmpl/alpine.tar.xz',
		})
		expect(ct).toBeInstanceOf(PveContainer)
		expect(ct.path).toBe('/nodes/ms01-0160/lxc/9010')
		const first = requests[0]
		if (!first) throw new Error('no create request')
		expect(formFields(first).get('unprivileged')).toBe('1')

		reply({ data: UPID })
		reply({ data: DONE })
		await cluster.createContainer({
			vmid: 9011,
			ostemplate: 'local:vztmpl/alpine.tar.xz',
			unprivileged: false,
		})
		const second = requests[2]
		if (!second) throw new Error('no second create request')
		expect(formFields(second).get('unprivileged')).toBe('0')
	})
})

describe('sessions', () => {
	test('a node shell opens once per node and is shared', async () => {
		const ssh = fakeSsh({ hostname: { stdout: 'ms01-0160\n' } })
		const { cluster } = clusterFixture({ shell: { ssh: { spawn: ssh.spawn } } })
		const [first, second] = await Promise.all([
			cluster.nodeShell('ms01-0160'),
			cluster.nodeShell('ms01-0160'),
		])
		expect(second).toBe(first)
		expect(await first.output('hostname')).toBe('ms01-0160')
		expect(ssh.commands.filter((line) => line.endsWith(' true'))).toHaveLength(1)
		expect(ssh.commands.every((line) => line.includes('root@ms01-0160'))).toBe(true)
	})

	test('a closed shell is dropped, and closeNodeShell closes the one that is open', async () => {
		const ssh = fakeSsh({ hostname: { stdout: 'ms01-0160\n' } })
		const { cluster } = clusterFixture({ shell: { ssh: { spawn: ssh.spawn } } })
		const first = await cluster.nodeShell('ms01-0160')
		await first.close()
		const second = await cluster.nodeShell('ms01-0160')
		expect(second).not.toBe(first)
		await cluster.closeNodeShell('ms01-0160')
		await cluster.closeNodeShell('ms01-0160')
		expect(await cluster.nodeShell('ms01-0160')).not.toBe(second)
	})

	test('a shell whose transport fails is dropped', async () => {
		let attempts = 0
		const ssh = fakeSsh({
			hostname: () => {
				attempts += 1
				return attempts === 1
					? { exitCode: 255, stderr: 'ssh: connect to host ms01-0160 port 22: Connection refused' }
					: { stdout: 'ms01-0160\n' }
			},
		})
		const { cluster } = clusterFixture({ shell: { ssh: { spawn: ssh.spawn } } })
		const first = await cluster.nodeShell('ms01-0160')
		await expect(first.output('hostname')).rejects.toBeInstanceOf(PveShellTransportError)
		const second = await cluster.nodeShell('ms01-0160')
		expect(second).not.toBe(first)
		expect(await second.output('hostname')).toBe('ms01-0160')
	})

	test('a shell that fails to open is not kept, so the next call tries again', async () => {
		const ssh = fakeSsh({
			true: { exitCode: 255, stderr: 'root@ms01-0160: Permission denied (publickey).' },
		})
		const { cluster } = clusterFixture({ shell: { ssh: { spawn: ssh.spawn }, transport: 'ssh' } })
		await expect(cluster.nodeShell('ms01-0160')).rejects.toBeInstanceOf(PveShellCredentialError)
		await expect(cluster.nodeShell('ms01-0160')).rejects.toBeInstanceOf(PveShellCredentialError)
		expect(ssh.commands).toHaveLength(2)
	})

	test('a VNC session opens once per vmid and is forgotten when the socket drops', async () => {
		const sockets = fakeSockets()
		const { cluster, reply, calls } = clusterFixture({ socketFactory: sockets.factory })
		reply({ data: VNC_PROXY })
		const [first, second] = await Promise.all([
			cluster.vncSession(VM_9000),
			cluster.vncSession(VM_9000),
		])
		expect(second).toBe(first)
		expect(first.connected).toBe(true)
		expect(sockets.vnc).toHaveLength(1)
		expect(calls().map((call) => `${call.method} ${call.path}`)).toEqual([
			'POST /nodes/ms01-0160/qemu/9000/vncproxy',
		])

		sockets.vnc[0]?.dropConnection()
		expect(first.connected).toBe(false)
		reply({ data: VNC_PROXY })
		const third = await cluster.vncSession(VM_9000)
		expect(third).not.toBe(first)
		expect(sockets.vnc).toHaveLength(2)
	})

	test('a serial console opens once per vmid and asks termproxy for the serial port', async () => {
		const sockets = fakeSockets()
		const { cluster, reply, calls } = clusterFixture({ socketFactory: sockets.factory })
		reply({ data: TERM_PROXY })
		const [first, second] = await Promise.all([
			cluster.serialConsole(VM_9000, { cols: 40, rows: 6 }),
			cluster.serialConsole(VM_9000),
		])
		expect(second).toBe(first)
		expect(first.connected).toBe(true)
		expect(first.cols).toBe(40)
		expect(sockets.ptys).toHaveLength(1)
		const request = calls()[0]
		if (!request) throw new Error('no termproxy request')
		expect(request.path).toBe('/nodes/ms01-0160/qemu/9000/termproxy')
		expect(formFields(request).get('serial')).toBe('serial0')
	})

	test('two clusters share no session state', async () => {
		const sockets = fakeSockets()
		const mock = mockClient()
		const first = new PveCluster(mock.client, { socketFactory: sockets.factory })
		const second = new PveCluster(mock.client, { socketFactory: sockets.factory })
		mock.reply({ data: VNC_PROXY })
		mock.reply({ data: VNC_PROXY })
		const sessions = await Promise.all([first.vncSession(VM_9000), second.vncSession(VM_9000)])
		expect(sessions[0]).not.toBe(sessions[1])
		expect(sockets.vnc).toHaveLength(2)
		await first.close()
		expect(sessions[0]?.connected).toBe(false)
		expect(sessions[1]?.connected).toBe(true)
		await second.close()
	})
})

describe('disposal', () => {
	test('close tears down every session and shell, and is safe to repeat', async () => {
		const sockets = fakeSockets()
		const ssh = fakeSsh()
		const { cluster, reply } = clusterFixture({
			socketFactory: sockets.factory,
			shell: { ssh: { spawn: ssh.spawn, controlPath: '/tmp/pve-agent-test.sock' } },
		})
		reply({ data: VNC_PROXY })
		reply({ data: TERM_PROXY })
		await cluster.vncSession(VM_9000)
		await cluster.serialConsole(VM_9000)
		await cluster.nodeShell('ms01-0160')

		await cluster.close()
		expect(sockets.vnc[0]?.closes).toBe(1)
		expect(sockets.ptys[0]?.closes).toBe(1)
		expect(ssh.commands.at(-1)).toContain('-O exit')

		await cluster.close()
		expect(sockets.vnc[0]?.closes).toBe(1)
	})

	test('close waits for a session still opening and closes it too', async () => {
		const sockets = fakeSockets()
		const { cluster, reply } = clusterFixture({ socketFactory: sockets.factory })
		reply({ data: VNC_PROXY, delayMs: 20 })
		const opening = cluster.vncSession(VM_9000)
		await cluster.close()
		expect((await opening).connected).toBe(false)
		expect(sockets.vnc[0]?.closes).toBe(1)
	})

	test('await using closes the cluster at the end of the block', async () => {
		const sockets = fakeSockets()
		const outer = clusterFixture({ socketFactory: sockets.factory })
		outer.reply({ data: VNC_PROXY })
		{
			await using cluster = outer.cluster
			await cluster.vncSession(VM_9000)
		}
		expect(sockets.vnc[0]?.closes).toBe(1)
	})
})
