import { describe, expect, test } from 'bun:test'
import { propertyFormats, TYPETEXT_DERIVED_FORMATS } from '../generated/formats.ts'
import {
	collapseIndexedKey,
	expandIndexedKey,
	formatPropertyString,
	formatSize,
	indexedKeyBase,
	isIndexedKey,
	parsePropertyString,
	parseSize,
	splitIndexedKey,
	splitPropertyParts,
	type PropertyFormat,
} from './props.ts'

function formatFor(key: string): PropertyFormat {
	const format = propertyFormats[key]
	if (!format) throw new Error(`no generated format for ${key}`)
	return format
}

const QEMU_CONFIG = 'PUT /nodes/{node}/qemu/{vmid}/config'
const LXC_CONFIG = 'PUT /nodes/{node}/lxc/{vmid}/config'

describe('parsePropertyString', () => {
	test('reads the default key from a bare value', () => {
		const bag = parsePropertyString(
			'local-zfs:32,cache=writeback',
			formatFor(`${QEMU_CONFIG} scsi[n]`),
		)
		expect(bag).toEqual({ file: 'local-zfs:32', cache: 'writeback' })
	})

	test('splits a key at its first equals sign', () => {
		const bag = parsePropertyString(
			'mapping=gpu,mdev=nvidia-1=x',
			formatFor(`${QEMU_CONFIG} hostpci[n]`),
		)
		expect(bag['mdev']).toBe('nvidia-1=x')
	})

	test('turns a key alias into two sub-keys', () => {
		const bag = parsePropertyString('virtio=BC:24:11:A1:B2:C3', formatFor(`${QEMU_CONFIG} net[n]`))
		expect(bag).toEqual({ model: 'virtio', macaddr: 'BC:24:11:A1:B2:C3' })
	})

	test('coerces to the types the format declares', () => {
		const bag = parsePropertyString(
			'virtio=BC:24:11:A1:B2:C3,firewall=1,tag=42,rate=12.5',
			formatFor(`${QEMU_CONFIG} net[n]`),
		)
		expect(bag['firewall']).toBe(true)
		expect(bag['tag']).toBe(42)
		expect(bag['rate']).toBe(12.5)
	})

	test('keeps text that does not fit the declared type', () => {
		const bag = parsePropertyString(
			'virtio=BC:24:11:A1:B2:C3,firewall=maybe,tag=abc',
			formatFor(`${QEMU_CONFIG} net[n]`),
		)
		expect(bag['firewall']).toBe('maybe')
		expect(bag['tag']).toBe('abc')
	})

	test('an integer sub-key takes digits only and a number sub-key a decimal', () => {
		const format = formatFor(`${QEMU_CONFIG} net[n]`)
		const read = (text: string): unknown =>
			parsePropertyString(`virtio=BC:24:11:A1:B2:C3,${text}`, format)[text.split('=')[0] ?? '']
		expect(read('tag=0x10')).toBe('0x10')
		expect(read('tag=1e3')).toBe('1e3')
		expect(read('tag=4.5')).toBe('4.5')
		expect(read('rate=1e3')).toBe('1e3')
		expect(read('rate=3')).toBe(3)
	})

	test('skips empty parts', () => {
		const bag = parsePropertyString('local:1,,cache=none,', formatFor(`${QEMU_CONFIG} scsi[n]`))
		expect(bag).toEqual({ file: 'local:1', cache: 'none' })
	})

	test('rejects an unknown sub-key unless strictKeys is off', () => {
		const format = formatFor(`${QEMU_CONFIG} net[n]`)
		expect(() => parsePropertyString('virtio=AA:BB,nope=1', format)).toThrow(/Unknown sub-key/)
		expect(parsePropertyString('nope=1', format, { strictKeys: false })).toEqual({ nope: '1' })
	})

	test('rejects a duplicate sub-key', () => {
		const format = formatFor(`${QEMU_CONFIG} scsi[n]`)
		expect(() => parsePropertyString('local:1,cache=none,cache=none', format)).toThrow(/Duplicate/)
	})

	test('rejects a second bare value', () => {
		const format = formatFor(`${QEMU_CONFIG} scsi[n]`)
		expect(() => parsePropertyString('local:1,local:2', format)).toThrow(/Duplicate/)
	})

	test('rejects a second key alias', () => {
		const format = formatFor(`${QEMU_CONFIG} net[n]`)
		expect(() => parsePropertyString('virtio=AA:BB,e1000=CC:DD', format)).toThrow(/already set/)
	})

	test('rejects a part with an empty value', () => {
		expect(() => parsePropertyString('cache=', formatFor(`${QEMU_CONFIG} scsi[n]`))).toThrow(
			/Malformed/,
		)
	})

	test('rejects a part with an empty key', () => {
		expect(() => parsePropertyString('=none', formatFor(`${QEMU_CONFIG} scsi[n]`))).toThrow(
			/Malformed/,
		)
	})

	test('rejects a bare value when the format has no default key', () => {
		expect(() => parsePropertyString('bare', formatFor(`${QEMU_CONFIG} ipconfig[n]`))).toThrow(
			/no default key/,
		)
	})

	test('keeps every value as text without a format', () => {
		expect(parsePropertyString('a=1,b=on')).toEqual({ a: '1', b: 'on' })
		expect(() => parsePropertyString('bare')).toThrow(/no default key/)
	})

	test('checks enums only when asked', () => {
		const format = formatFor(`${QEMU_CONFIG} scsi[n]`)
		expect(parsePropertyString('local:1,cache=bogus', format)['cache']).toBe('bogus')
		expect(() => parsePropertyString('local:1,cache=bogus', format, { validate: true })).toThrow(
			/expected one of/,
		)
	})

	test('checks required sub-keys only when asked', () => {
		const format = formatFor(`${LXC_CONFIG} net[n]`)
		expect(parsePropertyString('bridge=vmbr0', format)).toEqual({ bridge: 'vmbr0' })
		expect(() => parsePropertyString('bridge=vmbr0', format, { validate: true })).toThrow(
			/required sub-key 'name'/,
		)
	})
})

