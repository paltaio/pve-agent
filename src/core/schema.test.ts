import { describe, expect, test } from 'bun:test'
import { propertyFormats } from '../generated/formats.ts'
import {
	formatConfigValue,
	parseConfigValue,
	propertyFormatFor,
	resolveEndpoint,
} from './schema.ts'

const QEMU_CONFIG = '/nodes/{node}/qemu/{vmid}/config'

describe('resolveEndpoint', () => {
	test('matches a concrete path against its template', () => {
		expect(resolveEndpoint('PUT', '/nodes/ms01/qemu/110/config')?.path).toBe(QEMU_CONFIG)
		expect(resolveEndpoint('GET', '/nodes/ms01/lxc/110/status/current')?.path).toBe(
			'/nodes/{node}/lxc/{vmid}/status/current',
		)
	})

	test('matches a template path against itself', () => {
		expect(resolveEndpoint('PUT', QEMU_CONFIG)?.path).toBe(QEMU_CONFIG)
	})

	test('ignores a query string', () => {
		expect(resolveEndpoint('GET', '/nodes/ms01/tasks?limit=5')?.path).toBe('/nodes/{node}/tasks')
	})

	test('prefers the template with more literal segments', () => {
		expect(resolveEndpoint('GET', '/cluster/resources')?.path).toBe('/cluster/resources')
		expect(resolveEndpoint('GET', '/nodes/ms01/qemu/110/agent/exec-status')?.path).toBe(
			'/nodes/{node}/qemu/{vmid}/agent/exec-status',
		)
	})

	test('returns undefined for an unknown path or method', () => {
		expect(resolveEndpoint('GET', '/nodes/ms01/nope')).toBeUndefined()
		expect(resolveEndpoint('PATCH', '/version')).toBeUndefined()
	})
})

describe('propertyFormatFor', () => {
	test('finds an indexed family from a concrete key on a concrete path', () => {
		expect(propertyFormatFor('PUT', '/nodes/ms01/qemu/110/config', 'net0')).toBe(
			propertyFormats[`PUT ${QEMU_CONFIG} net[n]`],
		)
	})

	test('finds a plain parameter by its own name', () => {
		expect(propertyFormatFor('PUT', QEMU_CONFIG, 'boot')).toBe(
			propertyFormats[`PUT ${QEMU_CONFIG} boot`],
		)
	})

	test('returns undefined for a parameter that is not a property string', () => {
		expect(propertyFormatFor('PUT', QEMU_CONFIG, 'cores')).toBeUndefined()
		expect(propertyFormatFor('PUT', QEMU_CONFIG, 'nope0')).toBeUndefined()
	})

	test('returns undefined for an unknown endpoint', () => {
		expect(propertyFormatFor('PUT', '/nodes/ms01/nope', 'net0')).toBeUndefined()
	})
})

describe('config values', () => {
	test('parse and format through the registered format', () => {
		const path = '/nodes/ms01/qemu/110/config'
		const bag = parseConfigValue(
			'PUT',
			path,
			'net0',
			'virtio=BC:24:11:A1:B2:C3,bridge=vmbr0,tag=42',
		)
		expect(bag).toEqual({ model: 'virtio', macaddr: 'BC:24:11:A1:B2:C3', bridge: 'vmbr0', tag: 42 })
		expect(formatConfigValue('PUT', path, 'net0', bag)).toBe(
			'virtio=BC:24:11:A1:B2:C3,bridge=vmbr0,tag=42',
		)
	})

	test('pass options through', () => {
		const path = '/nodes/ms01/qemu/110/config'
		expect(() => parseConfigValue('PUT', path, 'scsi0', 'local:1,nope=1')).toThrow(
			/Unknown sub-key/,
		)
		expect(parseConfigValue('PUT', path, 'scsi0', 'local:1,nope=1', { strictKeys: false })).toEqual(
			{ file: 'local:1', nope: '1' },
		)
		expect(() =>
			formatConfigValue('PUT', path, 'scsi0', { cache: 'none' }, { validate: true }),
		).toThrow(/required sub-key 'file'/)
	})

	test('fall back to a plain split when the parameter has no format', () => {
		expect(parseConfigValue('PUT', QEMU_CONFIG, 'nope', 'a=1,b=2')).toEqual({ a: '1', b: '2' })
		expect(formatConfigValue('PUT', QEMU_CONFIG, 'nope', { a: '1', b: '2' })).toBe('a=1,b=2')
	})
})
