// Reads schema/apidoc.json and writes src/generated/. Run with `bun run
// generate` after refreshing the schema dump; never edit the output by hand.
// Ceph and SDN endpoints are left out.

import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..')
const outDir = resolve(repoRoot, 'src/generated')

interface SchemaNode {
	path: string
	text: string
	leaf?: number
	info?: Record<string, MethodInfo>
	children?: SchemaNode[]
}

interface MethodInfo {
	method: string
	name: string
	description?: string
	allowtoken?: number
	protected?: number
	proxyto?: string
	permissions?: unknown
	parameters?: ParamsSchema
	returns?: { type?: string }
}

interface ParamSchema {
	type?: string
	description?: string
	verbose_description?: string
	optional?: number
	enum?: string[]
	default?: unknown
	format?: string | Record<string, ParamSchema>
	items?: { type?: string }
	minimum?: number
	maximum?: number
	default_key?: number
	alias?: string
	keyAlias?: string
	pattern?: string
	format_description?: string
	typetext?: string
}

/**
 * The `parameters` object of one method. Most are a plain property bag; a few
 * wrap the bag in `allOf`, with one branch holding a `oneOf` discriminated on
 * `type-property`.
 */
interface ParamsSchema {
	properties?: Record<string, ParamSchema>
	additionalProperties?: number
	allOf?: ParamsSchema[]
	anyOf?: ParamsSchema[]
	oneOf?: ParamsSchema[]
	/** Name of the property whose value selects the branch, such as `type`. */
	'type-property'?: string
	'type-property-schema'?: ParamSchema
	/** On a `oneOf` branch: the discriminator value this branch answers to. */
	'instance-type'?: string
}

interface ParamVariant {
	/** The discriminator value, such as `node-affinity`. */
	value: string
	properties: Record<string, ParamSchema>
}

/** One method's parameters, with any combinator resolved. */
interface ParamModel {
	/** Every property from every branch, for the runtime and format registries. */
	flat: Record<string, ParamSchema>
	/** Properties every call carries, whichever branch it takes. */
	base: Record<string, ParamSchema>
	discriminator?: { property: string; schema: ParamSchema }
	variants: ParamVariant[]
}

interface Endpoint {
	key: string
	path: string
	method: string
	info: MethodInfo
	typeName: string
	model: ParamModel
}

const SKIP_PATH = /(^|\/)(ceph|sdn)(\/|$)/

/** Readable aliases for the parameter sets other modules build on. */
const TYPE_ALIASES: Record<string, string> = {
	'POST /nodes/{node}/qemu': 'QemuCreateParams',
	'PUT /nodes/{node}/qemu/{vmid}/config': 'QemuConfigParams',
	'POST /nodes/{node}/qemu/{vmid}/config': 'QemuConfigAsyncParams',
	'POST /nodes/{node}/lxc': 'LxcCreateParams',
	'PUT /nodes/{node}/lxc/{vmid}/config': 'LxcConfigParams',
	'POST /nodes/{node}/network': 'NetworkCreateParams',
	'PUT /nodes/{node}/network/{iface}': 'NetworkUpdateParams',
	'POST /storage': 'StorageCreateParams',
	'PUT /storage/{storage}': 'StorageUpdateParams',
	'POST /nodes/{node}/disks/zfs': 'ZfsCreateParams',
	'POST /nodes/{node}/vzdump': 'VzdumpParams',
	'POST /cluster/backup': 'BackupJobCreateParams',
	'PUT /cluster/backup/{id}': 'BackupJobUpdateParams',
	'POST /cluster/ha/resources': 'HaResourceCreateParams',
	'PUT /cluster/ha/resources/{sid}': 'HaResourceUpdateParams',
	'POST /cluster/ha/rules': 'HaRuleCreateParams',
	'PUT /cluster/ha/rules/{rule}': 'HaRuleUpdateParams',
	'POST /cluster/replication': 'ReplicationJobCreateParams',
	'PUT /cluster/replication/{id}': 'ReplicationJobUpdateParams',
}

const ROOT_HINT = /only root|root only|root@pam|requires root|restricted to root/i

