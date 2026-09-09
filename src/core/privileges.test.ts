import { describe, expect, test } from 'bun:test'
import { endpoints } from '../generated/endpoints.ts'
import { ROOT_ONLY_PARAM_RULES, rootOnlyParams } from './privileges.ts'

const QEMU_CONFIG = '/nodes/{node}/qemu/{vmid}/config'
const LXC_CONFIG = '/nodes/{node}/lxc/{vmid}/config'

function params(method: string, path: string, supplied: object): string[] {
	return rootOnlyParams(method, path, supplied).map((hit) => hit.param)
}

describe('rootOnlyParams', () => {
	test('returns nothing for no parameters or ordinary ones', () => {
		expect(rootOnlyParams('PUT', QEMU_CONFIG)).toEqual([])
		expect(
			params('PUT', QEMU_CONFIG, { cores: 2, name: 'web', net0: 'virtio,bridge=vmbr0' }),
		).toEqual([])
	})

	test('merges the documented parameters with a reason', () => {
		const hits = rootOnlyParams('POST', '/nodes/{node}/qemu/{vmid}/migrate', { force: true })
		expect(hits).toEqual([
			{ param: 'force', reason: 'the API schema marks this parameter as root-only' },
		])
	})

	test('only counts a parameter the caller set', () => {
		const path = '/nodes/{node}/qemu/{vmid}/status/start'
		expect(params('POST', path, { skiplock: false })).toEqual([])
		expect(params('POST', path, { skiplock: 0 })).toEqual([])
		expect(params('POST', path, { skiplock: undefined })).toEqual([])
		expect(params('POST', path, { skiplock: true })).toEqual(['skiplock'])
		expect(params('POST', path, { skiplock: 1 })).toEqual(['skiplock'])
	})

	test('a rule applies only on the paths it names', () => {
		expect(params('PUT', QEMU_CONFIG, { skiplock: true })).toEqual(['skiplock'])
		expect(params('PUT', '/cluster/options', { skiplock: true })).toEqual([])
	})

	test('flags args, lock and a hookscript on create and config', () => {
		expect(
			params('POST', '/nodes/{node}/qemu', { args: '-x', hookscript: 'local:snippets/h' }),
		).toEqual(['args', 'hookscript'])
		expect(params('PUT', QEMU_CONFIG, { lock: 'backup' })).toEqual(['lock'])
		expect(params('POST', '/nodes/{node}/lxc', { hookscript: 'local:snippets/h' })).toEqual([
			'hookscript',
		])
		expect(params('PUT', LXC_CONFIG, { hookscript: 'local:snippets/h' })).toEqual(['hookscript'])
	})

	test('flags the qemu options the permission check has no class for', () => {
		expect(
			params('PUT', QEMU_CONFIG, {
				affinity: '0-3',
				parallel0: '/dev/parport0',
				ivshmem: 'size=1',
				vmgenid: '1',
				hugepages: '2',
				cores: 2,
			}),
		).toEqual(['affinity', 'parallel0', 'ivshmem', 'vmgenid', 'hugepages'])
		expect(
			params('POST', '/nodes/{node}/qemu', { arch: 'aarch64', 'amd-sev': 'type=std' }),
		).toEqual(['arch', 'amd-sev'])
	})

	test('flags a delete that names a root-only option', () => {
		expect(params('PUT', QEMU_CONFIG, { delete: 'args,name' })).toEqual(['delete'])
		expect(params('PUT', QEMU_CONFIG, { delete: 'parallel1' })).toEqual(['delete'])
		expect(params('PUT', QEMU_CONFIG, { delete: 'name,memory' })).toEqual([])
	})

	test('reads the mount point value on lxc', () => {
		expect(params('PUT', LXC_CONFIG, { mp0: '/srv/host,mp=/data' })).toEqual(['mp0'])
		expect(params('PUT', LXC_CONFIG, { mp1: 'volume=/dev/sdb,mp=/data' })).toEqual(['mp1'])
		expect(params('PUT', LXC_CONFIG, { mp0: 'local-zfs:8,mp=/data' })).toEqual([])
		expect(params('POST', '/nodes/{node}/lxc', { rootfs: '/srv/root' })).toEqual(['rootfs'])
		expect(params('POST', '/nodes/{node}/lxc', { rootfs: 'local-zfs:8' })).toEqual([])
	})

	test('lets nesting through and stops at any other feature', () => {
		expect(params('PUT', LXC_CONFIG, { features: 'nesting=1' })).toEqual([])
		expect(params('PUT', LXC_CONFIG, { features: 'nesting=1,keyctl=1' })).toEqual(['features'])
		expect(params('PUT', LXC_CONFIG, { features: 'fuse=1' })).toEqual(['features'])
	})

	test('flags a container device passthrough', () => {
		expect(params('PUT', LXC_CONFIG, { dev0: '/dev/ttyUSB0' })).toEqual(['dev0'])
	})

	test('separates raw host devices from mappings', () => {
		expect(params('PUT', QEMU_CONFIG, { hostpci0: '0000:01:00.0' })).toEqual(['hostpci0'])
		expect(params('PUT', QEMU_CONFIG, { hostpci0: 'host=0000:01:00.0,pcie=1' })).toEqual([
			'hostpci0',
		])
		expect(params('PUT', QEMU_CONFIG, { hostpci0: 'mapping=gpu' })).toEqual([])
		expect(params('PUT', QEMU_CONFIG, { hostpci0: 'mapping=gpu,romfile=vbios.bin' })).toEqual([
			'hostpci0',
		])
		expect(params('PUT', QEMU_CONFIG, { usb0: 'host=1-1.2' })).toEqual(['usb0'])
		expect(params('PUT', QEMU_CONFIG, { usb0: '046d:c52b' })).toEqual(['usb0'])
		expect(params('PUT', QEMU_CONFIG, { usb0: 'host=spice' })).toEqual([])
		expect(params('PUT', QEMU_CONFIG, { usb0: 'spice,usb3=1' })).toEqual([])
		expect(params('PUT', QEMU_CONFIG, { usb0: 'mapping=scanner' })).toEqual([])
	})

	test('allows a socket serial port and nothing else', () => {
		expect(params('PUT', QEMU_CONFIG, { serial0: 'socket' })).toEqual([])
		expect(params('PUT', QEMU_CONFIG, { serial1: '/dev/ttyS0' })).toEqual(['serial1'])
	})

	test('flags the migration and start parameters the worker sets', () => {
		const start = '/nodes/{node}/qemu/{vmid}/status/start'
		expect(
			params('POST', start, {
				migratedfrom: 'ms02',
				migration_type: 'insecure',
				targetstorage: 'local',
				'force-cpu': 'host',
			}),
		).toEqual(['migratedfrom', 'migration_type', 'targetstorage', 'force-cpu'])
		expect(params('POST', '/nodes/{node}/qemu/{vmid}/status/stop', { keepActive: true })).toEqual([
			'keepActive',
		])
		expect(params('POST', '/nodes/{node}/qemu/{vmid}/status/stop', { timeout: 30 })).toEqual([])
	})

	test('lets a login shell through and refuses any other command', () => {
		expect(params('POST', '/nodes/{node}/termproxy', { cmd: 'login' })).toEqual([])
		expect(params('POST', '/nodes/{node}/termproxy', { cmd: 'ceph_install' })).toEqual(['cmd'])
		expect(params('POST', '/nodes/{node}/vncshell', { cmd: 'upgrade' })).toEqual(['cmd'])
	})
})

describe('ROOT_ONLY_PARAM_RULES', () => {
	test('every rule matches at least one registry endpoint that takes the parameter', () => {
		for (const rule of ROOT_ONLY_PARAM_RULES) {
			const takers = Object.values(endpoints).filter(
				(info) => rule.path.test(info.path) && rule.param in info.params,
			)
			expect(takers.length, `${rule.param} on ${rule.path}`).toBeGreaterThan(0)
		}
	})
})
