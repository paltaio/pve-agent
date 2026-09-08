import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
	DOCUMENTED_ROOT_ONLY_PARAMS,
	ROOT_ONLY_ENDPOINTS,
	TOKEN_FORBIDDEN_ENDPOINTS,
	endpoints,
	type EndpointInfo,
} from './endpoints.ts'
import { TYPETEXT_DERIVED_FORMATS, propertyFormats } from './formats.ts'

const registry: Readonly<Record<string, EndpointInfo>> = endpoints
const all = Object.entries(registry)

interface SchemaMethod {
	parameters?: { properties?: Record<string, unknown> }
}

interface SchemaNode {
	path: string
	info?: Record<string, SchemaMethod>
	children?: SchemaNode[]
}

const SKIP_PATH = /(^|\/)(ceph|sdn)(\/|$)/

async function loadSchema(): Promise<SchemaNode[]> {
	const raw: unknown = await Bun.file(resolve(import.meta.dir, '../../schema/apidoc.json')).json()
	if (!Array.isArray(raw)) throw new Error('schema/apidoc.json is not a schema node array')
	return raw
}

/** Every `METHOD path` in the schema outside Ceph and SDN, with its method info. */
function* schemaMethods(nodes: SchemaNode[]): Generator<[string, SchemaMethod]> {
	for (const node of nodes) {
		if (!SKIP_PATH.test(node.path)) {
			for (const [method, info] of Object.entries(node.info ?? {})) {
				yield [`${method} ${node.path}`, info]
			}
		}
		yield* schemaMethods(node.children ?? [])
	}
}

describe('endpoint registry', () => {
	test('covers every endpoint in the schema except Ceph and SDN', async () => {
		const expected = [...schemaMethods(await loadSchema())].map(([key]) => key)
		expect(Object.keys(endpoints).sort()).toEqual(expected.sort())
	})

	test('keys read as METHOD path', () => {
		for (const [key, info] of all) expect(key).toBe(`${info.method} ${info.path}`)
	})

	test('leaves Ceph and SDN out', () => {
		expect(all.filter(([key]) => /\/(ceph|sdn)(\/|$)/.test(key))).toEqual([])
	})

	test('carries the parameter metadata a caller needs', () => {
		const config = endpoints['PUT /nodes/{node}/qemu/{vmid}/config']
		expect(config.returnType).toBe('null')
		expect(config.proxyTo).toBe('node')
		expect(config.protectedCall).toBe(true)
		expect(config.params.vmid).toEqual({ type: 'integer', optional: false, format: 'pve-vmid' })
		expect(config.params['scsi[n]'].propertyString).toBe(true)
		expect(config.params.ostype.enum).toContain('l26')
	})

	test('POST config is the async twin of the synchronous PUT', () => {
		expect(endpoints['POST /nodes/{node}/qemu/{vmid}/config'].returnType).toBe('string')
		expect(endpoints['PUT /nodes/{node}/qemu/{vmid}/config'].returnType).toBe('null')
	})
})

describe('privilege metadata', () => {
	test('lists the endpoints registered with no permissions block', () => {
		expect([...ROOT_ONLY_ENDPOINTS].sort()).toEqual([
			'DELETE /cluster/acme/account/{name}',
			'DELETE /cluster/config/nodes/{node}',
			'GET /cluster/acme/account/{name}',
			'GET /cluster/backup-info',
			'POST /cluster/acme/account',
			'POST /cluster/config',
			'POST /cluster/config/join',
			'POST /cluster/config/nodes/{node}',
			'POST /nodes/{node}/execute',
			'POST /nodes/{node}/storage/{storage}/content/{volume}',
			'PUT /cluster/acme/account/{name}',
			'PUT /nodes/{node}/disks/wipedisk',
		])
	})

	test('lists the endpoints a token may never call', () => {
		expect([...TOKEN_FORBIDDEN_ENDPOINTS].sort()).toEqual([
			'DELETE /access/tfa/{userid}/{id}',
			'POST /access/tfa/{userid}',
			'POST /access/ticket',
			'PUT /access/password',
			'PUT /access/tfa/{userid}/{id}',
		])
	})

	test('picks up the parameters the schema text marks as root-only', () => {
		expect(DOCUMENTED_ROOT_ONLY_PARAMS['POST /nodes/{node}/qemu/{vmid}/status/start']).toContain(
			'skiplock',
		)
		expect(DOCUMENTED_ROOT_ONLY_PARAMS['POST /nodes/{node}/qemu/{vmid}/migrate']).toContain('force')
		expect(DOCUMENTED_ROOT_ONLY_PARAMS['GET /nodes/{node}/qemu/{vmid}/config']).toBeUndefined()
	})
})