/** Entries of a record in the order `Object.keys(record).sort()` gives. */
function sortedEntries<T>(record: Record<string, T>): [string, T][] {
	return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

function flatten(nodes: SchemaNode[], out: Endpoint[] = []): Endpoint[] {
	for (const node of nodes) {
		if (!SKIP_PATH.test(node.path)) {
			for (const [method, info] of Object.entries(node.info ?? {})) {
				out.push({
					key: `${method} ${node.path}`,
					path: node.path,
					method,
					info,
					typeName: '',
					model: buildParamModel(info.parameters),
				})
			}
		}
		flatten(node.children ?? [], out)
	}
	return out
}

/**
 * Flattens a `parameters` object into properties every call carries plus, when
 * the schema discriminates, one variant per branch.
 *
 * `allOf` and `anyOf` branches are merged. A `oneOf` carrying `type-property`
 * becomes the variant list. A `oneOf` without one has no discriminator to key
 * on, so its branches are merged with every property optional.
 */
function buildParamModel(params: ParamsSchema | undefined): ParamModel {
	const model: ParamModel = { flat: {}, base: {}, variants: [] }
	if (!params) return model

	const visit = (node: ParamsSchema): void => {
		for (const [name, schema] of Object.entries(node.properties ?? {})) {
			model.base[name] = schema
		}
		for (const branch of [...(node.allOf ?? []), ...(node.anyOf ?? [])]) visit(branch)

		if (!node.oneOf) return
		const property = node['type-property']
		const schema = node['type-property-schema']
		if (property && schema) {
			model.discriminator = { property, schema }
			for (const branch of node.oneOf) {
				const value = branch['instance-type']
				if (value === undefined) continue
				model.variants.push({ value, properties: { ...(branch.properties ?? {}) } })
			}
			return
		}
		for (const branch of node.oneOf) {
			for (const [name, sub] of Object.entries(branch.properties ?? {})) {
				model.base[name] = { ...sub, optional: 1 }
			}
		}
	}
	visit(params)

	model.flat = { ...model.base }
	if (model.discriminator) {
		model.flat[model.discriminator.property] = model.discriminator.schema
	}
	for (const variant of model.variants) {
		for (const [name, schema] of Object.entries(variant.properties)) {
			// A property missing from a sibling branch, or optional in one, cannot be
			// required in the flat view a runtime caller sees.
			const everywhere = model.variants.every((other) => {
				const sibling = other.properties[name]
				return sibling !== undefined && !sibling.optional
			})
			model.flat[name] = everywhere ? schema : { ...schema, optional: 1 }
		}
	}
	return model
}

function pascal(text: string): string {
	return text
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('')
}

const METHOD_WORD: Record<string, string> = {
	GET: 'Get',
	POST: 'Post',
	PUT: 'Put',
	DELETE: 'Delete',
}

/**
 * Interface names come from the path with its variables dropped, plus the
 * method. Paths that collapse onto the same name are separated by their
 * trailing path variables.
 */
function assignTypeNames(endpoints: Endpoint[]): void {
	const bases = new Map<string, Endpoint[]>()
	for (const endpoint of endpoints) {
		const fixed = endpoint.path.split('/').filter((s) => s && !s.startsWith('{'))
		const base = pascal(fixed.join('-')) + (METHOD_WORD[endpoint.method] ?? pascal(endpoint.method))
		const bucket = bases.get(base)
		if (bucket) bucket.push(endpoint)
		else bases.set(base, [endpoint])
	}

	for (const [base, bucket] of bases) {
		const first = bucket[0]
		if (bucket.length === 1 && first) {
			first.typeName = `${base}Params`
			continue
		}
		for (const endpoint of bucket) {
			const vars = [...pathVariables(endpoint.path)].map(pascal)
			endpoint.typeName = `${base}${vars.length > 0 ? `By${vars.join('')}` : ''}Params`
		}
		const seen = new Set<string>()
		for (const endpoint of bucket) {
			let name = endpoint.typeName
			let n = 2
			while (seen.has(name)) name = `${endpoint.typeName.slice(0, -'Params'.length)}${n++}Params`
			seen.add(name)
			endpoint.typeName = name
		}
	}
}

function quote(text: string): string {
	return JSON.stringify(text)
}

function isNumericLiteral(value: string): boolean {
	return value.trim() !== '' && Number.isFinite(Number(value))
}

function propKey(name: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name)
}

function oneLine(text: string | undefined, limit = 200): string | undefined {
	if (!text) return undefined
	const flat = text.replace(/\s+/g, ' ').trim()
	if (!flat) return undefined
	return flat.length > limit ? `${flat.slice(0, limit - 1)}...` : flat
}

