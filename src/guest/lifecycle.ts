/**
 * The status and power calls QEMU and LXC share. Each power call returns the
 * UPID of a worker task; `waitForRunState` reads the guest itself, since a
 * start or stop task can finish before the guest has settled.
 */

import type { PveClient, PveParams } from '../core/client.ts'
import { PveTimeoutError } from '../core/errors.ts'
import { pollUntil, type PollOptions } from '../core/poll.ts'
import {
	guestPath,
	normalizeStatus,
	type GuestRef,
	type GuestStatus,
	type RunState,
} from './types.ts'

export type PowerAction = 'start' | 'stop' | 'shutdown' | 'reboot' | 'suspend' | 'resume' | 'reset'

export interface WaitForStateOptions {
	/** Give up after this long. Defaults to 5 minutes. */
	timeoutMs?: number
	/** First poll delay. Defaults to 200 ms. */
	initialDelayMs?: number
	/** Ceiling for the backoff. Defaults to 2000 ms. */
	maxDelayMs?: number
	signal?: AbortSignal
	onPoll?: (status: GuestStatus) => void
}

/** The guest's current status. Needs VM.Audit. */
export async function getStatus(client: PveClient, ref: Required<GuestRef>): Promise<GuestStatus> {
	const raw = await client.get<Record<string, unknown>>(`${guestPath(ref)}/status/current`)
	return normalizeStatus(raw, ref)
}

/**
 * Polls the guest's status until it reaches `state`. Throws PveTimeoutError
 * when the deadline passes, naming the state the guest was actually in.
 */
export async function waitForRunState(
	client: PveClient,
	ref: Required<GuestRef>,
	state: RunState,
	options: WaitForStateOptions = {},
): Promise<GuestStatus> {
	const timeoutMs = options.timeoutMs ?? 5 * 60_000
	const pollOptions: PollOptions<GuestStatus> = {
		done: (status) => status.runState === state,
		onTimeout: (status) => {
			throw new PveTimeoutError({
				what: `${ref.type} ${ref.vmid} to be ${state}`,
				waitedMs: timeoutMs,
				detail: `it is still ${status.runState}`,
			})
		},
		timeoutMs,
	}
	if (options.initialDelayMs !== undefined) pollOptions.initialDelayMs = options.initialDelayMs
	if (options.maxDelayMs !== undefined) pollOptions.maxDelayMs = options.maxDelayMs
	if (options.onPoll !== undefined) pollOptions.onPoll = options.onPoll
	if (options.signal !== undefined) pollOptions.signal = options.signal
	return pollUntil(() => getStatus(client, ref), pollOptions)
}

/** Posts one power action and returns the task UPID. Needs VM.PowerMgmt. */
export async function powerAction(
	client: PveClient,
	ref: Required<GuestRef>,
	action: PowerAction,
	params: PveParams = {},
): Promise<string> {
	return client.post<string>(`${guestPath(ref)}/status/${action}`, params)
}

/**
 * Deletes the guest and every volume it owns. Returns a UPID. Needs
 * VM.Allocate. Parameters go in the query string: a DELETE with a body is
 * refused by the node.
 */
export async function destroyGuest(
	client: PveClient,
	ref: Required<GuestRef>,
	params: PveParams = {},
): Promise<string> {
	return client.delete<string>(guestPath(ref), params)
}
