import { describe, expect, test } from 'bun:test'
import {
	formatGuestConfigValue,
	guestPath,
	joinKeyList,
	normalizeFeature,
	normalizeLxcConfig,
	normalizeMigratePreconditions,
	normalizePending,
	normalizeQemuConfig,
	normalizeSnapshots,
	normalizeStatus,
	normalizeSummary,
	parseGuestConfigValue,
	toRunState,
} from './types.ts'

describe('guest paths', () => {
	test('percent-encodes the node name and defaults the type to qemu', () => {
		expect(guestPath({ node: 'ms02/0078', vmid: 110, type: 'lxc' })).toBe(
			'/nodes/ms02%2F0078/lxc/110',
		)
		expect(guestPath({ node: 'ms01-0160', vmid: 100 })).toBe('/nodes/ms01-0160/qemu/100')
	})
})

describe('normalizeSummary', () => {
	test('reads the CPU count under either name PVE uses', () => {
		// A node index reports cpus; /cluster/resources reports maxcpu.
		expect(normalizeSummary({ vmid: 110, cpus: 4 }, 'lxc', 'ms02-0078').maxcpu).toBe(4)
		expect(normalizeSummary({ vmid: 110, maxcpu: 4 }, 'lxc', 'ms02-0078').maxcpu).toBe(4)
	})

	test('refuses a row whose vmid is missing or unparseable', () => {
		// vmid 0 would address /nodes/x/qemu/0 on the next call made with the row.
		expect(() => normalizeSummary({ cpus: 4 }, 'lxc', 'ms02-0078')).toThrow(/vmid/)
		expect(() => normalizeSummary({ vmid: 'nope' }, 'lxc', 'ms02-0078')).toThrow(/vmid/)
	})

	test('keeps the row type and node when the row carries them', () => {
		const summary = normalizeSummary(
			{ vmid: 110, type: 'lxc', node: 'ms02-0078', status: 'running', template: 0, tags: 'a;b' },
			'qemu',
			'ms01-0160',
		)
		expect(summary.type).toBe('lxc')
		expect(summary.node).toBe('ms02-0078')
		expect(summary.template).toBe(false)
		expect(summary.tags).toEqual(['a', 'b'])
		expect(summary.raw['template']).toBe(0)
	})
})

describe('normalizeStatus', () => {
	test('folds a QMP pause into the run state', () => {
		expect(toRunState('running', 'running')).toBe('running')
		expect(toRunState('running', 'paused')).toBe('paused')
		expect(toRunState('running', 'prelaunch')).toBe('paused')
		expect(toRunState('stopped')).toBe('stopped')
	})

	test('reads a live LXC status', () => {
		const status = normalizeStatus(
			{
				vmid: 110,
				name: 'image-library',
				status: 'running',
				cpus: 4,
				mem: 856494080,
				maxmem: 4294967296,
				uptime: 267686,
				pid: 229026,
				ha: { managed: 0 },
				type: 'lxc',
			},
			{ type: 'lxc', node: 'ms02-0078', vmid: 110 },
		)
		expect(status.runState).toBe('running')
		expect(status.haManaged).toBe(false)
		expect(status.qmpStatus).toBeUndefined()
		expect(status.agentEnabled).toBeUndefined()
		expect(status.runningMachine).toBeUndefined()
		expect(status.template).toBe(false)
		expect(status.pid).toBe(229026)
	})

	test('reads the QEMU fields', () => {
		const status = normalizeStatus(
			{
				status: 'running',
				qmpstatus: 'paused',
				agent: 1,
				'running-machine': 'pc-q35-9.2+pve1',
				'running-qemu': '10.0.2',
				ha: { managed: 1 },
			},
			{ type: 'qemu', node: 'ms01-0160', vmid: 101 },
		)
		expect(status.runState).toBe('paused')
		expect(status.agentEnabled).toBe(true)
		expect(status.haManaged).toBe(true)
		expect(status.runningMachine).toBe('pc-q35-9.2+pve1')
		expect(status.runningQemu).toBe('10.0.2')
	})
})