function tsType(param: ParamSchema): string {
	if (param.enum && param.enum.length > 0) {
		// The schema spells every enum value as a string, including the ones on an
		// integer parameter, whose values go over the wire as numbers.
		const numeric = param.type === 'integer' || param.type === 'number'
		return param.enum
			.map((value) => (numeric && isNumericLiteral(value) ? value : quote(value)))
			.join(' | ')
	}
	switch (param.type) {
		case 'integer':
		case 'number':
			return 'number'
		case 'boolean':
			return 'boolean'
		case 'array': {
			const item = param.items?.type
			if (item === 'integer' || item === 'number') return 'number[]'
			if (item === 'boolean') return 'boolean[]'
			return 'string[]'
		}
		default:
			return 'string'
	}
}

function paramDoc(name: string, param: ParamSchema, method: string): string[] {
	const lines: string[] = []
	const description = oneLine(param.description)
	if (description) lines.push(description)
	if (param.default !== undefined) lines.push(`Default: ${JSON.stringify(param.default)}`)
	if (typeof param.format === 'string') lines.push(`Format: ${param.format}`)
	if (param.format && typeof param.format === 'object') {
		lines.push(`Property string with sub-keys: ${Object.keys(param.format).sort().join(', ')}`)
	}
	if (param.minimum !== undefined || param.maximum !== undefined) {
		lines.push(`Range: ${param.minimum ?? '-'} to ${param.maximum ?? '-'}`)
	}
	if (name === 'unprivileged' && method === 'POST') {
		lines.push('The create handler uses 1 when the parameter is absent.')
	}
	return lines
}

