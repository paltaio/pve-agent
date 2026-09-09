/**
 * One node: the API surface bound to it, and the root shell on it.
 */

import { NodeApi, type NodeStatus } from '../node/node.ts'
import type { NodeTaskListOptions, NodeTaskPage } from '../node/tasks.ts'
import type { NodeShell } from '../shell/node-shell.ts'
import type { PveContext } from './context.ts'

export class PveNode {
	readonly name: string
	/** Every node endpoint bound to this node: network, storage, disks, tasks and the rest. */
	readonly api: NodeApi

	private readonly context: PveContext

	constructor(context: PveContext, name: string) {
		this.context = context
		this.name = name
		this.api = new NodeApi(context.client, name)
	}

	/**
	 * A root shell on the node, with the ZFS, systemd, apt, qm and pct helpers
	 * on it. Opened on the first await and shared from then on.
	 *
	 * SSH when a key is authorised for root on the node, otherwise the
	 * termproxy websocket, which needs a root@pam ticket.
	 */
	get shell(): Promise<NodeShell> {
		return this.context.nodeShell(this.name)
	}

	/** Closes the shell on this node, if one is open. The next `shell` opens a new one. */
	closeShell(): Promise<void> {
		return this.context.closeNodeShell(this.name)
	}

	/** Uptime, load, CPU and memory use, kernel and PVE versions, root filesystem usage and boot mode. */
	status(): Promise<NodeStatus> {
		return this.api.status()
	}

	/** One page of worker tasks on this node, newest first, with the total count. */
	tasks(options?: NodeTaskListOptions): Promise<NodeTaskPage> {
		return this.api.tasks.list(options)
	}
}
