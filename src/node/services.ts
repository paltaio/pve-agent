/**
 * Node services.
 *
 * The API knows a fixed list of systemd units and refuses any other name;
 * a custom unit or a timer PVE does not ship has no endpoint.
 *
 * The node refuses to stop `pveproxy`, `pvedaemon` and `pve-cluster`. They
 * can be restarted and reloaded, and a restart of `pveproxy` or `pvedaemon`
 * drops in-flight API connections, including the one issuing the call.
 */

import type { PveClient } from '../core/client.ts'
import { endpoints } from '../generated/endpoints.ts'

/** The units the API accepts. */
export const NODE_SERVICES =
	endpoints['GET /nodes/{node}/services/{service}/state'].params.service.enum

export type NodeService = (typeof NODE_SERVICES)[number]

const SERVICE_SET: ReadonlySet<string> = new Set(NODE_SERVICES)

/** True when the API has an endpoint for this unit. */
export function isNodeService(service: string): service is NodeService {
	return SERVICE_SET.has(service)
}

export interface ServiceEntry extends Record<string, unknown> {
	service: string
	name: string
	desc: string
	/** `running`, `dead`, `exited`, `failed` or another systemd sub-state. */
	state: string
	/** `enabled`, `disabled`, `static`, `masked` or another systemd unit file state. */
	'unit-state': string
	'active-state': string
}

export class NodeServicesApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/services`
	}

	private servicePath(service: NodeService, action: string): string {
		return `${this.base}/${encodeURIComponent(service)}/${action}`
	}

	/** Every known unit with its current state. */
	async list(): Promise<ServiceEntry[]> {
		return this.client.get<ServiceEntry[]>(this.base)
	}

	async state(service: NodeService): Promise<ServiceEntry> {
		return this.client.get<ServiceEntry>(this.servicePath(service, 'state'))
	}

	/** Returns a UPID. */
	async start(service: NodeService): Promise<string> {
		return this.client.post<string>(this.servicePath(service, 'start'))
	}

	/** Refused by the node for `pveproxy`, `pvedaemon` and `pve-cluster`. Returns a UPID. */
	async stop(service: NodeService): Promise<string> {
		return this.client.post<string>(this.servicePath(service, 'stop'))
	}

	/**
	 * Restarting `pveproxy` or `pvedaemon` cuts open API connections, so the
	 * call itself may end in a dropped request even though the restart went
	 * through. Returns a UPID.
	 */
	async restart(service: NodeService): Promise<string> {
		return this.client.post<string>(this.servicePath(service, 'restart'))
	}

	/** Reload a unit without restarting it. Returns a UPID. */
	async reload(service: NodeService): Promise<string> {
		return this.client.post<string>(this.servicePath(service, 'reload'))
	}
}
