/**
 * Property strings: the `key=value,key=value` encoding PVE uses for many
 * parameters, such as `scsi0` or `net0`.
 *
 * The rules follow PVE::JSONSchema parse_property_string and
 * print_property_string:
 *
 * - Parts split on commas. There is no quoting and no escaping, so a value
 *   containing a comma cannot be represented; the node refuses it and so does
 *   the encoder here. Lists inside a value use semicolons.
 * - A key ends at the first '='; the rest of the part is the value, so values
 *   may contain '='.
 * - One sub-key may be marked `default_key` and written without its name. It
 *   is emitted first.
 * - A sub-key with `alias` renames itself on parse. With `keyAlias` on top,
 *   the sub-key name becomes a value too: on `net0`, `virtio=AA:BB:...` parses
 *   to `{ model: 'virtio', macaddr: 'AA:BB:...' }` and encodes back the same.
 * - Booleans are 1 and 0 on the wire.
 * - A sub-key whose format is `disk-size` accepts a byte count and prints with
 *   a K/M/G/T suffix.
 */

import type { PropertyFormat, PropertyFormatEntry } from '../generated/formats.ts'
import { PvePropertyError } from './errors.ts'
import { parseBoolean, toOptionalInteger, toOptionalNumber } from './values.ts'

export type { PropertyFormat, PropertyFormatEntry }

export type PropertyScalar = string | number | boolean

export type PropertyBag = Record<string, PropertyScalar>

export interface ParseOptions {
	/** Reject sub-keys the format does not declare. Defaults to true. */
	strictKeys?: boolean
	/** Check enum membership and required sub-keys. Defaults to false. */
	validate?: boolean
}

export type FormatOptions = ParseOptions

export interface PropertyParts {
	/** Parts written without a key. A well-formed value has at most one. */
	bare: string[]
	/** Parts written as `key=value`, in the order they appeared. */
	entries: [string, string][]
}

/** The sub-key a bare value belongs to, or undefined when the format has none. */
function defaultKeyOf(format: PropertyFormat): string | undefined {
	let found: string | undefined
	for (const [key, entry] of Object.entries(format)) {
		if (!entry.default_key) continue
		if (found !== undefined) {
			throw new PvePropertyError(`Format has two default keys: ${found} and ${key}`)
		}
		found = key
	}
	return found
}

/** Bytes to the K/M/G/T spelling PVE writes for `disk-size` sub-keys. */
export function formatSize(bytes: number): string {
	let size = Math.trunc(bytes)
	let unit = ''
	for (const next of ['K', 'M', 'G', 'T']) {
		if (size === 0 || size % 1024 !== 0) break
		size /= 1024
		unit = next
	}
	return `${size}${unit}`
}

/** The K/M/G/T spelling back to bytes, or undefined when the text is not a size. */
export function parseSize(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(?:([KMGT])(?:iB)?)?$/.exec(value)
	if (!match?.[1]) return undefined
	const exponent = match[2] === undefined ? 0 : 'KMGT'.indexOf(match[2]) + 1
	return Math.trunc(Number(match[1]) * 1024 ** exponent)
}

function coerce(raw: string, entry: PropertyFormatEntry | undefined): PropertyScalar {
	if (entry?.type === 'boolean') return parseBoolean(raw) ?? raw
	if (entry?.type === 'integer') return toOptionalInteger(raw) ?? raw
	if (entry?.type === 'number') return toOptionalNumber(raw) ?? raw
	return raw
}

function wireText(value: PropertyScalar, entry: PropertyFormatEntry | undefined): string {
	if (typeof value === 'boolean') return value ? '1' : '0'
	if (typeof value === 'number' && entry?.format === 'disk-size') return formatSize(value)
	return String(value)
}

function stringify(
	key: string,
	value: PropertyScalar,
	entry: PropertyFormatEntry | undefined,
): string {
	const text = wireText(value, entry)
	if (text.includes(',')) {
		throw new PvePropertyError(
			`Sub-key '${key}' has a comma in its value: ${text}. Property strings split on commas and have no escape; use semicolons for lists.`,
		)
	}
	return text
}

function validateBag(format: PropertyFormat, bag: PropertyBag): void {
	for (const [key, value] of Object.entries(bag)) {
		const entry = format[key]
		if (!entry?.enum) continue
		const text = wireText(value, entry)
		if (!entry.enum.includes(text)) {
			throw new PvePropertyError(
				`Sub-key '${key}' got '${text}', expected one of: ${entry.enum.join(', ')}`,
			)
		}
	}
	for (const [key, entry] of Object.entries(format)) {
		if (entry.alias || entry.optional) continue
		if (bag[key] === undefined) {
			throw new PvePropertyError(`Property string is missing required sub-key '${key}'`)
		}
	}
}

/**
 * Split a property string without consulting a format, for a caller that has
 * to look at a value before it knows which format applies.
 */
export function splitPropertyParts(input: string): PropertyParts {
	const parts: PropertyParts = { bare: [], entries: [] }
	for (const part of input.split(',')) {
		if (part.trim() === '') continue
		const eq = part.indexOf('=')
		if (eq <= 0) parts.bare.push(part)
		else parts.entries.push([part.slice(0, eq), part.slice(eq + 1)])
	}
	return parts
}

/**
 * Split `key=value,key=value` into a bag of sub-keys, resolving aliases and
 * coercing values to the types the format declares.
 */
