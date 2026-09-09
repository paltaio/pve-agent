/**
 * Reading the result attributes PVE puts beside `data`.
 *
 * A handful of handlers call `set_result_attrib`, which lands a key next to
 * `data` in the JSON envelope rather than inside it. A plain `PveClient.get`
 * returns `data` alone, so those keys need `{ withAttribs: true }`:
 *
 * - `GET /nodes/{node}/network` sets `changes`, the diff of the staged
 *   `/etc/network/interfaces.new` against the running file.
 * - `GET /nodes/{node}/tasks`, `GET /nodes/{node}/firewall/log` and
 *   `GET /nodes/{node}/replication/{id}/log` set `total`, the row count before
 *   `start` and `limit` paging.
 */

import type { EnvelopeResult, PveClient, PveParams } from '../core/client.ts'

export type { EnvelopeResult } from '../core/client.ts'

/**
 * Send one GET and return both the `data` field and the sibling attributes.
 * Reads only: no write endpoint sets a result attribute.
 */
export async function getEnvelope<T>(
	client: PveClient,
	path: string,
	params?: PveParams,
): Promise<EnvelopeResult<T>> {
	return client.request<T>('GET', path, params, { withAttribs: true })
}

/** The `total` attribute as a number, when the handler set one. */
export function envelopeTotal(attribs: Readonly<Record<string, unknown>>): number | undefined {
	const total = attribs['total']
	if (typeof total === 'number') return Number.isFinite(total) ? total : undefined
	if (typeof total === 'string' && total !== '') {
		const parsed = Number(total)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}
