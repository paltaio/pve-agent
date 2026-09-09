/**
 * The task list of one node, and the per-task calls routed by UPID.
 *
 * A UPID names the node that runs its task, so `status`, `log` and `stop`
 * go to that node whichever node this object is bound to. Only the list
 * itself belongs to a node.
 */

import type { PveClient } from '../core/client.ts'
import {
	getTaskLog,
	getTaskStatus,
	normalizeTaskListEntry,
	stopTask,
	type TaskListEntry,
	type TaskLogOptions,
	type TaskStatus,
} from '../core/tasks.ts'
import type { NodesTasksGetByNodeParams } from '../generated/types.ts'
import { getEnvelope } from '../cluster/envelope.ts'
import { toOptionalNumber } from '../core/values.ts'

export type NodeTaskListOptions = NodesTasksGetByNodeParams

export interface NodeTaskPage {
	tasks: TaskListEntry[]
	/** Rows matching the filter before `start` and `limit`, when the node reports it. */
	total: number | undefined
}

export class NodeTasksApi {
	private readonly client: PveClient
	private readonly base: string

	constructor(client: PveClient, node: string) {
		this.client = client
		this.base = `/nodes/${encodeURIComponent(node)}/tasks`
	}

	/**
	 * One page of the task list, newest first, with the total row count the
	 * node reports beside `data`. Defaults to the 50 most recent finished
	 * tasks; `source: 'all'` includes running ones.
	 */
	async list(options?: NodeTaskListOptions): Promise<NodeTaskPage> {
		const { data, attribs } = await getEnvelope<Record<string, unknown>[]>(
			this.client,
			this.base,
			options,
		)
		return { tasks: data.map(normalizeTaskListEntry), total: toOptionalNumber(attribs['total']) }
	}

	async status(upid: string): Promise<TaskStatus> {
		return getTaskStatus(this.client, upid)
	}

	/** Lines of a task log, oldest first. The whole log unless a limit is given. */
	async log(upid: string, options?: TaskLogOptions): Promise<string[]> {
		return getTaskLog(this.client, upid, options)
	}

	/** Signal a running task to stop. A worker that ignores the signal keeps going. */
	async stop(upid: string): Promise<void> {
		await stopTask(this.client, upid)
	}
}