describe('formatPropertyString', () => {
	test('writes the default key first, then the rest sorted', () => {
		const text = formatPropertyString(
			{ cache: 'writeback', file: 'local-zfs:vm-100-disk-0', discard: 'on' },
			formatFor(`${QEMU_CONFIG} scsi[n]`),
		)
		expect(text).toBe('local-zfs:vm-100-disk-0,cache=writeback,discard=on')
	})

	test('writes required sub-keys before optional ones', () => {
		const text = formatPropertyString(
			{ bridge: 'vmbr0', name: 'eth0', firewall: true },
			formatFor(`${LXC_CONFIG} net[n]`),
		)
		expect(text).toBe('name=eth0,bridge=vmbr0,firewall=1')
	})

	test('folds a key alias pair back into one part', () => {
		const text = formatPropertyString(
			{ model: 'virtio', macaddr: 'BC:24:11:A1:B2:C3', bridge: 'vmbr0' },
			formatFor(`${QEMU_CONFIG} net[n]`),
		)
		expect(text).toBe('virtio=BC:24:11:A1:B2:C3,bridge=vmbr0')
	})

	test('writes a key alias sub-key bare when its partner is absent', () => {
		const text = formatPropertyString(
			{ model: 'virtio', bridge: 'vmbr0' },
			formatFor(`${QEMU_CONFIG} net[n]`),
		)
		expect(text).toBe('virtio,bridge=vmbr0')
	})

	test('writes booleans as 1 and 0', () => {
		const text = formatPropertyString(
			{ file: 'local:1', backup: false, iothread: true },
			formatFor(`${QEMU_CONFIG} scsi[n]`),
		)
		expect(text).toBe('local:1,backup=0,iothread=1')
	})

	test('prints a byte count for a disk-size sub-key', () => {
		const text = formatPropertyString(
			{ file: 'local-zfs:vm-100-disk-0', size: 34359738368 },
			formatFor(`${QEMU_CONFIG} scsi[n]`),
		)
		expect(text).toBe('local-zfs:vm-100-disk-0,size=32G')
	})

	test('leaves a disk-size given as text alone', () => {
		const text = formatPropertyString(
			{ file: 'local-zfs:vm-100-disk-0', size: '32G' },
			formatFor(`${QEMU_CONFIG} scsi[n]`),
		)
		expect(text).toBe('local-zfs:vm-100-disk-0,size=32G')
	})

	test('refuses a value with a comma', () => {
		expect(() =>
			formatPropertyString({ file: 'local:1', serial: 'a,b' }, formatFor(`${QEMU_CONFIG} scsi[n]`)),
		).toThrow(/comma/)
		expect(() => formatPropertyString({ a: 'x,y' })).toThrow(/comma/)
	})

	test('reports a missing required sub-key when validating', () => {
		expect(() =>
			formatPropertyString({ cache: 'none' }, formatFor(`${QEMU_CONFIG} scsi[n]`), {
				validate: true,
			}),
		).toThrow(/required sub-key 'file'/)
	})

	test('reports a value outside the enum when validating', () => {
		expect(() =>
			formatPropertyString(
				{ file: 'local:1', cache: 'bogus' },
				formatFor(`${QEMU_CONFIG} scsi[n]`),
				{
					validate: true,
				},
			),
		).toThrow(/expected one of/)
	})

	test('rejects an unknown sub-key unless strictKeys is off', () => {
		const format = formatFor(`${QEMU_CONFIG} net[n]`)
		expect(() => formatPropertyString({ nope: '1' }, format)).toThrow(/Unknown sub-key/)
		expect(formatPropertyString({ nope: '1' }, format, { strictKeys: false })).toBe('nope=1')
	})

	test('keeps bag order without a format', () => {
		expect(formatPropertyString({ b: 1, a: true, c: 'x' })).toBe('b=1,a=1,c=x')
	})

	test('a lenient parse round-trips through a lenient format', () => {
		const format = formatFor(`${QEMU_CONFIG} net[n]`)
		const value = 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,nope=1'
		const bag = parsePropertyString(value, format, { strictKeys: false })
		expect(formatPropertyString(bag, format, { strictKeys: false })).toBe(value)
	})
})