describe('property formats', () => {
	test('registers the formats the schema spells out inline', () => {
		const net = propertyFormats['PUT /nodes/{node}/qemu/{vmid}/config net[n]']
		expect(net?.['model']?.default_key).toBe(1)
		expect(net?.['e1000']).toEqual({ alias: 'macaddr', keyAlias: 'model' })
		expect(net?.['macaddr']?.format).toBe('mac-addr')
	})

	test('reads the rest out of their typetext', () => {
		expect(TYPETEXT_DERIVED_FORMATS).toContain('PUT /nodes/{node}/qemu/{vmid}/config boot')
		const hostpci = propertyFormats['PUT /nodes/{node}/qemu/{vmid}/config hostpci[n]']
		expect(hostpci?.['host']?.default_key).toBe(1)
		expect(Object.keys(hostpci ?? {})).toContain('mapping')
		expect(hostpci?.['pcie']?.type).toBe('boolean')
	})

	test('every registered format names an endpoint that exists', () => {
		for (const key of Object.keys(propertyFormats)) {
			const endpointKey = key.slice(0, key.lastIndexOf(' '))
			expect(registry[endpointKey]).toBeDefined()
		}
	})
})

describe('combinator schemas', () => {
	test('a oneOf keyed on a discriminator becomes one interface per branch', () => {
		const create = endpoints['POST /cluster/ha/rules']
		expect(create.discriminator).toEqual({
			property: 'type',
			values: ['node-affinity', 'resource-affinity'],
		})
		// The discriminator itself must be sent, so it is required.
		expect(create.params.type.optional).toBe(false)
		expect(create.params.type.enum).toEqual(['node-affinity', 'resource-affinity'])
	})

	test('a property required in only one branch is optional in the runtime view', () => {
		const create = endpoints['POST /cluster/ha/rules']
		// nodes exists only on node-affinity; resources is required on both.
		expect(create.params.nodes.optional).toBe(true)
		expect(create.params.resources.optional).toBe(false)
		// rule comes from the plain allOf branch and stays required.
		expect(create.params.rule.optional).toBe(false)
	})

	test('both HA rule endpoints carry the union', () => {
		for (const key of ['POST /cluster/ha/rules', 'PUT /cluster/ha/rules/{rule}'] as const) {
			const info = endpoints[key]
			expect(info.discriminator.property).toBe('type')
			expect(Object.keys(info.params).length).toBeGreaterThan(0)
		}
	})

	test('no other endpoint lost or gained a parameter', async () => {
		const fromSchema = new Map<string, string[]>()
		for (const [key, info] of schemaMethods(await loadSchema())) {
			const properties = info.parameters?.properties
			if (properties) fromSchema.set(key, Object.keys(properties).sort())
		}

		// Every endpoint with a plain property bag must round-trip unchanged, which
		// is what proves the combinator work moved only the two HA rule endpoints.
		for (const [key, expected] of fromSchema) {
			const info = registry[key]
			if (!info) throw new Error(`Missing endpoint: ${key}`)
			expect(Object.keys(info.params).sort()).toEqual(expected)
		}
		// Endpoints the schema gives no property bag carry no parameters, apart from
		// the two whose parameters come out of a combinator.
		const withoutBag = Object.keys(registry).filter((key) => !fromSchema.has(key))
		const nonEmpty = withoutBag.filter((key) => Object.keys(registry[key]?.params ?? {}).length > 0)
		expect(nonEmpty.sort()).toEqual(['POST /cluster/ha/rules', 'PUT /cluster/ha/rules/{rule}'])
	})
})
