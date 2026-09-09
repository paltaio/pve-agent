import { describe, expect, test } from 'bun:test'
import { PveShellPolicyError } from './errors.ts'
import { NodeShell } from './node-shell.ts'
import { FakeTransport } from './test-support.ts'
import { parseDatasetRows, parseZpoolStatus } from './zfs.ts'

const TWO_POOLS = `  pool: rpool
 state: ONLINE
config:

\tNAME         STATE     READ WRITE CKSUM
\trpool        ONLINE       0     0     0
\t  nvme1n1p3  ONLINE       0     0     0

errors: No known data errors

  pool: tank
 state: ONLINE
config:

\tNAME                                STATE     READ WRITE CKSUM
\ttank                                ONLINE       0     0     0
\t  nvme-CT4000T710SSD8_25375309E588  ONLINE       0     0     0
\t  nvme-CT4000T710SSD8_253753280282  ONLINE       0     0     0

errors: No known data errors
`

const DEGRADED = `  pool: tank
 state: DEGRADED
status: One or more devices could not be used because the label is missing or
\tinvalid.
action: Replace the device using 'zpool replace'.
  scan: scrub repaired 0B in 00:04:11 with 0 errors on Sun Sep  7 00:28:12 2026
config:

\tNAME             STATE     READ WRITE CKSUM
\ttank             DEGRADED     0     0     0
\t  mirror-0       DEGRADED     0     0     0
\t    nvme0n1      ONLINE       0     0     0
\t    nvme1n1      FAULTED      0     0     3  too many errors

errors: No known data errors
`

const POOL_LIST = [
	'rpool\t1022202216448\t4980645888\t1017221570560\t0\t0\t1.00\tONLINE\t-',
	'tank\t7971459301376\t764384886784\t7207074414592\t0\t9\t1.00\tONLINE\t/mnt',
].join('\n')

const DATASET_ROWS = [
	'rpool\tfilesystem\t4035559424\t1927119650816\t98304\t/rpool\ton\toff\t-\t-\t1725000000',
	'rpool/secure\tfilesystem\t196608\t1927119650816\t196608\t/rpool/secure\tlz4\taes-256-gcm\tavailable\t-\t1725000100',
	'rpool/data@s1\tsnapshot\t0\t-\t98304\t-\ton\toff\t-\t-\t1725000200',
].join('\n')

function shell(reply?: (command: string) => { stdout?: string; exitCode?: number }) {
	const transport = new FakeTransport(reply === undefined ? {} : { reply })
	return { transport, shell: new NodeShell(transport, { destructive: 'allow' }) }
}

describe('parseZpoolStatus', () => {
	test('reads every pool in the output', () => {
		const pools = parseZpoolStatus(TWO_POOLS)
		expect(pools.map((pool) => pool.name)).toEqual(['rpool', 'tank'])
		expect(pools[0]?.state).toBe('ONLINE')
		expect(pools[0]?.errors).toBe('No known data errors')
	})

	test('nests devices under the vdev that holds them', () => {
		const [pool] = parseZpoolStatus(TWO_POOLS)
		expect(pool?.devices).toHaveLength(1)
		expect(pool?.devices[0]?.name).toBe('rpool')
		expect(pool?.devices[0]?.children.map((device) => device.name)).toEqual(['nvme1n1p3'])
	})

	test('reads the scan line, the wrapped status paragraph and error counts', () => {
		const [pool] = parseZpoolStatus(DEGRADED)
		expect(pool?.state).toBe('DEGRADED')
		expect(pool?.scan).toContain('scrub repaired 0B')
		expect(pool?.status).toBe(
			'One or more devices could not be used because the label is missing or invalid.',
		)
		expect(pool?.action).toContain('zpool replace')

		const mirror = pool?.devices[0]?.children[0]
		expect(mirror?.name).toBe('mirror-0')
		expect(mirror?.children).toHaveLength(2)
		const faulted = mirror?.children[1]
		expect(faulted?.state).toBe('FAULTED')
		expect(faulted?.checksumErrors).toBe(3)
		expect(faulted?.note).toBe('too many errors')
	})

	test('a pool with no devices still parses', () => {
		const pools = parseZpoolStatus('  pool: rpool\n state: ONLINE\nerrors: No known data errors\n')
		expect(pools[0]?.name).toBe('rpool')
		expect(pools[0]?.devices).toEqual([])
	})

	test('empty output is no pools', () => {
		expect(parseZpoolStatus('')).toEqual([])
	})
})

