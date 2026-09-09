/**
 * Finding and creating guests across the cluster.
 *
 * /cluster/resources answers for every node in one call and marks each row
 * with its type, so it is the cheapest way to map a vmid to the node that
 * holds it. Containers and virtual machines share one vmid space and both
 * appear in the same listing. The answer comes from the status cache that
 * pvestatd refreshes every few seconds, so a guest created a moment ago can
 * still show `status: 'unknown'`; read the guest's own status endpoint when
 * the answer has to be current.
 */

import { nextVmid } from '../cluster/cluster.ts'
import type { PveClient } from '../core/client.ts'
import { PveNotFoundError } from '../core/errors.ts'
import type { WaitOptions } from '../core/tasks.ts'
import type { LxcCreateParams, QemuCreateParams } from '../generated/types.ts'
import { LxcApi } from './lxc.ts'
import { QemuApi } from './qemu.ts'
import { normalizeSummary, type GuestRef, type GuestSummary, type GuestType } from './types.ts'

export interface ListGuestsOptions {
	/** Only virtual machines, or only containers. Both by default. */
	type?: GuestType
	/** Only guests on this node. */
	node?: string
	/** Drop templates from the result. They are included by default. */
	excludeTemplates?: boolean
	/** Only guests carrying this tag. */
	tag?: string
	/** Only guests in this state, such as 'running' or 'stopped'. */
	status?: string
}

/**
 * Every guest in the cluster, virtual machines and containers together,
 * sorted by vmid. One GET to /cluster/resources. A guest the caller may not
 * audit is absent from the answer.
 */
export async function listGuests(
	client: PveClient,
	options: ListGuestsOptions = {},
): Promise<GuestSummary[]> {
	const rows = await client.get<Record<string, unknown>[]>('/cluster/resources', { type: 'vm' })
	const guests: GuestSummary[] = []
	for (const row of rows) {
		if (row['type'] !== 'qemu' && row['type'] !== 'lxc') continue
		const summary = normalizeSummary(row, row['type'], String(row['node'] ?? ''))
		if (options.type && summary.type !== options.type) continue
		if (options.node && summary.node !== options.node) continue
		if (options.excludeTemplates && summary.template) continue
		if (options.status && summary.status !== options.status) continue
		if (options.tag && !summary.tags.includes(options.tag)) continue
		guests.push(summary)
	}
	return guests.sort((a, b) => a.vmid - b.vmid)
}

/** One guest by vmid, or undefined when no node in the cluster holds it. */
export async function findGuest(
	client: PveClient,
	vmid: number,
): Promise<GuestSummary | undefined> {
	const guests = await listGuests(client)
	return guests.find((guest) => guest.vmid === vmid)
}

/** One guest by vmid. Throws PveNotFoundError when the cluster has no such vmid. */
export async function resolveGuest(client: PveClient, vmid: number): Promise<GuestSummary> {
	const guest = await findGuest(client, vmid)
	if (!guest) {
		throw new PveNotFoundError({
			method: 'GET',
			path: '/cluster/resources',
			detail: `no guest with vmid ${vmid} exists on any node in the cluster`,
		})
	}
	return guest
}

/** A handle for a guest whose type and node are already known. Sends nothing. */
export function guestHandle(client: PveClient, ref: GuestRef): QemuApi | LxcApi {
	return ref.type === 'lxc'
		? new LxcApi(client, ref.node, ref.vmid)
		: new QemuApi(client, ref.node, ref.vmid)
}

/**
 * Looks a vmid up across the cluster and returns a handle of the right type.
 * Costs one GET. Throws PveNotFoundError when the vmid is free.
 */
export async function openGuest(client: PveClient, vmid: number): Promise<QemuApi | LxcApi> {
	return guestHandle(client, await resolveGuest(client, vmid))
}

export interface CreateVmSpec extends Omit<QemuCreateParams, 'vmid'> {
	/** vmid to claim. Defaults to the lowest free one in the cluster. */
	vmid?: number
}

export interface CreateContainerSpec extends Omit<LxcCreateParams, 'vmid'> {
	/** vmid to claim. Defaults to the lowest free one in the cluster. */
	vmid?: number
}

/**
 * Creates a virtual machine on `node`, waits for the create task and returns
 * its handle. Needs VM.Allocate on /vms plus Datastore.AllocateSpace on each
 * storage the config touches.
 *
 * Disks are config keys rather than a separate call: `scsi0: 'local-zfs:32'`
 * allocates 32 GiB, and `scsi0: 'local-zfs:0,import-from=<volume>'` imports
 * an existing image and sizes the disk from it. Setting `archive` restores a
 * backup instead, and the other keys become overrides on the archived config.
 */
export async function createVm(
	client: PveClient,
	node: string,
	spec: CreateVmSpec,
	wait?: WaitOptions,
): Promise<QemuApi> {
	const { vmid, ...params } = spec
	const id = vmid ?? (await nextVmid(client))
	const upid = await client.post<string>(`/nodes/${encodeURIComponent(node)}/qemu`, {
		...params,
		vmid: id,
	})
	await client.waitForTask(upid, wait)
	return new QemuApi(client, node, id)
}

/**
 * Creates a container on `node`, waits for the create task and returns its
 * handle. Needs VM.Allocate on /vms plus Datastore.AllocateSpace on the
 * rootfs storage.
 *
 * `ostemplate` names the template volume, as in
 * `'local:vztmpl/alpine-3.22-default_20250617_amd64.tar.xz'`, and `rootfs`
 * names the storage and size, as in `'local-zfs:8'`. Mount points are config
 * keys: `mp0: 'local-zfs:32,mp=/data'`.
 *
 * The schema documents `unprivileged` as defaulting to 0 while the create
 * handler uses 1, so a fresh container is sent `unprivileged: true` when the
 * spec leaves it out. A restore (`restore: true`, with the backup in
 * `ostemplate`) keeps the value from the archive instead.
 */
export async function createContainer(
	client: PveClient,
	node: string,
	spec: CreateContainerSpec,
	wait?: WaitOptions,
): Promise<LxcApi> {
	const { vmid, ...params } = spec
	const id = vmid ?? (await nextVmid(client))
	const upid = await client.post<string>(`/nodes/${encodeURIComponent(node)}/lxc`, {
		...(params.restore || params.unprivileged !== undefined ? {} : { unprivileged: true }),
		...params,
		vmid: id,
	})
	await client.waitForTask(upid, wait)
	return new LxcApi(client, node, id)
}
