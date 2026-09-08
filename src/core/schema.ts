/**
 * Pairs the generated property-string formats with the endpoint registry, so
 * a caller can parse or build a config value without carrying the format
 * around by hand.
 */

import { endpoints, type EndpointInfo } from '../generated/endpoints.ts'
import { propertyFormats } from '../generated/formats.ts'
import {
	formatPropertyString,
	parsePropertyString,
	splitIndexedKey,
	type FormatOptions,
	type ParseOptions,
	type PropertyBag,
	type PropertyFormat,
} from './props.ts'

/** Registry entries grouped by method and segment count. */
const byShape: ReadonlyMap<string, readonly EndpointInfo[]> = (() => {
	const groups = new Map<string, EndpointInfo[]>()
	for (const info of Object.values(endpoints)) {
		const shape = `${info.method} ${info.path.split('/').length}`
		const bucket = groups.get(shape)
		if (bucket) bucket.push(info)
		else groups.set(shape, [info])
	}
	return groups
})()

/**
 * The registry entry whose path template matches a concrete path, or
 * undefined when no template does. A template path matches itself. When
 * several templates fit, the one with the most literal segments wins.
 */
export function resolveEndpoint(method: string, path: string): EndpointInfo | undefined {
	const segments = (path.split('?')[0] ?? '').split('/')
	const candidates = byShape.get(`${method} ${segments.length}`) ?? []
	let best: EndpointInfo | undefined
	let bestLiterals = -1
	for (const info of candidates) {
		const template = info.path.split('/')
		let literals = 0
		let matched = true
		for (let i = 0; i < template.length; i++) {
			const part = template[i] ?? ''
			if (part.startsWith('{')) continue
			if (part !== segments[i]) {
				matched = false
				break
			}
			literals++
		}
		if (matched && literals > bestLiterals) {
			best = info
			bestLiterals = literals
		}
	}
	return best
}

/**
 * The property-string format for one parameter of one endpoint, or undefined
 * when the parameter is a plain value.
 *
 * `path` may be concrete, and `param` may be a concrete indexed key, so
 * ('PUT', '/nodes/ms01/qemu/110/config', 'net0') finds the format registered
 * for '/nodes/{node}/qemu/{vmid}/config' and 'net[n]'.
 */
export function propertyFormatFor(
	method: string,
	path: string,
	param: string,
): PropertyFormat | undefined {
	const endpoint = resolveEndpoint(method, path)
	if (!endpoint) return undefined
	const key = `${endpoint.method} ${endpoint.path}`
	const direct = propertyFormats[`${key} ${param}`]
	if (direct) return direct
	const family = splitIndexedKey(param)
	return family ? propertyFormats[`${key} ${family.base}[n]`] : undefined
}

/** Parses a config value with the format the schema registers for it. */
export function parseConfigValue(
	method: string,
	path: string,
	param: string,
	value: string,
	options?: ParseOptions,
): PropertyBag {
	return parsePropertyString(value, propertyFormatFor(method, path, param), options)
}

/** Builds a config value with the format the schema registers for it. */
export function formatConfigValue(
	method: string,
	path: string,
	param: string,
	bag: PropertyBag,
	options?: FormatOptions,
): string {
	return formatPropertyString(bag, propertyFormatFor(method, path, param), options)
}