describe('parseDatasetRows', () => {
	test('turns tab separated fields into records', () => {
		const datasets = parseDatasetRows(DATASET_ROWS)
		expect(datasets).toHaveLength(3)
		expect(datasets[0]?.usedBytes).toBe(4035559424)
		expect(datasets[0]?.mountpoint).toBe('/rpool')
		expect(datasets[0]?.createdAt).toBe(1725000000)
	})

	test('reads encryption state and turns a dash into undefined', () => {
		const [, secure, snapshot] = parseDatasetRows(DATASET_ROWS)
		expect(secure?.encryption).toBe('aes-256-gcm')
		expect(secure?.keyStatus).toBe('available')
		expect(secure?.origin).toBeUndefined()
		expect(snapshot?.type).toBe('snapshot')
		expect(snapshot?.availableBytes).toBeUndefined()
	})
})

describe('pool reads', () => {
	test('listPools parses the -Hp columns', async () => {
		const { transport, shell: node } = shell(() => ({ stdout: POOL_LIST }))
		const pools = await node.zfs.listPools()
		expect(transport.commands[0]).toBe(
			'zpool list -Hp -o name,size,alloc,free,fragmentation,capacity,dedupratio,health,altroot',
		)
		expect(pools).toHaveLength(2)
		expect(pools[0]).toMatchObject({
			name: 'rpool',
			sizeBytes: 1022202216448,
			allocatedBytes: 4980645888,
			freeBytes: 1017221570560,
			capacityPercent: 0,
			health: 'ONLINE',
			altroot: undefined,
		})
		expect(pools[1]).toMatchObject({ capacityPercent: 9, dedupRatio: 1, altroot: '/mnt' })
	})

	test('poolStatus names the pool and passes -v', async () => {
		const { transport, shell: node } = shell(() => ({ stdout: DEGRADED }))
		const [status] = await node.zfs.poolStatus('tank', { verbose: true })
		expect(transport.commands[0]).toBe('zpool status -v tank')
		expect(status?.name).toBe('tank')
		expect(await node.zfs.scrubStatus('tank')).toContain('scrub repaired')
	})

	test('pool properties come back as a record', async () => {
		const { transport, shell: node } = shell(() => ({ stdout: 'autotrim\ton\nashift\t12\n' }))
		expect(await node.zfs.getPoolProperties('rpool', ['autotrim', 'ashift'])).toEqual({
			autotrim: 'on',
			ashift: '12',
		})
		expect(transport.commands[0]).toBe('zpool get -Hp -o property,value autotrim,ashift rpool')
		await node.zfs.setPoolProperty('rpool', 'autotrim', 'off')
		expect(transport.commands[1]).toBe('zpool set autotrim=off rpool')
	})
})

