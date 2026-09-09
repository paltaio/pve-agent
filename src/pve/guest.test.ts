import { afterEach, describe, expect, test } from 'bun:test'
import { PveApiError, PveTaskError } from '../core/errors.ts'
import { closeMockClients, formFields } from '../core/test-support/api-mock.ts'
import { clusterFixture, DONE, fakeSsh, UPID, VNC_PROXY } from './test-support.ts'

afterEach(closeMockClients)

const VM = '/nodes/ms01-0160/qemu/9000'
const CT = '/nodes/ms02-0078/lxc/110'

/** Queues a UPID and a finished task status, the pair every lifecycle call reads. */
function taskDone(reply: (reply: { data: unknown }) => void): void {
	reply({ data: UPID })
	reply({ data: DONE })
}

describe('lifecycle calls wait for the task', () => {
	test('start posts and returns the finished status', async () => {
		const { cluster, reply, requests } = clusterFixture({ node: 'ms01-0160' })
		taskDone(reply)
		const status = await cluster.vm(9000).start()
		expect(status.exitStatus).toBe('OK')
		expect(status.outcome).toBe('ok')
		expect(requests[0]?.path).toBe(`${VM}/status/start`)
		expect(requests[1]?.path).toContain('/tasks/')
	})

	test('a failed task throws with its exit status', async () => {
		const { cluster, reply } = clusterFixture({ node: 'ms01-0160' })
		reply({ data: UPID })
		reply({ data: { status: 'stopped', exitstatus: 'start failed: QEMU exited' } })
		reply({ data: [{ n: 1, t: 'start failed: QEMU exited' }] })
		await expect(cluster.vm(9000).start()).rejects.toBeInstanceOf(PveTaskError)
	})

	test('a task that lost the config lock is posted again until it runs', async () => {
		const { cluster, reply, calls } = clusterFixture({ node: 'ms01-0160' })
		const locked = {
			status: 'stopped',
			exitstatus: "can't lock file '/var/lock/qemu-server/lock-9000.conf' - got timeout",
		}
		for (let i = 0; i < 2; i += 1) {
			reply({ data: UPID })
			reply({ data: locked })
			reply({ data: [{ n: 1, t: locked.exitstatus }] })
		}
		taskDone(reply)
		const status = await cluster.vm(9000).stop()
		expect(status.exitStatus).toBe('OK')
		const posts = calls().filter((call) => call.method === 'POST')
		expect(posts.map((call) => call.path)).toEqual([
			`${VM}/status/stop`,
			`${VM}/status/stop`,
			`${VM}/status/stop`,
		])
	})

	test('any other failure is thrown after one attempt', async () => {
		const { cluster, reply, calls } = clusterFixture({ node: 'ms01-0160' })
		reply({ data: UPID })
		reply({ data: { status: 'stopped', exitstatus: 'VM quit/powerdown failed' } })
		reply({ data: [] })
		await expect(cluster.vm(9000).shutdown()).rejects.toBeInstanceOf(PveTaskError)
		expect(calls().filter((call) => call.method === 'POST')).toHaveLength(1)
	})

	test('every power call hits its own endpoint with its parameters', async () => {
		const { cluster, reply, calls } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		for (let i = 0; i < 7; i += 1) taskDone(reply)
		await vm.stop({ timeout: 30 })
		await vm.shutdown({ forceStop: true })
		await vm.reboot()
		await vm.reset()
		await vm.suspend({ todisk: true })
		await vm.resume()
		await vm.start()
		const posts = calls().filter((call) => call.method === 'POST')
		expect(posts.map((call) => call.path)).toEqual([
			`${VM}/status/stop`,
			`${VM}/status/shutdown`,
			`${VM}/status/reboot`,
			`${VM}/status/reset`,
			`${VM}/status/suspend`,
			`${VM}/status/resume`,
			`${VM}/status/start`,
		])
		const stop = posts[0]
		const shutdown = posts[1]
		const suspend = posts[4]
		if (!stop || !shutdown || !suspend) throw new Error('missing power request')
		expect(formFields(stop).get('timeout')).toBe('30')
		expect(formFields(shutdown).get('forceStop')).toBe('1')
		expect(formFields(suspend).get('todisk')).toBe('1')
	})

	test('a container has the same calls on its own path', async () => {
		const { cluster, reply, calls } = clusterFixture({ node: 'ms01-0160' })
		const ct = cluster.container(110, 'ms02-0078')
		for (let i = 0; i < 6; i += 1) taskDone(reply)
		await ct.start()
		await ct.stop()
		await ct.shutdown({ timeout: 10 })
		await ct.reboot()
		await ct.suspend()
		await ct.resume()
		const posts = calls().filter((call) => call.method === 'POST')
		expect(posts.map((call) => call.path)).toEqual([
			`${CT}/status/start`,
			`${CT}/status/stop`,
			`${CT}/status/shutdown`,
			`${CT}/status/reboot`,
			`${CT}/status/suspend`,
			`${CT}/status/resume`,
		])
	})

	test('clone and migrate post their parameters and wait', async () => {
		const { cluster, reply, calls } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		taskDone(reply)
		taskDone(reply)
		await vm.clone({ newid: 9001, full: true })
		await vm.migrate({ target: 'ms02-0066', online: true })
		const posts = calls().filter((call) => call.method === 'POST')
		const clone = posts[0]
		const migrate = posts[1]
		if (!clone || !migrate) throw new Error('missing request')
		expect(clone.path).toBe(`${VM}/clone`)
		expect(formFields(clone).get('newid')).toBe('9001')
		expect(migrate.path).toBe(`${VM}/migrate`)
		expect(formFields(migrate).get('target')).toBe('ms02-0066')
	})

	test('delete closes the consoles first and passes purge in the query', async () => {
		const { cluster, reply, calls, vnc } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		reply({ data: VNC_PROXY })
		await vm.kvm.press('enter')
		taskDone(reply)
		await vm.delete({ purge: true })
		expect(vnc[0]?.closes).toBe(1)
		const destroy = calls().find((call) => call.method === 'DELETE')
		expect(destroy?.path).toBe(`${VM}?purge=1`)
	})
})

