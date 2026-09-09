import { afterEach, describe, expect, test } from 'bun:test'
import { PveTierError } from '../core/errors.ts'
import { closeMockClients, formObject, mockClient } from '../core/test-support/api-mock.ts'
import { listVms, QemuApi } from './qemu.ts'

afterEach(closeMockClients)

const path = '/nodes/ms01-0160/qemu/9000'
const upid = 'UPID:ms01:00000001:00000001:00000001:qmstart:9000:agents@pve:'

describe('QemuApi', () => {
	test('binds the sub-objects to the VM path', () => {
		const mock = mockClient()
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)
		expect(vm.type).toBe('qemu')
		expect(vm.path).toBe(path)
		expect(vm.snapshots.path).toBe(`${path}/snapshot`)
		expect(vm.firewall.rules.path).toBe(`${path}/firewall/rules`)
		expect(vm.agent.vmid).toBe(9000)
	})

	test('sends the power calls to their own endpoints and returns the UPID', async () => {
		const mock = mockClient()
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)
		for (let i = 0; i < 7; i += 1) mock.reply({ data: upid })

		expect(await vm.start()).toBe(upid)
		await vm.stop({ timeout: 30 })
		await vm.shutdown({ forceStop: true, timeout: 60 })
		await vm.reboot()
		await vm.reset()
		await vm.suspend({ todisk: true })
		await vm.resume()

		expect(mock.calls().map((call) => `${call.method} ${call.path}`)).toEqual([
			`POST ${path}/status/start`,
			`POST ${path}/status/stop`,
			`POST ${path}/status/shutdown`,
			`POST ${path}/status/reboot`,
			`POST ${path}/status/reset`,
			`POST ${path}/status/suspend`,
			`POST ${path}/status/resume`,
		])
		expect(formObject(mock.calls()[2] ?? mock.last())).toEqual({ forceStop: '1', timeout: '60' })
		expect(formObject(mock.calls()[5] ?? mock.last())).toEqual({ todisk: '1' })
	})

	test('reads status and config into normalized rows', async () => {
		const mock = mockClient()
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)

		mock.reply({ data: { status: 'running', qmpstatus: 'running', agent: 1 } })
		const status = await vm.status()
		expect(mock.last().path).toBe(`${path}/status/current`)
		expect(status.runState).toBe('running')
		expect(status.node).toBe('ms01-0160')

		mock.reply({
			data: { memory: 512, net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr1', digest: 'd' },
		})
		const config = await vm.getConfig({ current: true })
		expect(mock.last().path).toBe(`${path}/config?current=1`)
		expect(config.memory).toBe(512)
		expect(config.nets['net0']?.['bridge']).toBe('vmbr1')
		expect(config.digest).toBe('d')

		mock.reply({ data: { status: 'running' } })
		expect((await vm.waitForRunState('running')).runState).toBe('running')
	})

	test('separates the synchronous PUT config from the asynchronous POST', async () => {
		const mock = mockClient()
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)

		await vm.setConfig({ cores: 2 })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', `${path}/config`])
		expect(formObject(mock.last())).toEqual({ cores: '2' })

		mock.reply({ data: upid })
		expect(await vm.setConfigAsync({ scsi1: 'local-zfs:8', background_delay: 5 })).toBe(upid)
		expect([mock.last().method, mock.last().path]).toEqual(['POST', `${path}/config`])
		expect(formObject(mock.last())).toEqual({ scsi1: 'local-zfs:8', background_delay: '5' })
	})

	test('deletes and reverts config keys through the PUT parameters', async () => {
		const mock = mockClient()
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)

		await vm.deleteConfigKeys(['net1', 'unused0'], { force: true })
		expect(formObject(mock.last())).toEqual({ force: '1', delete: 'net1,unused0' })

		await vm.revertPending('memory')
		expect(formObject(mock.last())).toEqual({ revert: 'memory' })

		mock.reply({ data: [{ key: 'memory', value: 512, pending: 768 }] })
		const [change] = await vm.pending()
		expect(mock.last().path).toBe(`${path}/pending`)
		expect(change).toMatchObject({ key: 'memory', value: 512, pending: 768 })
	})

	test('deletes the VM with its parameters in the query string', async () => {
		const mock = mockClient()
		mock.reply({ data: upid })
		await new QemuApi(mock.client, 'ms01-0160', 9000).delete({ purge: true })
		expect([mock.last().method, mock.last().path]).toEqual(['DELETE', `${path}?purge=1`])
		expect(mock.last().body).toBe('')
	})

	test('sends the disk, clone, migrate and template calls', async () => {
		const mock = mockClient()
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)

		await vm.unlink(['unused0', 'unused1'], { force: true })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', `${path}/unlink`])
		expect(formObject(mock.last())).toEqual({ force: '1', idlist: 'unused0,unused1' })

		await vm.resize({ disk: 'scsi0', size: '+8G' })
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', `${path}/resize`])
		expect(formObject(mock.last())).toEqual({ disk: 'scsi0', size: '+8G' })

		await vm.moveDisk({ disk: 'scsi0', storage: 'fast', delete: true })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', `${path}/move_disk`])

		await vm.clone({ newid: 9010, full: true })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', `${path}/clone`])
		expect(formObject(mock.last())).toEqual({ newid: '9010', full: '1' })

		await vm.migrate({ target: 'ms02-0066', online: true })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', `${path}/migrate`])

		mock.reply({ data: { running: 1, allowed_nodes: ['ms02-0066'], local_disks: [] } })
		const pre = await vm.migratePreconditions('ms02-0066')
		expect(mock.last().path).toBe(`${path}/migrate?target=ms02-0066`)
		expect(pre.allowedNodes).toEqual(['ms02-0066'])

		await vm.toTemplate({ disk: 'scsi0' })
		expect([mock.last().method, mock.last().path]).toEqual(['POST', `${path}/template`])
	})

	test('reads feature, rrd, cloudinit and monitor', async () => {
		const mock = mockClient()
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)

		mock.reply({ data: { hasFeature: 1, nodes: ['ms01-0160'] } })
		expect(await vm.feature('clone', 'base')).toEqual({ hasFeature: true, nodes: ['ms01-0160'] })
		expect(mock.last().path).toBe(`${path}/feature?feature=clone&snapname=base`)

		mock.reply({ data: [{ time: 1, cpu: 0.5 }] })
		expect(await vm.rrddata({ timeframe: 'hour', cf: 'AVERAGE' })).toEqual([{ time: 1, cpu: 0.5 }])
		expect(mock.last().path).toBe(`${path}/rrddata?timeframe=hour&cf=AVERAGE`)

		mock.reply({ data: [{ key: 'ciuser', value: 'root', pending: 'admin' }] })
		const [row] = await vm.cloudinit()
		expect(row).toMatchObject({ key: 'ciuser', value: 'root', pending: 'admin' })

		await vm.regenerateCloudinit()
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', `${path}/cloudinit`])

		mock.reply({ data: '#cloud-config\n' })
		expect(await vm.cloudinitDump('user')).toBe('#cloud-config\n')
		expect(mock.last().path).toBe(`${path}/cloudinit/dump?type=user`)

		mock.reply({ data: 'VM status: running\n' })
		expect(await vm.monitor('info status')).toBe('VM status: running\n')
		expect(formObject(mock.last())).toEqual({ command: 'info status' })

		await vm.sendKey('ctrl-alt-delete')
		expect([mock.last().method, mock.last().path]).toEqual(['PUT', `${path}/sendkey`])
	})

	test('passes the console proxy calls through', async () => {
		const mock = mockClient()
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)

		mock.reply({ data: { port: '5900', ticket: 't' } })
		expect(await vm.vncProxy({ websocket: true })).toEqual({ port: '5900', ticket: 't' })
		expect(mock.last().path).toBe(`${path}/vncproxy`)
		expect(formObject(mock.last())).toEqual({ websocket: '1' })

		await vm.termProxy({ serial: 'serial0' })
		expect(mock.last().path).toBe(`${path}/termproxy`)

		await vm.spiceProxy()
		expect(mock.last().path).toBe(`${path}/spiceproxy`)
	})
})