describe('dataset command lines', () => {
	test('listDatasets defaults to filesystems and volumes, recursively', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.listDatasets()
		expect(transport.commands[0]).toBe(
			'zfs list -Hp -t filesystem,volume -o name,type,used,available,referenced,mountpoint,compression,encryption,keystatus,origin,creation -r',
		)
		await node.zfs.listDatasets({ target: 'rpool', depth: 1, types: ['volume'] })
		expect(transport.commands[1]).toEndWith(
			'-t volume -o name,type,used,available,referenced,mountpoint,compression,encryption,keystatus,origin,creation -d 1 rpool',
		)
		await node.zfs.listDatasets({ target: 'rpool', recursive: false })
		expect(transport.commands[2]).toEndWith('origin,creation rpool')
	})

	test('listSnapshots looks one level down unless told to recurse', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.listSnapshots('rpool/data')
		expect(transport.commands[0]).toEndWith(
			'-t snapshot -o name,type,used,available,referenced,mountpoint,compression,encryption,keystatus,origin,creation -d 1 rpool/data',
		)
		await node.zfs.listSnapshots('rpool/data', { recursive: true })
		expect(transport.commands[1]).toEndWith('origin,creation -r rpool/data')
		await node.zfs.listSnapshots()
		expect(transport.commands[2]).toEndWith('origin,creation')
	})

	test('getProperties and setProperty', async () => {
		const { transport, shell: node } = shell(() => ({ stdout: 'compression\tzstd\n' }))
		expect(await node.zfs.getProperties('rpool/data', ['compression'])).toEqual({
			compression: 'zstd',
		})
		expect(transport.commands[0]).toBe('zfs get -Hp -o property,value compression rpool/data')
		await node.zfs.setProperty('rpool/data', 'quota', '100G')
		expect(transport.commands[1]).toBe('zfs set quota=100G rpool/data')
	})

	test('creating an encrypted dataset passes the properties as -o and the key on stdin', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.createDataset('tank/secrets', {
			properties: { encryption: 'aes-256-gcm', keyformat: 'passphrase', keylocation: 'prompt' },
			keyMaterial: 'a passphrase',
		})
		expect(transport.commands[0]).toBe(
			'zfs create -o encryption=aes-256-gcm -o keyformat=passphrase -o keylocation=prompt tank/secrets',
		)
		expect(transport.calls[0]?.options.input).toBe('a passphrase')
	})

	test('a volume gets -V and the parent and mount flags', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.createDataset('tank/vol', { volumeSizeBytes: 1073741824, parents: true })
		expect(transport.commands[0]).toBe('zfs create -p -V 1073741824 tank/vol')
		await node.zfs.createDataset('tank/fs', { noMount: true, timeoutMs: 5 })
		expect(transport.commands[1]).toBe('zfs create -u tank/fs')
		expect(transport.calls[1]?.options.timeoutMs).toBe(5)
	})

	test('destroy takes recursive, dependents and dry-run flags', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.destroyDataset('tank/scratch', { recursive: true })
		expect(transport.commands[0]).toBe('zfs destroy -r tank/scratch')
		await node.zfs.destroyDataset('tank/scratch', { dryRun: true, dependents: true })
		expect(transport.commands[1]).toBe('zfs destroy -R -n -v tank/scratch')
		await node.zfs.destroyDataset('tank/scratch@s1')
		expect(transport.commands[2]).toBe('zfs destroy tank/scratch@s1')
	})

	test('destroy refuses a pool root', async () => {
		const { transport, shell: node } = shell()
		expect(() => node.zfs.destroyDataset('tank', { recursive: true })).toThrow(PveShellPolicyError)
		expect(transport.commands).toEqual([])
	})

	test('destroy and rollback are refused by the default policy', async () => {
		const transport = new FakeTransport()
		const node = new NodeShell(transport)
		await expect(node.zfs.destroyDataset('tank/scratch')).rejects.toThrow(PveShellPolicyError)
		await expect(node.zfs.rollback('tank/scratch@s1')).rejects.toThrow(PveShellPolicyError)
		expect(transport.commands).toEqual([])
	})

	test('snapshot, rollback, rename and clone', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.snapshot('tank/data@before', { recursive: true })
		await node.zfs.rollback('tank/data@before', { destroyNewer: true })
		await node.zfs.renameDataset('tank/data', 'tank/moved', { parents: true })
		await node.zfs.clone('tank/data@before', 'tank/copy', {
			properties: { mountpoint: '/mnt/copy' },
			parents: true,
		})
		expect(transport.commands).toEqual([
			'zfs snapshot -r tank/data@before',
			'zfs rollback -r tank/data@before',
			'zfs rename -p tank/data tank/moved',
			'zfs clone -p -o mountpoint=/mnt/copy tank/data@before tank/copy',
		])
	})

	test('keys are loaded from stdin or a location', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.loadKey('tank/secure', { keyMaterial: 'pw', recursive: true })
		await node.zfs.loadKey('tank/secure', { keyLocation: 'file:///root/key' })
		await node.zfs.unloadKey('tank/secure')
		await node.zfs.changeKey('tank/secure', { inheritFromParent: true })
		expect(transport.commands).toEqual([
			'zfs load-key -r -L prompt tank/secure',
			'zfs load-key -L file:///root/key tank/secure',
			'zfs unload-key tank/secure',
			'zfs change-key -i tank/secure',
		])
		expect(transport.calls[0]?.options.input).toBe('pw')
	})

	test('send and receive redirect to and from a node path', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.sendToFile('tank/data@s2', '/tmp/s2.zfs', {
			incrementalFrom: 'tank/data@s1',
			raw: true,
		})
		await node.zfs.receiveFromFile('tank/restored', '/tmp/s 2.zfs', {
			force: true,
			unmounted: true,
		})
		expect(transport.commands).toEqual([
			'zfs send -w -i tank/data@s1 tank/data@s2 > /tmp/s2.zfs',
			"zfs recv -F -u tank/restored < '/tmp/s 2.zfs'",
		])
	})
})