describe('round trips', () => {
	// Config values as a node writes them.
	const live: [string, string][] = [
		[`${LXC_CONFIG} rootfs`, 'tank-vms:subvol-110-disk-0,size=32G'],
		[`${LXC_CONFIG} mp[n]`, 'tank-vms:subvol-110-disk-1,mp=/srv/images,backup=0,size=2T'],
		[`${LXC_CONFIG} net[n]`, 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:B3:03:ED,ip=dhcp,type=veth'],
		[`${LXC_CONFIG} features`, 'nesting=1'],
		[`${QEMU_CONFIG} net[n]`, 'virtio=BC:24:11:A1:B2:C3,bridge=vmbr0,firewall=1,tag=42'],
		[
			`${QEMU_CONFIG} net[n]`,
			'e1000e=BC:24:11:A1:B2:C4,bridge=vmbr1,link_down=1,mtu=1400,queues=4',
		],
		[
			`${QEMU_CONFIG} scsi[n]`,
			'local-zfs:vm-100-disk-0,cache=writeback,discard=on,iothread=1,size=32G',
		],
		[`${QEMU_CONFIG} scsi[n]`, 'local-zfs:vm-100-disk-1,backup=0,size=1536M,ssd=1'],
		[`${QEMU_CONFIG} ide[n]`, 'local:iso/debian.iso,media=cdrom'],
		[`${QEMU_CONFIG} agent`, '1,fstrim_cloned_disks=1'],
		[`${QEMU_CONFIG} memory`, '4096'],
		[`${QEMU_CONFIG} boot`, 'order=scsi0;ide2;net0'],
		[`${QEMU_CONFIG} hostpci[n]`, 'mapping=gpu,pcie=1'],
		[`${QEMU_CONFIG} hostpci[n]`, '0000:01:00.0,pcie=1,rombar=0,x-vga=1'],
	]

	for (const [key, value] of live) {
		test(`${key} keeps ${value}`, () => {
			const format = formatFor(key)
			expect(formatPropertyString(parsePropertyString(value, format), format)).toBe(value)
		})
	}

	test('hostpci[n] comes from a typetext line and still resolves its default key', () => {
		const key = `${QEMU_CONFIG} hostpci[n]`
		expect(TYPETEXT_DERIVED_FORMATS).toContain(key)
		const bag = parsePropertyString('0000:01:00.0,pcie=1', formatFor(key))
		expect(bag).toEqual({ host: '0000:01:00.0', pcie: true })
	})

	test('scsi[n] size survives as bytes and prints back in units', () => {
		const format = formatFor(`${QEMU_CONFIG} scsi[n]`)
		const bag = parsePropertyString('local-zfs:vm-100-disk-0,size=32G', format)
		expect(parseSize(String(bag['size']))).toBe(34359738368)
		expect(formatPropertyString({ ...bag, size: 34359738368 * 2 }, format)).toBe(
			'local-zfs:vm-100-disk-0,size=64G',
		)
	})

	test('re-sorts optional sub-keys the way the node writes them', () => {
		const format = formatFor(`${QEMU_CONFIG} ipconfig[n]`)
		const bag = parsePropertyString('ip=10.0.0.5/24,gw=10.0.0.1', format)
		expect(formatPropertyString(bag, format)).toBe('gw=10.0.0.1,ip=10.0.0.5/24')
	})
})

describe('sizes', () => {
	test('formatSize picks the largest exact unit', () => {
		expect(formatSize(34359738368)).toBe('32G')
		expect(formatSize(2199023255552)).toBe('2T')
		expect(formatSize(1024)).toBe('1K')
		expect(formatSize(1023)).toBe('1023')
		expect(formatSize(1536 * 1024)).toBe('1536K')
		expect(formatSize(0)).toBe('0')
	})

	test('parseSize takes the units PVE accepts', () => {
		expect(parseSize('32G')).toBe(34359738368)
		expect(parseSize('2TiB')).toBe(2199023255552)
		expect(parseSize('1.5K')).toBe(1536)
		expect(parseSize('512')).toBe(512)
		expect(parseSize('big')).toBeUndefined()
		expect(parseSize('')).toBeUndefined()
	})
})

describe('indexed keys', () => {
	test('recognises the schema spelling', () => {
		expect(isIndexedKey('net[n]')).toBe(true)
		expect(isIndexedKey('net0')).toBe(false)
		expect(indexedKeyBase('mp[n]')).toBe('mp')
		expect(indexedKeyBase('memory')).toBeUndefined()
	})

	test('expands and collapses', () => {
		expect(expandIndexedKey('net[n]', 3)).toBe('net3')
		expect(collapseIndexedKey('scsi15', ['scsi[n]', 'net[n]'])).toBe('scsi[n]')
		expect(collapseIndexedKey('bootdisk', ['scsi[n]'])).toBeUndefined()
		expect(collapseIndexedKey('smbios1', ['scsi[n]'])).toBeUndefined()
		expect(splitIndexedKey('virtio12')).toEqual({ base: 'virtio', index: 12 })
		expect(splitIndexedKey('memory')).toBeUndefined()
	})

	test('rejects a name that is not indexed', () => {
		expect(() => expandIndexedKey('memory', 0)).toThrow(/not an indexed/)
	})

	test('rejects a negative or fractional index', () => {
		expect(() => expandIndexedKey('net[n]', -1)).toThrow(/non-negative integer/)
		expect(() => expandIndexedKey('net[n]', 1.5)).toThrow(/non-negative integer/)
	})
})

describe('splitPropertyParts', () => {
	test('separates bare values from named ones', () => {
		expect(splitPropertyParts('0000:01:00,pcie=1,romfile=x.bin')).toEqual({
			bare: ['0000:01:00'],
			entries: [
				['pcie', '1'],
				['romfile', 'x.bin'],
			],
		})
	})

	test('keeps a value that contains an equals sign', () => {
		expect(splitPropertyParts('mdev=a=b,,')).toEqual({ bare: [], entries: [['mdev', 'a=b']] })
	})
})