describe('status, config and snapshots', () => {
	test('status and waitFor read the current status', async () => {
		const { cluster, reply, requests } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		reply({ data: { status: 'stopped', vmid: 9000 } })
		expect((await vm.status()).runState).toBe('stopped')
		reply({ data: { status: 'stopped', vmid: 9000 } })
		reply({ data: { status: 'running', vmid: 9000 } })
		const status = await vm.waitFor('running', { initialDelayMs: 1 })
		expect(status.runState).toBe('running')
		expect(requests.map((request) => request.path)).toEqual([
			`${VM}/status/current`,
			`${VM}/status/current`,
			`${VM}/status/current`,
		])
	})

	test('config reads the normalized config and configure writes through PUT', async () => {
		const { cluster, reply, calls } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		reply({ data: { name: 'probe', memory: 1024, net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' } })
		const config = await vm.config()
		expect(config.name).toBe('probe')
		expect(config.nets['net0']?.['bridge']).toBe('vmbr0')
		reply({ data: null })
		await vm.configure({ memory: '4096' })
		const put = calls()[1]
		if (!put) throw new Error('no config request')
		expect(put.method).toBe('PUT')
		expect(put.path).toBe(`${VM}/config`)
		expect(formFields(put).get('memory')).toBe('4096')
	})

	test('notes reads the description and setNotes replaces it', async () => {
		const { cluster, reply, calls } = clusterFixture({ node: 'ms01-0160' })
		const ct = cluster.container(110, 'ms02-0078')
		reply({ data: { description: 'facade check' } })
		expect(await ct.notes()).toBe('facade check')
		reply({ data: {} })
		expect(await ct.notes()).toBeUndefined()
		reply({ data: null })
		await ct.setNotes('hello')
		const put = calls()[2]
		if (!put) throw new Error('no config request')
		expect(put.path).toBe(`${CT}/config`)
		expect(formFields(put).get('description')).toBe('hello')
	})

	test('snapshot passes the name and the options through and waits', async () => {
		const { cluster, reply, requests } = clusterFixture({ node: 'ms01-0160' })
		taskDone(reply)
		await cluster.vm(9000).snapshot('clean', { description: 'before install', vmstate: true })
		const create = requests[0]
		if (!create) throw new Error('no snapshot request')
		expect(create.path).toBe(`${VM}/snapshot`)
		const fields = formFields(create)
		expect(fields.get('snapname')).toBe('clean')
		expect(fields.get('description')).toBe('before install')
		expect(fields.get('vmstate')).toBe('1')
	})

	test('snapshots, rollback and deleteSnapshot use the snapshot subtree', async () => {
		const { cluster, reply, calls } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		reply({
			data: [
				{ name: 's1', snaptime: 1 },
				{ name: 'current', digest: 'x' },
			],
		})
		expect((await vm.snapshots()).map((snapshot) => snapshot.name)).toEqual(['s1', 'current'])
		taskDone(reply)
		await vm.rollback('s1', { start: true })
		taskDone(reply)
		await vm.deleteSnapshot('s1', { force: true })
		const paths = calls().map((call) => `${call.method} ${call.path}`)
		expect(paths).toContain(`POST ${VM}/snapshot/s1/rollback`)
		expect(paths).toContain(`DELETE ${VM}/snapshot/s1?force=1`)
	})

	test('firewall and api expose the module handle underneath', () => {
		const { cluster } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		expect(vm.firewall).toBe(vm.api.firewall)
		expect(vm.guest).toBe(vm.api.agent)
		expect(vm.api.path).toBe(VM)
	})
})

describe('running commands inside a guest', () => {
	test('the vm os helper is picked from the config and kept', async () => {
		const { cluster, reply, calls } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		reply({ data: { ostype: 'l26' } })
		reply({ data: { pid: 42 } })
		reply({ data: { exited: 1, exitcode: 0, 'out-data': '1000\n' } })
		const os = await vm.os
		expect(os.os).toBe('linux')
		expect(await os.output('id -u')).toBe('1000')
		expect(await vm.os).toBe(os)
		expect(calls().map((call) => call.path)).toEqual([
			`${VM}/config`,
			`${VM}/agent/exec`,
			`${VM}/agent/exec-status?pid=42`,
		])
	})

	test('a failed os open is retried on the next await', async () => {
		const { cluster, reply } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		reply({ status: 500, body: 'no such VM' })
		await expect(vm.os).rejects.toThrow()
		reply({ data: { ostype: 'win11' } })
		expect((await vm.os).os).toBe('windows')
	})

	test('waitForAgent polls ping until it answers', async () => {
		const { cluster, reply, requests } = clusterFixture({ node: 'ms01-0160' })
		const vm = cluster.vm(9000)
		reply({ status: 500, body: 'QEMU guest agent is not running' })
		reply({ data: { result: null } })
		await vm.waitForAgent({ initialDelayMs: 1, maxDelayMs: 1 })
		expect(requests.map((request) => request.path)).toEqual([
			`${VM}/agent/ping`,
			`${VM}/agent/ping`,
		])
	})

	test('a container runs commands through pct exec on its node shell', async () => {
		const ssh = fakeSsh({ 'pct exec 110': { stdout: 'alpine\n' } })
		const { cluster, requests } = clusterFixture({
			node: 'ms01-0160',
			shell: { ssh: { spawn: ssh.spawn } },
		})
		const ct = cluster.container(110, 'ms02-0078')
		const result = await ct.exec('cat /etc/hostname')
		expect(result.stdout).toBe('alpine\n')
		expect(ssh.commands.at(-1)).toContain(
			"root@ms02-0078 pct exec 110 -- sh -c 'cat /etc/hostname'",
		)
		expect(await ct.shell).toBe(await cluster.nodeShell('ms02-0078'))

		const os = await ct.os
		expect(os.os).toBe('linux')
		expect(await os.output('cat /etc/hostname')).toBe('alpine')
		expect(ssh.commands.at(-1)).toContain("pct exec 110 -- /bin/sh -c 'cat /etc/hostname'")
		expect(requests).toEqual([])
	})

	test('a guest agent error surfaces as the API error it was', async () => {
		const { cluster, reply } = clusterFixture({ node: 'ms01-0160' })
		reply({ status: 500, body: 'QEMU guest agent is not running' })
		await expect(cluster.vm(9000).guest.output(['hostname'])).rejects.toBeInstanceOf(PveApiError)
	})
})