function renderDoc(rawLines: string[], indent: string): string {
	// A comment terminator inside a default value or description would end the
	// block early.
	const lines = rawLines.map((line) => line.replace(/\*\//g, '* /'))
	if (lines.length === 0) return ''
	if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`
	return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`
}

function pathVariables(path: string): Set<string> {
	return new Set([...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? ''))
}

/** Renders the members of one interface body from a property bag. */
function renderMembers(
	properties: Record<string, ParamSchema>,
	inPath: Set<string>,
	method: string,
): string {
	return sortedEntries(properties)
		.filter(([name]) => !inPath.has(name))
		.map(([name, param]) => {
			const doc = renderDoc(paramDoc(name, param, method), '\t')
			const type = tsType(param)
			const indexed = /^([A-Za-z][A-Za-z0-9_-]*)\[n\]$/.exec(name)
			if (indexed) {
				return `${doc}\t[key: \`${indexed[1]}\${number}\`]: ${type} | undefined`
			}
			return `${doc}\t${propKey(name)}${param.optional ? '?' : ''}: ${type}`
		})
		.join('\n')
}

function variantTypeName(endpoint: Endpoint, value: string): string {
	return `${endpoint.typeName.slice(0, -'Params'.length)}${pascal(value)}Params`
}

function renderParamsInterface(endpoint: Endpoint): string {
	const { model } = endpoint
	const inPath = pathVariables(endpoint.path)
	const summary = oneLine(endpoint.info.description)
	const headerLines = [
		`${endpoint.method} ${endpoint.path}`,
		...(summary ? [summary] : []),
		...(inPath.size > 0 ? [`Path variables: ${[...inPath].join(', ')}`] : []),
	]

	const discriminator = model.discriminator
	if (!discriminator || model.variants.length === 0) {
		const body = renderMembers(model.base, inPath, endpoint.method)
		const header = renderDoc(headerLines, '')
		if (body === '') return `${header}export interface ${endpoint.typeName} {}\n`
		return `${header}export interface ${endpoint.typeName} {\n${body}\n}\n`
	}

	// The schema discriminates on one property, so each branch gets its own
	// interface and the endpoint's name is their union.
	const blocks = model.variants.map((variant) => {
		const properties: Record<string, ParamSchema> = {
			...model.base,
			[discriminator.property]: { ...discriminator.schema, enum: [variant.value] },
			...variant.properties,
		}
		const header = renderDoc(
			[...headerLines, `Branch taken when ${discriminator.property} is '${variant.value}'.`],
			'',
		)
		const body = renderMembers(properties, inPath, endpoint.method)
		return `${header}export interface ${variantTypeName(endpoint, variant.value)} {\n${body}\n}\n`
	})

	const union = model.variants
		.map((variant) => variantTypeName(endpoint, variant.value))
		.join(' | ')
	const alias = renderDoc([...headerLines, `Discriminated on ${discriminator.property}.`], '')
	return `${blocks.join('\n')}\n${alias}export type ${endpoint.typeName} = ${union}\n`
}

function renderEndpointEntry(endpoint: Endpoint): string {
	const info = endpoint.info
	const entries = sortedEntries(endpoint.model.flat)

	const params = entries
		.map(([name, param]) => {
			const bits = [
				`type: ${quote(param.type ?? 'string')}`,
				`optional: ${param.optional ? 'true' : 'false'}`,
			]
			if (param.enum) bits.push(`enum: [${param.enum.map(quote).join(', ')}]`)
			if (typeof param.format === 'string') bits.push(`format: ${quote(param.format)}`)
			if (param.format && typeof param.format === 'object') bits.push('propertyString: true')
			if (param.default !== undefined) bits.push(`default: ${JSON.stringify(param.default)}`)
			return `\t\t\t${propKey(name)}: { ${bits.join(', ')} },`
		})
		.join('\n')

	const lines = [
		`\t\tmethod: ${quote(endpoint.method)},`,
		`\t\tpath: ${quote(endpoint.path)},`,
		`\t\tname: ${quote(info.name)},`,
		`\t\tdescription: ${quote(oneLine(info.description, 240) ?? '')},`,
		`\t\tallowToken: ${info.allowtoken === 0 ? 'false' : 'true'},`,
		`\t\trootOnly: ${info.permissions === undefined ? 'true' : 'false'},`,
		`\t\tprotectedCall: ${info.protected ? 'true' : 'false'},`,
		`\t\tproxyTo: ${info.proxyto ? quote(info.proxyto) : 'null'},`,
		`\t\treturnType: ${quote(info.returns?.type ?? 'null')},`,
		...(endpoint.model.discriminator
			? [
					`\t\tdiscriminator: { property: ${quote(endpoint.model.discriminator.property)}, values: [${endpoint.model.variants
						.map((v) => quote(v.value))
						.join(', ')}] },`,
				]
			: []),
		entries.length > 0 ? `\t\tparams: {\n${params}\n\t\t},` : '\t\tparams: {},',
	]
	return `\t${quote(endpoint.key)}: {\n${lines.join('\n')}\n\t},`
}

function renderFormatLiteral(format: Record<string, ParamSchema>): string {
	const entries = sortedEntries(format)
		.map(([subKey, sub]) => {
			const bits: string[] = []
			if (sub.type) bits.push(`type: ${quote(sub.type)}`)
			if (sub.enum) bits.push(`enum: [${sub.enum.map(quote).join(', ')}]`)
			if (sub.optional) bits.push('optional: 1')
			if (sub.default_key) bits.push('default_key: 1')
			if (sub.alias) bits.push(`alias: ${quote(sub.alias)}`)
			if (sub.keyAlias) bits.push(`keyAlias: ${quote(sub.keyAlias)}`)
			if (typeof sub.format === 'string') bits.push(`format: ${quote(sub.format)}`)
			if (sub.default !== undefined) bits.push(`default: ${JSON.stringify(sub.default)}`)
			if (sub.minimum !== undefined) bits.push(`minimum: ${sub.minimum}`)
			if (sub.maximum !== undefined) bits.push(`maximum: ${sub.maximum}`)
			if (sub.pattern) bits.push(`pattern: ${quote(sub.pattern)}`)
			if (sub.format_description) bits.push(`format_description: ${quote(sub.format_description)}`)
			return `\t\t${propKey(subKey)}: { ${bits.join(', ')} },`
		})
		.join('\n')
	return `{\n${entries}\n\t}`
}

/**
 * Named formats such as pve-qm-hostpci are registered by name, so the schema
 * dump carries no sub-key definitions for them - only the typetext the CLI
 * prints. That text names every sub-key, which one may be written without its
 * name, and which are required, so a usable format falls out of it.
 *
 * Only booleans and integers are read back from the value placeholders. The
 * `<a|b|c>` placeholders are description text, not registered enums, so they
 * stay untyped rather than becoming a union that rejects valid values.
 */
function formatFromTypetext(typetext: string): Record<string, ParamSchema> | undefined {
	if (!/\[,\s*[\w-]+=/.test(typetext)) return undefined

	const optional = new Set<string>()
	for (const match of typetext.matchAll(/\[,?\s*\[?([\w-]+)=/g)) {
		if (match[1]) optional.add(match[1])
	}

	const format: Record<string, ParamSchema> = {}
	for (const match of typetext.matchAll(/(?:^|[[,]\s*)\[?([\w-]+)=(?:<([^>]*)>|([^\s,\]]*))/g)) {
		const key = match[1]
		if (!key) continue
		const placeholder = match[2] ?? match[3] ?? ''
		const entry: ParamSchema = {}
		if (placeholder === '1|0' || placeholder === '0|1') entry.type = 'boolean'
		else if (placeholder === 'integer') entry.type = 'integer'
		else if (placeholder === 'number') entry.type = 'number'
		else entry.type = 'string'
		if (optional.has(key)) entry.optional = 1
		format[key] = entry
	}

	const defaultKey = /^\[?\[([\w-]+)=\]/.exec(typetext)?.[1]
	const defaultEntry = defaultKey ? format[defaultKey] : undefined
	if (defaultEntry) defaultEntry.default_key = 1

	return Object.keys(format).length > 0 ? format : undefined
}

const BANNER = '// Generated by scripts/generate-api.ts from schema/apidoc.json. Do not edit.\n\n'

function renderEndpointsFile(endpoints: Endpoint[]): string {
	const rootOnly = endpoints.filter((e) => e.info.permissions === undefined).map((e) => e.key)
	const noToken = endpoints.filter((e) => e.info.allowtoken === 0).map((e) => e.key)

	const docRootParams: Record<string, string[]> = {}
	for (const endpoint of endpoints) {
		const flagged: string[] = []
		for (const [name, param] of Object.entries(endpoint.model.flat)) {
			if (ROOT_HINT.test(`${param.description ?? ''} ${param.verbose_description ?? ''}`)) {
				flagged.push(name)
			}
		}
		if (flagged.length > 0) docRootParams[endpoint.key] = flagged.sort()
	}

	return [
		BANNER,
		'/** Parameter metadata as the node registered it. */\n',
		'export interface EndpointParam {\n',
		'\treadonly type: string\n',
		'\treadonly optional: boolean\n',
		'\treadonly enum?: readonly string[]\n',
		'\t/** Named format such as pve-vmid, absent for a plain value. */\n',
		'\treadonly format?: string\n',
		'\t/** True when the value is a `key=value,...` property string. */\n',
		'\treadonly propertyString?: boolean\n',
		'\treadonly default?: string | number | boolean | null\n',
		'}\n\n',
		'export interface EndpointInfo {\n',
		'\treadonly method: string\n',
		'\treadonly path: string\n',
		'\treadonly name: string\n',
		'\treadonly description: string\n',
		'\t/** False for the endpoints an API token may never call. */\n',
		'\treadonly allowToken: boolean\n',
		'\t/** True when the handler compares the caller against root@pam. */\n',
		'\treadonly rootOnly: boolean\n',
		'\t/** True when the call runs in a privileged worker on the node. */\n',
		'\treadonly protectedCall: boolean\n',
		'\treadonly proxyTo: string | null\n',
		'\treadonly returnType: string\n',
		'\t/** Set when the parameter set is a union keyed on one property. */\n',
		'\treadonly discriminator?: { readonly property: string; readonly values: readonly string[] }\n',
		'\treadonly params: Readonly<Record<string, EndpointParam>>\n',
		'}\n\n',
		'export const endpoints = {\n',
		endpoints.map(renderEndpointEntry).join('\n'),
		'\n} as const satisfies Readonly<Record<string, EndpointInfo>>\n\n',
		'export type EndpointKey = keyof typeof endpoints\n\n',
		'/** Endpoints whose handler tests for root@pam, so a root-owned token also fails. */\n',
		'export const ROOT_ONLY_ENDPOINTS: readonly EndpointKey[] = [\n',
		rootOnly.map((key) => `\t${quote(key)},\n`).join(''),
		']\n\n',
		'/** Endpoints registered with allowtoken 0. */\n',
		'export const TOKEN_FORBIDDEN_ENDPOINTS: readonly EndpointKey[] = [\n',
		noToken.map((key) => `\t${quote(key)},\n`).join(''),
		']\n\n',
		'/** Parameters the schema text itself marks as root-only. */\n',
		'export const DOCUMENTED_ROOT_ONLY_PARAMS: Readonly<Record<string, readonly string[]>> = {\n',
		sortedEntries(docRootParams)
			.map(([key, names]) => `\t${quote(key)}: [${names.map(quote).join(', ')}],\n`)
			.join(''),
		'}\n',
	].join('')
}

function renderFormatsFile(endpoints: Endpoint[]): { source: string; count: number } {
	const entries: string[] = []
	const derived: string[] = []
	for (const endpoint of endpoints) {
		for (const [name, param] of sortedEntries(endpoint.model.flat)) {
			const registryKey = `${endpoint.key} ${name}`
			if (param.format && typeof param.format === 'object') {
				entries.push(`\t${quote(registryKey)}: ${renderFormatLiteral(param.format)},`)
				continue
			}
			if (typeof param.format !== 'string') continue
			const fromText = formatFromTypetext(param.typetext ?? '')
			if (!fromText) continue
			entries.push(`\t${quote(registryKey)}: ${renderFormatLiteral(fromText)},`)
			derived.push(registryKey)
		}
	}
	const source = [
		BANNER,
		'/** One sub-key of a property string, as the node registered it. */\n',
		'export interface PropertyFormatEntry {\n',
		'\treadonly type?: string\n',
		'\treadonly enum?: readonly string[]\n',
		'\treadonly default?: string | number | boolean | null\n',
		'\treadonly optional?: number\n',
		'\treadonly format?: string\n',
		'\treadonly pattern?: string\n',
		'\treadonly format_description?: string\n',
		'\t/** Set on the sub-key a value may carry without its name. */\n',
		'\treadonly default_key?: number\n',
		'\t/** Writing this sub-key stores its value under the named sub-key instead. */\n',
		'\treadonly alias?: string\n',
		"\t/** This sub-key's own name is stored as the value of the named sub-key. */\n",
		'\treadonly keyAlias?: string\n',
		'\treadonly minimum?: number\n',
		'\treadonly maximum?: number\n',
		'}\n\n',
		'export type PropertyFormat = Readonly<Record<string, PropertyFormatEntry>>\n\n',
		'/** Property-string formats keyed by "METHOD path paramName". */\n',
		'export const propertyFormats: Readonly<Record<string, PropertyFormat>> = {\n',
		entries.join('\n'),
		'\n}\n\n',
		'/**\n',
		' * Entries read out of a typetext line rather than a registered sub-key schema.\n',
		' * They name every sub-key and mark the default key, and carry no enums.\n',
		' */\n',
		'export const TYPETEXT_DERIVED_FORMATS: readonly string[] = [\n',
		derived.map((key) => `\t${quote(key)},\n`).join(''),
		']\n',
	].join('')
	return { source, count: entries.length }
}

function renderTypesFile(endpoints: Endpoint[]): string {
	const aliasLines = Object.entries(TYPE_ALIASES).map(([key, alias]) => {
		const endpoint = endpoints.find((e) => e.key === key)
		if (!endpoint) throw new Error(`Alias target is not in the schema: ${key}`)
		return `export type ${alias} = ${endpoint.typeName}\n`
	})
	return [
		BANNER,
		endpoints.map(renderParamsInterface).join('\n'),
		'\n',
		'/** Short names for the parameter sets the guest and cluster modules use most. */\n',
		aliasLines.join(''),
	].join('')
}

async function run(): Promise<void> {
	const raw: unknown = await Bun.file(resolve(repoRoot, 'schema/apidoc.json')).json()
	if (!Array.isArray(raw)) throw new Error('schema/apidoc.json is not a schema node array')
	const endpoints = flatten(raw as SchemaNode[])
	endpoints.sort((a, b) => a.key.localeCompare(b.key))
	const combinatorEndpoints: string[] = []
	for (const endpoint of endpoints) {
		const params = endpoint.info.parameters
		if (params?.allOf || params?.oneOf || params?.anyOf) combinatorEndpoints.push(endpoint.key)
	}
	assignTypeNames(endpoints)

	// Every file is rendered before any is written, so a render that throws
	// leaves the committed tree as it was.
	const formats = renderFormatsFile(endpoints)
	const files: [string, string][] = [
		['endpoints.ts', renderEndpointsFile(endpoints)],
		['formats.ts', formats.source],
		['types.ts', renderTypesFile(endpoints)],
		[
			'index.ts',
			`${BANNER}export * from './endpoints.ts'\nexport * from './formats.ts'\nexport * from './types.ts'\n`,
		],
	]

	for (const [name, source] of files) await Bun.write(resolve(outDir, name), source)

	console.log(
		`endpoints: ${endpoints.length}, property formats: ${formats.count}, combinator schemas: ${combinatorEndpoints.length}`,
	)
	for (const key of combinatorEndpoints) {
		const endpoint = endpoints.find((e) => e.key === key)
		const variants = endpoint?.model.variants.map((v) => v.value).join(', ')
		console.log(
			`  ${key} -> ${variants ? `union on ${endpoint?.model.discriminator?.property}: ${variants}` : 'merged'}`,
		)
	}
}

await run()