describe('pool command lines', () => {
	test('scrub, trim, import, export and upgrade', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.scrub('tank', { pause: true })
		await node.zfs.trim('tank', { devices: ['/dev/sda'], suspend: true })
		await node.zfs.importPool('tank', {
			searchDirs: ['/dev/disk/by-id'],
			force: true,
			noMount: true,
			altroot: '/mnt',
			mountpoint: '/data',
			newName: 'tank2',
		})
		await node.zfs.importPool()
		await node.zfs.exportPool('tank', { force: true })
		await node.zfs.upgradePool('tank')
		expect(transport.commands).toEqual([
			'zpool scrub -p tank',
			'zpool trim -s tank /dev/sda',
			'zpool import -d /dev/disk/by-id -f -N -R /mnt -o mountpoint=/data tank tank2',
			'zpool import',
			'zpool export -f tank',
			'zpool upgrade tank',
		])
	})

	test('vdev and device changes', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.addVdev('tank', ['mirror', '/dev/sdc', '/dev/sdd'], { force: true })
		await node.zfs.attachDevice('tank', '/dev/sdc', '/dev/sde')
		await node.zfs.detachDevice('tank', '/dev/sdc')
		await node.zfs.replaceDevice('tank', '/dev/sdc', '/dev/sdf', { force: true })
		await node.zfs.offlineDevice('tank', '/dev/sdc', { temporary: true })
		await node.zfs.onlineDevice('tank', '/dev/sdc', { expand: true })
		expect(transport.commands).toEqual([
			'zpool add -f tank mirror /dev/sdc /dev/sdd',
			'zpool attach tank /dev/sdc /dev/sde',
			'zpool detach tank /dev/sdc',
			'zpool replace -f tank /dev/sdc /dev/sdf',
			'zpool offline -t tank /dev/sdc',
			'zpool online -e tank /dev/sdc',
		])
	})
})

describe('values interpolated into a zfs command line', () => {
	test('a property list is quoted, not interpolated', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.getProperties('tank', ['all; rm -rf /'])
		expect(transport.commands[0]).toBe("zfs get -Hp -o property,value 'all; rm -rf /' tank")
	})

	test('a pool property list is quoted too', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.getPoolProperties('tank', ['all; rm -rf /'])
		expect(transport.commands[0]).toBe("zpool get -Hp -o property,value 'all; rm -rf /' tank")
	})

	test('a dataset type list is quoted', async () => {
		const { transport, shell: node } = shell()
		await node.zfs.listDatasets({ types: ['filesystem; rm -rf /' as 'filesystem'] })
		expect(transport.commands[0]).toContain("-t 'filesystem; rm -rf /'")
	})

	test('a size or depth has to be a number', async () => {
		const { transport, shell: node } = shell()
		expect(() =>
			node.zfs.createDataset('tank/x', {
				volumeSizeBytes: '1G -o mountpoint=/' as unknown as number,
			}),
		).toThrow(/volumeSizeBytes/)
		await expect(
			node.zfs.listDatasets({ depth: '1 -o name' as unknown as number }),
		).rejects.toThrow(/depth/)
		expect(transport.commands).toEqual([])
	})
})