describe('root-only parameters', () => {
	test('refuses skiplock on a token-only client before sending', async () => {
		const mock = mockClient({ ticket: false })
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)

		await expect(vm.unlock()).rejects.toBeInstanceOf(PveTierError)
		await expect(vm.start({ skiplock: true })).rejects.toThrow(/skiplock/)
		expect(mock.calls()).toHaveLength(0)
	})

	test('lets a mapped PCI device through and stops a raw host one', async () => {
		const mock = mockClient({ ticket: false })
		const vm = new QemuApi(mock.client, 'ms01-0160', 9000)

		await vm.setConfig({ hostpci0: 'mapping=gpu,pcie=1' })
		expect(mock.calls()).toHaveLength(1)

		await expect(vm.setConfig({ hostpci1: '0000:01:00.0' })).rejects.toBeInstanceOf(PveTierError)
		expect(mock.calls()).toHaveLength(1)
	})
})

describe('listVms', () => {
	test('normalizes the node index and passes the full flag', async () => {
		const mock = mockClient()
		mock.reply({ data: [{ vmid: 100, name: 'a', status: 'stopped', template: 1, cpus: 2 }] })
		const [vm] = await listVms(mock.client, 'ms01-0160', { full: true })
		expect(mock.last().path).toBe('/nodes/ms01-0160/qemu?full=1')
		expect(vm).toMatchObject({
			type: 'qemu',
			node: 'ms01-0160',
			vmid: 100,
			template: true,
			maxcpu: 2,
		})
	})
})