describe('config normalizers', () => {
	test('parses the disks and nets of a VM and keeps the rest raw', () => {
		const config = normalizeQemuConfig(
			{
				name: 'demo',
				memory: 512,
				cores: 1,
				ostype: 'l26',
				scsihw: 'virtio-scsi-single',
				agent: '1,fstrim_cloned_disks=1',
				scsi0: 'ms01-vms:vm-9001-disk-0,size=1G',
				ide2: 'local:iso/debian.iso,media=cdrom',
				efidisk0: 'ms01-vms:vm-9001-disk-1,efitype=4m,size=1M',
				unused0: 'ms01-vms:vm-9001-disk-2',
				net0: 'virtio=BC:24:11:A1:B2:C3,bridge=vmbr1',
				onboot: 1,
				digest: 'abc',
				vmgenid: 'x',
			},
			{ node: 'ms01-0160', vmid: 9001 },
		)
		expect(config.type).toBe('qemu')
		expect(config.name).toBe('demo')
		expect(config.memory).toBe(512)
		expect(config.onboot).toBe(true)
		expect(config.agent).toEqual({ enabled: true, fstrim_cloned_disks: true })
		expect(Object.keys(config.disks)).toEqual(['efidisk0', 'ide2', 'scsi0'])
		expect(config.disks['scsi0']).toEqual({ file: 'ms01-vms:vm-9001-disk-0', size: '1G' })
		expect(config.disks['ide2']?.['media']).toBe('cdrom')
		expect(config.unused['unused0']).toEqual({ file: 'ms01-vms:vm-9001-disk-2' })
		expect(config.nets['net0']).toEqual({
			model: 'virtio',
			macaddr: 'BC:24:11:A1:B2:C3',
			bridge: 'vmbr1',
		})
		expect(config.raw['vmgenid']).toBe('x')
		expect(config.raw['memory']).toBe(512)
	})

	test('reads memory from the property string spelling too', () => {
		const config = normalizeQemuConfig({ memory: 'current=2048' }, { node: 'n', vmid: 1 })
		expect(config.memory).toBe(2048)
	})

	test('keeps a sub-key the schema does not list', () => {
		const config = normalizeQemuConfig(
			{ net0: 'virtio=BC:24:11:A1:B2:C3,bridge=vmbr1,newkey=1' },
			{ node: 'n', vmid: 1 },
		)
		expect(config.nets['net0']?.['newkey']).toBe('1')
	})

	test('parses the volumes, mounts and features of a container', () => {
		const config = normalizeLxcConfig(
			{
				hostname: 'ct',
				cores: 4,
				memory: 256,
				swap: 0,
				unprivileged: 1,
				arch: 'amd64',
				digest: 'ee97fffd872e52e4a5caf93952b5a00c8e44cc59',
				rootfs: 'tank-vms:subvol-110-disk-0,size=32G',
				mp0: 'tank-data:subvol-110-disk-1,mp=/data,size=100G',
				mp10: '/mnt/host,mp=/host',
				features: 'nesting=1',
				net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:B3:03:ED,ip=dhcp,type=veth',
			},
			{ node: 'ms02-0078', vmid: 110 },
		)
		expect(config.type).toBe('lxc')
		expect(config.unprivileged).toBe(true)
		expect(config.swap).toBe(0)
		expect(config.rootfs).toEqual({ volume: 'tank-vms:subvol-110-disk-0', size: '32G' })
		expect(Object.keys(config.mounts)).toEqual(['mp0', 'mp10'])
		expect(config.mounts['mp10']?.['volume']).toBe('/mnt/host')
		expect(config.features).toEqual({ nesting: true })
		expect(config.nets['net0']?.['ip']).toBe('dhcp')
		expect(config.raw['cores']).toBe(4)
		expect(config.digest).toBe('ee97fffd872e52e4a5caf93952b5a00c8e44cc59')
	})

	test('parses and formats one value against its schema format', () => {
		const bag = parseGuestConfigValue('qemu', 'net3', 'virtio=BC:24:11:A1:B2:C3,bridge=vmbr1')
		expect(bag['model']).toBe('virtio')
		expect(formatGuestConfigValue('qemu', 'net3', bag)).toBe(
			'virtio=BC:24:11:A1:B2:C3,bridge=vmbr1',
		)
	})
})

describe('row normalizers', () => {
	test('marks the current pseudo-entry in a snapshot list', () => {
		const snapshots = normalizeSnapshots([
			{ name: 'before-upgrade', snaptime: 1788000000, vmstate: 0 },
			{ name: 'current', description: 'You are here!', running: 1 },
		])
		expect(snapshots[0]?.current).toBe(false)
		expect(snapshots[0]?.vmstate).toBe(false)
		expect(snapshots[1]?.current).toBe(true)
		expect(snapshots[1]?.running).toBe(true)
		expect(snapshots[1]?.raw['running']).toBe(1)
	})

	test('reads hasFeature whether it arrives as 1 or true', () => {
		expect(normalizeFeature({ hasFeature: 1 }).hasFeature).toBe(true)
		expect(normalizeFeature({ hasFeature: true }).hasFeature).toBe(true)
		expect(normalizeFeature({ hasFeature: 0 }).hasFeature).toBe(false)
		expect(normalizeFeature({ hasFeature: 1, nodes: ['ms01'] }).nodes).toEqual(['ms01'])
	})

	test('reads a pending row with a queued delete', () => {
		const rows = normalizePending([
			{ key: 'memory', value: 4096, pending: 8192 },
			{ key: 'net1', delete: 2 },
		])
		expect(rows[0]).toMatchObject({ key: 'memory', value: 4096, pending: 8192, delete: undefined })
		expect(rows[1]).toMatchObject({ key: 'net1', value: undefined, pending: undefined, delete: 2 })
	})

	test('reads migrate preconditions under the QEMU and the LXC spelling', () => {
		const qemu = normalizeMigratePreconditions({
			running: 1,
			allowed_nodes: ['ms02-0066'],
			not_allowed_nodes: { 'ms02-0078': { unavailable_storages: ['ms01-vms'] } },
			local_disks: [{ volid: 'ms01-vms:vm-101-disk-0' }],
			local_resources: ['hostpci0'],
		})
		expect(qemu.running).toBe(true)
		expect(qemu.allowedNodes).toEqual(['ms02-0066'])
		expect(Object.keys(qemu.notAllowedNodes ?? {})).toEqual(['ms02-0078'])
		expect(qemu.localDisks[0]?.['volid']).toBe('ms01-vms:vm-101-disk-0')
		expect(qemu.localResources).toEqual(['hostpci0'])

		const lxc = normalizeMigratePreconditions({ running: 0, 'allowed-nodes': ['ms02-0066'] })
		expect(lxc.running).toBe(false)
		expect(lxc.allowedNodes).toEqual(['ms02-0066'])
		expect(lxc.notAllowedNodes).toBeUndefined()
		expect(lxc.localDisks).toEqual([])
	})

	test('joins a key list the way the delete parameter wants it', () => {
		expect(joinKeyList(['net1', 'mp0'])).toBe('net1,mp0')
		expect(joinKeyList('lock')).toBe('lock')
	})
})