export function parsePropertyString(
	input: string,
	format?: PropertyFormat,
	options: ParseOptions = {},
): PropertyBag {
	const strictKeys = options.strictKeys ?? true
	const defaultKey = format ? defaultKeyOf(format) : undefined
	const bag: PropertyBag = {}

	for (const part of input.split(',')) {
		if (part.trim() === '') continue

		const eq = part.indexOf('=')
		if (eq === -1) {
			if (defaultKey === undefined) {
				throw new PvePropertyError(
					`Property string '${input}' has a value without a key, and its format defines no default key`,
				)
			}
			if (bag[defaultKey] !== undefined) {
				throw new PvePropertyError(`Duplicate value for default key '${defaultKey}'`)
			}
			bag[defaultKey] = coerce(part, format?.[defaultKey])
			continue
		}
		if (eq === 0 || eq === part.length - 1) {
			throw new PvePropertyError(`Malformed property string part '${part}' in '${input}'`)
		}

		let key = part.slice(0, eq)
		const raw = part.slice(eq + 1)
		if (bag[key] !== undefined) {
			throw new PvePropertyError(`Duplicate sub-key '${key}' in property string '${input}'`)
		}

		let entry = format?.[key]
		if (entry?.alias) {
			if (entry.keyAlias) {
				if (bag[entry.keyAlias] !== undefined) {
					throw new PvePropertyError(`Key alias '${entry.keyAlias}' is already set in '${input}'`)
				}
				bag[entry.keyAlias] = key
			}
			key = entry.alias
			entry = format?.[key]
			if (bag[key] !== undefined) {
				throw new PvePropertyError(`Sub-key '${key}' is already set (reached via alias)`)
			}
		}

		if (format && !entry && strictKeys) {
			throw new PvePropertyError(`Unknown sub-key '${key}' in property string '${input}'`)
		}

		bag[key] = coerce(raw, entry)
	}

	if (format && options.validate) validateBag(format, bag)
	return bag
}

/**
 * Serialize a bag back to a property string. Key order follows PVE: the
 * default key first, then required sub-keys, then the rest, each group sorted.
 */
export function formatPropertyString(
	bag: PropertyBag,
	format?: PropertyFormat,
	options: FormatOptions = {},
): string {
	if (!format) {
		return Object.entries(bag)
			.map(([key, value]) => `${key}=${stringify(key, value, undefined)}`)
			.join(',')
	}

	if (options.validate) validateBag(format, bag)

	const strictKeys = options.strictKeys ?? true
	const defaultKey = defaultKeyOf(format)
	// keyAlias name -> the sub-key its value pairs with, such as model -> macaddr.
	const keyAliases = new Map<string, string>()
	for (const entry of Object.values(format)) {
		if (entry.keyAlias && entry.alias) keyAliases.set(entry.keyAlias, entry.alias)
	}

	const done = new Set<string>()
	const parts: string[] = []

	const addKey = (key: string): void => {
		if (done.has(key)) return
		done.add(key)

		const value = bag[key]
		if (value === undefined) return

		let entry = format[key]

		// A keyAlias sub-key folds two bag entries into one `value=value` part.
		const partner = keyAliases.get(key)
		const partnerValue = partner === undefined ? undefined : bag[partner]
		if (partner !== undefined && partnerValue !== undefined) {
			const left = stringify(key, value, entry)
			const right = stringify(partner, partnerValue, format[partner])
			parts.push(`${left}=${right}`)
			done.add(partner)
			return
		}

		if (entry?.alias) entry = format[entry.alias]
		if (!entry && strictKeys) {
			throw new PvePropertyError(`Unknown sub-key '${key}' for this property string format`)
		}

		const text = stringify(key, value, entry)
		parts.push(key === defaultKey ? text : `${key}=${text}`)
	}

	if (defaultKey !== undefined) addKey(defaultKey)
	const keys = Object.keys(bag).sort()
	for (const key of keys) {
		const entry = format[key]
		if (entry && !entry.optional) addKey(key)
	}
	for (const key of keys) addKey(key)

	return parts.join(',')
}

/** Matches the `foo[n]` spelling the API schema uses for indexed parameters. */
const INDEXED_KEY = /^([A-Za-z][A-Za-z0-9_-]*)\[n\]$/

/** True when a schema parameter name stands for a family such as `net0`, `net1`. */
export function isIndexedKey(schemaKey: string): boolean {
	return INDEXED_KEY.test(schemaKey)
}

/** `net[n]` -> `net`. Returns undefined for keys that are not indexed. */
export function indexedKeyBase(schemaKey: string): string | undefined {
	return INDEXED_KEY.exec(schemaKey)?.[1]
}

/** `net[n]` plus 0 -> `net0`. */
export function expandIndexedKey(schemaKey: string, index: number): string {
	const base = indexedKeyBase(schemaKey)
	if (base === undefined) {
		throw new PvePropertyError(`'${schemaKey}' is not an indexed parameter name`)
	}
	if (!Number.isInteger(index) || index < 0) {
		throw new PvePropertyError(`Index must be a non-negative integer, got ${index}`)
	}
	return `${base}${index}`
}

/** `net0` -> `net[n]` when `known` lists that family, for schema lookups. */
export function collapseIndexedKey(configKey: string, known: Iterable<string>): string | undefined {
	const split = splitIndexedKey(configKey)
	if (!split) return undefined
	const candidate = `${split.base}[n]`
	for (const key of known) {
		if (key === candidate) return candidate
	}
	return undefined
}

/** Splits `net0` into its family and index. */
export function splitIndexedKey(configKey: string): { base: string; index: number } | undefined {
	const match = /^([A-Za-z][A-Za-z0-9_-]*?)(\d+)$/.exec(configKey)
	if (!match?.[1] || !match[2]) return undefined
	return { base: match[1], index: Number(match[2]) }
}
