/**
 * External metric servers and the metrics export.
 *
 * A metric server is a push target: pvestatd sends node, guest and storage
 * samples to it. The export endpoint is the pull side, for reading the same
 * samples over the API.
 */

import type { PveClient } from '../core/client.ts'
import { toOptionalBoolean, toOptionalNumber, toOptionalString } from '../core/values.ts'
import type {
	ClusterMetricsExportGetParams,
	ClusterMetricsServerPostParams,
	ClusterMetricsServerPutParams,
} from '../generated/types.ts'

export interface MetricServer {
	id: string
	/** `graphite`, `influxdb` or `opentelemetry`. */
	type: string
	server: string
	port: number | undefined
	disable: boolean | undefined
	comment: string | undefined
	raw: Readonly<Record<string, unknown>>
}

function normalizeServer(raw: Record<string, unknown>): MetricServer {
	return {
		id: String(raw['id'] ?? ''),
		type: String(raw['type'] ?? ''),
		server: String(raw['server'] ?? ''),
		port: toOptionalNumber(raw['port']),
		disable: toOptionalBoolean(raw['disable']),
		comment: toOptionalString(raw['comment']),
		raw,
	}
}

export interface MetricsExport {
	data: Record<string, unknown>[]
}

export class ClusterMetricsApi {
	readonly client: PveClient

	constructor(client: PveClient) {
		this.client = client
	}

	/** Configured metric servers. Token tier. */
	async listServers(): Promise<MetricServer[]> {
		const rows = await this.client.get<Record<string, unknown>[]>('/cluster/metrics/server')
		return rows.map(normalizeServer)
	}

	async getServer(id: string): Promise<MetricServer> {
		return normalizeServer(
			await this.client.get<Record<string, unknown>>(
				`/cluster/metrics/server/${encodeURIComponent(id)}`,
			),
		)
	}

	/**
	 * Add a metric server. `type` picks which of the transport fields apply:
	 * graphite uses `path` and `proto`, influxdb uses `influxdbproto`, `bucket`
	 * and `organization`, opentelemetry uses the `otel-*` fields. Returns
	 * nothing.
	 */
	async createServer(id: string, params: ClusterMetricsServerPostParams): Promise<void> {
		await this.client.post<null>(`/cluster/metrics/server/${encodeURIComponent(id)}`, params)
	}

	/** Change a metric server. `delete` unsets keys. Returns nothing. */
	async updateServer(id: string, params: ClusterMetricsServerPutParams): Promise<void> {
		await this.client.put<null>(`/cluster/metrics/server/${encodeURIComponent(id)}`, params)
	}

	async deleteServer(id: string): Promise<void> {
		await this.client.delete<null>(`/cluster/metrics/server/${encodeURIComponent(id)}`)
	}

	/**
	 * Current metric samples for the cluster. `history` with `start-time`
	 * returns everything buffered since that epoch second instead of the latest
	 * point, and `local-only` limits the answer to the node taking the request.
	 * Token tier.
	 */
	async export(options: ClusterMetricsExportGetParams = {}): Promise<MetricsExport> {
		return this.client.get<MetricsExport>('/cluster/metrics/export', options)
	}
}
